// Reads public Facebook events without logging in.
//
// Facebook server-renders the whole event into the page HTML for logged-out
// visitors — the "See more on Facebook" dialog is only a client-side overlay
// drawn on top of content that is already there. So there is nothing to click
// past server-side; we just need to ask for HTML and read the embedded JSON.
//
// See docs/plans/2026-07-27-facebook-no-login-plan.md for the measurements
// behind the two non-obvious rules below.

// ── Tests ─────────────────────────────────────────────────────────────────────

function test_fbFindString() {
  var s = '"name":"Movie Night","is_canceled":false,"day_time_sentence":"Sunday, August 2, 2026"';
  if (fbFindString_(s, 'day_time_sentence') !== 'Sunday, August 2, 2026') {
    throw new Error('day_time_sentence mismatch: ' + fbFindString_(s, 'day_time_sentence'));
  }
  if (fbFindString_(s, 'nope') !== null) throw new Error('missing key should be null');

  // Escaped quotes and slashes inside the value must not end it early.
  var esc = '"uri":"https:\\/\\/x.test\\/a?b=1&c=2","q":"say \\"hi\\" now"';
  if (fbFindString_(esc, 'uri') !== 'https://x.test/a?b=1&c=2') {
    throw new Error('slash unescape failed: ' + fbFindString_(esc, 'uri'));
  }
  if (fbFindString_(esc, 'q') !== 'say "hi" now') {
    throw new Error('quote unescape failed: ' + fbFindString_(esc, 'q'));
  }

  Logger.log('test_fbFindString: ALL PASSED');
}

function test_fbFindNumber() {
  var s = '"tz_display_name":"CDT","start_timestamp":1785677400,"end_timestamp":1785684600}';
  if (fbFindNumber_(s, 'start_timestamp') !== 1785677400) throw new Error('start mismatch');
  if (fbFindNumber_(s, 'end_timestamp') !== 1785684600) throw new Error('end mismatch');
  if (fbFindNumber_(s, 'absent') !== null) throw new Error('missing number should be null');
  Logger.log('test_fbFindNumber: ALL PASSED');
}

function test_fbLinkifyOffsets() {
  // THE regression test for this feature. Facebook counts link offsets in
  // Unicode codepoints; JS strings index in UTF-16 units. Three emoji ahead of
  // the URL put the two three apart, so a naive substr() slices mid-surrogate
  // and produces a broken href.
  var url = 'https://ex.test/abc';
  var text = '😊🎉✊ Link: ' + url + ' and more';

  var utf16Index = text.indexOf(url);
  var cpOffset = Array.from(text.substring(0, utf16Index)).length;
  if (cpOffset === utf16Index) throw new Error('fixture is not exercising the offset gap');

  var html = fbLinkify_(text, [{ url: url, offset: cpOffset, length: Array.from(url).length }]);

  if (html.indexOf('<a href="' + url + '">' + url + '</a>') < 0) {
    throw new Error('link not built correctly: ' + html);
  }
  if (html.indexOf('😊🎉✊ Link: ') !== 0) {
    throw new Error('emoji corrupted: ' + html);
  }

  // Using UTF-16 offsets instead would have sliced mid-emoji — prove it differs.
  var wrong = fbLinkify_(text, [{ url: url, offset: utf16Index, length: url.length }]);
  if (wrong === html) throw new Error('test cannot distinguish codepoint from utf16 offsets');

  Logger.log('test_fbLinkifyOffsets: ALL PASSED');
}

function test_fbLinkifyEscapesAndBreaks() {
  var html = fbLinkify_('a < b & c\n\nnext', []);
  if (html !== 'a &lt; b &amp; c<br><br>next') throw new Error('got: ' + html);

  // Out-of-bounds or overlapping ranges must be skipped, not throw.
  var safe = fbLinkify_('short', [{ url: 'https://x.test', offset: 2, length: 999 }]);
  if (safe !== 'short') throw new Error('bad range should be ignored: ' + safe);

  Logger.log('test_fbLinkifyEscapesAndBreaks: ALL PASSED');
}

function test_fbParseRanges() {
  // external_url must win over the l.facebook.com wrapper, whose signed `h`
  // token expires and would leave a dead link in the calendar event.
  var blob = '"ranges":[{"entity":{"__typename":"ExternalUrl",' +
    '"url":"https:\\/\\/l.facebook.com\\/l.php?u=https%3A%2F%2Fex.test&h=AUA7",' +
    '"external_url":"https:\\/\\/ex.test\\/full-path",' +
    '"web_link":{"url":"https:\\/\\/ex.test\\/full-path","fbclid":null}},' +
    '"entity_is_weak_reference":false,"length":19,"offset":7}]';

  var r = fbParseRanges_(blob);
  if (r.length !== 1) throw new Error('expected 1 range, got ' + r.length);
  if (r[0].url !== 'https://ex.test/full-path') throw new Error('should prefer external_url: ' + r[0].url);
  if (r[0].offset !== 7 || r[0].length !== 19) throw new Error('offset/length mismatch');

  if (fbParseRanges_('no ranges here').length !== 0) throw new Error('expected no ranges');

  Logger.log('test_fbParseRanges: ALL PASSED');
}

function test_fbParseEvent() {
  var html =
    '<meta property="og:title" content="Movie Night" />' +
    '<script type="application/json" data-sjs>{"data":{"event":' +
    '"is_canceled":false,"day_time_sentence":"Sunday, August 2, 2026 at 8:30 AM – 10:30 AM CDT",' +
    '"event_place":{"__typename":"FreeformPlace","name":"Pfluger Brg, Austin, TX"},' +
    '"cover_photo":{"photo":{"full_image":{"height":900,"uri":"https:\\/\\/scontent.test\\/img.webp?oh=1&oe=2"}}},' +
    '"event_description":{"text":"Hi 😊\\nLink: https:\\/\\/ex.test\\/abc",' +
    '"ranges":[{"entity":{"__typename":"ExternalUrl","external_url":"https:\\/\\/ex.test\\/abc"},' +
    // offset 11 = codepoint index of the URL in "Hi 😊\nLink: https://ex.test/abc"
    '"length":19,"offset":11}]},' +
    '"tz_display_name":"CDT","start_timestamp":1785677400,"end_timestamp":1785684600}</script>';

  var ev = parseFacebookEvent_(html);
  if (!ev) throw new Error('expected an event');
  if (ev.title !== 'Movie Night') throw new Error('title: ' + ev.title);
  if (ev.startTimestamp !== 1785677400) throw new Error('start: ' + ev.startTimestamp);
  if (ev.endTimestamp !== 1785684600) throw new Error('end: ' + ev.endTimestamp);
  if (ev.location.indexOf('Pfluger') < 0) throw new Error('location: ' + ev.location);
  if (ev.imageUrl !== 'https://scontent.test/img.webp?oh=1&oe=2') throw new Error('image: ' + ev.imageUrl);
  if (ev.descriptionHtml.indexOf('<a href="https://ex.test/abc">https://ex.test/abc</a>') < 0) {
    throw new Error('description link: ' + ev.descriptionHtml);
  }
  if (ev.dayTimeSentence.indexOf('August 2, 2026') < 0) throw new Error('sentence: ' + ev.dayTimeSentence);

  // A page with no event data returns null so the caller can fall back.
  if (parseFacebookEvent_('<html><body>nothing here</body></html>') !== null) {
    throw new Error('expected null for a non-event page');
  }

  Logger.log('test_fbParseEvent: ALL PASSED');
}

function test_fbFormatForClaude() {
  var block = formatFacebookEventForClaude_({
    title: 'Movie Night',
    dayTimeSentence: 'Sunday, August 2, 2026 at 8:30 AM – 10:30 AM CDT',
    startTimestamp: 1785677400, endTimestamp: 1785684600, timezone: 'CDT',
    location: 'Pfluger Brg, Austin, TX',
    descriptionHtml: 'Hi<br>more',
    imageUrl: 'https://scontent.test/img.webp'
  }, 'https://facebook.com/events/1/');

  if (block.indexOf('Movie Night') < 0) throw new Error('missing title');
  if (block.indexOf('Sunday, August 2, 2026') < 0) throw new Error('missing when');
  if (block.indexOf('1785677400') < 0) throw new Error('missing epoch start');
  if (block.indexOf('https://facebook.com/events/1/') < 0) throw new Error('missing source url');
  // The description must not travel to the model — it is passed through verbatim.
  if (block.indexOf('Hi<br>more') >= 0) throw new Error('description should not be sent to Claude');

  Logger.log('test_fbFormatForClaude: ALL PASSED');
}

function test_extractFacebookEvent_live() {
  var result = extractEventData('https://www.facebook.com/events/1058029123674308/');
  Logger.log(JSON.stringify(result, null, 2));
  // Inspect the Execution log: title, date 2026-08-02, 08:30-10:30, location
  // "Pfluger Pedestrian Brg", and a description ending with the complete
  // getinvolved.activism.wtf URL inside a working <a href>.
}

// ── Fetch ─────────────────────────────────────────────────────────────────────

/**
 * Fetches a Facebook event page as HTML.
 *
 * Two rules here are load-bearing and were established by measurement:
 *
 *  1. Send the Accept header. With it, Facebook server-renders the event into
 *     the HTML. Without it, the same URL returns a ~586KB JavaScript shell
 *     containing no event data at all.
 *  2. Do NOT set a User-Agent. UrlFetchApp ignores the header anyway, and
 *     Facebook answers a browser User-Agent on this endpoint with HTTP 400 —
 *     its own Apps Script UA works fine.
 *
 * @param {string} url
 * @returns {string|null} Page HTML, or null if the fetch failed
 */
function fetchFacebookEventPage_(url) {
  try {
    var resp = UrlFetchApp.fetch(url, {
      muteHttpExceptions: true,
      followRedirects: true,
      headers: { 'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' }
    });
    if (resp.getResponseCode() !== 200) {
      Logger.log('fetchFacebookEventPage_: HTTP ' + resp.getResponseCode());
      return null;
    }
    return resp.getContentText();
  } catch (e) {
    Logger.log('fetchFacebookEventPage_ error: ' + e.message);
    return null;
  }
}

// ── JSON field readers ────────────────────────────────────────────────────────

// The embedded blobs run to hundreds of KB and Apps Script has no DOM or
// streaming JSON parser, so we read individual fields by key rather than
// parsing whole objects.

/**
 * Reads a JSON string value by key out of raw page text.
 * Walks the value by hand so an escaped quote doesn't terminate it early.
 * @param {string} text
 * @param {string} key
 * @param {number} [fromIndex] - Start searching here, to scope to a sub-object
 * @returns {string|null}
 */
function fbFindString_(text, key, fromIndex) {
  var needle = '"' + key + '":"';
  var i = text.indexOf(needle, fromIndex || 0);
  if (i < 0) return null;

  var k = i + needle.length;
  var out = '';
  while (k < text.length) {
    var ch = text.charAt(k);
    if (ch === '\\') { out += ch + text.charAt(k + 1); k += 2; continue; }
    if (ch === '"') break;
    out += ch;
    k++;
  }

  try {
    return JSON.parse('"' + out + '"');
  } catch (e) {
    return null;
  }
}

/**
 * Reads a JSON number value by key out of raw page text.
 * @returns {number|null}
 */
function fbFindNumber_(text, key, fromIndex) {
  var m = new RegExp('"' + key + '":(-?\\d+)').exec(text.substring(fromIndex || 0));
  return m ? parseInt(m[1], 10) : null;
}

// ── Description ───────────────────────────────────────────────────────────────

function fbEscapeHtml_(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Pulls the description's link ranges out of its JSON blob.
 *
 * Every link carries three URL forms. `entity.url` is an l.facebook.com
 * redirect whose signed `h` token expires, so a calendar event built from it
 * would eventually dead-end. `external_url` is the clean destination — use it.
 *
 * @param {string} blob - The event_description region of the page
 * @returns {Array<{url: string, offset: number, length: number}>}
 */
function fbParseRanges_(blob) {
  var out = [];
  var seen = {};
  var re = /"external_url":"((?:[^"\\]|\\.)*)"/g;
  var m;

  while ((m = re.exec(blob)) !== null) {
    // offset/length trail the entity object that owns this external_url.
    var tail = blob.substring(m.index, m.index + 4000);
    var lm = tail.match(/"length":(\d+),"offset":(\d+)/);
    if (!lm) continue;

    var offset = parseInt(lm[2], 10);
    if (seen[offset]) continue;
    seen[offset] = true;

    var url;
    try {
      url = JSON.parse('"' + m[1] + '"');
    } catch (e) {
      continue;
    }
    out.push({ url: url, offset: offset, length: parseInt(lm[1], 10) });
  }

  return out;
}

/**
 * Rebuilds Facebook's description text as HTML with working links.
 *
 * Facebook reports link positions as offsets in Unicode CODEPOINTS, while
 * JavaScript strings are indexed in UTF-16 code units. Every emoji earlier in
 * the text pushes the two further apart, so a naive substr() slices through the
 * middle of a surrogate pair and yields a mangled, broken href. Indexing a
 * codepoint array instead is what keeps the links intact.
 *
 * The text is reproduced verbatim — nothing is summarised, shortened or reworded.
 *
 * @param {string} text - event_description.text
 * @param {Array<{url: string, offset: number, length: number}>} ranges
 * @returns {string} HTML using only <a> and <br>
 */
function fbLinkify_(text, ranges) {
  var cps = Array.from(text);
  var sorted = (ranges || []).slice().sort(function (a, b) { return a.offset - b.offset; });

  var out = '';
  var pos = 0;

  for (var i = 0; i < sorted.length; i++) {
    var r = sorted[i];
    // Skip overlapping or out-of-bounds ranges rather than corrupting the text.
    if (r.offset < pos || r.length <= 0 || r.offset + r.length > cps.length) continue;

    out += fbEscapeHtml_(cps.slice(pos, r.offset).join(''));
    var label = cps.slice(r.offset, r.offset + r.length).join('');
    out += '<a href="' + fbEscapeHtml_(r.url) + '">' + fbEscapeHtml_(label) + '</a>';
    pos = r.offset + r.length;
  }

  out += fbEscapeHtml_(cps.slice(pos).join(''));

  return out.replace(/\r\n|\r|\n/g, '<br>');
}

// ── Event record ──────────────────────────────────────────────────────────────

/**
 * Extracts the event record Facebook server-renders into the page.
 * Returns null when the page carries no event data, so callers can fall back
 * rather than build an event out of nothing.
 *
 * @param {string} html - Raw page HTML
 * @returns {{title: string|null, dayTimeSentence: string|null, startTimestamp: number|null,
 *            endTimestamp: number|null, timezone: string|null, location: string|null,
 *            descriptionHtml: string|null, imageUrl: string|null}|null}
 */
function parseFacebookEvent_(html) {
  // day_time_sentence is present on every event page and nowhere else, which
  // makes it a reliable signal that we got real content and not the JS shell.
  if (html.indexOf('"day_time_sentence"') < 0) return null;

  var titleMatch = html.match(/<meta property="og:title" content="([^"]*)"/);

  var ev = {
    title: titleMatch ? fbDecodeEntities_(titleMatch[1]).trim() : null,
    dayTimeSentence: fbFindString_(html, 'day_time_sentence'),
    startTimestamp: fbFindNumber_(html, 'start_timestamp'),
    endTimestamp: fbFindNumber_(html, 'end_timestamp'),
    timezone: fbFindString_(html, 'tz_display_name'),
    location: null,
    descriptionHtml: null,
    imageUrl: null
  };

  var placeIndex = html.indexOf('"event_place"');
  if (placeIndex >= 0) ev.location = fbFindString_(html, 'name', placeIndex);

  var imageIndex = html.indexOf('"full_image"');
  if (imageIndex >= 0) ev.imageUrl = fbFindString_(html, 'uri', imageIndex);

  var descIndex = html.indexOf('"event_description"');
  if (descIndex >= 0) {
    var blob = html.substring(descIndex, descIndex + 60000);
    var text = fbFindString_(blob, 'text');
    if (text) ev.descriptionHtml = fbLinkify_(text, fbParseRanges_(blob));
  }

  return ev;
}

function fbDecodeEntities_(s) {
  return s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
          .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'");
}

/**
 * Formats the parsed event as an authoritative block for Claude.
 *
 * The description is deliberately absent: it is passed through verbatim and
 * must never be rewritten by the model.
 *
 * @param {Object} ev - From parseFacebookEvent_
 * @param {string} sourceUrl
 * @returns {string}
 */
function formatFacebookEventForClaude_(ev, sourceUrl) {
  var lines = ['=== FACEBOOK EVENT DATA — AUTHORITATIVE SOURCE FOR ALL FIELDS ==='];
  if (ev.title)           lines.push('Title: ' + ev.title);
  if (ev.dayTimeSentence) lines.push('When: ' + ev.dayTimeSentence);
  if (ev.startTimestamp)  lines.push('Start (unix epoch seconds): ' + ev.startTimestamp);
  if (ev.endTimestamp)    lines.push('End (unix epoch seconds): ' + ev.endTimestamp);
  if (ev.timezone)        lines.push('Timezone: ' + ev.timezone);
  if (ev.location)        lines.push('Location: ' + ev.location);
  lines.push('Source URL: ' + sourceUrl);
  if (ev.imageUrl)        lines.push('Image URL: ' + ev.imageUrl);
  lines.push('The description is supplied separately and must not be written or rewritten by you.');
  lines.push('Return null for the description field.');
  lines.push('=== END FACEBOOK EVENT DATA ===');
  return lines.join('\n');
}
