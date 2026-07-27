# Multi-Date (Repeating) Events Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** When an event page lists several dates, create **one repeating** Google Calendar event covering exactly those dates, with per-date times honored and a confirmation screen that states which dates will be created and how.

**Architecture:** Claude extraction returns an `occurrences[]` list. A new pure function `planRecurrence_()` derives a plan from that list — an `RRULE` when the dates fit a standard pattern, an `RDATE` list when they don't, `single` for one date. Occurrences whose time differs from the series are patched as individual instances after insert. The confirmation UI and the writer both call the same planner, so the banner can never disagree with what gets created.

**Tech Stack:** Google Apps Script (ES5-style `.gs`), Advanced Calendar Service, `clasp`, Claude API. Local unit tests run under Node 20 via a small `vm`-based runner.

---

## Conventions for every task

- Work on the existing `multi-date-events` branch. **No worktrees** — the user declined them.
- **Do not run `./deploy.sh`** until Task 18. `.clasp.json` pins one `scriptId`; pushing overwrites the live web app.
- Local tests: `node tests/run.js RecurrenceService.gs Utilities.gs`
- Every commit message ends with:
  ```
  Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
  ```
- `.gs` files are ES5-flavored. Use `var`, `function`, no arrow functions, no `const`/`let` in `src/*.gs` — match the surrounding code.
- Private helpers end with `_`. GAS will not expose a trailing-underscore function to `google.script.run`, so anything the UI calls must **not** have one.

---

## Task 1: Local test runner

Apps Script has no test runner — existing `test_*` functions are run by hand in the editor. The planner is pure, so we can get real red/green locally. This task is a prerequisite for every TDD step that follows.

**Files:**
- Create: `tests/run.js`
- Modify: `src/Utilities.gs`
- Modify: `src/CalendarService.gs:81-87`

**Step 1: Write the runner**

`tests/run.js` (repo root `tests/` is outside clasp's `rootDir: "src"`, so it is never pushed):

```js
#!/usr/bin/env node
// Runs Apps Script test_* functions locally under Node.
// Only load PURE .gs files here — anything touching Calendar/Drive/Properties
// must stay an editor-only test.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = path.join(__dirname, '..', 'src');
const files = process.argv.slice(2);
if (!files.length) {
  console.error('usage: node tests/run.js <File.gs> [File.gs ...]');
  process.exit(1);
}

const sandbox = {
  console,
  Logger: { log: function (m) { /* swallow; assertions throw */ } },
  Session: { getScriptTimeZone: function () { return 'America/Chicago'; } }
};
const context = vm.createContext(sandbox);

for (const f of files) {
  vm.runInContext(fs.readFileSync(path.join(SRC, f), 'utf8'), context, { filename: f });
}

const tests = Object.keys(context).filter(
  (k) => k.indexOf('test_') === 0 && typeof context[k] === 'function' && k.indexOf('_live') === -1
);

let pass = 0;
let fail = 0;
for (const name of tests) {
  try {
    context[name]();
    console.log('  PASS  ' + name);
    pass++;
  } catch (e) {
    console.log('  FAIL  ' + name + '\n        ' + e.message);
    fail++;
  }
}
console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
```

**Step 2: Move `addHours_` into Utilities.gs**

The planner needs it and it is a pure time helper that does not belong in `CalendarService.gs`. **Cut** this block from `src/CalendarService.gs` (currently lines 75-87, the jsdoc plus the function) and paste it at the end of `src/Utilities.gs` unchanged:

```js
/**
 * Adds hours to an HH:MM string, wrapping past midnight.
 * @param {string} timeStr - HH:MM
 * @param {number} hours
 * @returns {string} HH:MM
 */
function addHours_(timeStr, hours) {
  var parts = timeStr.split(':');
  var totalMinutes = parseInt(parts[0], 10) * 60 + parseInt(parts[1], 10) + hours * 60;
  var h = Math.floor(totalMinutes / 60) % 24;
  var m = totalMinutes % 60;
  return (h < 10 ? '0' : '') + h + ':' + (m < 10 ? '0' : '') + m;
}
```

GAS shares one global scope across files, so `CalendarService.gs` keeps working unchanged.

**Step 3: Verify the runner works against existing tests**

Run: `node tests/run.js Utilities.gs`
Expected: `PASS  test_utilities` and `1 passed, 0 failed`.

If it fails, the runner is wrong — fix it before continuing. This is the baseline.

**Step 4: Commit**

```bash
git add tests/run.js src/Utilities.gs src/CalendarService.gs
git commit -m "test: add local Node runner for pure .gs unit tests"
```

---

## Task 2: `normalizeOccurrences_`

**Files:**
- Create: `src/RecurrenceService.gs`

**Step 1: Write the failing test**

At the top of `src/RecurrenceService.gs`, matching the repo's convention of tests-first-in-file:

```js
function test_normalizeOccurrences() {
  // Sorts by date, drops duplicate dates, defaults a missing end to start + 2h.
  var out = normalizeOccurrences_([
    { date: '2026-08-17', start_time: '19:00', end_time: '20:00' },
    { date: '2026-08-10', start_time: '19:00', end_time: null },
    { date: '2026-08-17', start_time: '09:00', end_time: '10:00' },
    { date: 'garbage',    start_time: '19:00', end_time: '20:00' },
    { date: '2026-08-24', start_time: '19:00', end_time: '19:00' }
  ]);

  if (out.length !== 3) throw new Error('expected 3 occurrences, got ' + out.length);
  if (out[0].date !== '2026-08-10') throw new Error('not sorted: ' + out[0].date);
  if (out[0].end_time !== '21:00') throw new Error('null end should default to +2h, got ' + out[0].end_time);
  if (out[1].start_time !== '19:00') throw new Error('duplicate date should keep the first entry');
  if (out[2].end_time !== '21:00') throw new Error('end == start should default to +2h, got ' + out[2].end_time);

  Logger.log('test_normalizeOccurrences: ALL PASSED');
}
```

**Step 2: Run to verify it fails**

Run: `node tests/run.js RecurrenceService.gs Utilities.gs`
Expected: `FAIL test_normalizeOccurrences` with `normalizeOccurrences_ is not defined`.

**Step 3: Implement**

```js
/**
 * Cleans an occurrence list: drops malformed entries, dedupes by date,
 * sorts ascending, and fills a missing end time with start + 2h (matching
 * the long-standing single-event default).
 * @param {Array<{date:string,start_time:string,end_time:string|null}>} list
 * @returns {Array<{date:string,start_time:string,end_time:string}>}
 */
function normalizeOccurrences_(list) {
  var seen = {};
  var out = [];
  (list || []).forEach(function (o) {
    if (!o || !o.date || !o.start_time) return;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(o.date)) return;
    if (!/^\d{2}:\d{2}$/.test(o.start_time)) return;
    if (seen[o.date]) return;
    seen[o.date] = true;
    var end = (o.end_time && o.end_time !== o.start_time)
      ? o.end_time
      : addHours_(o.start_time, 2);
    out.push({ date: o.date, start_time: o.start_time, end_time: end });
  });
  out.sort(function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : 0; });
  return out;
}
```

**Step 4: Run to verify it passes**

Run: `node tests/run.js RecurrenceService.gs Utilities.gs`
Expected: `PASS test_normalizeOccurrences`.

**Step 5: Commit**

```bash
git add src/RecurrenceService.gs
git commit -m "feat: normalize occurrence lists for recurrence planning"
```

---

## Task 3: Date helpers

Pure calendar math, kept separate so the fitters stay readable. All arithmetic uses `Date.UTC` so DST can never shift a day.

**Files:**
- Modify: `src/RecurrenceService.gs`

**Step 1: Write the failing test**

```js
function test_dateHelpers() {
  if (daysBetween_('2026-08-10', '2026-08-17') !== 7) throw new Error('daysBetween_ weekly');
  if (daysBetween_('2026-03-07', '2026-03-09') !== 2) throw new Error('daysBetween_ across DST start');
  if (dowOf_('2026-08-10') !== 1) throw new Error('Aug 10 2026 should be Monday');
  if (ymd_(dateUtc_('2026-08-10') + 7 * 86400000) !== '2026-08-17') throw new Error('ymd_ roundtrip');
  if (monthIndex_('2026-01-01') !== monthIndex_('2025-12-01') + 1) throw new Error('monthIndex_ year wrap');
  if (ordinalInMonth_('2026-08-11') !== 2) throw new Error('Aug 11 is the 2nd Tuesday');
  if (exactDayOfMonth_(2026, 1, 31) !== null) throw new Error('Feb 31 must be null, not rolled over');
  if (nthWeekdayOfMonth_(2026, 7, 2, 2) !== '2026-08-11') throw new Error('2nd Tuesday of Aug 2026');
  Logger.log('test_dateHelpers: ALL PASSED');
}
```

**Step 2: Run to verify it fails**

Run: `node tests/run.js RecurrenceService.gs Utilities.gs`
Expected: `FAIL test_dateHelpers` — `daysBetween_ is not defined`.

**Step 3: Implement**

```js
var DOW_CODES = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
var MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                   'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
var DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function pad2_(n) { return (n < 10 ? '0' : '') + n; }

/** YYYY-MM-DD → UTC epoch ms at midnight. */
function dateUtc_(s) {
  var p = s.split('-');
  return Date.UTC(+p[0], +p[1] - 1, +p[2]);
}

/** UTC epoch ms → YYYY-MM-DD. */
function ymd_(ms) {
  var d = new Date(ms);
  return d.getUTCFullYear() + '-' + pad2_(d.getUTCMonth() + 1) + '-' + pad2_(d.getUTCDate());
}

function daysBetween_(a, b) { return Math.round((dateUtc_(b) - dateUtc_(a)) / 86400000); }
function dowOf_(s) { return new Date(dateUtc_(s)).getUTCDay(); }
function dayOfMonth_(s) { return +s.split('-')[2]; }

/** Absolute month number, so month deltas work across year boundaries. */
function monthIndex_(s) {
  var p = s.split('-');
  return (+p[0]) * 12 + (+p[1] - 1);
}

/** Which nth-weekday-of-month this date is (Aug 11 2026 → 2, the 2nd Tuesday). */
function ordinalInMonth_(s) { return Math.ceil(dayOfMonth_(s) / 7); }

/**
 * Builds YYYY-MM-DD, or null if that day does not exist in that month.
 * Guards the Feb-31 case: Date.UTC would silently roll into March.
 */
function exactDayOfMonth_(y, m, dom) {
  var d = new Date(Date.UTC(y, m, dom));
  if (d.getUTCMonth() !== ((m % 12) + 12) % 12) return null;
  return ymd_(d.getTime());
}

/** The ord-th `dow` of month m, or null if the month has no such day. */
function nthWeekdayOfMonth_(y, m, ord, dow) {
  var first = new Date(Date.UTC(y, m, 1)).getUTCDay();
  return exactDayOfMonth_(y, m, 1 + ((dow - first + 7) % 7) + (ord - 1) * 7);
}
```

**Step 4: Run to verify it passes**

Expected: `PASS test_dateHelpers`.

**Step 5: Commit**

```bash
git add src/RecurrenceService.gs
git commit -m "feat: add UTC-safe date helpers for recurrence fitting"
```

---

## Task 4: Modal time and exceptions

**Files:**
- Modify: `src/RecurrenceService.gs`

**Step 1: Write the failing test**

```js
function test_modalTime() {
  var occ = normalizeOccurrences_([
    { date: '2026-08-10', start_time: '19:00', end_time: '20:00' },
    { date: '2026-08-17', start_time: '19:00', end_time: '20:00' },
    { date: '2026-08-24', start_time: '19:00', end_time: '20:00' },
    { date: '2026-08-31', start_time: '18:00', end_time: '20:00' }
  ]);
  var t = modalTime_(occ);
  if (t.start_time !== '19:00' || t.end_time !== '20:00') {
    throw new Error('expected 19:00-20:00, got ' + t.start_time + '-' + t.end_time);
  }

  // A 2-2 tie resolves to the earliest date's time, so DTSTART stays predictable.
  var tie = modalTime_(normalizeOccurrences_([
    { date: '2026-08-10', start_time: '09:00', end_time: '10:00' },
    { date: '2026-08-11', start_time: '17:00', end_time: '18:00' },
    { date: '2026-08-12', start_time: '09:00', end_time: '10:00' },
    { date: '2026-08-13', start_time: '17:00', end_time: '18:00' }
  ]));
  if (tie.start_time !== '09:00') throw new Error('tie should pick earliest date, got ' + tie.start_time);

  Logger.log('test_modalTime: ALL PASSED');
}
```

**Step 2: Run to verify it fails** — `modalTime_ is not defined`.

**Step 3: Implement**

```js
/**
 * The most common start/end pair, which becomes the series time. Ties resolve
 * to the earliest date because `occ` is already sorted and we compare with a
 * strict `>`.
 * @param {Array} occ - normalized occurrences
 * @returns {{start_time:string, end_time:string}}
 */
function modalTime_(occ) {
  var counts = {};
  occ.forEach(function (o) {
    var k = o.start_time + '|' + o.end_time;
    counts[k] = (counts[k] || 0) + 1;
  });
  var best = occ[0];
  var bestN = 0;
  occ.forEach(function (o) {
    var n = counts[o.start_time + '|' + o.end_time];
    if (n > bestN) { bestN = n; best = o; }
  });
  return { start_time: best.start_time, end_time: best.end_time };
}
```

**Step 4: Run to verify it passes.**

**Step 5: Commit**

```bash
git add src/RecurrenceService.gs
git commit -m "feat: derive series time and per-date exceptions"
```

---

## Task 5: Daily and weekly rule fitting

**Files:**
- Modify: `src/RecurrenceService.gs`

**Step 1: Write the failing test**

```js
function test_fitDailyWeekly() {
  var weekly = fitRule_(['2026-08-10', '2026-08-17', '2026-08-24', '2026-08-31']);
  if (weekly !== 'RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=4') throw new Error('weekly: ' + weekly);

  var biweekly = fitRule_(['2026-08-10', '2026-08-24', '2026-09-07']);
  if (biweekly !== 'RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=MO;COUNT=3') throw new Error('biweekly: ' + biweekly);

  var daily = fitRule_(['2026-08-10', '2026-08-11', '2026-08-12']);
  if (daily !== 'RRULE:FREQ=DAILY;COUNT=3') throw new Error('daily: ' + daily);

  var everyOther = fitRule_(['2026-08-10', '2026-08-12', '2026-08-14']);
  if (everyOther !== 'RRULE:FREQ=DAILY;INTERVAL=2;COUNT=3') throw new Error('every other day: ' + everyOther);

  if (fitRule_(['2026-08-10', '2026-08-17', '2026-09-03']) !== null) throw new Error('irregular must not fit');

  Logger.log('test_fitDailyWeekly: ALL PASSED');
}
```

**Step 2: Run to verify it fails** — `fitRule_ is not defined`.

**Step 3: Implement**

```js
/**
 * Tries each supported pattern in order and returns an RRULE line, or null.
 * Callers MUST verify the result with expandRule_ before using it.
 * @param {Array<string>} dates - sorted YYYY-MM-DD, length >= 2
 * @returns {string|null}
 */
function fitRule_(dates) {
  return fitDaily_(dates) ||
         fitWeekly_(dates) ||
         fitMonthlyByDate_(dates) ||
         fitMonthlyByWeekday_(dates);
}

/** The common gap in days, or 0 if the gaps are not all equal. */
function equalGaps_(dates) {
  var g = daysBetween_(dates[0], dates[1]);
  if (g <= 0) return 0;
  for (var i = 1; i < dates.length - 1; i++) {
    if (daysBetween_(dates[i], dates[i + 1]) !== g) return 0;
  }
  return g;
}

function fitDaily_(dates) {
  var g = equalGaps_(dates);
  if (!g || g > 6) return null;
  return 'RRULE:FREQ=DAILY' + (g > 1 ? ';INTERVAL=' + g : '') + ';COUNT=' + dates.length;
}

function fitWeekly_(dates) {
  var g = equalGaps_(dates);
  if (!g || g % 7 !== 0) return null;
  var weeks = g / 7;
  return 'RRULE:FREQ=WEEKLY' + (weeks > 1 ? ';INTERVAL=' + weeks : '') +
         ';BYDAY=' + DOW_CODES[dowOf_(dates[0])] + ';COUNT=' + dates.length;
}
```

Add temporary stubs so `fitRule_` resolves — Task 6 fills them in:

```js
function fitMonthlyByDate_(dates) { return null; }
function fitMonthlyByWeekday_(dates) { return null; }
```

**Step 4: Run to verify it passes.**

**Step 5: Commit**

```bash
git add src/RecurrenceService.gs
git commit -m "feat: fit daily and weekly recurrence rules"
```

---

## Task 6: Monthly rule fitting

**Files:**
- Modify: `src/RecurrenceService.gs` (replace the two stubs from Task 5)

**Step 1: Write the failing test**

```js
function test_fitMonthly() {
  var byDate = fitRule_(['2026-08-15', '2026-09-15', '2026-10-15']);
  if (byDate !== 'RRULE:FREQ=MONTHLY;COUNT=3') throw new Error('monthly by date: ' + byDate);

  var quarterly = fitRule_(['2026-01-15', '2026-04-15', '2026-07-15']);
  if (quarterly !== 'RRULE:FREQ=MONTHLY;INTERVAL=3;COUNT=3') throw new Error('quarterly: ' + quarterly);

  // 2nd Tuesday of Aug/Sep/Oct 2026
  var byWeekday = fitRule_(['2026-08-11', '2026-09-08', '2026-10-13']);
  if (byWeekday !== 'RRULE:FREQ=MONTHLY;BYDAY=2TU;COUNT=3') throw new Error('2nd Tuesday: ' + byWeekday);

  Logger.log('test_fitMonthly: ALL PASSED');
}
```

**Step 2: Run to verify it fails** — the stubs return `null`.

**Step 3: Implement — replace the stubs**

```js
/** The common month step, or 0 if the steps are not all equal. */
function equalMonthSteps_(dates) {
  var k = monthIndex_(dates[1]) - monthIndex_(dates[0]);
  if (k <= 0) return 0;
  for (var i = 1; i < dates.length - 1; i++) {
    if (monthIndex_(dates[i + 1]) - monthIndex_(dates[i]) !== k) return 0;
  }
  return k;
}

/** Same day-of-month every k months, e.g. the 15th. */
function fitMonthlyByDate_(dates) {
  var dom = dayOfMonth_(dates[0]);
  for (var i = 1; i < dates.length; i++) {
    if (dayOfMonth_(dates[i]) !== dom) return null;
  }
  var k = equalMonthSteps_(dates);
  if (!k) return null;
  return 'RRULE:FREQ=MONTHLY' + (k > 1 ? ';INTERVAL=' + k : '') + ';COUNT=' + dates.length;
}

/** Same weekday at the same ordinal every k months, e.g. the 2nd Tuesday. */
function fitMonthlyByWeekday_(dates) {
  var dow = dowOf_(dates[0]);
  var ord = ordinalInMonth_(dates[0]);
  // A 5th weekday does not exist in every month; let RDATE handle those.
  if (ord > 4) return null;
  for (var i = 1; i < dates.length; i++) {
    if (dowOf_(dates[i]) !== dow || ordinalInMonth_(dates[i]) !== ord) return null;
  }
  var k = equalMonthSteps_(dates);
  if (!k) return null;
  return 'RRULE:FREQ=MONTHLY' + (k > 1 ? ';INTERVAL=' + k : '') +
         ';BYDAY=' + ord + DOW_CODES[dow] + ';COUNT=' + dates.length;
}
```

**Step 4: Run to verify it passes** — both `test_fitMonthly` and `test_fitDailyWeekly` must be green.

**Step 5: Commit**

```bash
git add src/RecurrenceService.gs
git commit -m "feat: fit monthly recurrence rules by date and by weekday ordinal"
```

---

## Task 7: Expansion verification

This is the safety net. A rule is only used if expanding it reproduces the input dates exactly.

**Files:**
- Modify: `src/RecurrenceService.gs`

**Step 1: Write the failing test**

```js
function test_expandRule() {
  var weekly = expandRule_('RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=4', '2026-08-10', 4);
  if (weekly.join(',') !== '2026-08-10,2026-08-17,2026-08-24,2026-08-31') {
    throw new Error('weekly expansion: ' + weekly.join(','));
  }

  var monthly = expandRule_('RRULE:FREQ=MONTHLY;COUNT=3', '2026-08-15', 3);
  if (monthly.join(',') !== '2026-08-15,2026-09-15,2026-10-15') {
    throw new Error('monthly expansion: ' + monthly.join(','));
  }

  // RFC 5545: a monthly-by-date rule SKIPS months lacking that day.
  // Jan 31 monthly does not produce Feb 28 — this is what catches a bad fit.
  var skips = expandRule_('RRULE:FREQ=MONTHLY;COUNT=3', '2026-01-31', 3);
  if (skips.join(',') !== '2026-01-31,2026-03-31,2026-05-31') {
    throw new Error('monthly should skip short months: ' + skips.join(','));
  }

  var byWeekday = expandRule_('RRULE:FREQ=MONTHLY;BYDAY=2TU;COUNT=3', '2026-08-11', 3);
  if (byWeekday.join(',') !== '2026-08-11,2026-09-08,2026-10-13') {
    throw new Error('2nd Tuesday expansion: ' + byWeekday.join(','));
  }

  Logger.log('test_expandRule: ALL PASSED');
}
```

**Step 2: Run to verify it fails** — `expandRule_ is not defined`.

**Step 3: Implement**

```js
/**
 * Expands an RRULE line into the dates it would actually generate, following
 * RFC 5545's rule that invalid dates (Feb 31) are skipped rather than clamped.
 * Used to verify a fitted rule before trusting it.
 * @param {string} rule
 * @param {string} startYmd - DTSTART date, always instance 1
 * @param {number} n
 * @returns {Array<string>}
 */
function expandRule_(rule, startYmd, n) {
  var freq = (rule.match(/FREQ=([A-Z]+)/) || [])[1];
  var interval = +((rule.match(/INTERVAL=(\d+)/) || [])[1] || 1);
  var byday = rule.match(/BYDAY=(\d*)([A-Z]{2})/);
  var out = [];

  if (freq === 'DAILY' || freq === 'WEEKLY') {
    var step = (freq === 'DAILY' ? 1 : 7) * interval;
    for (var i = 0; i < n; i++) {
      out.push(ymd_(dateUtc_(startYmd) + i * step * 86400000));
    }
    return out;
  }

  if (freq === 'MONTHLY') {
    var p = startYmd.split('-');
    var y = +p[0];
    var m = +p[1] - 1;
    var dom = +p[2];
    var guard = 0;
    while (out.length < n && guard++ < 600) {
      var cand = (byday && byday[1])
        ? nthWeekdayOfMonth_(y, m, +byday[1], DOW_CODES.indexOf(byday[2]))
        : exactDayOfMonth_(y, m, dom);
      if (cand) out.push(cand);
      m += interval;
      y += Math.floor(m / 12);
      m = ((m % 12) + 12) % 12;
    }
    return out;
  }

  return [];
}

function sameList_(a, b) {
  if (a.length !== b.length) return false;
  for (var i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
```

**Step 4: Run to verify it passes.**

**Step 5: Commit**

```bash
git add src/RecurrenceService.gs
git commit -m "feat: expand and verify recurrence rules before trusting them"
```

---

## Task 8: `planRecurrence_` and the RDATE fallback

**Files:**
- Modify: `src/RecurrenceService.gs`

**Step 1: Write the failing tests**

```js
function test_planRecurrence_single() {
  var plan = planRecurrence_([{ date: '2026-08-10', start_time: '19:00', end_time: '20:00' }], 'America/Chicago');
  if (plan.method !== 'single') throw new Error('method: ' + plan.method);
  if (plan.recurrence !== null) throw new Error('single events must not carry a recurrence');
  if (plan.exceptions.length !== 0) throw new Error('single events have no exceptions');
  Logger.log('test_planRecurrence_single: ALL PASSED');
}

function test_planRecurrence_weekly() {
  // The real Meetup case: Vegan Book Club, Aug 10/17/24/31 2026, 7-8pm.
  var plan = planRecurrence_([
    { date: '2026-08-10', start_time: '19:00', end_time: '20:00' },
    { date: '2026-08-17', start_time: '19:00', end_time: '20:00' },
    { date: '2026-08-24', start_time: '19:00', end_time: '20:00' },
    { date: '2026-08-31', start_time: '19:00', end_time: '20:00' }
  ], 'America/Chicago');

  if (plan.method !== 'rrule') throw new Error('method: ' + plan.method);
  if (plan.recurrence[0] !== 'RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=4') throw new Error('rule: ' + plan.recurrence[0]);
  if (plan.base.date !== '2026-08-10') throw new Error('base date: ' + plan.base.date);
  if (plan.exceptions.length !== 0) throw new Error('no exceptions expected');
  Logger.log('test_planRecurrence_weekly: ALL PASSED');
}

function test_planRecurrence_weeklyTimeException() {
  var plan = planRecurrence_([
    { date: '2026-08-10', start_time: '19:00', end_time: '20:00' },
    { date: '2026-08-17', start_time: '19:00', end_time: '20:00' },
    { date: '2026-08-24', start_time: '19:00', end_time: '20:00' },
    { date: '2026-08-31', start_time: '18:00', end_time: '20:00' }
  ], 'America/Chicago');

  if (plan.method !== 'rrule') throw new Error('a differing time must not break the series');
  if (plan.base.start_time !== '19:00') throw new Error('series time should be the modal 19:00');
  if (plan.exceptions.length !== 1) throw new Error('expected 1 exception, got ' + plan.exceptions.length);
  if (plan.exceptions[0].date !== '2026-08-31') throw new Error('wrong exception date');
  if (plan.dates[3].isException !== true) throw new Error('UI row should be flagged');
  Logger.log('test_planRecurrence_weeklyTimeException: ALL PASSED');
}

function test_planRecurrence_irregular() {
  var plan = planRecurrence_([
    { date: '2026-08-10', start_time: '19:00', end_time: '20:00' },
    { date: '2026-08-17', start_time: '19:00', end_time: '20:00' },
    { date: '2026-09-03', start_time: '19:00', end_time: '20:00' },
    { date: '2026-09-20', start_time: '19:00', end_time: '20:00' }
  ], 'America/Chicago');

  if (plan.method !== 'rdate') throw new Error('method: ' + plan.method);
  // DTSTART is instance 1 per RFC 5545, so RDATE lists dates 2..n only.
  var expected = 'RDATE;TZID=America/Chicago:20260817T190000,20260903T190000,20260920T190000';
  if (plan.recurrence[0] !== expected) throw new Error('rdate: ' + plan.recurrence[0]);
  Logger.log('test_planRecurrence_irregular: ALL PASSED');
}

function test_planRecurrence_rejectsBadFit() {
  // Looks monthly-by-day-of-month at a glance, but Feb 31 does not exist, so
  // the rule cannot reproduce these dates. Must degrade to RDATE.
  var plan = planRecurrence_([
    { date: '2026-01-31', start_time: '19:00', end_time: '20:00' },
    { date: '2026-02-28', start_time: '19:00', end_time: '20:00' },
    { date: '2026-03-31', start_time: '19:00', end_time: '20:00' }
  ], 'America/Chicago');
  if (plan.method !== 'rdate') throw new Error('bad fit must degrade to rdate, got ' + plan.method);
  Logger.log('test_planRecurrence_rejectsBadFit: ALL PASSED');
}

function test_planRecurrence_neverUsesUntil() {
  var inputs = [
    ['2026-08-10', '2026-08-17', '2026-08-24'],
    ['2026-08-15', '2026-09-15', '2026-10-15'],
    ['2026-08-11', '2026-09-08', '2026-10-13'],
    ['2026-08-10', '2026-08-11', '2026-08-12']
  ];
  inputs.forEach(function (dates) {
    var plan = planRecurrence_(dates.map(function (d) {
      return { date: d, start_time: '19:00', end_time: '20:00' };
    }), 'America/Chicago');
    var line = plan.recurrence ? plan.recurrence[0] : '';
    if (line.indexOf('UNTIL') >= 0) throw new Error('UNTIL leaked into: ' + line);
    if (plan.method === 'rrule' && line.indexOf('COUNT=' + dates.length) < 0) {
      throw new Error('rule must be pinned with COUNT=' + dates.length + ': ' + line);
    }
  });
  Logger.log('test_planRecurrence_neverUsesUntil: ALL PASSED');
}
```

**Step 2: Run to verify they fail** — `planRecurrence_ is not defined`.

**Step 3: Implement**

```js
/**
 * Decides how to create a set of occurrences in Google Calendar.
 *
 * Rules always terminate with COUNT=n, never UNTIL, so the series covers
 * exactly the dates extracted from the page with no DST or timezone ambiguity
 * about where it stops. A fitted rule is used only if expandRule_ reproduces
 * the input dates exactly; otherwise the dates go out as an explicit RDATE
 * list, which keeps even an irregular set as a single repeating event.
 *
 * @param {Array} occurrences - [{date, start_time, end_time}]
 * @param {string} tz - IANA timezone, e.g. 'America/Chicago'
 * @returns {{method:string, summary:string, base:Object|null,
 *            recurrence:Array<string>|null, exceptions:Array, dates:Array}}
 */
function planRecurrence_(occurrences, tz) {
  var occ = normalizeOccurrences_(occurrences);
  if (occ.length === 0) {
    return { method: 'none', summary: 'No valid dates yet.', base: null,
             recurrence: null, exceptions: [], dates: [] };
  }

  var time = modalTime_(occ);
  var isException = function (o) {
    return o.start_time !== time.start_time || o.end_time !== time.end_time;
  };
  var uiDates = occ.map(function (o) {
    return { date: o.date, start_time: o.start_time, end_time: o.end_time,
             isException: isException(o) };
  });

  if (occ.length === 1) {
    return { method: 'single', summary: summarizePlan_('single', occ, null),
             base: occ[0], recurrence: null, exceptions: [], dates: uiDates };
  }

  var dates = occ.map(function (o) { return o.date; });
  var base = { date: dates[0], start_time: time.start_time, end_time: time.end_time };
  var exceptions = occ.filter(isException);

  var rule = fitRule_(dates);
  if (rule && !sameList_(expandRule_(rule, dates[0], dates.length), dates)) rule = null;

  if (rule) {
    return { method: 'rrule', summary: summarizePlan_('rrule', occ, rule), base: base,
             recurrence: [rule], exceptions: exceptions, dates: uiDates };
  }

  return { method: 'rdate', summary: summarizePlan_('rdate', occ, null), base: base,
           recurrence: [buildRdate_(dates.slice(1), time.start_time, tz)],
           exceptions: exceptions, dates: uiDates };
}

/**
 * RDATE line covering dates 2..n. DTSTART is already instance 1 per RFC 5545,
 * so including the first date again would be redundant.
 */
function buildRdate_(dates, startTime, tz) {
  var stamps = dates.map(function (d) {
    return d.replace(/-/g, '') + 'T' + startTime.replace(':', '') + '00';
  });
  return 'RDATE;TZID=' + tz + ':' + stamps.join(',');
}
```

Add a temporary stub so the tests run — Task 9 replaces it:

```js
function summarizePlan_(method, occ, rule) { return method; }
```

**Step 4: Run to verify all six pass.**

**Step 5: Commit**

```bash
git add src/RecurrenceService.gs
git commit -m "feat: plan recurrence with verified RRULE and RDATE fallback"
```

---

## Task 9: Human-readable plan summary

**Files:**
- Modify: `src/RecurrenceService.gs` (replace the `summarizePlan_` stub)

**Step 1: Write the failing test**

```js
function test_summarizePlan() {
  var weekly = planRecurrence_([
    { date: '2026-08-10', start_time: '19:00', end_time: '20:00' },
    { date: '2026-08-17', start_time: '19:00', end_time: '20:00' },
    { date: '2026-08-24', start_time: '19:00', end_time: '20:00' },
    { date: '2026-08-31', start_time: '18:00', end_time: '20:00' }
  ], 'America/Chicago').summary;

  if (weekly.indexOf('every week on Monday') < 0) throw new Error('missing cadence: ' + weekly);
  if (weekly.indexOf('4 occurrences') < 0) throw new Error('missing count: ' + weekly);
  if (weekly.indexOf('Aug 10') < 0 || weekly.indexOf('Aug 31') < 0) throw new Error('missing range: ' + weekly);
  if (weekly.indexOf('one repeating') < 0) throw new Error('must state the method: ' + weekly);
  if (weekly.indexOf('1 date has a different time') < 0) throw new Error('must flag exceptions: ' + weekly);

  var single = planRecurrence_([{ date: '2026-08-10', start_time: '19:00', end_time: '20:00' }], 'America/Chicago').summary;
  if (single.indexOf('Single event') < 0) throw new Error('single summary: ' + single);

  var irregular = planRecurrence_([
    { date: '2026-08-10', start_time: '19:00', end_time: '20:00' },
    { date: '2026-09-03', start_time: '19:00', end_time: '20:00' }
  ], 'America/Chicago').summary;
  if (irregular.indexOf('custom date list') < 0) throw new Error('rdate summary: ' + irregular);

  Logger.log('test_summarizePlan: ALL PASSED');
}
```

**Step 2: Run to verify it fails** — the stub returns just the method name.

**Step 3: Implement — replace the stub**

```js
/** 'Mon, Aug 10' */
function formatShortDate_(s) {
  var p = s.split('-');
  return DAY_NAMES[dowOf_(s)] + ', ' + MONTH_NAMES[+p[1] - 1] + ' ' + (+p[2]);
}

/** 'Aug 10' */
function formatDateOnly_(s) {
  var p = s.split('-');
  return MONTH_NAMES[+p[1] - 1] + ' ' + (+p[2]);
}

/** '7:00 PM' */
function formatTime12_(t) {
  var p = t.split(':');
  var h = +p[0];
  var suffix = h >= 12 ? 'PM' : 'AM';
  var h12 = h % 12 === 0 ? 12 : h % 12;
  return h12 + ':' + p[1] + ' ' + suffix;
}

/** 'every week on Monday', 'every 2 weeks on Monday', 'every month', ... */
function describeCadence_(rule) {
  var freq = (rule.match(/FREQ=([A-Z]+)/) || [])[1];
  var interval = +((rule.match(/INTERVAL=(\d+)/) || [])[1] || 1);
  var byday = rule.match(/BYDAY=(\d*)([A-Z]{2})/);
  var unit = { DAILY: 'day', WEEKLY: 'week', MONTHLY: 'month' }[freq] || 'time';
  var every = interval === 1 ? 'every ' + unit : 'every ' + interval + ' ' + unit + 's';

  if (freq === 'WEEKLY' && byday) {
    return every + ' on ' + DAY_NAMES_FULL[DOW_CODES.indexOf(byday[2])];
  }
  if (freq === 'MONTHLY' && byday && byday[1]) {
    var ordinals = ['', 'first', 'second', 'third', 'fourth'];
    return every + ' on the ' + ordinals[+byday[1]] + ' ' + DAY_NAMES_FULL[DOW_CODES.indexOf(byday[2])];
  }
  return every;
}

/**
 * Plain-language description of what will be created, shown verbatim in the
 * confirmation banner. States both WHICH dates and HOW they will be created.
 */
function summarizePlan_(method, occ, rule) {
  var n = occ.length;

  if (method === 'single') {
    return 'Single event on ' + formatShortDate_(occ[0].date) + ', ' +
           formatTime12_(occ[0].start_time) + ' – ' + formatTime12_(occ[0].end_time) + '.';
  }

  var range = formatDateOnly_(occ[0].date) + ' – ' + formatDateOnly_(occ[n - 1].date);
  var head = method === 'rrule'
    ? 'Repeating event — ' + describeCadence_(rule) + ', ' + n + ' occurrences (' + range + '). ' +
      'Created as one repeating calendar event.'
    : 'Repeating event — ' + n + ' custom dates (' + range + '). ' +
      'Created as one repeating calendar event with a custom date list.';

  var time = modalTime_(occ);
  var odd = occ.filter(function (o) {
    return o.start_time !== time.start_time || o.end_time !== time.end_time;
  }).length;
  if (odd > 0) {
    head += ' ' + odd + ' date' + (odd === 1 ? ' has' : 's have') +
            ' a different time and will be adjusted individually after creation.';
  }
  return head;
}
```

Add alongside the other name tables near the top of the file:

```js
var DAY_NAMES_FULL = ['Sunday', 'Monday', 'Tuesday', 'Wednesday',
                      'Thursday', 'Friday', 'Saturday'];
```

**Step 4: Run to verify it passes.**

**Step 5: Full suite check**

Run: `node tests/run.js RecurrenceService.gs Utilities.gs`
Expected: all 12 tests pass, `0 failed`.

**Step 6: Commit**

```bash
git add src/RecurrenceService.gs
git commit -m "feat: describe the recurrence plan in plain language for the UI"
```

---

## Task 10: Expose the planner to the UI

`google.script.run` cannot call a function whose name ends in `_`, so the UI needs a public wrapper.

**Files:**
- Modify: `src/RecurrenceService.gs`

**Step 1: Implement**

```js
/**
 * Public wrapper called from the confirmation UI via google.script.run to
 * refresh the recurrence banner. Server-side so the UI and the writer share
 * one implementation and can never disagree.
 * @param {Array} occurrences - [{date, start_time, end_time}]
 * @returns {Object} plan
 */
function planRecurrence(occurrences) {
  return planRecurrence_(occurrences, Session.getScriptTimeZone());
}
```

**Step 2: Verify no test regressions**

Run: `node tests/run.js RecurrenceService.gs Utilities.gs`
Expected: still all passing.

**Step 3: Commit**

```bash
git add src/RecurrenceService.gs
git commit -m "feat: expose planRecurrence to the client for the confirmation banner"
```

---

## Task 11: Extraction returns `occurrences[]`

**Files:**
- Modify: `src/Extraction.gs:57-79` (the prompt)
- Modify: `src/Extraction.gs:340-349` (`parseClaudeResponse_`)

**Step 1: Write the failing test**

Add near the existing extraction tests in `src/Extraction.gs`:

```js
function test_parseOccurrences() {
  // A response WITHOUT occurrences must degrade to today's behavior, not crash.
  var legacy = parseClaudeResponse_(JSON.stringify({
    title: 'One Night Only', date: '2026-08-10',
    start_time: '19:00', end_time: '20:00'
  }));
  if (!legacy.occurrences || legacy.occurrences.length !== 1) {
    throw new Error('legacy response should back-fill one occurrence');
  }
  if (legacy.occurrences[0].date !== '2026-08-10') throw new Error('back-fill used the wrong date');

  var multi = parseClaudeResponse_(JSON.stringify({
    title: 'Vegan Book Club', date: '2026-08-10', start_time: '19:00', end_time: '20:00',
    occurrences: [
      { date: '2026-08-10', start_time: '19:00', end_time: '20:00' },
      { date: '2026-08-17', start_time: '19:00', end_time: '20:00' }
    ]
  }));
  if (multi.occurrences.length !== 2) throw new Error('multi-date list should survive parsing');

  Logger.log('test_parseOccurrences: ALL PASSED');
}
```

**Step 2: Run to verify it fails**

Run: `node tests/run.js Extraction.gs RecurrenceService.gs Utilities.gs`
Expected: `FAIL test_parseOccurrences` — `legacy response should back-fill one occurrence`.

> Note: `Extraction.gs` loads fine under the runner because its API calls all sit inside function bodies. `test_extractEventData_live` is skipped by the runner's `_live` filter.

**Step 3: Implement the back-fill**

In `parseClaudeResponse_`, after `JSON.parse`:

```js
function parseClaudeResponse_(text) {
  try {
    // Extract JSON object if wrapped in extra text
    var match = text.match(/\{[\s\S]*\}/);
    if (!match) return null;
    var data = JSON.parse(match[0]);

    // Older/partial responses omit `occurrences`. Back-fill a one-element list
    // from the top-level fields so downstream code has a single shape to handle.
    if (!data.occurrences || !data.occurrences.length) {
      data.occurrences = data.date
        ? [{ date: data.date, start_time: data.start_time, end_time: data.end_time || null }]
        : [];
    }
    return data;
  } catch (e) {
    return null;
  }
}
```

**Step 4: Update `EXTRACTION_PROMPT`**

Add the field to the JSON schema block, after `"end_time_note"`:

```
  "occurrences": "Array of every date this event happens on: [{\"date\":\"YYYY-MM-DD\",\"start_time\":\"HH:MM\",\"end_time\":\"HH:MM|null\"}]. ALWAYS include at least one entry (array)",
```

Add these rules to the `Rules:` list:

```
- occurrences: list EVERY date the page states this event happens on. A normal single-date event returns an array of exactly one entry. The top-level date/start_time/end_time must always mirror occurrences[0].
- Do NOT extrapolate a recurrence beyond the dates actually shown. If the page gives both a rule ("every week on Monday until August 31") and an explicit list of dates, the explicit list wins.
- If a recurrence is described in prose WITH a stated end date but the individual dates are not listed, expand it into explicit dates yourself and stop at the stated end. Never invent dates past it.
- If a specific date has a different start or end time from the others, put that date's real time on its own entry. Otherwise repeat the common time on every entry.
- Apply the nearest-future-occurrence rule to the FIRST date only, then keep dates increasing, so a list like "12/20, 1/10" rolls into the following year.
```

**Step 5: Run to verify it passes.**

**Step 6: Commit**

```bash
git add src/Extraction.gs
git commit -m "feat: extract every date an event occurs on as occurrences[]"
```

---

## Task 12: Feed Meetup's series string to Claude

Meetup's JSON-LD carries only the first occurrence; the recurrence exists solely as prose in the embedded page state. Without this, multi-date Meetup events keep extracting as single-date.

**Files:**
- Modify: `src/Extraction.gs` (new helper + call site near the existing `extractMeetupImage_` usage at line 186)

**Step 1: Write the failing test**

```js
function test_extractMeetupSeries() {
  var html = '"maxTickets":0,"series":{"__typename":"Series","description":' +
             '"Every week on Monday until August 31, 2026"},"rsvps":{}';
  var s = extractMeetupSeries_(html);
  if (s !== 'Every week on Monday until August 31, 2026') throw new Error('got: ' + s);
  if (extractMeetupSeries_('<html>no series here</html>') !== null) {
    throw new Error('expected null when the page has no series');
  }
  Logger.log('test_extractMeetupSeries: ALL PASSED');
}
```

**Step 2: Run to verify it fails** — `extractMeetupSeries_ is not defined`.

**Step 3: Implement**

```js
/**
 * Pulls Meetup's recurrence description out of the embedded page state.
 *
 * Meetup's JSON-LD only ever exposes the FIRST occurrence of a series, so a
 * four-week book club looks like a one-off event. The only recurrence signal on
 * the page is prose: "series":{"description":"Every week on Monday until
 * August 31, 2026"}. We surface it to Claude as context rather than parsing it,
 * because the enumerated dates in the body remain authoritative.
 * @param {string} html - Raw page HTML
 * @returns {string|null}
 */
function extractMeetupSeries_(html) {
  var m = html.match(/"series"\s*:\s*\{[^}]*?"description"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  if (!m) return null;
  return m[1].replace(/\\"/g, '"').replace(/\\n/g, ' ').trim() || null;
}
```

**Step 4: Wire it into the prefix**

In `extractEventData`, the Meetup image override currently runs *after* the Claude call. The series string must be added *before*. Insert this just above `var result = callClaude_(cleaned, false);`:

```js
  // Meetup hides its recurrence in page state as prose, and its JSON-LD only
  // carries the first occurrence — surface it so multi-date series are caught.
  if (url.indexOf('meetup.com') >= 0) {
    var series = extractMeetupSeries_(html);
    if (series) {
      cleaned = '=== EVENT SERIES RECURRENCE (from Meetup) ===\n' + series +
                '\nThis event repeats. Enumerate every date in occurrences[], ' +
                'stopping at the stated end date.\n=== END SERIES ===\n\n' + cleaned;
    }
  }
```

**Step 5: Run to verify it passes.**

**Step 6: Commit**

```bash
git add src/Extraction.gs
git commit -m "feat: surface Meetup's series recurrence string to Claude"
```

---

## Task 13: Create recurring calendar events

**Files:**
- Modify: `src/CalendarService.gs:48-73`

**Step 1: Rewrite `createCalendarEvent`**

```js
/**
 * Creates a Google Calendar event from one or more occurrences.
 *
 * Prefers a single repeating event (RRULE, or RDATE for irregular dates) so the
 * description and flyer live in one place. Occurrences whose time differs from
 * the series are patched individually afterwards. Falls back to N duplicated
 * events only if the recurring insert fails.
 *
 * @param {Object} eventData - title, occurrences[], location, description
 * @returns {{eventId:string, eventIds:Array<string>, eventUrl:string,
 *            method:string, occurrenceCount:number, warnings:Array<string>}
 *          |{error:string}}
 */
function createCalendarEvent(eventData) {
  try {
    var calendarId = PropertiesService.getScriptProperties().getProperty('CALENDAR_ID');
    var tz = Session.getScriptTimeZone();

    var occurrences = (eventData.occurrences && eventData.occurrences.length)
      ? eventData.occurrences
      : [{ date: eventData.date, start_time: eventData.start_time, end_time: eventData.end_time }];

    var plan = planRecurrence_(occurrences, tz);
    if (plan.method === 'none') return { error: 'No valid dates to create.' };

    var warnings = [];

    try {
      var resource = buildEventResource_(eventData, plan.base, tz);
      if (plan.recurrence) resource.recurrence = plan.recurrence;

      var event = Calendar.Events.insert(resource, calendarId);

      if (plan.exceptions.length) {
        warnings = warnings.concat(patchExceptions_(calendarId, event.id, plan, tz));
      }

      return {
        eventId: event.id,
        eventIds: [event.id],
        eventUrl: event.htmlLink,
        method: plan.method,
        occurrenceCount: plan.dates.length,
        warnings: warnings
      };
    } catch (recurErr) {
      if (plan.method === 'single') throw recurErr;
      // Recurring insert failed — fall back to standalone events per date.
      return duplicateEvents_(eventData, plan, calendarId, tz, recurErr.message);
    }
  } catch (e) {
    return { error: 'Failed to create calendar event: ' + e.message };
  }
}

/** Shared resource builder so the recurring and duplicated paths cannot drift. */
function buildEventResource_(eventData, occ, tz) {
  var resource = {
    summary: eventData.title,
    start: { dateTime: occ.date + 'T' + occ.start_time + ':00', timeZone: tz },
    end:   { dateTime: occ.date + 'T' + occ.end_time + ':00', timeZone: tz },
    description: eventData.description || ''
  };
  if (eventData.location) resource.location = eventData.location;
  return resource;
}
```

**Step 2: Verify nothing regressed locally**

Run: `node tests/run.js RecurrenceService.gs Utilities.gs Extraction.gs`
Expected: all still passing. `CalendarService.gs` is not loadable locally (it calls `Calendar`/`PropertiesService`); it is covered by the live tests in Task 17.

**Step 3: Commit**

```bash
git add src/CalendarService.gs
git commit -m "feat: create a single repeating calendar event for multi-date events"
```

---

## Task 14: Patch per-date time exceptions

**Files:**
- Modify: `src/CalendarService.gs`

**Step 1: Implement**

```js
/**
 * Applies per-date time overrides to individual instances of a recurring event.
 *
 * Instances are matched on the DATE portion of originalStartTime, because the
 * series was created at the modal time and each exception's real time differs.
 * A failure here is a warning, not an abort: the series already exists and is
 * correct apart from that one instance.
 * @returns {Array<string>} warnings
 */
function patchExceptions_(calendarId, eventId, plan, tz) {
  var warnings = [];
  var first = plan.dates[0].date;
  var last = plan.dates[plan.dates.length - 1].date;

  var instances;
  try {
    instances = Calendar.Events.instances(calendarId, eventId, {
      timeMin: first + 'T00:00:00Z',
      timeMax: last + 'T23:59:59Z',
      maxResults: 250
    }).items || [];
  } catch (e) {
    return ['Could not load event instances to adjust differing times: ' + e.message];
  }

  plan.exceptions.forEach(function (ex) {
    var match = null;
    for (var i = 0; i < instances.length; i++) {
      var ost = instances[i].originalStartTime || instances[i].start || {};
      var stamp = ost.dateTime || ost.date || '';
      if (stamp.indexOf(ex.date) === 0) { match = instances[i]; break; }
    }
    if (!match) {
      warnings.push('Could not find the ' + ex.date + ' occurrence to set its time.');
      return;
    }
    try {
      Calendar.Events.patch({
        start: { dateTime: ex.date + 'T' + ex.start_time + ':00', timeZone: tz },
        end:   { dateTime: ex.date + 'T' + ex.end_time + ':00', timeZone: tz }
      }, calendarId, match.id);
    } catch (e) {
      warnings.push('Could not set the time for ' + ex.date + ': ' + e.message);
    }
  });

  return warnings;
}
```

**Step 2: Commit**

```bash
git add src/CalendarService.gs
git commit -m "feat: patch instances whose times differ from the series"
```

---

## Task 15: Duplicate fallback, multi-date attachment and duplicate detection

**Files:**
- Modify: `src/CalendarService.gs:96-139`

**Step 1: Implement the duplicate fallback**

```js
/**
 * Last-resort path: create one standalone event per date. Only reached when a
 * recurring insert throws, never chosen by design.
 */
function duplicateEvents_(eventData, plan, calendarId, tz, reason) {
  var ids = [];
  var url = null;
  var warnings = ['Could not create a repeating event (' + reason +
                  '), so ' + plan.dates.length + ' separate events were created instead.'];

  plan.dates.forEach(function (occ) {
    try {
      var ev = Calendar.Events.insert(buildEventResource_(eventData, occ, tz), calendarId);
      ids.push(ev.id);
      if (!url) url = ev.htmlLink;
    } catch (e) {
      warnings.push('Could not create the ' + occ.date + ' event: ' + e.message);
    }
  });

  if (!ids.length) return { error: 'Failed to create calendar events: ' + reason };

  return {
    eventId: ids[0],
    eventIds: ids,
    eventUrl: url,
    method: 'duplicate',
    occurrenceCount: ids.length,
    warnings: warnings
  };
}
```

**Step 2: Attach the flyer to every created event**

A recurring master needs one call; the duplicate path needs N. Change `attachFileToCalendarEvent` to take an array:

```js
/**
 * Attaches a Drive file to one or more Calendar events.
 * A recurring master gets a single call and every instance inherits it; the
 * duplicate fallback needs one call per event.
 * @param {Array<string>} eventIds
 * @returns {{success:boolean}|{error:string}}
 */
function attachFileToCalendarEvent(eventIds, fileId, fileName) {
  try {
    var calendarId = PropertiesService.getScriptProperties().getProperty('CALENDAR_ID');
    var file = DriveApp.getFileById(fileId);
    var ids = [].concat(eventIds);

    ids.forEach(function (id) {
      Calendar.Events.patch(
        {
          attachments: [{
            fileUrl: 'https://drive.google.com/open?id=' + fileId,
            mimeType: file.getMimeType(),
            title: fileName
          }]
        },
        calendarId, id, { supportsAttachments: true }
      );
    });
    return { success: true };
  } catch (e) {
    return { error: 'Could not attach image to calendar event: ' + e.message };
  }
}
```

**Step 3: Report which dates already have the event**

```js
/**
 * Returns the dates that already hold an event with this title, so the result
 * screen can say "2 of 4 dates already had this event" instead of just "yes".
 * @param {string} title
 * @param {Array<string>} dates - YYYY-MM-DD
 * @returns {Array<string>} colliding dates
 */
function findDuplicateDates(title, dates) {
  var hits = [];
  try {
    var calendarId = PropertiesService.getScriptProperties().getProperty('CALENDAR_ID');
    var cal = CalendarApp.getCalendarById(calendarId);
    var lowerTitle = title.toLowerCase();
    dates.forEach(function (d) {
      var events = cal.getEvents(new Date(d + 'T00:00:00'), new Date(d + 'T23:59:59'));
      var clash = events.some(function (e) { return e.getTitle().toLowerCase() === lowerTitle; });
      if (clash) hits.push(d);
    });
  } catch (e) {
    return hits; // never block on a duplicate-check failure
  }
  return hits;
}
```

Keep `isDuplicateEvent` as a thin wrapper so `test_duplicateDetection` still passes:

```js
function isDuplicateEvent(title, date) {
  return findDuplicateDates(title, [date]).length > 0;
}
```

**Step 4: Commit**

```bash
git add src/CalendarService.gs
git commit -m "feat: add duplicate fallback, multi-event attachment, per-date duplicate detection"
```

---

## Task 16: Wire up `submitEvent`

**Files:**
- Modify: `src/Code.gs:67-129`

**Step 1: Rewrite the body**

```js
function submitEvent(eventData) {
  var driveResult = null;

  var occurrences = (eventData.occurrences && eventData.occurrences.length)
    ? eventData.occurrences
    : [{ date: eventData.date, start_time: eventData.start_time, end_time: eventData.end_time }];

  // Re-plan server-side. The UI's banner is only a preview; this is what runs.
  var plan = planRecurrence_(occurrences, Session.getScriptTimeZone());
  if (plan.method === 'none') return { error: 'Please provide at least one valid date.' };

  var dates = plan.dates.map(function (o) { return o.date; });

  // 1. Which of these dates already have this event?
  var duplicateDates = findDuplicateDates(eventData.title, dates);

  // 2. Save image to Drive (non-blocking), named for the first occurrence
  if (eventData.image_url) {
    driveResult = saveImageToDrive(eventData.image_url, eventData.title, dates[0]);
    if (driveResult.error) driveResult = null;
  }

  // 3. Build full description with source link appended
  var fullDescription = (eventData.description || '').trim();
  if (eventData.source_link_label && eventData.source_url) {
    fullDescription += '\n\n<a href="' + eventData.source_url + '">' + eventData.source_link_label + '</a>';
  }

  // 4. Create the calendar event(s)
  var calResult = createCalendarEvent({
    title: eventData.title,
    occurrences: occurrences,
    location: eventData.location,
    description: fullDescription
  });

  if (calResult.error) {
    return {
      error: calResult.error,
      partial: driveResult ? { driveUrl: driveResult.fileUrl } : null
    };
  }

  // 5. Attach the Drive image
  var attachResult = null;
  if (driveResult) {
    attachResult = attachFileToCalendarEvent(calResult.eventIds, driveResult.fileId, driveResult.fileName);
  }

  var userEmail = Session.getActiveUser().getEmail();
  var calendarUrl = calResult.eventUrl +
    (calResult.eventUrl.indexOf('?') >= 0 ? '&' : '?') + 'authuser=' + userEmail;

  return {
    success: true,
    method: calResult.method,
    occurrenceCount: calResult.occurrenceCount,
    dates: dates,
    duplicateDates: duplicateDates,
    warnings: calResult.warnings || [],
    title: eventData.title,
    calendarUrl: calendarUrl,
    driveUrl: driveResult ? driveResult.fileUrl : null,
    imageUrl: eventData.image_url || null,
    attachmentWarning: (driveResult && attachResult && attachResult.error) ? attachResult.error : null
  };
}
```

**Step 2: Commit**

```bash
git add src/Code.gs
git commit -m "feat: submit multi-date events through the recurrence planner"
```

---

## Task 17: Confirmation UI — date rows and live banner

**Files:**
- Modify: `src/Index.html`

**Step 1: Replace the date/time fields**

Delete the two `.field-row` blocks holding `f-date`, `f-start`, `f-end` (lines 104-114) and put this in their place:

```html
      <div id="recurrence-banner" class="rec-banner"></div>
      <label>Dates *</label>
      <div id="date-rows"></div>
      <button type="button" class="btn-add-date" onclick="addDateRow()">+ Add date</button>
      <div id="end-time-note" class="warning-note"></div>
```

**Step 2: Add styles** inside the existing `<style>` block:

```css
    .rec-banner { padding: 10px 12px; border-radius: 6px; margin-bottom: 12px; font-size: 0.86rem; background: #e8f0fe; color: #174ea6; border: 1px solid #c5d3f0; }
    .rec-banner.checking { background: #f1f3f4; color: #777; border-color: #ddd; }
    .rec-banner.single { background: #f1f3f4; color: #555; border-color: #ddd; }
    .date-row { display: flex; gap: 6px; align-items: center; margin-bottom: 6px; }
    .date-row input[type=date] { flex: 2 1 auto; min-width: 0; }
    .date-row input[type=time] { flex: 1 1 auto; min-width: 0; }
    .date-row .sep { color: #999; font-size: 0.85rem; }
    .date-row .diff-tag { font-size: 0.65rem; font-weight: 700; color: #b06000; background: #fef7e0; border: 1px solid #f9c840; border-radius: 3px; padding: 1px 4px; white-space: nowrap; }
    .date-row .rm { flex: 0 0 auto; background: none; border: none; color: #c5221f; font-size: 1rem; cursor: pointer; width: auto; margin: 0; padding: 0 4px; }
    .btn-add-date { width: auto; padding: 6px 12px; font-size: 0.82rem; background: #e8f0fe; color: #1a73e8; margin-top: 2px; }
```

**Step 3: Add the row-management JS** (replaces nothing; new functions near `populateForm`)

```js
    var planTimer = null;

    function addDateRow(date, start, end) {
      var rows = document.getElementById('date-rows');
      // A new row defaults to one interval past the last, keeping the pattern.
      if (!date && rows.children.length) {
        var existing = readDateRows();
        var last = existing[existing.length - 1];
        var step = existing.length > 1
          ? (Date.parse(last.date) - Date.parse(existing[existing.length - 2].date)) / 86400000
          : 7;
        date = new Date(Date.parse(last.date) + step * 86400000).toISOString().slice(0, 10);
        start = start || last.start_time;
        end = end || last.end_time;
      }

      var row = document.createElement('div');
      row.className = 'date-row';
      row.innerHTML =
        '<input type="date" value="' + (date || '') + '" oninput="onDatesChanged()">' +
        '<input type="time" value="' + (start || '') + '" oninput="onDatesChanged()">' +
        '<span class="sep">–</span>' +
        '<input type="time" value="' + (end || '') + '" oninput="onDatesChanged()">' +
        '<span class="diff-tag" style="display:none">diff</span>' +
        '<button type="button" class="rm" onclick="removeDateRow(this)" title="Remove date">&#10005;</button>';
      rows.appendChild(row);
      onDatesChanged();
    }

    function removeDateRow(btn) {
      var rows = document.getElementById('date-rows');
      if (rows.children.length <= 1) return;
      rows.removeChild(btn.parentNode);
      onDatesChanged();
    }

    function readDateRows() {
      var out = [];
      var rows = document.getElementById('date-rows').children;
      for (var i = 0; i < rows.length; i++) {
        var inputs = rows[i].getElementsByTagName('input');
        out.push({ date: inputs[0].value, start_time: inputs[1].value, end_time: inputs[2].value || null });
      }
      return out;
    }

    function onDatesChanged() {
      var rows = document.getElementById('date-rows').children;
      // The remove control is meaningless on the only row.
      for (var i = 0; i < rows.length; i++) {
        rows[i].getElementsByClassName('rm')[0].style.visibility =
          rows.length > 1 ? 'visible' : 'hidden';
      }

      var occ = readDateRows().filter(function (o) { return o.date && o.start_time; });
      var banner = document.getElementById('recurrence-banner');
      if (!occ.length) {
        banner.className = 'rec-banner single';
        banner.textContent = 'Add at least one date.';
        return;
      }

      banner.className = 'rec-banner checking';
      banner.textContent = 'Checking dates…';

      clearTimeout(planTimer);
      planTimer = setTimeout(function () {
        google.script.run
          .withSuccessHandler(renderPlan)
          .withFailureHandler(function () {
            banner.className = 'rec-banner single';
            banner.textContent = 'Could not preview the schedule — it will still be checked when you submit.';
          })
          .planRecurrence(occ);
      }, 400);
    }

    function renderPlan(plan) {
      var banner = document.getElementById('recurrence-banner');
      banner.className = 'rec-banner' + (plan.method === 'single' ? ' single' : '');
      banner.textContent = (plan.method === 'single' ? '' : '↻ ') + plan.summary;

      // Flag rows whose time differs from the series.
      var rows = document.getElementById('date-rows').children;
      var flagged = {};
      (plan.dates || []).forEach(function (d) { if (d.isException) flagged[d.date] = true; });
      for (var i = 0; i < rows.length; i++) {
        var d = rows[i].getElementsByTagName('input')[0].value;
        rows[i].getElementsByClassName('diff-tag')[0].style.display = flagged[d] ? 'inline' : 'none';
      }
    }
```

**Step 4: Populate rows from extraction** — in `populateForm`, replace the three lines setting `f-date`, `f-start`, `f-end` with:

```js
      var rows = document.getElementById('date-rows');
      rows.innerHTML = '';
      var occ = (data.occurrences && data.occurrences.length)
        ? data.occurrences
        : [{ date: data.date, start_time: data.start_time, end_time: data.end_time }];
      occ.forEach(function (o) { addDateRow(o.date || '', o.start_time || '', o.end_time || ''); });
```

**Step 5: Validate and submit occurrences** — in `submitEvent()`, replace the date/start reads and the `eventData` date fields:

```js
      var title = document.getElementById('f-title').value.trim();
      var occurrences = readDateRows();

      if (!title) { setStatus('submit-status', 'error', 'Title is required.'); return; }
      if (!occurrences.length) { setStatus('submit-status', 'error', 'Add at least one date.'); return; }

      var seen = {};
      for (var i = 0; i < occurrences.length; i++) {
        if (!occurrences[i].date || !occurrences[i].start_time) {
          setStatus('submit-status', 'error', 'Every date needs a date and a start time.');
          return;
        }
        if (seen[occurrences[i].date]) {
          setStatus('submit-status', 'error', 'Duplicate date: ' + occurrences[i].date);
          return;
        }
        seen[occurrences[i].date] = true;
      }
```

and in the `eventData` object replace `date`/`start_time`/`end_time` with:

```js
        occurrences: occurrences,
```

**Step 6: Update `reset()`** — add `document.getElementById('date-rows').innerHTML = '';` and `document.getElementById('recurrence-banner').textContent = '';`

**Step 7: Update the result screen** — in `showResult`, replace the status message block:

```js
      var statusMsg = result.occurrenceCount > 1
        ? (result.method === 'duplicate'
            ? 'Created ' + result.occurrenceCount + ' separate events.'
            : 'Created one repeating event with ' + result.occurrenceCount + ' occurrences.')
        : 'Event created successfully!';
      var statusType = 'success';

      if (result.duplicateDates && result.duplicateDates.length) {
        statusMsg += ' Note: ' + result.duplicateDates.length + ' of ' +
                     result.occurrenceCount + ' date(s) already had an event with this title (' +
                     result.duplicateDates.join(', ') + ').';
        statusType = 'warn';
      }
      if (result.warnings && result.warnings.length) {
        statusMsg += ' ' + result.warnings.join(' ');
        statusType = 'warn';
      }
      if (result.attachmentWarning) {
        statusMsg += ' (Image saved to Drive but could not be attached: ' + result.attachmentWarning + ')';
        statusType = 'warn';
      }
```

**Step 8: Commit**

```bash
git add src/Index.html
git commit -m "feat: confirmation UI showing which dates are created and how"
```

---

## Task 18: Live verification against the real calendar

These hit the real Calendar API and clean up after themselves. They must be run **from the Apps Script editor**, not the local runner.

**Files:**
- Modify: `src/CalendarService.gs`

**Step 1: Add the live tests**

```js
function test_createRecurringEvent_live() {
  var result = createCalendarEvent({
    title: '[TEST] Recurring Series',
    occurrences: [
      { date: '2026-08-10', start_time: '19:00', end_time: '20:00' },
      { date: '2026-08-17', start_time: '19:00', end_time: '20:00' },
      { date: '2026-08-24', start_time: '19:00', end_time: '20:00' },
      { date: '2026-08-31', start_time: '19:00', end_time: '20:00' }
    ],
    location: '', description: 'Live recurrence test.'
  });
  if (result.error) throw new Error(result.error);

  var calendarId = PropertiesService.getScriptProperties().getProperty('CALENDAR_ID');
  try {
    if (result.method !== 'rrule') throw new Error('expected rrule, got ' + result.method);

    var items = Calendar.Events.instances(calendarId, result.eventId, {
      timeMin: '2026-08-01T00:00:00Z', timeMax: '2026-09-30T23:59:59Z'
    }).items;
    if (items.length !== 4) throw new Error('expected exactly 4 instances, got ' + items.length);

    var got = items.map(function (i) { return i.start.dateTime.slice(0, 10); }).join(',');
    if (got !== '2026-08-10,2026-08-17,2026-08-24,2026-08-31') {
      throw new Error('wrong instance dates: ' + got);
    }
  } finally {
    Calendar.Events.remove(calendarId, result.eventId);
  }
  Logger.log('test_createRecurringEvent_live: ALL PASSED');
}

function test_createRecurringWithException_live() {
  var result = createCalendarEvent({
    title: '[TEST] Recurring With Exception',
    occurrences: [
      { date: '2026-08-10', start_time: '19:00', end_time: '20:00' },
      { date: '2026-08-17', start_time: '19:00', end_time: '20:00' },
      { date: '2026-08-24', start_time: '18:00', end_time: '20:00' }
    ],
    location: '', description: 'Live exception test.'
  });
  if (result.error) throw new Error(result.error);

  var calendarId = PropertiesService.getScriptProperties().getProperty('CALENDAR_ID');
  try {
    if (result.warnings.length) throw new Error('unexpected warnings: ' + result.warnings.join('; '));

    var items = Calendar.Events.instances(calendarId, result.eventId, {
      timeMin: '2026-08-01T00:00:00Z', timeMax: '2026-09-30T23:59:59Z'
    }).items;
    var odd = items.filter(function (i) { return i.start.dateTime.indexOf('2026-08-24') === 0; })[0];
    if (!odd) throw new Error('could not find the Aug 24 instance');
    if (odd.start.dateTime.indexOf('T18:00') < 0) {
      throw new Error('Aug 24 should start at 18:00, got ' + odd.start.dateTime);
    }
  } finally {
    Calendar.Events.remove(calendarId, result.eventId);
  }
  Logger.log('test_createRecurringWithException_live: ALL PASSED');
}
```

**Step 2: Push and run**

```bash
./deploy.sh
```

Then in the Apps Script editor run, in order, checking the Execution log for `ALL PASSED`:
1. `test_createAndDeleteEvent` — the pre-existing single-event path must still pass
2. `test_duplicateDetection`
3. `test_createRecurringEvent_live`
4. `test_createRecurringWithException_live`

**If any fail, stop and fix before continuing.**

**Step 3: End-to-end check in the web app**

Open the web app URL (signed in as **mike.miller@atxveg.org** — signing in as `mikem.exe@gmail.com` 404s the `/exec` URL) and paste:

`https://www.meetup.com/vegan-adventure-club-austin-tx/events/315806303/`

Verify:
- Four date rows appear: 2026-08-10, 08-17, 08-24, 08-31, all 19:00–20:00.
- Banner reads approximately: *"↻ Repeating event — every week on Monday, 4 occurrences (Aug 10 – Aug 31). Created as one repeating calendar event."*
- Change one row's start time to 18:00 → banner gains the "1 date has a different time" sentence and that row shows the `diff` tag.
- Change it back, remove a row → banner updates to 3 occurrences.
- Submit → result reads "Created one repeating event with 4 occurrences", and Google Calendar shows one series on exactly those four Mondays with the flyer attached.

**Step 4: Delete the test event from Google Calendar.**

**Step 5: Commit**

```bash
git add src/CalendarService.gs
git commit -m "test: add live recurrence and exception-patching tests"
```

---

## Task 19: Update the README and merge

**Files:**
- Modify: `README.md`

**Step 1: Document the behavior** — add after the "How it works" section:

```markdown
### Multi-date events

If an event page lists several dates (e.g. a book club meeting four Mondays in a
row), all of them are extracted. The confirmation screen shows every date with
its own start and end time — editable, removable, and extendable — plus a banner
stating exactly how the event will be created:

- **Repeating** — dates that fit a pattern become one repeating calendar event.
- **Repeating with a custom date list** — irregular dates still become one event.
- **Separate events** — only if creating a repeating event fails.

Series are pinned with `COUNT`, so only the dates shown are ever created. If one
date starts at a different time, that occurrence is adjusted individually and
flagged with a `diff` tag.
```

**Step 2: Full local suite**

Run: `node tests/run.js RecurrenceService.gs Utilities.gs Extraction.gs`
Expected: `0 failed`.

**Step 3: Commit and merge**

```bash
git add README.md
git commit -m "docs: document multi-date event support"
git checkout main
git merge --no-ff multi-date-events
```

**Step 4: Deploy**

```bash
./deploy.sh
```

Confirm the bookmarked web app URL still loads and a single-date event still works end to end.

---

## Risks to watch

| Risk | Mitigation |
|---|---|
| Claude enumerates dates the page didn't state | Prompt forbids extrapolating past shown dates; every date is visible and editable before submit |
| Google Calendar's web UI cannot edit an `RDATE` rule | Only reached for genuinely irregular dates; instances remain individually deletable. Accepted trade-off (user chose this over duplication) |
| `Calendar.Events.instances` not immediately populated after insert | Patch failures are collected as warnings, not aborts; the series is still correct |
| A 400ms-debounced `planRecurrence` call per keystroke feels slow | The banner is advisory only; submit re-plans server-side regardless |
| `addHours_` moved between files | GAS shares one global scope, so callers are unaffected; `test_createAndDeleteEvent` in Task 18 confirms |
