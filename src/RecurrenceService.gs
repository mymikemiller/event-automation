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

function test_planRecurrence_endOfMonthDates() {
  // "Last day of the month" is NOT a fixed day-of-month (31, 28, 31), so no
  // rule fits and these must go out as an explicit date list.
  var plan = planRecurrence_([
    { date: '2026-01-31', start_time: '19:00', end_time: '20:00' },
    { date: '2026-02-28', start_time: '19:00', end_time: '20:00' },
    { date: '2026-03-31', start_time: '19:00', end_time: '20:00' }
  ], 'America/Chicago');
  if (plan.method !== 'rdate') throw new Error('expected rdate, got ' + plan.method);
  if (plan.dates.length !== 3) throw new Error('all three dates must survive');
  Logger.log('test_planRecurrence_endOfMonthDates: ALL PASSED');
}

function test_verifierRejectsUnfaithfulRule() {
  // The fitters are exact by construction, so planRecurrence_ cannot currently
  // reach this branch. It exists as a guard against a future fitter that is
  // subtly wrong, so test the guard directly rather than through the planner.
  var dates = ['2026-01-31', '2026-02-28', '2026-03-31'];
  var wrong = 'RRULE:FREQ=MONTHLY;COUNT=3';
  var expanded = expandRule_(wrong, dates[0], dates.length);

  if (sameList_(expanded, dates)) {
    throw new Error('a monthly rule must NOT reproduce end-of-month dates');
  }
  if (expanded.join(',') !== '2026-01-31,2026-03-31,2026-05-31') {
    throw new Error('unexpected expansion: ' + expanded.join(','));
  }
  // And a faithful rule must be accepted, so the guard is not simply always-false.
  var good = ['2026-08-10', '2026-08-17', '2026-08-24'];
  if (!sameList_(expandRule_('RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=3', good[0], 3), good)) {
    throw new Error('a correct rule must verify');
  }
  Logger.log('test_verifierRejectsUnfaithfulRule: ALL PASSED');
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
  if (single.indexOf('7:00 PM') < 0) throw new Error('single should show 12h time: ' + single);

  var irregular = planRecurrence_([
    { date: '2026-08-10', start_time: '19:00', end_time: '20:00' },
    { date: '2026-09-03', start_time: '19:00', end_time: '20:00' }
  ], 'America/Chicago').summary;
  if (irregular.indexOf('custom date list') < 0) throw new Error('rdate summary: ' + irregular);

  var monthly = planRecurrence_([
    { date: '2026-08-11', start_time: '19:00', end_time: '20:00' },
    { date: '2026-09-08', start_time: '19:00', end_time: '20:00' },
    { date: '2026-10-13', start_time: '19:00', end_time: '20:00' }
  ], 'America/Chicago').summary;
  if (monthly.indexOf('second Tuesday') < 0) throw new Error('ordinal cadence: ' + monthly);

  Logger.log('test_summarizePlan: ALL PASSED');
}

var DOW_CODES = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
var MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                   'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
var DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
var DAY_NAMES_FULL = ['Sunday', 'Monday', 'Tuesday', 'Wednesday',
                      'Thursday', 'Friday', 'Saturday'];

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
