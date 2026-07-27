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
