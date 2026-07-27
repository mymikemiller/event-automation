# Multi-Date Event Support Design
**Date:** 2026-07-27

## Overview

Some event pages describe one event that happens on several dates. The canonical
example is
[Vegan Book Club](https://www.meetup.com/vegan-adventure-club-austin-tx/events/315806303/),
which meets on Aug 10, 17, 24 and 31, 2026.

Today the app creates exactly one calendar event from the first date it finds, so
the other three dates are silently lost. This design adds multi-date support with
a strong preference for Google Calendar's **repeating** feature over duplicated
events, an explicit end to the series so only the stated dates are created, and
per-date times so a date that starts at a different hour is still correct.

---

## Goals

- Detect every date an event page states, not just the first.
- Create **one repeating** calendar event whenever the dates can be expressed as a
  recurrence. Duplicate events only as a failure fallback.
- Terminate the series exactly at the last stated date — never generate extra
  occurrences.
- Honor per-date start/end times when they differ between dates.
- Make the confirmation screen state plainly **which dates** will be created and
  **how** (repeating vs. duplicating), and let the user correct any of it.

## Non-goals

- Reading recurrence from Meetup's per-occurrence sibling event URLs. Meetup gives
  each occurrence in a series its own event ID; we work from the single pasted URL.
- Editing an already-created series. The app creates events; changes happen in
  Google Calendar.

---

## What the source pages actually expose

Investigated against the Meetup example:

- **JSON-LD exposes only the first occurrence.** The `FoodEvent` block gives
  `startDate: 2026-08-10T19:00:00-05:00` / `endDate: 2026-08-10T20:00:00-05:00`
  and nothing about the other three dates. The existing extraction pipeline treats
  JSON-LD as authoritative, which is exactly why the series is currently lost.
- **The recurrence exists only as prose.** Embedded page state carries
  `"series":{"__typename":"Series","description":"Every week on Monday until August 31, 2026"}`.
  There is no `RRULE` anywhere in the page.
- **The dates are also enumerated in the description body:**
  `8/10: Meeting One …`, `8/17: Meeting Two …`, `8/24: Meeting Three …`,
  `8/31: Meeting Four — Special Author Visit with Gena!`

So there is no machine-readable recurrence to parse. The extracted **list of
concrete dates** is the authoritative artifact, and any recurrence rule is
something we derive from that list — not something we read off the page.

---

## Architecture

```
[Event page]
     |
     |-- Extraction.gs: Claude returns occurrences[] (date + start + end each)
     v
[occurrences array]
     |
     |-- RecurrenceService.gs: planRecurrence_(occurrences, tz)
     |        → { method, summary, base, recurrence, exceptions, dates }
     |
     |-- Index.html calls it (debounced) to render the confirmation banner
     |
     |-- Code.gs submitEvent() calls it again, authoritatively, to create
     v
[CalendarService.gs]
     |
     |-- single  → Calendar.Events.insert, no recurrence   (today's path)
     |-- rrule   → insert with ["RRULE:FREQ=…;COUNT=n"]
     |-- rdate   → insert with ["RDATE;TZID=…:…"]
     |-- then patch instances listed in plan.exceptions
     |-- on insert failure → duplicate: N standalone events
```

`planRecurrence_` is a pure function and the single source of truth. The UI and
the writer both call it, so the banner can never describe something different
from what gets created.

---

## Extraction changes (`Extraction.gs`)

`EXTRACTION_PROMPT` gains one field:

```json
"occurrences": [
  { "date": "YYYY-MM-DD", "start_time": "HH:MM", "end_time": "HH:MM|null" }
]
```

Prompt rules added:

- Always return `occurrences` with at least one entry. An ordinary single-date
  event returns an array of one.
- Top-level `date` / `start_time` / `end_time` remain and mirror `occurrences[0]`,
  so nothing downstream breaks.
- Enumerate **every** date the page states. Do not extrapolate a recurrence string
  past the dates shown. Where a page gives both a rule and an explicit list, the
  list wins. This is what pins the end date correctly.
- If a recurrence is described in prose with a stated end (`"until August 31,
  2026"`) but the dates are not enumerated, expand the prose into explicit dates
  and stop at the stated end.
- Per-date times: if a specific date has a different time, put that date's real
  time on its row; otherwise repeat the common time on every row.
- Years: apply the existing "nearest future occurrence" rule to the first date,
  then keep dates monotonically increasing, so `12/20, 1/10` rolls into the next
  year.

**Meetup series string.** A new `extractMeetupSeries_(html)` pulls
`"series":{…"description":"…"}` out of the page state, mirroring how
`extractMeetupImage_` already recovers the full-size photo. It is prefixed into
the Claude payload as authoritative recurrence context. Without it, JSON-LD's
single `startDate` would keep producing a one-date event.

**Backward compatibility.** If Claude omits `occurrences`, `parseClaudeResponse_`
back-fills a one-element array from the top-level fields. A partial model response
degrades to today's behavior instead of crashing.

---

## The recurrence planner (`RecurrenceService.gs`, new)

`planRecurrence_(occurrences, tz)` returns:

```js
{
  method:     'single' | 'rrule' | 'rdate' | 'duplicate',
  summary:    'Repeating event — every week on Monday, 4 occurrences (Aug 10 – Aug 31).',
  base:       { date, start_time, end_time },   // DTSTART occurrence
  recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=4'] | ['RDATE;TZID=…:…'] | null,
  exceptions: [ { date, start_time, end_time } ],
  dates:      [ … ]                              // echoed for the UI
}
```

Steps:

1. **Normalize** — sort by date, drop duplicates, default a missing `end_time` to
   start + 2h via the existing `addHours_`.
2. **Single** — length 1 → `method: 'single'`, `recurrence: null`. Identical to
   today's code path, so ordinary events cannot regress.
3. **Modal time** — find the most common `start–end` pair. That pair defines the
   series time; occurrences differing from it become `exceptions`.
4. **Fit an RRULE** over the dates, tried in order:
   - `FREQ=DAILY;INTERVAL=g` — equal gaps under 7 days
   - `FREQ=WEEKLY;INTERVAL=g/7;BYDAY=<dow>` — equal gaps that are multiples of 7
   - `FREQ=MONTHLY;INTERVAL=k` — same day-of-month, equal month steps
   - `FREQ=MONTHLY;BYDAY=2TU`-style — same weekday at the same ordinal in month
5. **Verify by expansion** — expand the candidate rule and compare element-wise
   against the input dates. Accept only on an exact match.
6. **No fit** → `method: 'rdate'`.

### Two decisions worth recording

**`COUNT`, never `UNTIL`.** Every generated rule terminates with `COUNT=n`, where
n is the number of extracted dates. `COUNT` pins the series to exactly the dates
we found, with no ambiguity about how `UNTIL` is evaluated across DST boundaries
or timezone conversions. The UI can still say "ending Aug 31" — that is just the
last element of the list.

**Expansion verification is the safety net.** Pattern fitting is easy to get
subtly wrong. Jan 31 / Feb 28 / Mar 31 looks like monthly-by-day-of-month, but
Feb 31 does not exist and the rule would not reproduce the input. Because we only
accept a rule that expands back to exactly the input dates, a bad fit degrades to
an explicit `RDATE` list rather than writing wrong dates to the calendar.

**RFC 5545 note.** `DTSTART` is itself the first instance of a recurrence set, so
`RDATE` lists dates 2…n only, and `COUNT=n` yields n total instances rather than
n + 1.

---

## Calendar creation (`CalendarService.gs`)

`createCalendarEvent(eventData)` accepts the occurrences array and the plan.

- **`single`** — unchanged.
- **`rrule` / `rdate`** — one `Calendar.Events.insert` whose `start` / `end` are
  the base occurrence and whose `recurrence` is the planner's line. `timeZone`
  stays explicit so the API keeps handling DST.

**Patching exceptions.** When `plan.exceptions` is non-empty, call
`Calendar.Events.instances(calendarId, eventId)` bounded by the first and last
date, match each exception to the instance whose `originalStartTime` falls on that
date, and `Calendar.Events.patch` its `start` / `end`. A patch failure is
collected as a warning rather than aborting — the series already exists and is
correct apart from that one time.

**Attachment.** The flyer is attached once to the recurring master and inherited
by every instance. One Drive file instead of N, which is the main practical
payoff of preferring recurrence over duplication.

**Duplicate fallback.** If the recurring insert throws — a rejected `RDATE`, an
API error — catch it and create N standalone events sharing the same description
and the same attached Drive file, returning `method: 'duplicate'` and the reason.
This is the "you may duplicate" escape hatch, reached on failure rather than by
design.

**Duplicate detection.** `isDuplicateEvent` takes the full date list and returns
which dates already hold a same-titled event, so the result screen can report
"2 of 4 dates already had this event" instead of a bare boolean.

---

## Confirmation UI (`Index.html`)

The single Date field and the Start/End row are replaced by a **Dates** block. An
ordinary one-date event renders as a single row and reads much like today's form.

```
┌────────────────────────────────────────────┐
│ ↻ Repeating event — every week on Monday,  │
│   4 occurrences (Aug 10 – Aug 31).         │
│   Created as ONE repeating calendar event. │
│   1 date has a different time and will be  │
│   adjusted individually after creation.    │
└────────────────────────────────────────────┘
Dates
  [2026-08-10] [19:00] – [20:00]        ✕
  [2026-08-17] [19:00] – [20:00]        ✕
  [2026-08-24] [19:00] – [20:00]        ✕
  [2026-08-31] [18:00] – [20:00]  diff  ✕
  + Add date
```

- Any edit fires a 400 ms-debounced `google.script.run.planRecurrence(rows)`; the
  banner rerenders from the returned plan and shows a muted "checking…" state in
  between.
- The banner names both which dates and how: `rrule` → "one repeating event",
  `rdate` → "one repeating event with a custom date list", `single` → "single
  event", `duplicate` → "N separate events" with the reason.
- A row whose time differs from the series carries a small `diff` tag, so the
  exception behavior is visible rather than implied.
- `✕` is hidden when one row remains. `+ Add date` clones the last row, advancing
  by the current interval.
- The existing `end_time_note` warning renders under the first row.
- Client-side validation before submit: every row needs a date and a start time,
  and dates must be unique.

**The banner is a preview, never an input.** `submitEvent` re-runs
`planRecurrence_` server-side on the submitted rows and creates from that result,
so a stale or failed banner refresh cannot cause a wrong write.

---

## Error handling

| Failure | Behavior |
|---|---|
| Claude omits `occurrences` | Back-fill a one-element array from top-level fields |
| Claude returns a date in the past | Existing "nearest future occurrence" prompt rule applies to the first date |
| Rule fit does not expand back to the input dates | Fall through to `RDATE` |
| Recurring insert throws | Fall back to N duplicated events, report the reason |
| Instance patch fails | Warn on the result screen; series is kept |
| Some dates already have the event | Warn with the specific dates; do not block |

---

## Testing

Repo convention: `test_*` functions run from the Apps Script editor, throwing on
failure and logging `ALL PASSED`. The planner is pure, so most coverage costs
nothing and touches no API.

| Test | Asserts |
|---|---|
| `test_planRecurrence_single` | 1 occurrence → `single`, `recurrence: null` |
| `test_planRecurrence_weekly` | Aug 10/17/24/31 → `FREQ=WEEKLY;BYDAY=MO;COUNT=4`, no exceptions |
| `test_planRecurrence_weeklyTimeException` | Same dates, Aug 31 at 18:00 → `rrule` + exactly 1 exception |
| `test_planRecurrence_biweekly` | `INTERVAL=2` |
| `test_planRecurrence_daily` | `FREQ=DAILY` |
| `test_planRecurrence_monthlyByDate` | 15th across 3 months |
| `test_planRecurrence_monthlyByWeekday` | 2nd Tuesday → `BYDAY=2TU` |
| `test_planRecurrence_irregular` | → `rdate`; `RDATE` omits the first date |
| `test_planRecurrence_rejectsBadFit` | Jan 31 / Feb 28 / Mar 31 → forced to `rdate` |
| `test_planRecurrence_normalizes` | Unsorted and duplicate dates collapse correctly |
| `test_planRecurrence_neverUsesUntil` | No `UNTIL` in any generated rule |
| `test_parseOccurrences` | Response without `occurrences` back-fills one element |
| `test_extractMeetupSeries` | Series regex recovers the prose recurrence string |

Live tests that create and then delete real events:

- `test_createRecurringEvent_live` — `Calendar.Events.instances` returns exactly 4
  instances, on the expected dates.
- `test_createRecurringWithException_live` — the patched instance reads 18:00.

---

## Deployment

Unchanged: `./deploy.sh`, which redeploys the pinned deployment ID so the
bookmarked web app URL keeps working.
