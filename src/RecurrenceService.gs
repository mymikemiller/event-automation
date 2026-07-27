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
