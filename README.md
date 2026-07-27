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

---

## Facebook Login (optional — needed for private/group events)

Connecting a Facebook account lets the app fetch group posts via the Graph API instead of scraping, which is required for any page behind a login wall.

### 1. Create a Facebook App

1. Go to [developers.facebook.com](https://developers.facebook.com) and click **My Apps → Create App**.
2. Choose app type **"Other"** → **"Consumer"**.
3. Give it a name (e.g. "Event Automation") and click **Create App**.

### 2. Add Facebook Login

1. From your app dashboard, click **Add a Product** and find **Facebook Login** → click **Set Up**.
2. Choose **Web** as the platform.
3. In the left sidebar, go to **Facebook Login → Settings**.
4. Under **Valid OAuth Redirect URIs**, add your GAS web app URL (see Deploy section below — you need to deploy first to get this URL).
5. Click **Save Changes**.

### 3. Add credentials to Script Properties

In the Apps Script editor, go to **Project Settings → Script Properties** and add:

| Key | Value |
|-----|-------|
| `FACEBOOK_APP_ID` | Found on your app dashboard under **App ID** |
| `FACEBOOK_APP_SECRET` | Found under **App Settings → Basic → App Secret** |

### 4. Add yourself as a test user

Until your app goes through Facebook's App Review, it only works for people with a role in your Facebook App. To add yourself:

1. In the app dashboard, go to **Roles → Test Users** (or **Roles → Roles**).
2. Add your Facebook account as a **Developer** or **Tester**.

After that, clicking **Connect** in the app will let you log in with your Facebook account and extract events from group posts.

---

## Deploy

The web app entry point is declared in `src/appsscript.json` (the `webapp`
block: execute as the deploying user, access restricted to the owner). The
stable `/exec` URL is tied to a fixed **deployment ID** — to keep that URL (and
any bookmarks / the Facebook redirect URI) stable, always **redeploy that same
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

If you ever need to change *who* can access the app (e.g. `ANYONE` so the
Facebook OAuth callback can reach `/exec`), edit the `access` value in
`src/appsscript.json` and run `./deploy.sh`.

---

## Test

### Locally (fast, no deploy)

Pure logic runs under Node without touching Google at all:

```bash
node tests/run.js Extraction.gs RecurrenceService.gs Utilities.gs   # 19 tests
node tests/calendar.test.js                                          # 5 tests
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
