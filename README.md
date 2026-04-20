# Event Automation

A Google Apps Script web app: paste an event URL, Claude AI extracts the details, and the script creates a Google Calendar event with the flyer saved to Google Drive.

---

## How it works

1. You open the web app URL and paste an event page URL.
2. The script fetches the page, sends the HTML to Claude, and extracts title, date, time, location, description, and image.
3. You review and edit the extracted fields, then confirm.
4. The script saves the flyer image to a Drive folder, creates the Calendar event, and attaches the image.

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

## Deploy

Push local code to Apps Script and create/update the web app deployment:

```bash
# Push all files in src/ to the bound Apps Script project
clasp push

# Open the Apps Script editor to manage deployments
clasp open-script
```

In the editor: **Deploy → Manage deployments → New deployment** (or update an existing one).
- Type: **Web app**
- Execute as: **Me**
- Who has access: **Anyone with Google account** (or restrict to your domain)

Copy the web app URL — that's what you open to use the app.

> After any code change: run `clasp push`, then in the editor use **Deploy → Manage deployments → Edit** (pencil icon) and click **Deploy** to update the existing deployment. The URL stays the same.

---

## Test

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
| `test_processEventUrl_badUrl` | Code.gs | Error handling for unreachable URLs |

To test a live extraction, edit `test_extractEventData_live` in Extraction.gs, replace the URL with a real event URL, push with `clasp push`, then run it from the editor and inspect the execution log output.
