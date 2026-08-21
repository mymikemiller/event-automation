# Event Automation

A Google Apps Script web app: paste an event URL, Claude AI extracts the details, and the script creates a Google Calendar event with the flyer saved to Google Drive.

---

## How it works

1. You open the web app URL and paste an event page URL.
2. The script fetches the page, sends the HTML to Claude, and extracts title, date, time, location, description, and image.
3. You review and edit the extracted fields, then confirm.
4. The script saves the flyer image to a Drive folder, creates the Calendar event, and attaches the image.

### Multi-date events

If an event page lists several dates — a book club meeting four Mondays in a
row, say — all of them are extracted. The confirmation screen shows every date
with its own start and end time, each editable and removable, plus an **Add
date** button. A banner above states exactly what will be created:

- **Repeating** — dates that fit a pattern become one repeating calendar event
  (`every week on Monday, 4 occurrences (Aug 10 – Aug 31)`).
- **Repeating with a custom date list** — irregular dates still become a single
  event, using an `RDATE` list rather than a rule.
- **Separate events** — only as a fallback, if creating a repeating event fails.

Because it stays one event, the description and flyer live in one place and a
later edit applies to every date.

Two details worth knowing:

- Series are pinned with `COUNT`, never `UNTIL`, so only the dates found on the
  page are ever created — no stray occurrences past the end.
- If one date starts at a different time from the rest, that occurrence is
  adjusted individually after the series is created, and its row is marked
  `diff` on the confirmation screen.

---

## Prerequisites (one-time setup)

1. **Node.js** — https://nodejs.org
2. **clasp** (Google's CLI for Apps Script):
   ```bash
   npm install -g @google/clasp
   ```
3. **Log in to clasp** with the Google account that owns the target calendar:
   ```bash
   clasp login
   ```
4. **Enable the Apps Script API** at https://script.google.com/home/usersettings — toggle "Google Apps Script API" ON.

---

## Script Properties

In the Apps Script editor, go to **Project Settings → Script Properties** and add:

| Key | Value |
|-----|-------|
| `CLAUDE_API_KEY` | Your Anthropic API key |
| `CALENDAR_ID` | The Google Calendar ID to create events on (find it in Calendar Settings → Integrate calendar) |
| `DRIVE_FOLDER_ID` | The Google Drive folder ID where flyer images are saved (the ID at the end of the folder's URL) |
| `TOCKIFY_EMAIL` | The Tockify account email |
| `TOCKIFY_PASSWORD` | The Tockify account password |

---

## Facebook events

Public Facebook event URLs work with no login and no app credentials.

Facebook server-renders the whole event into the page HTML for logged-out
visitors — the "See more on Facebook" dialog is only a client-side overlay
drawn on top of content that is already there. The script fetches the page with
an `Accept: text/html` header (without it Facebook returns a JavaScript shell
containing no event data) and reads the title, exact start/end timestamps,
location, cover photo, and full description out of the embedded JSON.

Two details worth knowing:

- The description is copied **verbatim**. It is never passed through the
  language model to be rewritten, summarised, or shortened.
- Links keep their real destinations rather than Facebook's `l.facebook.com`
  redirect wrapper, whose signed token expires — so they still work from the
  calendar event. Facebook reports link positions as offsets in Unicode
  codepoints while JavaScript indexes strings in UTF-16 units, so
  `fbLinkify_()` indexes a codepoint array; otherwise any emoji earlier in the
  description shifts every href and corrupts it.

If Facebook changes its page format, the app falls back to asking you to paste
the event text in by hand.

---

## Instagram posts

Public Instagram post, reel and IGTV URLs work with no login.

The post URL itself gives us nothing: a plain fetch returns a JavaScript shell,
and the `og:` tags a crawler gets carry a **square 640×640 crop** of the flyer.
The crop cannot be undone by editing the URL — the `stp=` crop specification is
covered by the signed `oh=` token, so a rewritten URL is answered with HTTP 403.

So the script reads `/p/<shortcode>/embed/captioned/` instead, which
server-renders the whole post: the full caption, and the **uncropped original**
image. `/p/`, `/reel/` and `/tv/` all resolve the same shortcode, so every form
is normalised to `/p/`.

The "Never miss a post from …" dialog never comes into it. Like Facebook's "See
more on Facebook" dialog, it is a client-side overlay drawn over content the
server has already sent — and there is no browser in the loop to draw it.

### Reading the flyer

An Instagram caption is usually chatter rather than a listing: "this Saturday,
August 22nd" with no year, a venue named only by `@handle`. The flyer it is
posted with normally states all of it outright.

So extraction runs in two passes. The first reads the caption alone, under
instructions to report only what the caption says and return null for the rest —
a guessed end time is indistinguishable from a stated one afterwards, and would
keep the image closed. If title, date, start time, end time or location came
back empty, a second pass sends the full image to Claude with the caption
beside it and the flyer named as authoritative. A caption that stated
everything never pays for that call.

The image goes to Claude as inline bytes rather than as a URL to fetch:
Instagram's CDN URLs are signed, short-lived and served from a region-specific
host that need not answer someone else's request.

Two details worth knowing:

- The caption becomes the description **verbatim** — never passed through the
  model to be rewritten, the same rule Facebook events follow.
- Instagram writes `@handle` and `#hashtag` links site-relative with a
  `utm_source=ig_embed` tracker. Both are rewritten to absolute, tracker-free
  URLs, so they still work from the calendar event.

If Instagram changes its embed format, the app falls back to asking you to paste
the post text in by hand.

---

## Tockify

Events reach Tockify by Google Calendar sync, which carries no image. The script
closes that gap: submitting an event queues a job, and a trigger running every
five minutes sets the flyer as the featured image on the matching Tockify event.
An event Austin Vegan Association hosts is tagged in the same pass.

The image goes over as the **original source URL**, not the Drive copy. Tockify
downloads and keeps its own copy, so the link only has to survive a single
fetch — and `saveImageToDrive` returns a Drive *viewer* page, which would give
Tockify HTML rather than an image.

Matching is on title **and** exact start time. Title alone is not enough, since
repeating events share one. A multi-date event syncs to Tockify as a single
repeating record, so there is one image to set no matter how many dates it has.

The tag is `Austin-Vegan-Association`, and an event earns it when the URL you
submitted is a Meetup event under the `vegaustin` group. That link rides along in
the queued job, so the host is decided from what was pasted rather than from
anything Tockify holds.

`tockifyAvaHost_` (`src/TockifyUtil.gs`) answers `yes`, `no` or `unknown` —
three states rather than a boolean because a canonical
`meetup.com/vegaustin/events/<id>` URL is free to classify, while a `meetu.ps`
share link or a `meetup.com/ls/click` tracking link costs an HTTP round trip.
The `unknown` case is resolved in the background job by following one redirect
hop, so submitting an event never waits on Meetup. A link still not classifiable
after that is reported as an error rather than treated as a `no`: an event that
goes untagged with no signal is the failure this path exists to prevent.

The slug is matched on the URL **path**, for the same reason the Meetup notifier
matches its IDs there. A real entry on this calendar reads:

```
meetup.com/vegaustin/events/313891224/?slug=vegaustin&eventId=307154188
```

so a plain substring test for `vegaustin` also fires on another group's event
that merely carries that query string, tagging events AVA does not host. Two
further rules fall out of the same trap: the match needs an event ID after
`/events/`, so a group's listing page is not read as an event, and the *first*
`/events/` segment decides, so a URL sitting inside a query string cannot win.

Because the tag has nothing to do with the flyer, an event is queued when it has
an image **or** its host group is anything other than a definite `no` — an
AVA event submitted without a flyer still gets tagged, and such a job does only
the tag write. An `unknown` link is queued under the same rule and simply finds
nothing to do once it resolves to another group.

The queue itself is one JSON string in one script property, capped at 9KB. A job
runs from about 180 bytes with no image up to around 630 with both URLs long, so
the ceiling is anywhere between roughly 50 pending jobs and about 14 — assume the
low end. The image URL is the lever there, not the source URL: a Facebook CDN
link carries some 330 characters of signed parameters, where the difference
between a canonical Meetup link and a tracked one is about 120.

Past the cap the job is not stored and the submission warns rather than failing,
because the calendar event, the Drive file and the attachment have all landed by
then and only the Tockify follow-up is missed; the warning tells you to set the
image and tag by hand. That ceiling is far above what a hand-driven tool reaches
in a day, but it is real and it does not correct itself — nothing prunes the
queue, and a sustained Tockify login outage stops it draining at all.

Four details worth knowing:

- Tockify issues no API token. Auth is a session cookie obtained by logging in
  with `TOCKIFY_EMAIL` / `TOCKIFY_PASSWORD`. Enabling MFA on the Tockify account
  breaks this and there is no fallback.
- Cropping is skipped deliberately. Tockify applies crops at display time as CDN
  URL operations, and its cropper defaults to the whole image — so skipping the
  step produces exactly what accepting the default by hand produces.
- `imageIdNg` is the field that sets the image. Writing `imageSets` directly
  returns HTTP 200 and is silently ignored, so the code re-reads the response
  and treats an empty `imageSets` as a failure.
- Tags are a flat top-level array of strings on that same record —
  `tags: ["Austin-Vegan-Association"]`. The public `ngevent` API nests the same
  data at `content.tagset.tags.default`, and copying that shape back is the same
  trap as `imageSets`: an unrecognised field is answered with a silent 200, so it
  would look saved and change nothing. The tag write is verified against the
  saved record for exactly that reason.

If an event has not appeared in Tockify within two hours, the job is dropped and
you get an email saying so. Any other failure drops it on the spot and emails
every problem the job hit rather than only the first. Each of those lines carries
a prefix, and the prefixes come in two kinds that must not be read alike:

- `image:`, `host group:` and `write:` name a stage that failed, whether it
  returned an error or threw. A stage with no line ran and worked — absence is
  the success signal, which is why nothing separately reports what was applied —
  so a lone `host group:` line means the flyer landed and only the tag did not.
  The same rule holds inside the `write:` stage, which sets the image and the tag
  in one request: it names each field that failed to stick, one per line, so an
  unnamed field in that write landed.
- `find:` and `aborted:` mean the job stopped there: the Tockify event lookup
  failed, or an exception outside the image stage cut the run short. Stages
  missing after one of these never ran, so nothing can be assumed about them
  either way.

None of these endpoints are documented or contractual, so failures are loud by
design.

Run `installTockifyTrigger` once from the editor to install the trigger.

---

## Meetup new-event alerts

Meetup has no usable "new event" notification, and events reach the calendar by
hand through this web app — so a newly published event can sit unnoticed for
days. An hourly job watches the groups listed in `MEETUP_GROUPS` and emails
`MEETUP_NOTIFY_EMAIL` when one of them has published an event that is not yet on
the calendar.

Both constants are at the top of `src/MeetupService.gs`. Adding a group is
appending its slug — Meetup event IDs are globally unique rather than per-group,
so nothing else is per-group:

```js
var MEETUP_GROUPS = ['vegaustin'];
```

Events come from Meetup's public iCal feed, `meetup.com/<slug>/events/ical/`,
which needs no auth and no API key. That is why this doesn't scrape the group
page through Claude or hold OAuth credentials for Meetup's GraphQL API.

### Deciding what counts as "new"

An event is new when it is in the feed but matches nothing on the calendar.
Matching runs two rules, either of which is enough:

1. **The RSVP link.** `submitEvent` appends a source link to every event it
   creates, so most calendar entries carry their Meetup URL. The numeric event
   ID in that URL is an exact identity.
2. **Identical title and start time**, as a fallback for entries created
   directly in Google Calendar with no link at all.

Rule 1 reads the ID from the URL **path**, never the query string. A real entry
on this calendar reads:

```
meetup.com/vegaustin/events/313891224/?slug=vegaustin&eventId=307154188
```

where the query string names a *different* event. Matching on a bare number, on
"the last number", or on `eventId=` silently pairs the wrong events.

Two link shapes on the calendar yield no ID at all — Meetup's `/ls/click`
tracking redirects, and group-level `/events/` URLs. Those fall through to rule
2, and failing that cost one stray email, once.

### Repeat suppression

Notified event IDs are kept in the `MEETUP_NOTIFIED_IDS` script property, so an
event you are slow to add to the calendar is announced once, not every hour.

That set is pruned to the IDs still in the feed — Meetup doesn't reuse event
IDs, so an event that has rolled off can't come back. The prune only runs for
groups that actually fetched: otherwise a single Meetup outage would empty the
set and the next healthy run would re-announce everything.

### Before installing the trigger

Run `previewMeetupCheck` from the editor. It runs the whole pipeline and logs
what it *would* send, sending nothing and storing nothing, so you can confirm it
stays quiet on events already on the calendar. Then run `installMeetupTrigger`
once, **as the account that owns the script** — a time-driven trigger runs as
whoever installed it.

If Meetup ever moves the feed, the job emails you rather than failing silently,
at most once a day.

---

## Deploy

The web app entry point is declared in `src/appsscript.json` (the `webapp`
block: execute as the deploying user, access restricted to the owner). The
stable `/exec` URL is tied to a fixed **deployment ID** — to keep that URL (and
any bookmarks) stable, always **redeploy that same
deployment** rather than creating a new one.

Use the deploy script:

```bash
./deploy.sh "optional description"
```

It runs `clasp push`, cuts a new immutable version, and redeploys the pinned
deployment to it. The bookmarked URL never changes:

```
https://script.google.com/a/macros/atxveg.org/s/AKfycbx_zs0uCLGSxxB3btHhF3ehvdM_3CL2BHK_P0SuCYyRh2FJ61dv21snaSwisHDCb7Fe/exec
```

> The `/a/macros/atxveg.org/` segment forces the correct Google account
> (`mike.miller@atxveg.org`, the owner). With `access: MYSELF`, opening the plain
> `/macros/` URL while signed into another account returns a misleading
> "file does not exist" error.

> ⚠️ Do **not** run `clasp deploy` — it mints a *new* deployment ID and breaks
> the bookmarked URL. For quick testing without versioning, `clasp push` updates
> the `/dev` URL immediately (latest saved code, owner login required).

If you ever need to change *who* can access the app, edit the `access` value in
`src/appsscript.json` and run `./deploy.sh`.

---

## Test

### Locally (fast, no deploy)

Pure logic runs under Node without touching Google at all:

```bash
node tests/run.js FacebookService.gs Extraction.gs RecurrenceService.gs Utilities.gs   # 26 tests
node tests/run.js MeetupService.gs                                                     # 12 tests
node tests/run.js TockifyUtil.gs                                                       # 1 test
node tests/calendar.test.js                                                            # 5 tests
```

`tests/run.js` loads `.gs` files into a Node `vm` context with `Logger`/`Session`
shims and runs their `test_*` functions, skipping anything named `*_live`.
`tests/calendar.test.js` covers `CalendarService.gs` against a stub that filters
instances by `timeMin`/`timeMax` the way the real API does — a permissive stub
once hid a timezone bug that only appeared against live Google Calendar.

`tests/` sits outside clasp's `rootDir`, so none of it is ever pushed.

### In the Apps Script editor (anything touching Google)

Google Apps Script doesn't have a test runner. Each test is a named function you run manually:

1. If you get an `invalid_grant` auth error, re-authenticate first: `clasp login`
2. Run `clasp open-script` to open the Apps Script editor.
3. Select a test function from the function dropdown (top toolbar).
4. Click **Run**.
5. Check results in **View → Executions** (the execution log).

Available test functions:

| Function | File | What it tests |
|----------|------|---------------|
| `test_parseClaudeResponse` | Extraction.gs | JSON parsing logic |
| `test_extractEventData_live` | Extraction.gs | Full extraction against a real URL (edit the URL in the function first) |
| `test_createAndDeleteEvent` | CalendarService.gs | Calendar event creation and cleanup |
| `test_duplicateDetection` | CalendarService.gs | Duplicate event check |
| `test_createRecurringEvent_live` | CalendarService.gs | A repeating series produces exactly the expected instances |
| `test_createRecurringWithException_live` | CalendarService.gs | An occurrence with a different time is patched individually |
| `test_createIrregularSeries_live` | CalendarService.gs | The `RDATE` path materializes on irregular dates |
| `test_processEventUrl_badUrl` | Code.gs | Error handling for unreachable URLs |
| `test_tockifyLogin_live` | TockifyService.gs | Logging in returns a `TKFSession` cookie |
| `test_tockifyUploadImage_live` | TockifyService.gs | An image URL uploads and comes back with a uuid |
| `test_tockifyAvaTagEndToEnd_live` | TockifyService.gs | The AVA tag reaches a real event record. **Drains the whole live queue, and needs a tag cleared by hand first — see below** |
| `test_tockifyIsAvaEvent_live` | TockifyService.gs | Host-group classification, including a real short link resolved over the network |
| `test_tockifyEventGroupShape_live` | TockifyService.gs | Read-only probe reporting where tags live on an authenticated event group |

The CalendarService `*_live` tests create `[TEST]` events and delete them in a
`finally` block.

`test_tockifyAvaTagEndToEnd_live` is the one to read before you run it. It calls
`processTockifyQueue_()`, so it drains the **entire** live queue, not just the job
it added: every other pending job is applied or dropped and emailed in the same
pass. And it has a manual precondition — open the fixture event in the Tockify UI
and remove its `Austin-Vegan-Association` tag first. With the tag already there
the merge is a no-op, the PUT changes nothing, and the check passes on a tag that
predates the run, proving nothing about whether the field is writable. The test
refuses to run rather than pass that way, so `PRECONDITION FAILED` in the log
means exactly that. Its fixture event is already tagged again, so re-point the
four constants at another AVA event before re-running.

To test a live extraction, edit `test_extractEventData_live` in Extraction.gs, replace the URL with a real event URL, push with `clasp push`, then run it from the editor and inspect the execution log output.
