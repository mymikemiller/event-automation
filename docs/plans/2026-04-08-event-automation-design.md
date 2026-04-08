# Event Automation Design
**Date:** 2026-04-08

## Overview

A Google Apps Script web app that lets non-technical users paste an event URL on their phone, uses Claude AI to extract event details, creates a Google Calendar event, saves the event image to Google Drive, and attaches the image to the calendar event — setting up a clean handoff for eventual Tockify automation.

---

## Goals

- Non-technical users can trigger the workflow from a phone browser
- AI intelligently extracts event fields from any event page
- Calendar event and Drive image are created and linked automatically
- All extracted fields are editable before submission
- Tockify image upload remains manual for now but is set up for future automation

---

## Architecture

```
[User on phone]
      |
      | pastes URL into GAS web app
      v
[Google Apps Script Web App]
      |
      |-- UrlFetchApp fetches the webpage HTML
      |
      |-- Calls Claude API with the HTML
      |       → extracts: title, date, start time, end time (best-guess),
      |                   location, description, image URL, source link label
      |
      |-- Shows confirmation screen (all fields editable)
      |       → user reviews, corrects if needed, clicks "Create Event"
      |
      |-- Saves image to Google Drive
      |       → folder: 1C2HvHGoj9POvH4Wduc_Pqx4waKspIBj9
      |       → filename: YYYY-MM-DD_Event-Title.jpg
      |
      |-- Creates event in Google Calendar
      |       → calendar: c_c4e31b92f471a556930f0ea1bfb3d5881e7a190610b84278ab4bbb8883b9342e@group.calendar.google.com
      |
      |-- Attaches Drive image to Calendar event
      |       → via Calendar Advanced Service (Events.patch with attachments)
      |
      v
[Confirmation: Calendar event link + Drive file link]
```

---

## Components

### 1. Web App UI

- Single HTML page served by Apps Script
- Shareable URL, works on any phone browser
- Restricted to authorized Google accounts
- **Input:** text field for event URL + "Extract" button
- **Confirmation screen:** all extracted fields shown as editable inputs
  - Title
  - Date
  - Start time
  - End time (with yellow warning if guessed)
  - Location
  - Full description (editable textarea)
  - Appended source link label + URL (editable)
  - Image URL (editable)
- **Live status:** "Fetching page… Extracting info… Creating event… Saving image…"
- **Final confirmation:** event summary, Calendar link, Drive file link

---

### 2. Claude Extraction

Claude receives the raw HTML and returns a structured JSON object.

| Field | Required | Behavior if missing |
|---|---|---|
| `title` | Yes | Block submission, show error |
| `date` | Yes | Block submission, show error |
| `start_time` | Yes | Block submission, show error |
| `end_time` | No | Best-guess from description; yellow warning shown |
| `end_time_note` | No | Explanation of guess shown to user |
| `location` | No | Yellow warning, proceed |
| `description` | No | Yellow warning, proceed. Returned as HTML (bold/italic/links/lists only). |
| `image_url` | No | Yellow warning, proceed |
| `source_link_label` | No | Defaults to "See Website for details" |

**Source link label examples:**
- Meetup URL → "RSVP on Meetup"
- Luma URL → "RSVP on Luma"
- Eventbrite URL → "RSVP on Eventbrite"
- Unknown → "See Website for details"

The source link is appended to the end of the description before saving:
```
Join us for an evening of...

RSVP on Meetup: https://meetup.com/...
```

If Claude returns malformed JSON, GAS retries once with a stricter prompt before surfacing an error to the user.

---

### 3. Google Calendar Integration

- Uses `CalendarApp` (built-in GAS service) for event creation
- Uses Calendar Advanced Service (`Calendar.Events.patch`) to attach the Drive image
- Calendar ID and other config stored as Script Properties (not hardcoded)
- **Duplicate check:** before creating, GAS checks for an existing event with the same title and date; warns user but allows override

**Calendar ID:**
```
c_c4e31b92f471a556930f0ea1bfb3d5881e7a190610b84278ab4bbb8883b9342e@group.calendar.google.com
```

---

### 4. Google Drive Integration

- Image fetched via `UrlFetchApp`, saved as a blob
- Target folder ID: `1C2HvHGoj9POvH4Wduc_Pqx4waKspIBj9`
- Filename format: `YYYY-MM-DD_Event-Title.jpg` (title slugified: spaces → hyphens, special chars stripped)
- After upload, file is attached to the Calendar event so event + image are co-located for future Tockify automation

---

## Error Handling

| Scenario | Behavior |
|---|---|
| Source URL unreachable / paywalled | Specific error message (not generic) |
| Claude returns malformed JSON | Retry once with stricter prompt, then error |
| Required field not found | Block submission, highlight missing fields |
| End time not found | Best-guess shown with yellow warning note |
| Image download fails | Non-blocking warning; event still created |
| Drive upload succeeds, Calendar attach fails | Warning with manual fallback links to both |
| Duplicate event detected | Warning shown; user can proceed anyway |

---

## Order of Operations (after user confirms)

1. Save image to Google Drive
2. Create Google Calendar event
3. Attach Drive image to Calendar event
4. Display confirmation with Calendar event link + Drive file link

---

## Setup Requirements (one-time, for deployer)

- Enable **Calendar Advanced Service** in Apps Script
- Set Script Properties:
  - `CLAUDE_API_KEY`
  - `CALENDAR_ID`
  - `DRIVE_FOLDER_ID`
- Deploy as a Web App with access restricted to specific Google accounts
- Share the web app URL with team members

---

## Future Work (out of scope for now)

- **Tockify automation:** A hosted Playwright service (Railway/Render) that logs into Tockify, finds the event (matched by title/date), and sets the image using the already-attached Drive file via Google Drive integration
- **Email trigger:** Automatically detect event URLs from incoming emails
