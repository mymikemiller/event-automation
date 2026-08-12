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
    // Lookalike domains must not read as Meetup — a prefixed host, a suffixed
    // one, and the shortener's equivalent.
    ['https://notmeetup.com/vegaustin/events/315879624/', 'no'],
    ['https://meetup.com.evil.test/vegaustin/events/1/', 'no'],
    ['https://notmeetu.ps/e/Qbwn8/', 'no'],
    // Host and slug are both case-insensitive.
    ['https://www.Meetup.com/VegAustin/events/1/', 'yes'],
    // Group-level URL carries no event; not an event link. The group's
    // event-LISTING page is the same story — an event link always carries an
    // ID, so /events/ with nothing after it must answer the same way.
    ['https://www.meetup.com/vegaustin/', 'no'],
    ['https://www.meetup.com/vegaustin/events/', 'no'],
    // A listing page is where the scan STOPS. Anything further right is not
    // this URL's event — matching it tags another group's event as ours.
    ['https://www.meetup.com/other-group/events/?next=https://www.meetup.com/vegaustin/events/999/', 'no'],
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

  // tockifyRedirectTarget_ — the Location header parsed away from the network,
  // so the shapes that only ever turn up against a live shortener are pinned
  // here for free. Fixtures are built in this file on purpose: `instanceof
  // Array` is realm-sensitive, as tests/run.js warns.
  var SHORT_REQ = 'https://meetu.ps/e/Qbwn8/1qvFq/i';
  var CLICK_REQ = 'https://www.meetup.com/ls/click?upn=u001.abc';
  var targetCases = [
    // The shape verified live on 2026-08-12.
    [{ 'Location': 'https://www.meetup.com/vegaustin/events/315879624/?_xtd=x&from=ref' }, SHORT_REQ, 302,
     'https://www.meetup.com/vegaustin/events/315879624/?_xtd=x&from=ref'],
    // UrlFetchApp does not normalise header case, so both spellings must work.
    [{ 'location': 'https://www.meetup.com/vegaustin/events/1/' }, SHORT_REQ, 301,
     'https://www.meetup.com/vegaustin/events/1/'],
    // Repeated headers arrive as an array, the same duality as Set-Cookie. Two
    // entries, not one: a single-element array stringifies to exactly its
    // element, so a one-entry fixture passes even with the [0] deleted and pins
    // nothing. Two also pins WHICH entry is taken.
    [{ 'Location': ['https://www.meetup.com/vegaustin/events/2/', 'https://evil.test/'] }, SHORT_REQ, 302,
     'https://www.meetup.com/vegaustin/events/2/'],
    // Protocol-relative is legal, and classifies correctly once a scheme is on
    // it — refusing it outright would turn a correct 'yes' into an error email.
    [{ 'Location': '//www.meetup.com/vegaustin/events/3/' }, SHORT_REQ, 302,
     'https://www.meetup.com/vegaustin/events/3/'],
    // Path-relative off Meetup's own click tracker is the case where resolving
    // rather than rejecting actually recovers a canonical event URL.
    [{ 'Location': '/vegaustin/events/4/' }, CLICK_REQ, 302,
     'https://www.meetup.com/vegaustin/events/4/'],
    // Off the shortener it stays on the shortener's origin, which tockifyAvaHost_
    // then answers 'unknown' for — a loud error rather than a silent 'no'.
    [{ 'Location': '/e/other/' }, SHORT_REQ, 302, 'https://meetu.ps/e/other/'],
    // 307/308 preserve the method but are still redirects.
    [{ 'Location': 'https://www.meetup.com/vegaustin/events/5/' }, SHORT_REQ, 308,
     'https://www.meetup.com/vegaustin/events/5/']
  ];
  targetCases.forEach(function (c) {
    var got = tockifyRedirectTarget_(c[0], c[1], c[2]);
    if (got.url !== c[3]) {
      throw new Error('tockifyRedirectTarget_(' + JSON.stringify(c[0]) + ', HTTP ' + c[2] +
        ') -> ' + JSON.stringify(got) + ', want ' + c[3]);
    }
  });

  // The two failure modes must not be reported as each other: a 200 carrying a
  // Location is not a redirect at all, while a 302 without one is a broken
  // redirect. An HTTP 404 here is the deleted-fixture case, and saying so is
  // what stops the next person debugging working code.
  var targetErrors = [
    [{ 'Location': 'https://www.meetup.com/vegaustin/events/1/' }, SHORT_REQ, 200, 'not a redirect (HTTP 200)'],
    [{}, SHORT_REQ, 404, 'not a redirect (HTTP 404)'],
    [{}, SHORT_REQ, 302, 'no Location header (HTTP 302)'],
    [{ 'Location': '' }, SHORT_REQ, 302, 'no Location header (HTTP 302)'],
    [{ 'Location': [] }, SHORT_REQ, 302, 'no Location header (HTTP 302)'],
    [null, SHORT_REQ, 302, 'no Location header (HTTP 302)'],
    // Anything still not absolute after resolution is refused rather than handed
    // to tockifyAvaHost_, which would answer 'no' — the silent skip this whole
    // feature exists to prevent.
    [{ 'Location': 'events/6/' }, SHORT_REQ, 302, 'unresolvable Location'],
    [{ 'Location': 'javascript:alert(1)' }, SHORT_REQ, 302, 'unresolvable Location'],
    [{ 'Location': '/vegaustin/events/7/' }, 'not-a-url', 302, 'unresolvable Location']
  ];
  targetErrors.forEach(function (c) {
    var got = tockifyRedirectTarget_(c[0], c[1], c[2]);
    if (!got.error || got.error.indexOf(c[3]) === -1) {
      throw new Error('tockifyRedirectTarget_(' + JSON.stringify(c[0]) + ', HTTP ' + c[2] +
        ') -> ' + JSON.stringify(got) + ', want error containing "' + c[3] + '"');
    }
    // A result carrying both is how a caller checking the wrong field follows a
    // URL the parser had already rejected.
    if (got.url) throw new Error('an error result must carry no url: ' + JSON.stringify(got));
  });

  // tockifyAddTag_ — merges, never replaces. Re-running a job must be a no-op.
  //
  // Fixtures are the flat top-level array the live probe found on the
  // authenticated eventgroup record on 2026-08-12 — group.tags = [...] — not the
  // public ngevent API's nested content.tagset.tags.default. Built in this file
  // on purpose: `instanceof Array` is realm-sensitive, as tests/run.js warns, so
  // a host-realm fixture would silently take the malformed path and pass.
  var added = tockifyAddTag_(['Potluck'], AVA_TOCKIFY_TAG);
  if (added.join(',') !== 'Potluck,' + AVA_TOCKIFY_TAG) {
    throw new Error('existing tags must be preserved, got ' + JSON.stringify(added));
  }

  // The VALUE, not the length: a length of 2 is equally consistent with the tag
  // having replaced 'y', so length alone pins nothing about what came back.
  var already = tockifyAddTag_(['x', AVA_TOCKIFY_TAG, 'y'], AVA_TOCKIFY_TAG);
  if (already.join(',') !== 'x,' + AVA_TOCKIFY_TAG + ',y') {
    throw new Error('an already-present tag must leave the list unchanged, got ' + JSON.stringify(already));
  }

  // Malformed or absent input must not throw, and must come back as a fresh
  // one-element array. The `instanceof Array` check on the result is what fails
  // by name rather than by TypeError when a string input is passed through:
  // 'Austin-Vegan-Association'.slice() is a string that already "contains" the
  // tag, so it survives the indexOf guard untouched.
  [undefined, null, {}, 'nope', 123, AVA_TOCKIFY_TAG].forEach(function (input) {
    var built = tockifyAddTag_(input, AVA_TOCKIFY_TAG);
    if (!(built instanceof Array) || built.join(',') !== AVA_TOCKIFY_TAG) {
      throw new Error('tockifyAddTag_(' + JSON.stringify(input) + ') -> ' + JSON.stringify(built) +
        ', want a fresh [' + AVA_TOCKIFY_TAG + ']');
    }
  });

  // The input must not be mutated — the caller PUTs the whole group and a
  // surprise in-place edit is how a "verify it stuck" check passes on a write
  // that never happened. Both branches: only the tag-absent one appends.
  var original = ['Potluck'];
  tockifyAddTag_(original, AVA_TOCKIFY_TAG);
  if (original.join(',') !== 'Potluck') {
    throw new Error('tockifyAddTag_ must not mutate its input, got ' + JSON.stringify(original));
  }

  var noop = [AVA_TOCKIFY_TAG, 'Potluck'];
  tockifyAddTag_(noop, AVA_TOCKIFY_TAG);
  if (noop.join(',') !== AVA_TOCKIFY_TAG + ',Potluck') {
    throw new Error('tockifyAddTag_ must not mutate its input on the no-op branch, got ' + JSON.stringify(noop));
  }

  // The tag-PRESENT case below is the load-bearing one, and it is the only thing
  // in this file that catches a `concat`-style implementation: that appends a
  // copy when the tag is absent but returns the caller's own array untouched
  // when it is present, which every check above passes. Nothing is appended on
  // that branch, so the input reads back correct however it was returned — only
  // pushing into the RESULT exposes the alias.
  //
  // The tag-ABSENT case is its symmetric twin, and is redundant on its own: for
  // the result to alias the input there the implementation must append in place,
  // which trips the no-mutate check above first, loudly and by name. It stays
  // because an asymmetric pair invites a future reader to finish the cleanup by
  // deleting the other one.
  var srcAbsent = ['Potluck'];
  tockifyAddTag_(srcAbsent, AVA_TOCKIFY_TAG).push('x');
  if (srcAbsent.join(',') !== 'Potluck') {
    throw new Error('the result must share no array with the input (tag absent), got ' + JSON.stringify(srcAbsent));
  }

  var srcPresent = [AVA_TOCKIFY_TAG];
  tockifyAddTag_(srcPresent, AVA_TOCKIFY_TAG).push('x');
  if (srcPresent.join(',') !== AVA_TOCKIFY_TAG) {
    throw new Error('the result must share no array with the input (tag present), got ' + JSON.stringify(srcPresent));
  }

  // A tag that merely CONTAINS ours must not suppress the append. Matching is
  // exact, on whole elements — 'Austin-Vegan-Association-Board' is a different
  // tag, and a substring test here refuses to append forever, so the job's
  // read-back never passes and the event retries until it gives up.
  var sibling = tockifyAddTag_([AVA_TOCKIFY_TAG + '-Board'], AVA_TOCKIFY_TAG);
  if (sibling.join(',') !== AVA_TOCKIFY_TAG + '-Board,' + AVA_TOCKIFY_TAG) {
    throw new Error('a superstring sibling must not suppress the append, got ' + JSON.stringify(sibling));
  }

  // tockifyHasTag_ — used to verify the write stuck
  if (!tockifyHasTag_(['x', AVA_TOCKIFY_TAG, 'y'], AVA_TOCKIFY_TAG)) {
    throw new Error('tockifyHasTag_ should find a present tag among others');
  }
  // Two distinct substring traps, and each needs its own entry.
  //   - The CONTAINER is a string (entries 6-7): a bare indexOf on it finds the
  //     tag inside and reports a write that never landed. Guarded by
  //     `instanceof Array`.
  //   - An ELEMENT is a superstring (entries 8-9): matching elements loosely —
  //     joining the array, or indexOf per element — says "tagged" about an event
  //     carrying only a sibling tag. Guarded by Array#indexOf being an exact
  //     ===-match on whole elements. Nothing above catches this: 'x' shares no
  //     substring with the tag, and the string entries exercise the type guard
  //     rather than the match semantics.
  [undefined, null, [], ['x'], {}, AVA_TOCKIFY_TAG, 'tags=' + AVA_TOCKIFY_TAG + ';',
   [AVA_TOCKIFY_TAG + '-Board'], ['Not-' + AVA_TOCKIFY_TAG]].forEach(function (input) {
    if (tockifyHasTag_(input, AVA_TOCKIFY_TAG)) {
      throw new Error('tockifyHasTag_(' + JSON.stringify(input) + ') should be false');
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
 * The event ID is what separates an event link from the group's /events/
 * listing page: an event link always carries an ID, and a listing page names no
 * event, so it must answer 'no' just as the bare group URL does. The first such
 * segment decides whether or not it names an event, for the reason on the regex.
 *
 * So a string holding a listing-page segment is settled here even when it also
 * mentions a shortener — once any /events/ segment matches, the shortener checks
 * below are unreachable and the answer is 'no', not 'unknown'. That is the
 * useful way round: 'unknown' would send a listing page to the redirect
 * resolver, which finds no Location and reports a host it could not determine.
 * A link that is only a shortener still answers 'unknown'.
 *
 * Matches the first meetup.com/<slug>/events/<id> anywhere in the string; it
 * does not verify that segment is the URL's own authority.
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

  // (?:^|[\/.]) so notmeetup.com does not match; the trailing \/ after
  // meetup\.com is what rejects meetup.com.evil.test.
  //
  // The FIRST meetup.com/<slug>/events/ segment decides, whether or not it
  // names an event. Scanning past a listing page for a segment that does is
  // how a URL in the query string gets read as this URL's own event.
  var m = s.match(/(?:^|[\/.])meetup\.com\/([^\/\s?#]+)\/events\/(\d*)/i);
  if (m) {
    if (!m[2]) return 'no';   // a listing page names no event
    return m[1].toLowerCase() === AVA_MEETUP_SLUG ? 'yes' : 'no';
  }

  // Share shortener and Meetup's own click tracker: the group is recoverable
  // only by following the redirect.
  if (/(?:^|[\/.])meetu\.ps\//i.test(s)) return 'unknown';
  if (/(?:^|[\/.])meetup\.com\/ls\/click/i.test(s)) return 'unknown';

  return 'no';
}

/**
 * The absolute URL a redirect response points at.
 *
 * Pure header parsing, kept out of the network file for the same reason
 * tockifySessionCookie_ is: everything interesting here is a shape that only
 * turns up against a live third-party server, and a hand-run *_live test is the
 * one place a regression will not be noticed.
 *
 * Three traps, each of which fails silently rather than loudly:
 *   - UrlFetchApp does not normalise header case, and gives an array when a
 *     header repeats, exactly as it does for Set-Cookie.
 *   - A 200 carrying a stale Location is not a redirect. Following it reports a
 *     host the server never redirected to.
 *   - A relative Location is legal HTTP. Handed to tockifyAvaHost_ unresolved it
 *     matches nothing and answers 'no', which is indistinguishable from a real
 *     "not AVA" — so it must be resolved, and refused if it still cannot be.
 *     Resolving beats refusing: a protocol-relative //www.meetup.com/... URL
 *     classifies correctly the moment it has a scheme, and rejecting it outright
 *     would turn a right answer into an error.
 *
 * @param {Object|null} headers - from HTTPResponse.getAllHeaders()
 * @param {string} requestUrl - what was fetched, the base for a relative Location
 * @param {number} statusCode
 * @returns {{url: string}|{error: string}}
 */
function tockifyRedirectTarget_(headers, requestUrl, statusCode) {
  if (!(statusCode >= 300 && statusCode < 400)) {
    return { error: 'not a redirect (HTTP ' + statusCode + ')' };
  }

  var loc = headers && (headers['Location'] || headers['location']);
  if (loc instanceof Array) loc = loc[0];
  if (!loc) return { error: 'redirect with no Location header (HTTP ' + statusCode + ')' };
  loc = String(loc);

  if (loc.indexOf('//') === 0) {
    // Scheme-relative. Every host in scope is https, and upgrading is the safe
    // direction to guess wrong in.
    loc = 'https:' + loc;
  } else if (loc.charAt(0) === '/') {
    var origin = String(requestUrl).match(/^(https?:\/\/[^\/?#]+)/i);
    if (origin) loc = origin[1] + loc;
  }
  if (!/^https?:\/\//i.test(loc)) return { error: 'unresolvable Location: ' + loc };

  return { url: loc };
}

/**
 * The event group's tag list with `tag` present, preserving every tag already
 * on it.
 *
 * Shape confirmed by live probe on 2026-08-12 (test_tockifyEventGroupShape_live)
 * against the authenticated **eventgroup** record — the one we GET and PUT. Tags
 * are a plain top-level array of strings:
 *
 *   group.tags = ["Austin-Vegan-Association"]
 *
 * The public `ngevent` API nests the same data as
 * content.tagset.tags.default, and that is NOT what to write. Reading the public
 * response and copying its shape is the trap here: this server answers a body it
 * does not recognise with a silent 200 (see `imageSets` vs `imageIdNg` on
 * tockifyUpdateEventGroup_), so a nested tagset would look like it saved and
 * quietly change nothing. The probe found no `tagset` key anywhere on the
 * eventgroup record, and no `content` wrapper at all.
 *
 * The `.slice()` is unconditional, so the result never shares an array with the
 * input — not even on the branch where the tag is already there and nothing is
 * appended. The caller PUTs the whole record and then verifies against the
 * freshly parsed response; a result that shared the caller's array is how that
 * check passes on a write that never happened.
 *
 * Matching is exact, on whole elements. A sibling tag that merely contains this
 * one — 'Austin-Vegan-Association-Board' — must still get the tag appended; a
 * substring test there refuses to append forever, and the caller's read-back
 * then fails on every retry until the job gives up.
 *
 * @param {Array|null|undefined} tags - group.tags; absent or empty on an
 *   untagged event (not probed — the probe sampled a tagged one; both handled)
 * @param {string} tag
 * @returns {Array} a new array
 */
function tockifyAddTag_(tags, tag) {
  var list = (tags instanceof Array) ? tags.slice() : [];
  if (list.indexOf(tag) === -1) list.push(tag);
  return list;
}

/**
 * Whether an event group's tag list carries a tag. Used to verify a write stuck
 * — this API answers a rejected field with HTTP 200, so a status code proves
 * nothing and this check is the only thing between a silent failure and a
 * correct report.
 *
 * Two guards, against two different substring traps:
 *   - `instanceof Array` is load-bearing, not a type-safety nicety: given a
 *     string `tags` that merely contains the tag as a substring, a bare indexOf
 *     returns a non-negative index and reports a write that never landed as a
 *     success. That is exactly the value a server rejecting the array shape
 *     could hand back.
 *   - Array#indexOf matches whole elements with ===, which is equally
 *     load-bearing. Comparing loosely instead — joining the array, or running
 *     indexOf on each element — reports "tagged" for an event carrying only
 *     'Austin-Vegan-Association-Board', a different tag that happens to contain
 *     this one.
 *
 * @param {Array|null|undefined} tags - group.tags
 * @param {string} tag
 * @returns {boolean}
 */
function tockifyHasTag_(tags, tag) {
  return (tags instanceof Array) && tags.indexOf(tag) !== -1;
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
