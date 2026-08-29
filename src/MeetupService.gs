// ---------------------------------------------------------------------------
// Config. Adding a group is appending its slug — Meetup event IDs are globally
// unique, not per-group, so nothing else here is per-group.
// ---------------------------------------------------------------------------

var MEETUP_GROUPS = ['vegaustin'];
var MEETUP_NOTIFY_EMAIL = 'mike.miller@atxveg.org';

// The bookmarked web app URL, kept in step with deploy.sh. ScriptApp
// .getService().getUrl() only returns a usable value inside doGet, not from a
// time-driven trigger, so it cannot be read when the notification mail is sent.
var MEETUP_WEBAPP_URL = 'https://script.google.com/a/macros/atxveg.org/s/AKfycbx_zs0uCLGSxxB3btHhF3ehvdM_3CL2BHK_P0SuCYyRh2FJ61dv21snaSwisHDCb7Fe/exec';

// ---------------------------------------------------------------------------

/**
 * Fetches and parses one group's public iCal feed.
 *
 * The feed needs no auth and no API key, which is why it is preferred over
 * scraping the group page through Claude or holding OAuth credentials for
 * Meetup's GraphQL API.
 *
 * @param {string} slug - e.g. 'vegaustin'
 * @returns {{events: Array<Object>}|{error: string}}
 */
function meetupFetchGroupEvents_(slug) {
  var url = 'https://www.meetup.com/' + encodeURIComponent(slug) + '/events/ical/';
  var resp;

  try {
    resp = UrlFetchApp.fetch(url, {
      muteHttpExceptions: true,
      followRedirects: true,
      headers: { 'Accept': 'text/calendar' }
    });
  } catch (e) {
    return { error: 'fetch threw for ' + slug + ': ' + e.message };
  }

  var code = resp.getResponseCode();
  if (code !== 200) {
    return { error: 'feed for ' + slug + ' returned HTTP ' + code };
  }

  var body = resp.getContentText();
  if (body.indexOf('BEGIN:VCALENDAR') === -1) {
    return { error: 'feed for ' + slug + ' was not iCalendar — the URL may have moved' };
  }

  return { events: meetupParseIcal_(body) };
}

// Shaped like the live vegaustin feed fetched 2026-08-08: CRLF line endings, a
// VTIMEZONE block carrying its own DTSTART/RRULE, folded long lines, and
// escaped commas in text values.
var MEETUP_TEST_ICAL = [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'PRODID:-//Meetup//Meetup Calendar 1.0//EN',
  'X-WR-CALNAME:Austin Vegan Association',
  'BEGIN:VTIMEZONE',
  'TZID:America/Chicago',
  'BEGIN:DAYLIGHT',
  'TZOFFSETFROM:-0600',
  'TZNAME:CDT',
  'DTSTART:19700308T020000',
  'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU',
  'END:DAYLIGHT',
  'END:VTIMEZONE',
  'BEGIN:VEVENT',
  'UID:event_315879117@meetup.com',
  'DTSTART;TZID=America/Chicago:20260808T183000',
  'DTEND;TZID=America/Chicago:20260808T203000',
  'SUMMARY:Vegan Potluck & VegFest Support Rally',
  'URL;VALUE=URI:https://www.meetup.com/vegaustin/events/315879117/',
  'STATUS:CONFIRMED',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'UID:event_315879713@meetup.com',
  'DTSTART;TZID=America/Chicago:20260823T170000',
  // Folded across three lines, and with an escaped comma.
  'SUMMARY:Dinner at Mission Burger Co. (NEW Mueller Location!)\\, plus a very ',
  ' long title that Meetup wrapped onto a continuation line to stay inside the ',
  ' 75 octet limit',
  'URL;VALUE=URI:https://www.meetup.com/vegaustin/events/315879713/',
  'STATUS:CONFIRMED',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'UID:event_999999999@meetup.com',
  'DTSTART;TZID=America/Chicago:20260901T120000',
  'SUMMARY:Cancelled Thing',
  'URL;VALUE=URI:https://www.meetup.com/vegaustin/events/999999999/',
  'STATUS:CANCELLED',
  'END:VEVENT',
  'END:VCALENDAR'
].join('\r\n');

function test_meetupParseIcal_skipsVtimezone() {
  var events = meetupParseIcal_(MEETUP_TEST_ICAL);

  // The VTIMEZONE block holds DTSTART:19700308T020000. A parser that scans the
  // whole file for DTSTART invents a 1970 event and corrupts the real ones.
  events.forEach(function (e) {
    if (e.startLocal.indexOf('1970') === 0) {
      throw new Error('parsed a VTIMEZONE DTSTART as an event: ' + e.startLocal);
    }
  });

  // Three VEVENTs, one of them CANCELLED and dropped.
  if (events.length !== 2) {
    throw new Error('expected 2 live events, got ' + events.length +
      ' (' + events.map(function (e) { return e.id; }).join(', ') + ')');
  }

  Logger.log('test_meetupParseIcal_skipsVtimezone: PASSED');
}

function test_meetupParseIcal_fields() {
  var e = meetupParseIcal_(MEETUP_TEST_ICAL)[0];

  var expected = {
    id: '315879117',
    title: 'Vegan Potluck & VegFest Support Rally',
    url: 'https://www.meetup.com/vegaustin/events/315879117/',
    tzid: 'America/Chicago',
    startLocal: '20260808T183000'
  };

  Object.keys(expected).forEach(function (k) {
    if (e[k] !== expected[k]) {
      throw new Error('event.' + k + ' → ' + JSON.stringify(e[k]) +
        ', expected ' + JSON.stringify(expected[k]));
    }
  });

  Logger.log('test_meetupParseIcal_fields: PASSED');
}

function test_meetupParseIcal_unfoldsAndUnescapes() {
  var e = meetupParseIcal_(MEETUP_TEST_ICAL)[1];

  var expected = 'Dinner at Mission Burger Co. (NEW Mueller Location!), plus a ' +
    'very long title that Meetup wrapped onto a continuation line to stay ' +
    'inside the 75 octet limit';

  if (e.title !== expected) {
    throw new Error('folded SUMMARY → ' + JSON.stringify(e.title) +
      ', expected ' + JSON.stringify(expected));
  }

  Logger.log('test_meetupParseIcal_unfoldsAndUnescapes: PASSED');
}

function test_meetupParseIcal_empty() {
  if (meetupParseIcal_('').length !== 0) throw new Error('expected [] for empty input');
  if (meetupParseIcal_('BEGIN:VCALENDAR\r\nEND:VCALENDAR').length !== 0) {
    throw new Error('expected [] for a calendar with no events');
  }
  Logger.log('test_meetupParseIcal_empty: PASSED');
}

function test_meetupIdsInText() {
  // A real description: the RSVP link plus unrelated prose.
  var desc = 'Join us!\n\n<a href="https://www.meetup.com/vegaustin/events/315879117/">RSVP on Meetup</a>';
  var got = meetupIdsInText_(desc);
  if (got.length !== 1 || got[0] !== '315879117') {
    throw new Error('expected ["315879117"], got ' + JSON.stringify(got));
  }

  // The trap again, at description level: the path ID wins, the query-string
  // eventId must not appear at all.
  var trap = meetupIdsInText_('meetup.com/vegaustin/events/313891224/?slug=vegaustin&eventId=307154188');
  if (trap.length !== 1 || trap[0] !== '313891224') {
    throw new Error('expected only the path ID, got ' + JSON.stringify(trap));
  }

  // Several links in one description, deduplicated.
  var many = meetupIdsInText_(
    'meetup.com/vegaustin/events/111/ and meetup.com/other-group/events/222 and meetup.com/vegaustin/events/111/'
  );
  if (many.join(',') !== '111,222') {
    throw new Error('expected ["111","222"], got ' + JSON.stringify(many));
  }

  if (meetupIdsInText_('').length !== 0) throw new Error('expected [] for empty text');
  if (meetupIdsInText_('no links here').length !== 0) throw new Error('expected [] when unlinked');

  Logger.log('test_meetupIdsInText: PASSED');
}

function test_meetupPruneNotified() {
  var notified = { '111': 'vegaustin', '222': 'vegaustin', '333': 'othergroup' };

  // 111 still upcoming, 222 has left the feed, othergroup fetched fine and no
  // longer lists 333.
  var kept = meetupPruneNotified_(
    notified,
    { vegaustin: { '111': true }, othergroup: {} },
    []
  );
  if (Object.keys(kept).sort().join(',') !== '111') {
    throw new Error('expected only 111 kept, got ' + JSON.stringify(kept));
  }

  // othergroup's fetch FAILED this run. Its IDs must survive, or the next good
  // run re-emails them.
  var keptOnFailure = meetupPruneNotified_(
    notified,
    { vegaustin: { '111': true } },
    ['othergroup']
  );
  if (Object.keys(keptOnFailure).sort().join(',') !== '111,333') {
    throw new Error('a failed group must keep its IDs, got ' + JSON.stringify(keptOnFailure));
  }

  Logger.log('test_meetupPruneNotified: PASSED');
}

function test_meetupApproxInstant() {
  var got = meetupApproxInstant_('20260808T183000');
  var expected = Date.UTC(2026, 7, 8, 18, 30, 0);
  if (got !== expected) {
    throw new Error('meetupApproxInstant_ → ' + new Date(got).toISOString() +
      ', expected ' + new Date(expected).toISOString());
  }
  Logger.log('test_meetupApproxInstant: PASSED');
}

function test_meetupPrettyTime() {
  var cases = [
    ['20260808T183000', '6:30 PM'],
    ['20260830T123000', '12:30 PM'],  // noon is 12 PM, not 0 PM
    ['20260830T000000', '12:00 AM'],  // midnight is 12 AM, not 0 AM
    ['20260830T090500', '9:05 AM']
  ];
  cases.forEach(function (c) {
    var got = meetupPrettyTime_(c[0]);
    if (got !== c[1]) throw new Error(c[0] + ' → ' + got + ', expected ' + c[1]);
  });
  Logger.log('test_meetupPrettyTime: PASSED');
}

// Stand-in for Utilities.formatDate, which the Node harness has no access to.
// The real job injects the Apps Script version. Fixed CDT offset is fine here:
// every fixture start is in August.
function meetupTestFormatLocal_(date, tzid) {
  if (tzid !== 'America/Chicago') throw new Error('fixture only models America/Chicago');
  var d = new Date(date.getTime() - 5 * 3600 * 1000); // CDT = UTC-5
  var p = function (n, w) { return ('' + n).length >= w ? '' + n : ('0000' + n).slice(-w); };
  return p(d.getUTCFullYear(), 4) + p(d.getUTCMonth() + 1, 2) + p(d.getUTCDate(), 2) +
    'T' + p(d.getUTCHours(), 2) + p(d.getUTCMinutes(), 2) + p(d.getUTCSeconds(), 2);
}

// 2026-08-08 18:30 CDT, the real start of the potluck.
var MEETUP_TEST_EVENT = {
  id: '315879117',
  title: 'Vegan Potluck & VegFest Support Rally',
  tzid: 'America/Chicago',
  startLocal: '20260808T183000'
};
var MEETUP_TEST_START = new Date(Date.UTC(2026, 7, 8, 23, 30, 0));

function test_meetupIsOnCalendar_matchesById() {
  // Title and start both differ; only the RSVP link ties them together.
  var cal = [{
    meetupIds: ['315879117'],
    title: 'Potluck (renamed by hand)',
    start: new Date(Date.UTC(2026, 7, 9, 1, 0, 0))
  }];

  if (!meetupIsOnCalendar_(MEETUP_TEST_EVENT, cal, meetupTestFormatLocal_)) {
    throw new Error('expected an ID match to count as already-calendared');
  }
  Logger.log('test_meetupIsOnCalendar_matchesById: PASSED');
}

function test_meetupIsOnCalendar_matchesByTitleAndStart() {
  // No RSVP link at all — the fallback has to carry it.
  var cal = [{ meetupIds: [], title: MEETUP_TEST_EVENT.title, start: MEETUP_TEST_START }];

  if (!meetupIsOnCalendar_(MEETUP_TEST_EVENT, cal, meetupTestFormatLocal_)) {
    throw new Error('expected title+start to count as already-calendared');
  }
  Logger.log('test_meetupIsOnCalendar_matchesByTitleAndStart: PASSED');
}

function test_meetupIsOnCalendar_rejectsPartialMatches() {
  var sameTitleOtherTime = [{
    meetupIds: [],
    title: MEETUP_TEST_EVENT.title,
    start: new Date(Date.UTC(2026, 7, 15, 23, 30, 0))
  }];
  if (meetupIsOnCalendar_(MEETUP_TEST_EVENT, sameTitleOtherTime, meetupTestFormatLocal_)) {
    throw new Error('a recurring event at a different time is NOT this event');
  }

  var sameTimeOtherTitle = [{ meetupIds: [], title: 'Something Else', start: MEETUP_TEST_START }];
  if (meetupIsOnCalendar_(MEETUP_TEST_EVENT, sameTimeOtherTitle, meetupTestFormatLocal_)) {
    throw new Error('an unrelated event starting at the same instant is NOT this event');
  }

  var otherId = [{ meetupIds: ['307154188'], title: 'x', start: MEETUP_TEST_START }];
  if (meetupIsOnCalendar_(MEETUP_TEST_EVENT, otherId, meetupTestFormatLocal_)) {
    throw new Error('a different meetup ID is NOT this event');
  }

  if (meetupIsOnCalendar_(MEETUP_TEST_EVENT, [], meetupTestFormatLocal_)) {
    throw new Error('an empty calendar matches nothing');
  }

  Logger.log('test_meetupIsOnCalendar_rejectsPartialMatches: PASSED');
}

function test_meetupWebAppLink() {
  var link = meetupWebAppLink_('https://www.meetup.com/vegaustin/events/316302553/');
  if (link !== MEETUP_WEBAPP_URL +
      '?url=https%3A%2F%2Fwww.meetup.com%2Fvegaustin%2Fevents%2F316302553%2F') {
    throw new Error('unexpected link: ' + link);
  }
  // The slashes have to be encoded, not passed through: an unescaped one ends
  // the /exec path as far as some mail clients' auto-linkers are concerned.
  if (link.indexOf('meetup.com/vegaustin') >= 0) throw new Error('event URL was not encoded');

  // No URL to hand over is not a reason to send a broken link.
  if (meetupWebAppLink_('') !== MEETUP_WEBAPP_URL) throw new Error('empty URL should give the bare web app URL');

  Logger.log('test_meetupWebAppLink: ALL PASSED');
}

function test_meetupExtractEventId() {
  var cases = [
    // Plain canonical URL, with and without the trailing slash.
    ['https://www.meetup.com/vegaustin/events/315879117/', '315879117'],
    ['https://www.meetup.com/vegaustin/events/315879117', '315879117'],
    // Real calendar entry whose QUERY STRING carries a different eventId than
    // the path. Anything not anchored on the path pairs the wrong events.
    ['meetup.com/vegaustin/events/313891224/?slug=vegaustin&eventId=307154188&isFirstPublish=true', '313891224'],
    // Share/tracking query strings seen on the live calendar.
    ['meetup.com/vegan-adventure-club-austin-tx/events/314564938/?utm_medium=referral&member_id=8769368', '314564938'],
    ['meetup.com/vegaustin/events/313482523/?eventOrigin=group_upcoming_events', '313482523'],
    ['meetup.com/vegan-adventure-club-austin-tx/events/315320570/?_xtd=gqFypzg3NjkzNjihcKNhcGk%253D&from=ref', '315320570'],
    // Group-level URL: no event ID to extract.
    ['https://www.meetup.com/vegan-adventure-club-austin-tx/events/', null],
    // Meetup click-tracking redirect: the ID is not recoverable without a fetch.
    ['meetup.com/ls/click?upn=u001.NY3oBFzZ5LJDG7YcnfSAKsQAD0GnFi1zzMJ-2FAp8', null],
    // Not Meetup at all.
    ['https://www.example.com/events/12345/', null],
    ['', null],
    [null, null]
  ];

  cases.forEach(function (c) {
    var got = meetupExtractEventId_(c[0]);
    if (got !== c[1]) {
      throw new Error('meetupExtractEventId_(' + JSON.stringify(c[0]) + ') → ' +
        JSON.stringify(got) + ', expected ' + JSON.stringify(c[1]));
    }
  });

  Logger.log('test_meetupExtractEventId: ALL PASSED');
}

/**
 * Every distinct Meetup event ID linked from a block of text, in first-seen
 * order. Path-anchored for the reason given on meetupExtractEventId_.
 * @param {string} text
 * @returns {Array<string>}
 */
function meetupIdsInText_(text) {
  var ids = [];
  if (!text) return ids;
  var re = /meetup\.com\/[^\/\s]+\/events\/(\d+)/gi;
  var m;
  while ((m = re.exec(text)) !== null) {
    if (ids.indexOf(m[1]) === -1) ids.push(m[1]);
  }
  return ids;
}

/**
 * Drops remembered IDs that have left the feed, keeping everything belonging to
 * a group whose fetch failed this run.
 *
 * Meetup does not reuse event IDs, so an event that has left the upcoming feed
 * cannot return and its ID is dead weight — which is what keeps the stored map
 * inside the 9KB ScriptProperties value limit indefinitely.
 *
 * @param {Object} notified - id -> slug
 * @param {Object} seenBySlug - slug -> {id: true}, only for groups that fetched
 * @param {Array<string>} failedSlugs
 * @returns {Object} pruned id -> slug
 */
function meetupPruneNotified_(notified, seenBySlug, failedSlugs) {
  var kept = {};
  Object.keys(notified).forEach(function (id) {
    var slug = notified[id];
    if (failedSlugs.indexOf(slug) !== -1) kept[id] = slug;               // unknowable this run
    else if (seenBySlug[slug] && seenBySlug[slug][id]) kept[id] = slug;  // still upcoming
  });
  return kept;
}

/**
 * Reads 'yyyyMMddTHHmmss' as though it were UTC. Used to size the calendar
 * query window, which is padded by a day, and to render the date in the email —
 * neither of which can be shifted by the missing offset.
 * @param {string} startLocal
 * @returns {number} epoch millis
 */
function meetupApproxInstant_(startLocal) {
  return Date.UTC(
    +startLocal.slice(0, 4), +startLocal.slice(4, 6) - 1, +startLocal.slice(6, 8),
    +startLocal.slice(9, 11), +startLocal.slice(11, 13), +startLocal.slice(13, 15)
  );
}

/**
 * '20260808T183000' -> '6:30 PM'
 * @param {string} startLocal
 * @returns {string}
 */
function meetupPrettyTime_(startLocal) {
  var h = +startLocal.slice(9, 11);
  var m = startLocal.slice(11, 13);
  var ampm = h >= 12 ? 'PM' : 'AM';
  var h12 = h % 12 === 0 ? 12 : h % 12;
  return h12 + ':' + m + ' ' + ampm;
}

/**
 * Is this Meetup event already on the Google Calendar?
 *
 * Two rules, OR'd:
 *   1. A calendar event whose description links to this Meetup event ID. Exact
 *      identity, and the reason the RSVP link is worth relying on.
 *   2. Byte-identical title AND identical start wall clock. Needed because the
 *      RSVP link is only usually present — events entered straight into Google
 *      Calendar may carry no link at all.
 *
 * OR rather than AND is deliberate. Notification is once-per-event-ever, so a
 * false positive costs one stray email while a false negative means a real
 * event is never announced. Rule 2 only fires when title and start instant both
 * agree, which in practice means it is the same event, so it removes stray
 * emails at negligible risk of hiding a real one.
 *
 * Start comparison happens on wall-clock strings in the FEED's timezone, not on
 * absolute instants, so it stays correct for a group in any timezone without
 * doing timezone arithmetic by hand.
 *
 * @param {{id: string, title: string, tzid: string, startLocal: string}} mEvent
 * @param {Array<{meetupIds: Array<string>, title: string, start: Date}>} calEntries
 * @param {function(Date, string): string} formatLocal - (date, tzid) => 'yyyyMMddTHHmmss'
 * @returns {boolean}
 */
function meetupIsOnCalendar_(mEvent, calEntries, formatLocal) {
  for (var i = 0; i < calEntries.length; i++) {
    var entry = calEntries[i];

    if (entry.meetupIds && entry.meetupIds.indexOf(mEvent.id) !== -1) return true;

    if (entry.title && entry.title.trim() === mEvent.title.trim() &&
        entry.start && formatLocal(entry.start, mEvent.tzid) === mEvent.startLocal) {
      return true;
    }
  }
  return false;
}

/**
 * Parses a Meetup iCal feed into event records.
 *
 * Only VEVENT blocks are read. The VTIMEZONE block carries its own DTSTART and
 * RRULE (DTSTART:19700308T020000 for the US DST rule), so a parser that scans
 * the whole document for DTSTART invents 1970 events and misaligns the rest.
 *
 * Start times are kept as the feed's local wall clock plus its TZID rather than
 * converted to a Date. Conversion would depend on the runtime timezone, which
 * differs between Apps Script and the Node test harness; comparison against the
 * calendar happens on wall-clock strings instead. See meetupCalendarKey_.
 *
 * @param {string} icalText
 * @returns {Array<{id: string, title: string, url: string, tzid: string, startLocal: string}>}
 */
function meetupParseIcal_(icalText) {
  if (!icalText) return [];

  // RFC 5545 line folding: a CRLF followed by one space or tab continues the
  // previous line. Unfold before anything else or long SUMMARYs get truncated.
  var unfolded = String(icalText).replace(/\r\n/g, '\n').replace(/\n[ \t]/g, '');

  var events = [];
  var blocks = unfolded.split('BEGIN:VEVENT').slice(1);

  for (var i = 0; i < blocks.length; i++) {
    var block = blocks[i].split('END:VEVENT')[0];

    // Cancelled events are still listed. They are not news.
    if (/^STATUS:CANCELLED\s*$/m.test(block)) continue;

    var url = meetupIcalValue_(block, 'URL');
    var uid = meetupIcalValue_(block, 'UID');
    var start = block.match(/^DTSTART(;[^:\n]*)?:(\d{8}T\d{6})/m);

    // The UID is event_<id>@meetup.com; fall back to the URL if that changes.
    var id = (uid && uid.match(/(\d+)/) ? uid.match(/(\d+)/)[1] : null) ||
      meetupExtractEventId_(url);

    if (!id || !start) continue;

    var tzid = start[1] ? (start[1].match(/TZID=([^;:]+)/) || [])[1] : null;

    events.push({
      id: id,
      title: meetupIcalValue_(block, 'SUMMARY'),
      url: url,
      tzid: tzid || 'UTC',
      startLocal: start[2]
    });
  }

  return events;
}

/**
 * Reads one iCal property value out of an already-unfolded block, dropping any
 * property parameters (URL;VALUE=URI:...) and unescaping RFC 5545 text.
 * @param {string} block
 * @param {string} name
 * @returns {string} Empty string when absent.
 */
function meetupIcalValue_(block, name) {
  var m = block.match(new RegExp('^' + name + '(?:;[^:\\n]*)?:(.*)$', 'm'));
  if (!m) return '';
  return m[1]
    .replace(/\\n/gi, '\n')
    .replace(/\\,/g, ',')
    .replace(/\\;/g, ';')
    .replace(/\\\\/g, '\\')
    .trim();
}

/**
 * Pulls the numeric Meetup event ID out of a URL.
 *
 * Anchored on the /events/<id> PATH segment on purpose. A real entry on the
 * calendar reads:
 *   meetup.com/vegaustin/events/313891224/?slug=vegaustin&eventId=307154188
 * where the query string names a DIFFERENT event. Matching on a bare \d+, on
 * the last number, or on eventId= silently pairs the wrong events.
 *
 * Meetup event IDs are globally unique, not per-group, so the slug is ignored.
 *
 * @param {string} url
 * @returns {string|null} The ID, or null if this URL carries none.
 */
function meetupExtractEventId_(url) {
  if (!url) return null;
  var m = String(url).match(/meetup\.com\/[^\/\s]+\/events\/(\d+)/i);
  return m ? m[1] : null;
}

/**
 * The web app link for one event, with the event URL already in the box.
 *
 * The whole point of the notification mail is to hand over a single URL, so it
 * travels as `?url=` rather than as something to copy back out by hand. doGet
 * whitelists the value before printing it (safePrefillUrl_ in Code.gs), which
 * is why it has to be a plain encoded http(s) URL and nothing cleverer.
 *
 * @param {string} eventUrl
 * @returns {string} The web app URL, pre-filled when there is a URL to fill it with.
 */
function meetupWebAppLink_(eventUrl) {
  return eventUrl
    ? MEETUP_WEBAPP_URL + '?url=' + encodeURIComponent(eventUrl)
    : MEETUP_WEBAPP_URL;
}
