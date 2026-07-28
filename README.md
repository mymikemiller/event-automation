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

## Tockify

Events reach Tockify by Google Calendar sync, which carries no image. The script
closes that gap: submitting an event queues a job, and a trigger running every
five minutes sets the flyer as the featured image on the matching Tockify event.

The image goes over as the **original source URL**, not the Drive copy. Tockify
downloads and keeps its own copy, so the link only has to survive a single
fetch — and `saveImageToDrive` returns a Drive *viewer* page, which would give
Tockify HTML rather than an image.

Matching is on title **and** exact start time. Title alone is not enough, since
repeating events share one. A multi-date event syncs to Tockify as a single
repeating record, so there is one image to set no matter how many dates it has.

Three details worth knowing:

- Tockify issues no API token. Auth is a session cookie obtained by logging in
  with `TOCKIFY_EMAIL` / `TOCKIFY_PASSWORD`. Enabling MFA on the Tockify account
  breaks this and there is no fallback.
- Cropping is skipped deliberately. Tockify applies crops at display time as CDN
  URL operations, and its cropper defaults to the whole image — so skipping the
  step produces exactly what accepting the default by hand produces.
- `imageIdNg` is the field that sets the image. Writing `imageSets` directly
  returns HTTP 200 and is silently ignored, so the code re-reads the response
  and treats an empty `imageSets` as a failure.

If an event has not appeared in Tockify within two hours, the job is dropped and
you get an email. None of these endpoints are documented or contractual, so
failures are loud by design.

Run `installTockifyTrigger` once from the editor to install the trigger.

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

The `*_live` tests create `[TEST]` events and delete them in a `finally` block.

To test a live extraction, edit `test_extractEventData_live` in Extraction.gs, replace the URL with a real event URL, push with `clasp push`, then run it from the editor and inspect the execution log output.
