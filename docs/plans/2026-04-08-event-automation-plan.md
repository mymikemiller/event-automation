# Event Automation Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a Google Apps Script web app where a user pastes an event URL, Claude AI extracts event details, and the script creates a Google Calendar event with the image saved and attached from Google Drive.

**Architecture:** A clasp-managed GAS project with server-side `.gs` files handling extraction (Claude API), Drive upload, and Calendar creation, and a single `Index.html` for the phone-friendly web UI. All config (API key, calendar ID, folder ID) lives in Script Properties, never hardcoded.

**Tech Stack:** Google Apps Script (clasp for local dev), Claude API (claude-sonnet-4-6), Google Calendar Advanced Service, Google Drive API (built-in GAS), Vanilla HTML/CSS/JS for the UI.

---

## Project File Structure

```
event-automation/
  src/
    appsscript.json       ← GAS manifest (enables Calendar Advanced Service)
    Code.gs               ← doGet(), include(), top-level routing
    Extraction.gs         ← Claude API call + JSON parsing
    DriveService.gs       ← image download + Drive upload
    CalendarService.gs    ← event creation, attachment, duplicate check
    Utilities.gs          ← slugify, date/time formatting helpers
    Index.html            ← web app UI (HTML + CSS + JS)
  docs/
    plans/
      ...
  .clasp.json             ← clasp project config (gitignored — contains scriptId)
  .claspignore            ← exclude docs/ from push
```

---

## Testing Approach

Google Apps Script doesn't have a traditional test runner. Each task includes a `test_*.gs`-style function that you run manually from the Apps Script editor (Extensions → Apps Script → select function → Run). Check results in the **Execution log** (View → Executions). This is the standard GAS testing workflow.

---

## Prerequisites (complete before Task 1)

1. Install Node.js (if not already): https://nodejs.org
2. Install clasp globally:
   ```bash
   npm install -g @google/clasp
   ```
3. Log in to clasp:
   ```bash
   clasp login
   ```
   This opens a browser — authorize with the Google account that owns the target calendar.
4. Enable the Apps Script API in your Google account:
   Visit https://script.google.com/home/usersettings and toggle "Google Apps Script API" ON.

---

## Task 1: Project Scaffold

**Files:**
- Create: `src/appsscript.json`
- Create: `src/Code.gs`
- Create: `src/Utilities.gs`
- Create: `src/Extraction.gs`
- Create: `src/DriveService.gs`
- Create: `src/CalendarService.gs`
- Create: `src/Index.html`
- Create: `.claspignore`

**Step 1: Create the GAS project via clasp**

From `/Users/mike/projects/event-automation`:
```bash
mkdir -p src
cd src
clasp create --title "Event Automation" --type webapp
```
This creates `.clasp.json` in `src/` with the `scriptId`. Move it to the project root:
```bash
mv .clasp.json ../.clasp.json
```
Then edit `../.clasp.json` to add `"rootDir": "src"` so clasp knows where to find files:
```json
{
  "scriptId": "<your-script-id>",
  "rootDir": "src"
}
```

**Step 2: Create `src/appsscript.json`**

```json
{
  "timeZone": "America/New_York",
  "dependencies": {
    "enabledAdvancedServices": [
      {
        "userSymbol": "Calendar",
        "serviceId": "calendar",
        "version": "v3"
      }
    ]
  },
  "webapp": {
    "executeAs": "USER_DEPLOYING",
    "access": "DOMAIN"
  },
  "exceptionLogging": "STACKDRIVER",
  "runtimeVersion": "V8"
}
```

Note: `"access": "DOMAIN"` restricts to your Google Workspace domain. Change to `"ANYONE_WITH_GOOGLE_ACCOUNT"` if your team uses personal Gmail accounts.

**Step 3: Create stub files**

Create each of the following with just a comment so clasp can push them:

`src/Code.gs`:
```javascript
// Main entry point
```

`src/Utilities.gs`:
```javascript
// Utility helpers
```

`src/Extraction.gs`:
```javascript
// Claude API extraction
```

`src/DriveService.gs`:
```javascript
// Google Drive image upload
```

`src/CalendarService.gs`:
```javascript
// Google Calendar operations
```

`src/Index.html`:
```html
<!DOCTYPE html>
<html><body><p>Coming soon</p></body></html>
```

**Step 4: Create `.claspignore`**

```
docs/**
*.md
.git/**
node_modules/**
```

**Step 5: Push to GAS**

```bash
clasp push
```

Expected output: `Pushed N files.`

Then open the script in the browser to verify files appeared:
```bash
clasp open
```

**Step 6: Set Script Properties**

In the Apps Script editor: **Project Settings** (gear icon) → **Script Properties** → Add:

| Property | Value |
|---|---|
| `CLAUDE_API_KEY` | your Anthropic API key |
| `CALENDAR_ID` | `c_c4e31b92f471a556930f0ea1bfb3d5881e7a190610b84278ab4bbb8883b9342e@group.calendar.google.com` |
| `DRIVE_FOLDER_ID` | `1C2HvHGoj9POvH4Wduc_Pqx4waKspIBj9` |

**Step 7: Commit**

```bash
cd /Users/mike/projects/event-automation
git add src/ .claspignore
git commit -m "feat: scaffold GAS project with clasp"
```

---

## Task 2: Utility Helpers

**Files:**
- Modify: `src/Utilities.gs`

**Step 1: Write the test function first**

Replace `src/Utilities.gs` with:

```javascript
function test_utilities() {
  const cases = [
    { input: ['Hello World!', '2026-04-15'], expected: '2026-04-15_Hello-World' },
    { input: ['Café & Co.', '2026-01-01'], expected: '2026-01-01_Cafe-Co' },
    { input: ['  Spaces  ', '2026-06-30'], expected: '2026-06-30_Spaces' },
  ];

  cases.forEach(({ input, expected }) => {
    const result = buildFilename(input[0], input[1]);
    if (result !== expected) {
      throw new Error(`buildFilename('${input[0]}', '${input[1]}') → '${result}', expected '${expected}'`);
    }
  });

  Logger.log('test_utilities: ALL PASSED');
}

function buildFilename(title, date) {
  // TODO
}

function slugify(text) {
  // TODO
}
```

**Step 2: Run test to verify it fails**

In the Apps Script editor: select `test_utilities` → Run.
Expected in Execution log: `Error: buildFilename(...) → 'undefined', expected '...'`

**Step 3: Implement the helpers**

```javascript
/**
 * Builds a Drive filename: YYYY-MM-DD_Slugified-Title
 * @param {string} title - Event title
 * @param {string} date  - ISO date string YYYY-MM-DD
 * @returns {string}
 */
function buildFilename(title, date) {
  return date + '_' + slugify(title);
}

/**
 * Converts a string to a URL-safe slug (hyphens, no special chars).
 * Handles basic accented characters.
 * @param {string} text
 * @returns {string}
 */
function slugify(text) {
  return text
    .normalize('NFD')                     // decompose accented chars
    .replace(/[\u0300-\u036f]/g, '')      // strip accent marks
    .replace(/[^a-zA-Z0-9\s-]/g, '')     // remove special chars
    .trim()
    .replace(/\s+/g, '-');               // spaces to hyphens
}
```

**Step 4: Push and run test**

```bash
clasp push
```

In editor: select `test_utilities` → Run.
Expected: `test_utilities: ALL PASSED`

**Step 5: Commit**

```bash
git add src/Utilities.gs
git commit -m "feat: add buildFilename and slugify utilities"
```

---

## Task 3: Claude Extraction

**Files:**
- Modify: `src/Extraction.gs`

**Step 1: Write test function**

```javascript
function test_parseClaudeResponse() {
  const validJson = JSON.stringify({
    title: 'Test Event',
    date: '2026-04-15',
    start_time: '19:00',
    end_time: '21:00',
    end_time_note: null,
    location: '123 Main St',
    description: 'A great event.',
    image_url: 'https://example.com/image.jpg',
    source_link_label: 'RSVP on Meetup'
  });

  const result = parseClaudeResponse_(validJson);
  if (result.title !== 'Test Event') throw new Error('title mismatch');
  if (result.source_link_label !== 'RSVP on Meetup') throw new Error('label mismatch');

  // Test malformed JSON triggers retry flag
  const bad = parseClaudeResponse_('not json at all');
  if (bad !== null) throw new Error('expected null for bad JSON');

  Logger.log('test_parseClaudeResponse: ALL PASSED');
}
```

**Step 2: Run test to verify it fails**

Select `test_parseClaudeResponse` → Run.
Expected: `ReferenceError: parseClaudeResponse_ is not defined`

**Step 3: Implement extraction**

```javascript
var CLAUDE_MODEL = 'claude-sonnet-4-6';
var CLAUDE_API_URL = 'https://api.anthropic.com/v1/messages';

var EXTRACTION_PROMPT = `You are extracting event details from a webpage. Return ONLY valid JSON with these exact fields:

{
  "title": "Event title (string, required)",
  "date": "YYYY-MM-DD (string, required)",
  "start_time": "HH:MM in 24h format (string, required)",
  "end_time": "HH:MM in 24h format, or null if unknown (string|null)",
  "end_time_note": "Explain your best guess for end time, or null if end time was explicit (string|null)",
  "location": "Full location string, or null (string|null)",
  "description": "Event description as HTML, preserving bold/italic/links/lists from the source page. Use only: <b>, <i>, <ul>, <li>, <a href>, <br>. Strip all other tags. Or null if no description. (string|null)",
  "image_url": "Direct URL to the main event image, or null (string|null)",
  "source_link_label": "One of: 'RSVP on Meetup', 'RSVP on Luma', 'RSVP on Eventbrite', 'RSVP on Facebook', or 'See Website for details' (string)"
}

Rules:
- Return ONLY the JSON object. No markdown, no explanation.
- For end_time: if not explicitly stated, make a best guess from context (e.g. 'networking dinner' → 2-3 hours, 'workshop' → 3 hours, 'coffee meetup' → 1.5 hours). Always set end_time_note when guessing.
- For source_link_label: infer from the URL domain if possible.
- For description: preserve bold/italic/links/lists using only <b>, <i>, <ul>, <li>, <a href>, <br>. Strip all other HTML tags.
- Dates must be YYYY-MM-DD. Times must be HH:MM (24h).`;

/**
 * Fetches a URL and extracts event data using Claude.
 * Retries once with a stricter prompt if JSON parsing fails.
 * @param {string} url - The event page URL
 * @returns {{data: Object}|{error: string}}
 */
function extractEventData(url) {
  var html;
  try {
    var response = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
    var code = response.getResponseCode();
    if (code !== 200) {
      return { error: 'Could not fetch the page (HTTP ' + code + '). It may be behind a login or paywall.' };
    }
    html = response.getContentText();
  } catch (e) {
    return { error: 'Could not reach the URL: ' + e.message };
  }

  // Strip script/style tags to reduce token usage
  var cleaned = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .substring(0, 30000); // cap at ~30k chars

  var result = callClaude_(cleaned, false);
  if (result === null) {
    // Retry with stricter prompt
    result = callClaude_(cleaned, true);
  }
  if (result === null) {
    return { error: 'Could not extract event data from this page. Please try a different URL or fill in the fields manually.' };
  }
  return { data: result };
}

/**
 * Calls Claude API and returns parsed JSON, or null on failure.
 * @param {string} htmlContent
 * @param {boolean} strict - Use stricter retry prompt
 * @returns {Object|null}
 */
function callClaude_(htmlContent, strict) {
  var apiKey = PropertiesService.getScriptProperties().getProperty('CLAUDE_API_KEY');
  var systemPrompt = strict
    ? EXTRACTION_PROMPT + '\n\nCRITICAL: Your previous response was not valid JSON. Return ONLY the raw JSON object starting with { and ending with }. Absolutely no other text.'
    : EXTRACTION_PROMPT;

  var payload = {
    model: CLAUDE_MODEL,
    max_tokens: 1024,
    system: systemPrompt,
    messages: [{ role: 'user', content: 'Extract event details from this HTML:\n\n' + htmlContent }]
  };

  try {
    var response = UrlFetchApp.fetch(CLAUDE_API_URL, {
      method: 'post',
      contentType: 'application/json',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    });

    var body = JSON.parse(response.getContentText());
    if (!body.content || !body.content[0]) return null;
    return parseClaudeResponse_(body.content[0].text);
  } catch (e) {
    Logger.log('Claude API error: ' + e.message);
    return null;
  }
}

/**
 * Parses Claude's text response as JSON.
 * @param {string} text
 * @returns {Object|null}
 */
function parseClaudeResponse_(text) {
  try {
    // Extract JSON object if wrapped in extra text
    var match = text.match(/\{[\s\S]*\}/);
    if (!match) return null;
    return JSON.parse(match[0]);
  } catch (e) {
    return null;
  }
}
```

**Step 4: Push and run test**

```bash
clasp push
```

Select `test_parseClaudeResponse` → Run.
Expected: `test_parseClaudeResponse: ALL PASSED`

**Step 5: Write live extraction test (optional but recommended)**

Add this test to run against a real event URL:
```javascript
function test_extractEventData_live() {
  // Replace with a real public event URL for testing
  var url = 'https://lu.ma/some-event';
  var result = extractEventData(url);
  Logger.log(JSON.stringify(result, null, 2));
  // Manually inspect output in Execution log
}
```

Run it and inspect the log to verify fields are extracted correctly.

**Step 6: Commit**

```bash
git add src/Extraction.gs
git commit -m "feat: add Claude extraction with retry logic"
```

---

## Task 4: Drive Image Upload

**Files:**
- Modify: `src/DriveService.gs`

**Step 1: Write test function**

```javascript
function test_saveImageToDrive() {
  // Uses a small, stable public image for testing
  var testUrl = 'https://www.google.com/images/branding/googlelogo/2x/googlelogo_color_272x92dp.png';
  var result = saveImageToDrive(testUrl, 'Test Event', '2026-04-15');

  if (!result.fileId) throw new Error('No fileId returned');
  if (result.fileName !== '2026-04-15_Test-Event.png') {
    throw new Error('Unexpected filename: ' + result.fileName);
  }

  // Clean up: delete the test file
  DriveApp.getFileById(result.fileId).setTrashed(true);
  Logger.log('test_saveImageToDrive: ALL PASSED');
}
```

**Step 2: Run test to verify it fails**

Select `test_saveImageToDrive` → Run.
Expected: `ReferenceError: saveImageToDrive is not defined`

**Step 3: Implement Drive upload**

```javascript
/**
 * Downloads an image from a URL and saves it to the configured Drive folder.
 * @param {string} imageUrl - Direct URL to the image
 * @param {string} eventTitle - Used to build the filename
 * @param {string} eventDate  - YYYY-MM-DD, used to build the filename
 * @returns {{fileId: string, fileName: string, fileUrl: string}|{error: string}}
 */
function saveImageToDrive(imageUrl, eventTitle, eventDate) {
  var folderId = PropertiesService.getScriptProperties().getProperty('DRIVE_FOLDER_ID');

  try {
    var response = UrlFetchApp.fetch(imageUrl, { muteHttpExceptions: true });
    if (response.getResponseCode() !== 200) {
      return { error: 'Image URL returned HTTP ' + response.getResponseCode() };
    }

    var blob = response.getBlob();
    var mimeType = blob.getContentType() || 'image/jpeg';
    var ext = mimeType.split('/')[1] || 'jpg';
    // Normalize extension
    if (ext === 'jpeg') ext = 'jpg';

    var fileName = buildFilename(eventTitle, eventDate) + '.' + ext;
    blob.setName(fileName);

    var folder = DriveApp.getFolderById(folderId);
    var file = folder.createFile(blob);

    return {
      fileId: file.getId(),
      fileName: file.getName(),
      fileUrl: file.getUrl()
    };
  } catch (e) {
    return { error: 'Failed to save image: ' + e.message };
  }
}
```

**Step 4: Push and run test**

```bash
clasp push
```

Select `test_saveImageToDrive` → Run.
Expected: `test_saveImageToDrive: ALL PASSED`
Also verify in Drive that the test file was created then trashed.

**Step 5: Commit**

```bash
git add src/DriveService.gs
git commit -m "feat: add Drive image upload with filename formatting"
```

---

## Task 5: Calendar Event Creation + Attachment

**Files:**
- Modify: `src/CalendarService.gs`

**Step 1: Write test functions**

```javascript
function test_createAndDeleteEvent() {
  var eventData = {
    title: '[TEST] Event Automation Test',
    date: '2026-04-15',
    start_time: '19:00',
    end_time: '21:00',
    location: '123 Test St',
    description: 'Test description.\n\nRSVP on Meetup: https://meetup.com/test'
  };

  var result = createCalendarEvent(eventData);
  if (!result.eventId) throw new Error('No eventId returned: ' + JSON.stringify(result));

  // Clean up
  var cal = CalendarApp.getCalendarById(
    PropertiesService.getScriptProperties().getProperty('CALENDAR_ID')
  );
  cal.getEventById(result.eventId).deleteEvent();

  Logger.log('test_createAndDeleteEvent: ALL PASSED');
}

function test_duplicateDetection() {
  // Create an event, then check duplicate detection finds it, then clean up
  var eventData = {
    title: '[TEST] Duplicate Check',
    date: '2026-04-15',
    start_time: '19:00',
    end_time: '21:00',
    location: '',
    description: 'Test'
  };

  var created = createCalendarEvent(eventData);
  var isDuplicate = isDuplicateEvent('[TEST] Duplicate Check', '2026-04-15');
  
  // Clean up
  var cal = CalendarApp.getCalendarById(
    PropertiesService.getScriptProperties().getProperty('CALENDAR_ID')
  );
  cal.getEventById(created.eventId).deleteEvent();

  if (!isDuplicate) throw new Error('Expected duplicate to be detected');
  Logger.log('test_duplicateDetection: ALL PASSED');
}
```

**Step 2: Run tests to verify they fail**

Select `test_createAndDeleteEvent` → Run.
Expected: `ReferenceError: createCalendarEvent is not defined`

**Step 3: Implement Calendar service**

```javascript
/**
 * Creates a Google Calendar event.
 * @param {Object} eventData - Fields: title, date, start_time, end_time, location, description
 * @returns {{eventId: string, eventUrl: string}|{error: string}}
 */
function createCalendarEvent(eventData) {
  try {
    var calendarId = PropertiesService.getScriptProperties().getProperty('CALENDAR_ID');
    var cal = CalendarApp.getCalendarById(calendarId);
    if (!cal) return { error: 'Calendar not found. Check CALENDAR_ID script property.' };

    var startDate = parseDateTimeToDate_(eventData.date, eventData.start_time);
    var endDate = parseDateTimeToDate_(eventData.date, eventData.end_time || eventData.start_time);
    // If end == start (no end time given), default to +2 hours
    if (endDate <= startDate) {
      endDate = new Date(startDate.getTime() + 2 * 60 * 60 * 1000);
    }

    var options = { description: eventData.description || '' };
    if (eventData.location) options.location = eventData.location;

    var event = cal.createEvent(eventData.title, startDate, endDate, options);
    return {
      eventId: event.getId(),
      eventUrl: 'https://calendar.google.com/calendar/event?eid=' + 
                Utilities.base64Encode(event.getId())
    };
  } catch (e) {
    return { error: 'Failed to create calendar event: ' + e.message };
  }
}

/**
 * Attaches a Drive file to a Calendar event using the Advanced Calendar Service.
 * @param {string} eventId  - Calendar event ID
 * @param {string} fileId   - Drive file ID
 * @param {string} fileName - Display name for the attachment
 * @returns {{success: boolean}|{error: string}}
 */
function attachFileToCalendarEvent(eventId, fileId, fileName) {
  try {
    var calendarId = PropertiesService.getScriptProperties().getProperty('CALENDAR_ID');
    var file = DriveApp.getFileById(fileId);

    Calendar.Events.patch(
      {
        attachments: [{
          fileUrl: 'https://drive.google.com/open?id=' + fileId,
          mimeType: file.getMimeType(),
          title: fileName
        }]
      },
      calendarId,
      eventId,
      { supportsAttachments: true }
    );
    return { success: true };
  } catch (e) {
    return { error: 'Could not attach image to calendar event: ' + e.message };
  }
}

/**
 * Checks if an event with the same title already exists on the given date.
 * @param {string} title
 * @param {string} date - YYYY-MM-DD
 * @returns {boolean}
 */
function isDuplicateEvent(title, date) {
  try {
    var calendarId = PropertiesService.getScriptProperties().getProperty('CALENDAR_ID');
    var cal = CalendarApp.getCalendarById(calendarId);
    var start = new Date(date + 'T00:00:00');
    var end = new Date(date + 'T23:59:59');
    var events = cal.getEvents(start, end);
    var lowerTitle = title.toLowerCase();
    return events.some(function(e) {
      return e.getTitle().toLowerCase() === lowerTitle;
    });
  } catch (e) {
    return false; // Don't block on duplicate check failure
  }
}

/**
 * Parses YYYY-MM-DD and HH:MM into a JS Date.
 * @param {string} date - YYYY-MM-DD
 * @param {string} time - HH:MM (24h)
 * @returns {Date}
 */
function parseDateTimeToDate_(date, time) {
  var parts = time.split(':');
  var d = new Date(date + 'T00:00:00');
  d.setHours(parseInt(parts[0], 10));
  d.setMinutes(parseInt(parts[1], 10));
  return d;
}
```

**Step 4: Push and run tests**

```bash
clasp push
```

Run `test_createAndDeleteEvent` → Expected: `ALL PASSED`
Run `test_duplicateDetection` → Expected: `ALL PASSED`

Check your Google Calendar to confirm the test event was created and then deleted.

**Step 5: Commit**

```bash
git add src/CalendarService.gs
git commit -m "feat: add calendar event creation, attachment, and duplicate detection"
```

---

## Task 6: Main Orchestrator

**Files:**
- Modify: `src/Code.gs`

**Step 1: Write test for orchestrator**

```javascript
function test_processEventUrl_badUrl() {
  var result = processEventUrl('https://this-domain-definitely-does-not-exist-xyz.com/event');
  if (!result.error) throw new Error('Expected error for unreachable URL');
  Logger.log('test_processEventUrl_badUrl: PASSED — ' + result.error);
}
```

**Step 2: Run test to verify it fails**

Select `test_processEventUrl_badUrl` → Run.
Expected: `ReferenceError: processEventUrl is not defined`

**Step 3: Implement the orchestrator**

Replace `src/Code.gs` with:

```javascript
/**
 * GAS Web App entry point — serves the HTML UI.
 */
function doGet() {
  return HtmlService.createHtmlOutputFromFile('Index')
    .setTitle('Event Automation')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/**
 * Called by the UI: fetches a URL and returns extracted event data for preview.
 * @param {string} url
 * @returns {{data: Object}|{error: string}}
 */
function processEventUrl(url) {
  if (!url || !url.startsWith('http')) {
    return { error: 'Please enter a valid URL starting with http.' };
  }
  return extractEventData(url);
}

/**
 * Called by the UI after the user confirms: creates Drive file, Calendar event, attaches image.
 * @param {Object} eventData - Confirmed, user-edited event fields + imageUrl + sourceUrl
 * @returns {{success: true, calendarUrl: string, driveUrl: string}|{error: string, partial: Object}}
 */
function submitEvent(eventData) {
  var driveResult = null;
  var calResult = null;

  // 1. Check for duplicates
  var duplicate = isDuplicateEvent(eventData.title, eventData.date);

  // 2. Save image to Drive (non-blocking)
  if (eventData.image_url) {
    driveResult = saveImageToDrive(eventData.image_url, eventData.title, eventData.date);
    if (driveResult.error) {
      driveResult = null; // Continue without image
    }
  }

  // 3. Build full description with source link appended
  var fullDescription = (eventData.description || '').trim();
  if (eventData.source_link_label && eventData.source_url) {
    fullDescription += '\n\n' + eventData.source_link_label + ': ' + eventData.source_url;
  }

  // 4. Create Calendar event
  calResult = createCalendarEvent({
    title: eventData.title,
    date: eventData.date,
    start_time: eventData.start_time,
    end_time: eventData.end_time,
    location: eventData.location,
    description: fullDescription
  });

  if (calResult.error) {
    return {
      error: calResult.error,
      partial: driveResult ? { driveUrl: driveResult.fileUrl } : null
    };
  }

  // 5. Attach Drive image to Calendar event
  var attachResult = null;
  if (driveResult) {
    attachResult = attachFileToCalendarEvent(
      calResult.eventId,
      driveResult.fileId,
      driveResult.fileName
    );
  }

  return {
    success: true,
    duplicate: duplicate,
    calendarUrl: calResult.eventUrl,
    driveUrl: driveResult ? driveResult.fileUrl : null,
    attachmentWarning: (driveResult && attachResult && attachResult.error) ? attachResult.error : null
  };
}
```

**Step 4: Push and run test**

```bash
clasp push
```

Select `test_processEventUrl_badUrl` → Run.
Expected: `PASSED — Could not reach the URL: ...`

**Step 5: Commit**

```bash
git add src/Code.gs
git commit -m "feat: add orchestrator with processEventUrl and submitEvent"
```

---

## Task 7: Web App UI

**Files:**
- Modify: `src/Index.html`

**Step 1: Implement the full UI**

Replace `src/Index.html` with the complete UI. This is mobile-first and handles all states:

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Event Automation</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f5f5f5; color: #333; padding: 16px; }
    h1 { font-size: 1.3rem; margin-bottom: 16px; color: #1a73e8; }
    .card { background: white; border-radius: 8px; padding: 16px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); margin-bottom: 16px; }
    label { display: block; font-size: 0.85rem; font-weight: 600; margin-bottom: 4px; color: #555; }
    input, textarea { width: 100%; border: 1px solid #ddd; border-radius: 4px; padding: 8px; font-size: 0.95rem; }
    textarea { min-height: 100px; resize: vertical; }
    button { width: 100%; padding: 12px; border: none; border-radius: 6px; font-size: 1rem; font-weight: 600; cursor: pointer; margin-top: 8px; }
    .btn-primary { background: #1a73e8; color: white; }
    .btn-primary:disabled { background: #aaa; cursor: not-allowed; }
    .btn-success { background: #34a853; color: white; }
    .status { padding: 10px; border-radius: 4px; margin-bottom: 12px; font-size: 0.9rem; }
    .status.info { background: #e8f0fe; color: #1a73e8; }
    .status.warn { background: #fef7e0; color: #b06000; border: 1px solid #f9c840; }
    .status.error { background: #fce8e6; color: #c5221f; }
    .status.success { background: #e6f4ea; color: #137333; }
    .field-group { margin-bottom: 12px; }
    .warning-note { font-size: 0.8rem; color: #b06000; margin-top: 4px; }
    #url-section, #confirm-section, #result-section { display: none; }
    #url-section { display: block; }
    .field-row { display: flex; gap: 8px; }
    .field-row .field-group { flex: 1; }
    a.link-btn { display: block; text-align: center; padding: 10px; border-radius: 6px; background: #e8f0fe; color: #1a73e8; text-decoration: none; font-weight: 600; margin-top: 8px; }
  </style>
</head>
<body>
  <h1>Event Automation</h1>

  <!-- Step 1: URL Input -->
  <div id="url-section" class="card">
    <div class="field-group">
      <label for="url-input">Event Page URL</label>
      <input type="url" id="url-input" placeholder="https://..." autocomplete="off">
    </div>
    <div id="url-status"></div>
    <button class="btn-primary" id="extract-btn" onclick="extractEvent()">Extract Event Info</button>
  </div>

  <!-- Step 2: Confirmation Form -->
  <div id="confirm-section">
    <div id="confirm-status"></div>
    <div class="card">
      <div class="field-group">
        <label for="f-title">Title *</label>
        <input type="text" id="f-title">
      </div>
      <div class="field-row">
        <div class="field-group">
          <label for="f-date">Date *</label>
          <input type="date" id="f-date">
        </div>
      </div>
      <div class="field-row">
        <div class="field-group">
          <label for="f-start">Start Time *</label>
          <input type="time" id="f-start">
        </div>
        <div class="field-group">
          <label for="f-end">End Time</label>
          <input type="time" id="f-end">
          <div id="end-time-note" class="warning-note"></div>
        </div>
      </div>
      <div class="field-group">
        <label for="f-location">Location</label>
        <input type="text" id="f-location">
      </div>
      <div class="field-group">
        <label for="f-description">Description</label>
        <textarea id="f-description"></textarea>
      </div>
      <div class="field-group">
        <label for="f-link-label">Source Link Label</label>
        <input type="text" id="f-link-label">
      </div>
      <div class="field-group">
        <label for="f-image-url">Image URL</label>
        <input type="url" id="f-image-url">
      </div>
      <div id="submit-status"></div>
      <button class="btn-success" id="submit-btn" onclick="submitEvent()">Create Calendar Event</button>
      <button class="btn-primary" style="background:#888;margin-top:8px" onclick="reset()">Start Over</button>
    </div>
  </div>

  <!-- Step 3: Result -->
  <div id="result-section" class="card">
    <div id="result-status"></div>
    <div id="result-links"></div>
    <button class="btn-primary" style="margin-top:12px" onclick="reset()">Add Another Event</button>
  </div>

  <script>
    var sourceUrl = '';

    function setStatus(elId, type, msg) {
      var el = document.getElementById(elId);
      el.className = 'status ' + type;
      el.textContent = msg;
    }
    function clearStatus(elId) {
      var el = document.getElementById(elId);
      el.className = '';
      el.textContent = '';
    }
    function show(id) { document.getElementById(id).style.display = 'block'; }
    function hide(id) { document.getElementById(id).style.display = 'none'; }

    function extractEvent() {
      var url = document.getElementById('url-input').value.trim();
      if (!url) { setStatus('url-status', 'error', 'Please enter a URL.'); return; }

      sourceUrl = url;
      document.getElementById('extract-btn').disabled = true;
      setStatus('url-status', 'info', 'Fetching page and extracting event info...');

      google.script.run
        .withSuccessHandler(function(result) {
          document.getElementById('extract-btn').disabled = false;
          if (result.error) {
            setStatus('url-status', 'error', result.error);
            return;
          }
          populateForm(result.data);
        })
        .withFailureHandler(function(err) {
          document.getElementById('extract-btn').disabled = false;
          setStatus('url-status', 'error', 'Unexpected error: ' + err.message);
        })
        .processEventUrl(url);
    }

    function populateForm(data) {
      document.getElementById('f-title').value = data.title || '';
      document.getElementById('f-date').value = data.date || '';
      document.getElementById('f-start').value = data.start_time || '';
      document.getElementById('f-end').value = data.end_time || '';
      document.getElementById('f-location').value = data.location || '';
      document.getElementById('f-description').value = data.description || '';
      document.getElementById('f-link-label').value = data.source_link_label || 'See Website for details';
      document.getElementById('f-image-url').value = data.image_url || '';

      // Show end time note if guessed
      var noteEl = document.getElementById('end-time-note');
      noteEl.textContent = data.end_time_note ? '⚠ ' + data.end_time_note : '';

      // Show warnings for missing optional fields
      var warnings = [];
      if (!data.location) warnings.push('location');
      if (!data.description) warnings.push('description');
      if (!data.image_url) warnings.push('image URL');

      clearStatus('confirm-status');
      if (warnings.length) {
        setStatus('confirm-status', 'warn', 'Could not find: ' + warnings.join(', ') + '. You can fill these in manually.');
      }

      hide('url-section');
      show('confirm-section');
    }

    function submitEvent() {
      var title = document.getElementById('f-title').value.trim();
      var date = document.getElementById('f-date').value;
      var startTime = document.getElementById('f-start').value;

      if (!title || !date || !startTime) {
        setStatus('submit-status', 'error', 'Title, date, and start time are required.');
        return;
      }

      document.getElementById('submit-btn').disabled = true;
      setStatus('submit-status', 'info', 'Creating calendar event and saving image...');

      var eventData = {
        title: title,
        date: date,
        start_time: startTime,
        end_time: document.getElementById('f-end').value,
        location: document.getElementById('f-location').value.trim(),
        description: document.getElementById('f-description').value.trim(),
        source_link_label: document.getElementById('f-link-label').value.trim(),
        image_url: document.getElementById('f-image-url').value.trim(),
        source_url: sourceUrl
      };

      google.script.run
        .withSuccessHandler(function(result) {
          document.getElementById('submit-btn').disabled = false;
          if (result.error) {
            setStatus('submit-status', 'error', result.error +
              (result.partial && result.partial.driveUrl ? ' Image was saved: ' + result.partial.driveUrl : ''));
            return;
          }
          showResult(result);
        })
        .withFailureHandler(function(err) {
          document.getElementById('submit-btn').disabled = false;
          setStatus('submit-status', 'error', 'Unexpected error: ' + err.message);
        })
        .submitEvent(eventData);
    }

    function showResult(result) {
      hide('url-section');
      hide('confirm-section');
      show('result-section');

      var statusMsg = 'Event created successfully!';
      var statusType = 'success';

      if (result.duplicate) {
        statusMsg = 'Event created. Note: an event with this title already existed on this date.';
        statusType = 'warn';
      }
      if (result.attachmentWarning) {
        statusMsg += ' (Image saved to Drive but could not be attached: ' + result.attachmentWarning + ')';
        statusType = 'warn';
      }

      setStatus('result-status', statusType, statusMsg);

      var links = '';
      if (result.calendarUrl) {
        links += '<a class="link-btn" href="' + result.calendarUrl + '" target="_blank">View Calendar Event</a>';
      }
      if (result.driveUrl) {
        links += '<a class="link-btn" href="' + result.driveUrl + '" target="_blank">View Image in Drive</a>';
      }
      document.getElementById('result-links').innerHTML = links;
    }

    function reset() {
      document.getElementById('url-input').value = '';
      sourceUrl = '';
      clearStatus('url-status');
      hide('confirm-section');
      hide('result-section');
      show('url-section');
    }
  </script>
</body>
</html>
```

**Step 2: Push and test manually**

```bash
clasp push
```

In Apps Script editor: **Deploy → Test deployments → Open latest code**.
Test on desktop first, then on phone.

Walk through the full flow:
1. Paste a real public event URL
2. Verify extraction fields populate correctly
3. Edit a field to confirm editability
4. Submit and verify Calendar event + Drive image appear

**Step 3: Commit**

```bash
git add src/Index.html
git commit -m "feat: add mobile-friendly web app UI with confirmation form"
```

---

## Task 8: Production Deployment

**Step 1: Deploy as Web App**

In Apps Script editor: **Deploy → New deployment**
- Type: Web app
- Description: "Event Automation v1"
- Execute as: Me
- Who has access: (choose appropriate option — see appsscript.json note in Task 1)

Click **Deploy**. Copy the Web App URL.

**Step 2: Verify on phone**

Open the Web App URL in your phone browser. Complete the full flow with a real event URL.

**Step 3: Share URL with team**

The Web App URL is the only thing team members need. They must be signed into a Google account that has access.

**Step 4: Commit deployment note**

```bash
git commit --allow-empty -m "chore: deployed v1 as GAS Web App"
```

---

## Setup Cheat Sheet (for deployer)

```
1. npm install -g @google/clasp
2. clasp login
3. Enable Apps Script API: https://script.google.com/home/usersettings
4. cd event-automation && clasp push
5. In Apps Script editor → Project Settings → Script Properties:
   - CLAUDE_API_KEY = <your key>
   - CALENDAR_ID    = c_c4e31b92f471a556930f0ea1bfb3d5881e7a190610b84278ab4bbb8883b9342e@group.calendar.google.com
   - DRIVE_FOLDER_ID = 1C2HvHGoj9POvH4Wduc_Pqx4waKspIBj9
6. Enable Calendar Advanced Service in editor → Services → Google Calendar API v3
7. Deploy → New deployment → Web App
8. Share the URL
```
