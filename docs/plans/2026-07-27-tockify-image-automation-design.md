# Tockify Image Automation — Design

**Date:** 2026-07-27
**Status:** Designed, not implemented. Every HTTP call below was verified against
the live Tockify API from a browser session on 2026-07-27.

---

## The problem

Events reach Tockify by Google Calendar sync, which carries no image. Today that
means logging in to Tockify, finding the freshly synced event, pasting the flyer
URL, cropping, and saving — by hand, for every event.

This automates that last step from Google Apps Script.

---

## Why the edit has to happen after the fact

Tockify's Google sync is read-only and one-way, and a Google Calendar event has
nowhere to put a featured image. So the image cannot ride in on the sync; it has
to be a second write, against Tockify's own API, after the event appears.

The sidebar in the calendar editor states the sync runs *"within seconds"* of a
Google-side change, and offers a manual `Refresh From Google`. So the wait is
short — but it is not zero, which is why this is a deferred job rather than part
of `submitEvent`.

**Critically: the sync does not overwrite images.** `Vegan Group Fitness` carries
`isExternal: true` alongside a populated `imageIdNg`. Had that not held, this
whole approach would be dead.

---

## Architecture

`submitEvent` enqueues one job; a time-driven trigger drains the queue.

```
submitEvent
  └─ enqueue { title, startMillis, imageUrl, tries: 0, firstSeen }

trigger (every 5 min)
  └─ for each pending job:
       find the event in Tockify by title + start time
       ├─ absent → tries++, give up at 2h and notify
       └─ found  → ingest image → register → set imageIdNg → dequeue
```

One job per event, not per date. A multi-date event syncs to Tockify as a single
repeating event — Tockify shows "Editing Repeating Group" — so there is one
record to patch regardless of how many occurrences it has.

The queue carries the image URL from extraction, so the job never has to match a
flyer back to an event. The `YYYY-MM-DD_Title` Drive filename convention stays
purely cosmetic.

### Which image URL

The original source URL from extraction (`eventData.image_url`), not the Drive
copy. Two reasons:

- `saveImageToDrive` returns `file.getUrl()`, a Drive *viewer* page. Handing that
  to an image fetcher yields HTML, not an image.
- Tockify downloads and stores its own copy at ingest time, so the URL only has
  to survive a single fetch. The image library already contains Facebook CDN
  filenames, so this path is proven in practice.

---

## Configuration

Script Properties:

| Key | Value |
|-----|-------|
| `TOCKIFY_EMAIL` | Tockify account email |
| `TOCKIFY_PASSWORD` | Tockify account password |

Constants (stable, no reason to make them properties):

| Name | Value |
|------|-------|
| `CALID` | `698678eaaea5aa1bccb5edcc` |
| `CALNAME` | `austin.vegan.events` |
| `UPLOADCARE_PUB_KEY` | `e14168cd40d42bd3b36c` |

The Uploadcare key is a *publishable* key, exposed in Tockify's client-side
JavaScript by design. It is not a secret.

---

## Authentication

Tockify has no API token and no refresh token. Auth is a single **httpOnly**
session cookie, `TKFSession`; there is nothing in `localStorage`, and the four
JS-readable cookies are all analytics and Stripe.

That left two options, and only one of them runs unattended:

- **Stored password, log in each run** — chosen. No captcha, no SSO, so it
  replays cleanly from `UrlFetchApp`.
- Captured session cookie — rejected. An httpOnly cookie has to be dug out of
  DevTools by hand and expires on Tockify's schedule, not ours.

```
POST /api/sessions2
Content-Type: application/json
Accept: application/json

{ "stayLoggedIn": true, "email": "…", "password": "…", "nextUri": "/" }
```

`stayLoggedIn` asks for the long-lived session rather than a browser-session
cookie. Success sets `TKFSession`; bad credentials return HTTP 400 with
`{errors: {form: {message}}}`.

The endpoint is not discoverable by probing — the form has no `action`
attribute, and this server answers **404 for auth failures and routing failures
alike** (`/api/subscription-status` returns 404 `"not logged in"` when
unauthenticated). A 404 here means nothing; it had to be captured from a real
login.

Cache the cookie in `CacheService` for 6 hours. Because a cached cookie can be
expired server-side without the script knowing, probe
`GET /api/subscription-status` before each run — 200 means live, anything else
means log in fresh.

---

## The calls

All verified live. Every one is a plain HTTP request `UrlFetchApp` can make.

### 1. Find the event

```
GET /api/ngevent?calname=<CALNAME>&startms=<ms>&max=50
    &view=agenda&start-inclusive=true&showAll=true
```

Returns `{ events: [...] }`. Match on
`content.summary.text === title && when.start.millis === startMillis`, then take
`eid.uid`.

### 2. Ingest the image into Uploadcare

```
GET https://upload.uploadcare.com/from_url/?pub_key=<KEY>&source_url=<encoded>
    → { type: "token", token }

GET https://upload.uploadcare.com/from_url/status/?token=<token>
    → { status: "success", uuid, size, original_filename, image_info }
```

Poll the status endpoint until `success` or `error`.

Do **not** pass `store=1` — the key has autostore disabled and the request fails
with `Autostore is disabled`.

### 3. Register it in Tockify's image library

```
POST /api/imageset
Content-Type: application/json
Accept: application/json

{ "url": "https://up.tockify.com/<uuid>/",
  "name": "<original_filename>",
  "suffix": "nosuffix" }
```

Two traps here:

- The field is **`url`** — the `up.tockify.com` CDN URL built from the Uploadcare
  uuid — not a `uuid` field. Sending the wrong schema returns `404 Not found`,
  not a validation error, which makes this impossible to guess.
- The response is `{}`. The new id must be **read back**:

```
GET /api/imageset?offset=0&limit=1     → newest first; [0].id is the new record
```

Tockify re-derives `width`, `height`, `size` and `masterFormat` itself, so there
is no need to send them.

### 4. Set the image on the event

```
GET /api/eventgroup/<CALID>/<uid>      → flat event-group record
    set  imageIdNg = <imageset id>
PUT /api/eventgroup/<CALID>/<uid>
```

`imageIdNg` is the write field. The server hydrates `imageSets` from it — writing
`imageSets` directly is silently ignored (returns 200 with `imageSets: []`).

### Also available

- `POST /api/google/resync/:id` — force a Google sync instead of waiting.
- `DELETE /api/eventgroup/<CALID>/<uid>` — used to clean up test events.

---

## Cropping

There is nothing to do. The Uploadcare cropper defaults to **FREE with the whole
image selected**, and crops are applied at display time as CDN URL operations
(`/-/preview/1162x693/-/setfill/ffffff/-/format/jpeg/`). No crop rectangle is
stored on the event. Skipping the crop step produces exactly the result that
accepting the default by hand produces.

---

## Failure handling

- **Event not found yet** — `tries++` and retry next run. Give up after 2h and
  email. Sync is seconds, so 2h is pure safety margin.
- **Login rejected** — clear the cached cookie and retry once, then email.
- **Image ingest fails** — email with the URL that failed; leave the event alone.

---

## Known failure modes

- **Tockify MFA.** `/api/user/mfaEnable` exists. Enabling MFA breaks programmatic
  login and there is no fallback — this design would need revisiting.
- **Facebook CDN expiry.** Those URLs are signed and time-limited. A job still
  retrying hours later may fetch a dead link. The 2h give-up bounds the exposure.
- **Private API.** None of these endpoints are documented or contractual.
  Tockify can change them without notice, so failures must be loud.

---

## Open items

- No end-to-end run has been done. Each link is verified individually against
  the live API, and the Apps Script translation of those calls has never been
  executed. The first real event exercises the chain as a whole.
- Everything was verified against a **native** Tockify event. Google-synced
  events show "This event is managed outside of Tockify so some fields can't be
  changed here", which greys out title/date/description — but the Change Image
  control stays enabled and external events demonstrably carry images, so
  `imageIdNg` is expected to be writable on them. Worth confirming on the first
  real run.
