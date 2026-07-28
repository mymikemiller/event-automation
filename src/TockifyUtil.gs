function test_tockifyUtil() {
  // tockifyImageName_ — Tockify names the library entry from this
  var nameCases = [
    ['https://scontent.example.com/v/t39/758244966_1023.webp?stp=dst&oh=abc',
     '758244966_1023.webp'],
    ['https://example.com/a/b/flyer.png', 'flyer.png'],
    ['https://example.com/img/My%20Flyer.jpg', 'My Flyer.jpg'],
    ['https://example.com/', 'event-image']
  ];
  nameCases.forEach(function (c) {
    var got = tockifyImageName_(c[0]);
    if (got !== c[1]) throw new Error('tockifyImageName_(' + c[0] + ') -> ' + got + ', want ' + c[1]);
  });

  // tockifyCdnUrl_
  if (tockifyCdnUrl_('abc-123') !== 'https://up.tockify.com/abc-123/') {
    throw new Error('tockifyCdnUrl_ wrong');
  }

  // tockifyMatchEvent_ — must match on title AND start time
  var events = [
    { eid: { uid: '11' }, content: { summary: { text: 'Other' } }, when: { start: { millis: 100 } } },
    { eid: { uid: '42' }, content: { summary: { text: 'Potluck' } }, when: { start: { millis: 200 } } },
    { eid: { uid: '43' }, content: { summary: { text: 'Potluck' } }, when: { start: { millis: 999 } } }
  ];
  if (tockifyMatchEvent_(events, 'Potluck', 200) !== '42') throw new Error('match failed');
  if (tockifyMatchEvent_(events, 'Potluck', 555) !== null) throw new Error('should not match wrong time');
  if (tockifyMatchEvent_(events, 'Nope', 200) !== null) throw new Error('should not match wrong title');
  if (tockifyMatchEvent_([], 'Potluck', 200) !== null) throw new Error('empty list should be null');
  if (tockifyMatchEvent_(null, 'Potluck', 200) !== null) throw new Error('null list should be null');

  // tockifySessionCookie_ — Set-Cookie may be a string or an array
  var arr = ['_ga=GA1.1.x; Path=/', 'TKFSession=abc-def; Path=/; HttpOnly'];
  if (tockifySessionCookie_(arr) !== 'TKFSession=abc-def') throw new Error('array parse failed');
  if (tockifySessionCookie_('TKFSession=zzz; HttpOnly') !== 'TKFSession=zzz') throw new Error('string parse failed');
  if (tockifySessionCookie_('_ga=1; Path=/') !== null) throw new Error('should be null when absent');
  if (tockifySessionCookie_(null) !== null) throw new Error('null should be null');

  // tockifyShouldGiveUp_
  var now = 1000000;
  if (tockifyShouldGiveUp_({ firstSeen: now - 60000 }, now)) throw new Error('1min should not give up');
  if (!tockifyShouldGiveUp_({ firstSeen: now - TOCKIFY_GIVE_UP_MS - 1 }, now)) throw new Error('past deadline should give up');

  // tockifyStartMillis_ — matches the local timezone the runner pins
  var ms = tockifyStartMillis_({ date: '2026-08-10', start_time: '18:30' });
  var back = new Date(ms);
  if (back.getFullYear() !== 2026 || back.getMonth() !== 7 || back.getDate() !== 10) {
    throw new Error('tockifyStartMillis_ wrong date');
  }
  if (back.getHours() !== 18 || back.getMinutes() !== 30) {
    throw new Error('tockifyStartMillis_ wrong time');
  }

  Logger.log('test_tockifyUtil: ALL PASSED');
}

var TOCKIFY_CALID = '698678eaaea5aa1bccb5edcc';
var TOCKIFY_CALNAME = 'austin.vegan.events';
var UPLOADCARE_PUB_KEY = 'e14168cd40d42bd3b36c';
var TOCKIFY_GIVE_UP_MS = 2 * 60 * 60 * 1000;
var TOCKIFY_QUEUE_KEY = 'TOCKIFY_IMAGE_QUEUE';

/**
 * Filename Tockify should use for the image library entry, taken from the
 * source URL. Query strings are stripped — Facebook CDN URLs carry signed
 * parameters that are not part of the name.
 * @param {string} url
 * @returns {string}
 */
function tockifyImageName_(url) {
  var path = String(url).split('?')[0].split('#')[0];
  var name = path.substring(path.lastIndexOf('/') + 1);
  try { name = decodeURIComponent(name); } catch (e) { /* leave encoded */ }
  return name || 'event-image';
}

/**
 * The up.tockify.com CDN URL for an Uploadcare uuid. This — not the uuid —
 * is what POST /api/imageset expects.
 * @param {string} uuid
 * @returns {string}
 */
function tockifyCdnUrl_(uuid) {
  return 'https://up.tockify.com/' + uuid + '/';
}

/**
 * Finds the uid of the event matching both title and start time.
 * Title alone is not enough — repeating events share a title.
 * @param {Array} events - from GET /api/ngevent
 * @param {string} title
 * @param {number} startMillis
 * @returns {string|null}
 */
function tockifyMatchEvent_(events, title, startMillis) {
  if (!events || !events.length) return null;
  for (var i = 0; i < events.length; i++) {
    var e = events[i];
    var t = e && e.content && e.content.summary && e.content.summary.text;
    var s = e && e.when && e.when.start && e.when.start.millis;
    if (t === title && s === startMillis) {
      return (e.eid && e.eid.uid) ? e.eid.uid : null;
    }
  }
  return null;
}

/**
 * Pulls the TKFSession cookie out of a Set-Cookie header.
 * UrlFetchApp gives a string for one cookie and an array for several.
 * @param {string|Array|null} setCookie
 * @returns {string|null} e.g. "TKFSession=abc-def"
 */
function tockifySessionCookie_(setCookie) {
  if (setCookie === null || setCookie === undefined) return null;
  var list = (setCookie instanceof Array) ? setCookie : [setCookie];
  for (var i = 0; i < list.length; i++) {
    var m = String(list[i]).match(/(?:^|[;,\s])TKFSession=([^;,\s]+)/);
    if (m) return 'TKFSession=' + m[1];
  }
  return null;
}

/**
 * Whether a queued job has waited long enough to be abandoned.
 * @param {Object} job
 * @param {number} now - epoch ms
 * @returns {boolean}
 */
function tockifyShouldGiveUp_(job, now) {
  return (now - job.firstSeen) >= TOCKIFY_GIVE_UP_MS;
}

/**
 * Epoch milliseconds for an occurrence, matching Tockify's when.start.millis.
 *
 * Builds the Date from local parts, so this is only correct while the script's
 * runtime timezone matches the calendar's. Both are America/Chicago — the
 * runtime's comes from the `timeZone` field in appsscript.json. Change one and
 * you must change the other, or every lookup will miss by the offset.
 *
 * @param {{date: string, start_time: string}} occurrence - YYYY-MM-DD and HH:MM
 * @returns {number}
 */
function tockifyStartMillis_(occurrence) {
  var d = occurrence.date.split('-');
  var t = (occurrence.start_time || '00:00').split(':');
  return new Date(
    parseInt(d[0], 10), parseInt(d[1], 10) - 1, parseInt(d[2], 10),
    parseInt(t[0], 10), parseInt(t[1], 10), 0, 0
  ).getTime();
}
