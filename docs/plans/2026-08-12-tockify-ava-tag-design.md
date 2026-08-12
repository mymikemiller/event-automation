# Tockify Austin Vegan Association Tag — Design

**Date:** 2026-08-12
**Status:** Partly implemented. The pure helpers are in `src/TockifyUtil.gs` and
the redirect resolver and host classifier are in `src/TockifyService.gs` (plan
Tasks 1, 2 and 4); the single-write `tockifyUpdateEventGroup_` and the job
rewiring (Tasks 5–7) are not written yet. The tag shape and the short-link
redirect were verified against live services on 2026-08-12, including the
authenticated eventgroup record — see [The tag's shape](#the-tags-shape).

---

## The problem

Events AVA hosts on Meetup should carry the Tockify tag
`Austin-Vegan-Association`. Today that is applied by hand, in the same visit to
the Tockify UI that the image upload used to require.

The image half of that visit is already automated. This extends the same job to
apply the tag, so an AVA event needs no manual Tockify step at all.

---

## What identifies an AVA event

The URL the submitter pasted into the tool — `eventData.source_url`, already
carried through to `submitEvent` and used to build the description's RSVP link.

AVA's group is `https://www.meetup.com/vegaustin/`, but the link reaching the
tool arrives in more than one shape:

| Shape | Example | Decidable offline? |
|-------|---------|--------------------|
| Canonical | `www.meetup.com/vegaustin/events/315879624` | yes |
| Another group | `www.meetup.com/vegan-adventure-club-austin-tx/events/314564938` | yes — not AVA |
| Share shortener | `meetu.ps/e/Qbwn8/1qvFq/i` | no |
| Click tracker | `meetup.com/ls/click?upn=u001.NY3oBF…` | no |
| Not Meetup | a Facebook or Eventbrite URL | yes — not AVA |

So the classifier returns three states, not a boolean:

```
tockifyAvaHost_(url) → 'yes' | 'no' | 'unknown'
```

`unknown` is the only state that costs a network call. Every canonical URL —
the common case — is decided with pure string work, which keeps `submitEvent`
free of an extra fetch and makes the whole classifier unit-testable.

### Matching on the path segment, not the string

The slug test is anchored on `meetup.com/<slug>/events/`, for the reason already
documented on `meetupExtractEventId_` (`src/MeetupService.gs:521`). A real entry
on this calendar reads:

```
meetup.com/vegaustin/events/313891224/?slug=vegaustin&eventId=307154188
```

A bare `indexOf('vegaustin')` also fires on any other group's event that happens
to carry `?slug=vegaustin` in a share URL, tagging events AVA does not host.

### Why not reuse `MEETUP_GROUPS`

`MEETUP_GROUPS` (`src/MeetupService.gs:6`) is the new-event notifier's watch
list. It happens to contain only `vegaustin` today, but its purpose is "groups
worth watching for events missing from the calendar" — which may well grow to
include groups AVA does not host. Tying the tag to it would silently mistag
every event from the next group added. The AVA slug gets its own constant.

---

## Resolving the shortened form

One `UrlFetchApp.fetch` with `followRedirects: false`, reading the `Location`
header and re-running the classifier on the result.

Verified live on 2026-08-12:

```
GET https://meetu.ps/e/Qbwn8/1qvFq/i
    → 302
    Location: https://www.meetup.com/vegaustin/events/315879624/?_xtd=…&from=ref
```

A single hop lands on the canonical URL. The resolver follows **one** hop and
treats a missing `Location` as unresolvable, rather than chasing a chain — a
redirect loop in an unattended 5-minute job is worse than a missed tag.

---

## The tag's shape

**Resolved by live probe on 2026-08-12** (`test_tockifyEventGroupShape_live`),
against the authenticated **eventgroup** record — the one the job actually GETs
and PUTs. Tags are a plain top-level array of strings:

```json
{ "calid": "…", "uid": "…", "title": "…",
  "tags": ["Austin-Vegan-Association"] }
```

The probe walked the whole record for the tag string and found it at exactly one
path, `tags[0]`, by an `===` comparison — so these are bare strings, not objects.
There is no `tagset` key anywhere on the record, and no `content` wrapper at all:
`group.tagset` and `group.content.tagset` both came back `undefined`.

### The trap: the public API's shape is not the write shape

The public read-only API (`GET /api/ngevent?calname=austin.vegan.events&…`)
nests the same data three levels deeper, under a `content` wrapper:

```json
"content": {
  "tagset": { "tags": { "default": ["Austin-Vegan-Association"] } }
}
```

This is the shape anyone reading the public API — or its documentation — would
copy, and it is **not what to write**. It is the same split already known for the
image, where the public response carries `content.imageSets` while the eventgroup
record takes `imageIdNg` at the top level. Sending a nested `tagset` costs
nothing visible: this server answers a body field it does not recognise with a
silent HTTP 200 (see `imageSets` vs `imageIdNg` in `tockifySetEventImage_`), so
the write would look accepted and change nothing.

Tags merge rather than replace: existing tags are preserved and
`Austin-Vegan-Association` is appended only when absent, so re-running a job is
a no-op. A missing or malformed `tags` becomes a fresh one-element array.

---

## Architecture

The existing queue and trigger are unchanged in shape. The job gains a second
thing it can do.

```
submitEvent
  └─ enqueue { title, startMillis, imageUrl, sourceUrl, tries: 0, firstSeen }
       when imageUrl OR tockifyAvaHost_(sourceUrl) !== 'no'

trigger (every 5 min)
  └─ for each pending job:
       find the event in Tockify by title + start time
       ├─ absent → tries++, give up at 2h and notify
       └─ found  → if imageUrl: ingest image → register → imageSetId
                   classify sourceUrl; if unknown, resolve the redirect once
                   one GET/PUT applying image and/or tag → dequeue
```

### The widened enqueue gate

`src/Code.gs:116` enqueues only when there is an image. An AVA event submitted
without one would therefore never reach Tockify at all, and never get tagged —
so the gate widens to `image_url || tockifyAvaHost_(sourceUrl) !== 'no'`.

Including `'unknown'` means a *non*-AVA Meetup event arriving by short link also
gets queued: the job resolves it, finds it is not AVA, and completes with
nothing to do. That is one wasted lookup, and it is the price of not making
`submitEvent` wait on a redirect fetch.

Jobs already sitting in the queue have no `sourceUrl`. `undefined` classifies as
`'no'`, so they drain as image-only exactly as they do today — no migration.

### One PUT, not two

Image and tag live in the same eventgroup record, so `tockifySetEventImage_`
becomes `tockifyUpdateEventGroup_(cookie, uid, {imageSetId, addTag})` — a single
GET/PUT applying whichever mutations are in play.

Two separate GET/PUT cycles would double the round trips and let the pair land
half-applied. With one, they share a fate, and the existing "a 200 alone does
not mean it stuck" read-back check extends naturally to verifying the tag came
back in the saved record.

---

## Failure handling

Unchanged from the image job except for one new case:

- **Redirect unresolvable** — email, then continue as not-AVA. The image is
  still applied; only the tag is skipped. The notice names the event so the tag
  can be added by hand. Chosen over silently skipping (an AVA event goes
  untagged with no signal) and over retrying the whole job (the image is held
  hostage to a shortener being down).
- **Tag did not stick** — email, same as a rejected image. These endpoints are
  undocumented; failures stay loud.

---

## Testing

Pure helpers get cases in `test_tockifyUtil`, following the existing pattern in
`src/TockifyUtil.gs`:

- `tockifyAvaHost_` — canonical AVA URL with and without trailing slash; the
  `?slug=vegaustin&eventId=…` mispair trap; another group's slug; `meetu.ps`;
  `meetup.com/ls/click`; a Facebook URL; empty; null; `undefined`
- tag merge — absent → appended; already present → unchanged (asserted on the
  *value*, not the length); unrelated tags preserved; missing or malformed `tags`
  → a fresh one-element array; the input never mutated and never shared by the
  result, on both the tag-absent and tag-already-present branches
- `tockifyHasTag_` — false for a **string** carrying the tag as a substring. A
  bare `indexOf` returns a non-negative index there and reports a write that
  never landed as a success

Live tests, editor-run, matching `test_tockifyLogin_live`:

- `test_tockifyEventGroupShape_live` — the shape probe, run 2026-08-12
- an end-to-end tag apply against a scratch event

---

## Files

| File | Change |
|------|--------|
| `TockifyUtil.gs` | `tockifyAvaHost_`, tag merge, AVA slug constant, tests |
| `TockifyService.gs` | redirect resolver; `tockifySetEventImage_` → `tockifyUpdateEventGroup_` |
| `TockifyJob.gs` | `tockifyApplyImage_` → `tockifyApplyJob_` |
| `TockifyQueue.gs` | `sourceUrl` on the job record |
| `Code.gs` | widened enqueue gate, pass `sourceUrl` |

---

## Open items

- ~~**Where `tagset` sits on the authenticated eventgroup record is
  unverified.**~~ **Resolved by live probe on 2026-08-12** — see
  [The tag's shape](#the-tags-shape). The answer was **neither candidate this
  entry predicted.** It expected the field to be named `tagset`, either at the
  top level (the strong expectation, by analogy with `imageIdNg`) or nested under
  `content` (as the public API has it). It is neither: there is no `tagset` key
  on the record at all. The field is differently named *and* differently shaped —
  a flat top-level `tags` array of bare strings, `group.tags = ["…"]`, with no
  per-group nesting and no `default` key. Both helpers were built against the
  predicted nesting first and had to be rewritten, which is the case for probing
  rather than reasoning by analogy: the analogy correctly predicted "flattened"
  and still got the field wrong, and writing the wrong field here returns a
  silent 200 rather than an error.
- **Editor-run required.** `clasp run` does not work on this project (web app,
  not an API executable), so the live probes are run by hand from the Apps
  Script editor.
- **Tagging is Meetup-only.** An AVA-hosted event submitted from a Facebook or
  Eventbrite URL is not tagged, because nothing in those URLs identifies the
  host. If that becomes common, the review screen would need a checkbox.
