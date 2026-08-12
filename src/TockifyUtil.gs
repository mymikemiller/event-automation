function test_tockifyUtil() {
  // tockifyAvaHost_ — three states, because only the short link costs a fetch
  var hostCases = [
    // Canonical AVA event URLs, with and without the trailing slash.
    ['https://www.meetup.com/vegaustin/events/315879624/', 'yes'],
    ['https://www.meetup.com/vegaustin/events/315879624', 'yes'],
    ['meetup.com/vegaustin/events/313482523/?eventOrigin=group_upcoming_events', 'yes'],
    // The mispair trap: the QUERY STRING names vegaustin, the PATH names the
    // group that actually hosts it. Anything not anchored on the path tags
    // other groups' events as ours.
    ['meetup.com/vegan-adventure-club-austin-tx/events/314564938/?slug=vegaustin', 'no'],
    // And the inverse — path is AVA, query names another group.
    ['meetup.com/vegaustin/events/313891224/?slug=other-group&eventId=307154188', 'yes'],
    // Another group.
    ['https://www.meetup.com/vegan-adventure-club-austin-tx/events/314564938/', 'no'],
    // Shortened and tracked forms: not decidable without a fetch.
    ['https://meetu.ps/e/Qbwn8/1qvFq/i', 'unknown'],
    ['meetu.ps/e/Qbwn8/1qvFq/i', 'unknown'],
    ['meetup.com/ls/click?upn=u001.NY3oBFzZ5LJDG7YcnfSAKsQAD0GnFi1zzMJ-2FAp8', 'unknown'],
    // A lookalike domain must not read as Meetup.
    ['https://notmeetup.com/vegaustin/events/315879624/', 'no'],
    // Group-level URL carries no event; not an event link.
    ['https://www.meetup.com/vegaustin/', 'no'],
    // Not Meetup at all, and the empty cases.
    ['https://www.facebook.com/events/1234567890/', 'no'],
    ['', 'no'],
    [null, 'no'],
    [undefined, 'no']
  ];
  hostCases.forEach(function (c) {
    var got = tockifyAvaHost_(c[0]);
    if (got !== c[1]) {
      throw new Error('tockifyAvaHost_(' + JSON.stringify(c[0]) + ') -> ' + got + ', want ' + c[1]);
    }
  });

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
    { eid: { uid: '11' }, ctstamp: 1, content: { summary: { text: 'Other' } }, when: { start: { millis: 100 } } },
    { eid: { uid: '42' }, ctstamp: 1, content: { summary: { text: 'Potluck' } }, when: { start: { millis: 200 } } },
    { eid: { uid: '43' }, ctstamp: 1, content: { summary: { text: 'Potluck' } }, when: { start: { millis: 999 } } }
  ];
  if (tockifyMatchEvent_(events, 'Potluck', 200) !== '42') throw new Error('match failed');

  // Duplicates share a title and start time. The job was enqueued for the
  // event just created, so the newest must win — picking the first match
  // silently image-stamps an older copy and reports success.
  var dupes = [
    { eid: { uid: '127' }, ctstamp: 1000, content: { summary: { text: 'Movie Night' } }, when: { start: { millis: 500 } } },
    { eid: { uid: '129' }, ctstamp: 9000, content: { summary: { text: 'Movie Night' } }, when: { start: { millis: 500 } } }
  ];
  if (tockifyMatchEvent_(dupes, 'Movie Night', 500) !== '129') {
    throw new Error('duplicates: newest should win');
  }
  dupes.reverse(); // order from the API must not matter
  if (tockifyMatchEvent_(dupes, 'Movie Night', 500) !== '129') {
    throw new Error('duplicates: newest should win regardless of order');
  }
  // A match with no ctstamp must still be usable rather than discarded.
  var noStamp = [
    { eid: { uid: '77' }, content: { summary: { text: 'Solo' } }, when: { start: { millis: 5 } } }
  ];
  if (tockifyMatchEvent_(noStamp, 'Solo', 5) !== '77') throw new Error('missing ctstamp should still match');
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
var AVA_MEETUP_SLUG = 'vegaustin';
var AVA_TOCKIFY_TAG = 'Austin-Vegan-Association';

/**
 * Whether a submitted event URL points at an event Austin Vegan Association
 * hosts on Meetup.
 *
 * Three states rather than a boolean, because the answer is free for a
 * canonical URL and costs an HTTP round trip for a shortened one. Returning
 * 'unknown' lets the caller decide where to pay that cost — here, inside the
 * retryable background job rather than in submitEvent.
 *
 * The slug is read from the /events/ PATH segment, for the reason documented on
 * meetupExtractEventId_ (MeetupService.gs): a real entry on this calendar reads
 *   meetup.com/vegaustin/events/313891224/?slug=vegaustin&eventId=307154188
 * so a bare indexOf('vegaustin') also fires on another group's event that
 * merely carries ?slug=vegaustin, tagging events AVA does not host.
 *
 * Deliberately NOT tied to MEETUP_GROUPS — that is the notifier's watch list
 * and may grow to include groups AVA does not host.
 *
 * @param {string} url
 * @returns {string} 'yes' | 'no' | 'unknown'
 */
function tockifyAvaHost_(url) {
  if (!url) return 'no';
  var s = String(url);

  // (?:^|[\/.]) so notmeetup.com and meetup.com.evil.test do not match.
  var m = s.match(/(?:^|[\/.])meetup\.com\/([^\/\s?#]+)\/events\//i);
  if (m) return m[1].toLowerCase() === AVA_MEETUP_SLUG ? 'yes' : 'no';

  // Share shortener and Meetup's own click tracker: the group is recoverable
  // only by following the redirect.
  if (/(?:^|[\/.])meetu\.ps\//i.test(s)) return 'unknown';
  if (/(?:^|[\/.])meetup\.com\/ls\/click/i.test(s)) return 'unknown';

  return 'no';
}

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
 *
 * Title alone is not enough — repeating events share one. Nor is title plus
 * start time unique: the same event can be on the calendar twice, and taking
 * the first match then stamps the image onto an older copy and reports
 * success, leaving the event you just created untouched and silent. The job
 * was enqueued for the event just created, so the newest match wins.
 *
 * @param {Array} events - from GET /api/ngevent
 * @param {string} title
 * @param {number} startMillis
 * @returns {string|null}
 */
function tockifyMatchEvent_(events, title, startMillis) {
  if (!events || !events.length) return null;
  var best = null;
  for (var i = 0; i < events.length; i++) {
    var e = events[i];
    var t = e && e.content && e.content.summary && e.content.summary.text;
    var s = e && e.when && e.when.start && e.when.start.millis;
    if (t !== title || s !== startMillis) continue;
    if (!e.eid || !e.eid.uid) continue;
    if (!best || (e.ctstamp || 0) > (best.ctstamp || 0)) best = e;
  }
  return best ? best.eid.uid : null;
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
