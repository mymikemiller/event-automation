# Meetup New-Event Notifier — Design

**Date:** 2026-08-08
**Status:** Designed, not implemented. Both feeds below were fetched live on
2026-08-08 and every claim about their shape is from that data, not from
documentation.

---

## The problem

Meetup has no usable notification for "this group published a new event." Events
reach the Austin Vegan Association Google Calendar by hand, through the Event
Automation web app, which means noticing the new Meetup post in the first place
is a manual step that can be missed for days.

This adds an hourly job to the existing Apps Script project that watches a
hard-coded list of Meetup groups and emails `mike.miller@atxveg.org` when a
group has published an event that is not yet on the calendar.

Scope is Meetup only. The group list starts as `['vegaustin']` and is designed
to take more slugs without other changes.

---

## Where the data comes from

Meetup publishes a per-group iCal feed that needs no auth:

```
https://www.meetup.com/<slug>/events/ical/
```

Verified 2026-08-08: `200 text/calendar`, 7,919 bytes, 4 upcoming events. Each
`VEVENT` carries everything needed:

```
UID:event_315879117@meetup.com
DTSTART;TZID=America/Chicago:20260808T183000
SUMMARY:Vegan Potluck & VegFest Support Rally
URL;VALUE=URI:https://www.meetup.com/vegaustin/events/315879117/
```

This is chosen over the two alternatives on purpose:

- **HTML scraping + Claude extraction**, as `Extraction.gs` does for arbitrary
  event pages, would cost an API call per run and break whenever Meetup reskins
  the page. The feed is a stable contract.
- **The Meetup GraphQL API** needs OAuth client credentials and a token refresh
  path, for strictly less information than the feed already gives.

The feed lists upcoming events only, which is exactly the window of interest.

---

## Deciding whether an event is already on the calendar

### Primary: the Meetup event ID in the description

Calendar events created through the web app get a source link appended by
`submitEvent` in `Code.gs`, usually labelled *RSVP on Meetup*. That link is an
exact identity, far better than any title or time heuristic.

Of the 112 events on the calendar, 47 carry a `meetup.com` link and 44 of those
yield a clean numeric event ID.

The ID must be read from the **path segment**, anchored:

```js
/meetup\.com\/[^\/\s]+\/events\/(\d+)/i
```

This is not fussiness. A real entry on the calendar reads:

```
meetup.com/vegaustin/events/313891224/?slug=vegaustin&eventId=307154188&isFirstPublish=true
```

The query string carries a *different* `eventId` than the path. A bare `(\d+)`,
a "last number wins" rule, or a search for `eventId=` pairs the wrong events.

Anchoring on the path also collapses every URL variant observed in the real
data — with and without trailing slash, `?utm_*`, `?eventOrigin=`, `?recId=`,
`?_xtd=` — onto the same key. Meetup's `UID:event_<id>@meetup.com` yields the
same number, so both sides agree without normalisation.

Meetup event IDs are globally unique, not per-group, so this rule needs no
knowledge of which group an event came from.

### Fallback: exact title + exact start instant

The RSVP link is only *usually* present. Events added directly in Google
Calendar rather than through the web app may carry no link, and 3 of the 47
linked events yield no ID (one `/ls/click` tracking redirect, one group-level
`/events/` URL with no ID in it).

So an event counts as already-calendared if the ID matches **or** title and
start instant both match. All 4 currently-listed Meetup events match the
calendar on both rules simultaneously:

```
20260808T233000Z | Vegan Potluck & VegFest Support Rally
20260812T233000Z | Dinner at Bouldin Creek Cafe
20260823T220000Z | Dinner at Mission Burger Co. (NEW Mueller Location!)
20260830T173000Z | 🧘 August Afternoon Yoga 🧘
```

### Why `or` and not `and`

This is the one place the design picks a direction to fail in, so it is worth
stating explicitly.

Because notification is once-per-event-ever, a false positive costs exactly one
stray email. A false negative means a real event is never announced. `or`
suppresses more than `and`, which looks like the riskier choice.

It is not, because the fallback only fires when a calendar event has *both* the
byte-identical title *and* the identical start instant — which in practice means
it is the same event. The rule removes a class of stray emails at negligible
risk of hiding a real one.

The two unmatchable links stay unmatchable. Resolving the `/ls/click` redirect
would mean an HTTP fetch per calendar event per hour, to save one email once.

---

## Architecture

Two new files, following the `Tockify*` split already in `src/`:

| File | Responsibility |
|------|----------------|
| `MeetupService.gs` | Config; fetch a group's iCal feed; parse `VEVENT`s; extract an event ID from a URL. Pure apart from `UrlFetchApp`. |
| `MeetupJob.gs` | The hourly job: calendar lookup, matching, email, notified-state, trigger installer. |

Config sits at the top of `MeetupService.gs`, matching how `TockifyUtil.gs`
holds `TOCKIFY_CALID` and friends:

```js
var MEETUP_GROUPS = ['vegaustin'];
var MEETUP_NOTIFY_EMAIL = 'mike.miller@atxveg.org';
```

Adding a group is appending a slug.

### One run

1. For each slug, fetch and parse the feed into `{id, title, url, start, slug}`.
2. Load the notified-ID set from `ScriptProperties`.
3. Query Calendar once through the existing `CALENDAR_ID` property, `timeMin` =
   now, `timeMax` = latest Meetup start + 1 day. Build two indexes from the
   result: meetup IDs found in descriptions, and `title|startInstant` keys.
4. An event is **new** if its ID is absent from the notified set **and** it
   matches neither calendar index.
5. Email each new event, adding its ID to the notified set after each send.

The calendar is read through the Calendar API rather than its public `.ics`
because that is the auth path the rest of the project already uses, and it
allows bounding the query by date instead of pulling all 112 events.

---

## State and repeat suppression

Notified IDs live in one `ScriptProperties` key, `MEETUP_NOTIFIED_IDS`, as JSON,
loaded and saved through helpers mirroring `tockifyQueueLoad_`/`tockifyQueueSave_`.

**Pruning.** A single `ScriptProperties` value is capped at 9KB, roughly 800 IDs
— reachable in a few years of unbounded growth. The rule: keep only IDs still
present in the feed. Meetup does not reuse event IDs, so once an event drops out
of the upcoming feed it cannot return and its ID is dead weight. State stays
bounded by feed size, currently 4 entries.

**The guard that makes pruning safe.** Prune only after a fetch that both
succeeded and returned at least one event. If Meetup 500s or returns an empty
calendar and the job prunes regardless, the notified set is wiped and the next
successful run re-emails every upcoming event. On any fetch error, state is left
untouched.

With several groups, one group's failure must not prune another's IDs. Each
stored ID records its source slug, and the prune set is the union across groups
that fetched successfully; a group that errored keeps its IDs.

**First run is silent by construction.** All 4 current events already match the
calendar by ID, so they are matched rather than emailed. No seeding step is
required. `previewMeetupCheck()` runs the full pipeline and `Logger.log`s what it
*would* send while sending nothing, so this is verified before the trigger is
installed rather than assumed.

---

## Email

One message per new event.

- **Subject:** `[Event Automation] New Meetup event: <title>`
- **Body:** title, start time formatted for `America/Chicago`, canonical event
  URL, group slug, and a link to the Event Automation web app — the next action
  is always pasting that URL into it.

Recipient is `MEETUP_NOTIFY_EMAIL`. Note that `tockifyNotify_` uses
`Session.getEffectiveUser().getEmail()` because `getActiveUser()` returns `""`
inside a time-driven trigger; this job hard-codes the address instead, as
specified, which sidesteps the issue entirely.

An ID is added to the notified set **only after `MailApp.sendEmail` returns**.
Marking before sending would let a transient send failure suppress that event
permanently.

---

## Error handling

The failure that matters is the silent one: if Meetup moves the feed URL, a job
that only logs and returns leaves months of events unannounced while looking
healthy.

- **Feed fetch fails** (non-200 or exception) — email a notice, throttled to at
  most one per 24h per group via a timestamp property, so a sustained outage
  costs one email a day rather than 24.
- **Calendar read fails** — abort the run. Newness cannot be determined, so
  nothing is emailed and nothing is pruned. Same 24h-throttled notice.
- **Send fails** — leave the ID unnotified; the next run retries.

---

## Trigger

`installMeetupTrigger()`, mirroring `installTockifyTrigger()`: deletes any
existing trigger for the handler, then creates an hourly time-driven one. Safe
to re-run. Installed once from the editor, after `previewMeetupCheck()` has been
inspected.

---

## Testing

`tests/meetup.test.js`, run under the existing `tests/run.js` harness, which
loads pure `.gs` files into a `vm` sandbox. Feed parsing and ID extraction are
pure, so they are covered locally. Cases come from what the real data actually
contains:

- **iCal line unfolding.** Meetup folds long `DESCRIPTION` values onto
  continuation lines beginning with a space. A parser that reads line-by-line
  without unfolding truncates them.
- **Skipping `VTIMEZONE`.** That block contains its own `DTSTART` and `RRULE`
  values (`DTSTART:19700308T020000`). A naive scan for `DTSTART` across the
  whole file picks up 1970 dates and corrupts every event.
- **`DTSTART;TZID=…` parameters** — the property name carries parameters and
  cannot be matched as a bare `DTSTART:` prefix.
- **ID extraction** — path anchoring against the `?slug=…&eventId=…` trap;
  trailing slash; `utm_*`; `null` for `/ls/click` and for group-level `/events/`
  URLs.
- **Matching** — ID hit, title+start fallback hit, and neither.

Calendar reads, `MailApp`, and `ScriptProperties` stay editor-only tests, per
the harness's existing rule.

---

## Known limitation

The title+start fallback builds a `Date` from the feed's local time using the
script timezone, which `appsscript.json` sets to `America/Chicago` — the same
zone the `vegaustin` feed declares. That is correct for every group in Central
time.

A future group in another timezone would compute the wrong instant and silently
fall back to ID-only matching. Rather than build general timezone handling for a
case that does not exist yet, the parser asserts the feed's `TZID` and logs a
warning on mismatch. If a non-Central group is ever added, this is the thing to
fix.
