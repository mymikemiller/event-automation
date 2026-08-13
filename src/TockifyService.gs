function test_tockifyLogin_live() {
  var r = tockifyLogin_(true);
  if (r.error) throw new Error(r.error);
  if (r.cookie.indexOf('TKFSession=') !== 0) throw new Error('unexpected cookie: ' + r.cookie);
  Logger.log('test_tockifyLogin_live: PASSED');
}

function test_tockifyUploadImage_live() {
  var r = tockifyUploadImage_('https://www.google.com/images/branding/googlelogo/2x/googlelogo_color_272x92dp.png');
  if (r.error) throw new Error(r.error);
  if (!r.uuid) throw new Error('no uuid returned');
  Logger.log('test_tockifyUploadImage_live: PASSED — uuid ' + r.uuid);
}

/**
 * End-to-end: queues a tag-only job for an event already in Tockify and drains
 * the queue once, then reports whether the tag landed.
 *
 * PRECONDITION — remove the Austin-Vegan-Association tag from this event in the
 * Tockify UI first. With the tag already present tockifyAddTag_ returns the list
 * unchanged, the PUT is a no-op, and the verification passes on a tag that
 * predates this run. That would prove nothing about the one thing no offline
 * test can establish: that `tags` is writable at all. This function refuses to
 * run rather than let that happen.
 *
 * Also logs `version` before and after. If it increments, the server really did
 * mutate the record — a signal worth having for any future field.
 *
 * Ran green on 2026-08-13: tags went [] -> ["Austin-Vegan-Association"] on a
 * Google-synced external event, which is what proved the field writable.
 * `version` stayed 1 across that write, so it is not a mutation signal.
 *
 * The fixture below is spent — that event is tagged again. To re-run after a
 * change to the tag path, re-point the four constants at any AVA event on the
 * calendar and clear its tag in the Tockify UI first.
 */
function test_tockifyAvaTagEndToEnd_live() {
  var TITLE = '🧘 August Afternoon Yoga 🧘';
  var START = 1788111000000;
  var SOURCE = 'https://www.meetup.com/vegaustin/events/315879894/';
  var UID = '135';

  var login = tockifySession_();
  if (login.error) throw new Error(login.error);

  var path = '/api/eventgroup/' + TOCKIFY_CALID + '/' + UID;
  var before = JSON.parse(tockifyFetch_(path, login.cookie).getContentText());
  Logger.log('BEFORE: tags=' + JSON.stringify(before.tags) + ' version=' + before.version);

  if (tockifyHasTag_(before.tags, AVA_TOCKIFY_TAG)) {
    throw new Error('PRECONDITION FAILED: the event still carries ' + AVA_TOCKIFY_TAG +
      '. Remove it in the Tockify UI first, or this run cannot fail and proves nothing.');
  }

  tockifyQueueAdd_(TITLE, START, '', SOURCE);
  processTockifyQueue_();

  var after = JSON.parse(tockifyFetch_(path, login.cookie).getContentText());
  Logger.log('AFTER : tags=' + JSON.stringify(after.tags) + ' version=' + after.version);
  Logger.log('queue remaining: ' + JSON.stringify(tockifyQueueLoad_()));

  if (!tockifyHasTag_(after.tags, AVA_TOCKIFY_TAG)) {
    throw new Error('tag did not land — tags came back ' + JSON.stringify(after.tags));
  }
  Logger.log('test_tockifyAvaTagEndToEnd_live: PASSED — tag written to a live record');
}

function test_tockifyIsAvaEvent_live() {
  // Verified 2026-08-12: this short link 302s to
  // www.meetup.com/vegaustin/events/315879624/
  var short = tockifyIsAvaEvent_('https://meetu.ps/e/Qbwn8/1qvFq/i');
  if (short.error) {
    throw new Error('short-link resolution failed — an HTTP 404 here likely means the ' +
      'fixture event was deleted, not that the code broke: ' + short.error);
  }
  if (!short.isAva) throw new Error('short link to an AVA event should resolve to isAva');

  // These two must be decided offline. Checking .error is what makes that an
  // assertion rather than a comment: an {error} result has isAva === undefined,
  // so the isAva checks below pass just as happily on a URL that went to the
  // network and failed there.
  var canonical = tockifyIsAvaEvent_('https://www.meetup.com/vegaustin/events/315879624/');
  if (canonical.error) throw new Error('canonical URL should need no fetch: ' + canonical.error);
  if (!canonical.isAva) throw new Error('canonical AVA URL should be isAva');

  var other = tockifyIsAvaEvent_('https://www.facebook.com/events/1234567890/');
  if (other.error) throw new Error('a Facebook URL should need no fetch: ' + other.error);
  if (other.isAva) throw new Error('a Facebook URL is not an AVA Meetup event');

  Logger.log('test_tockifyIsAvaEvent_live: PASSED');
}

/**
 * Reports where `tagset` actually lives on an authenticated event group.
 *
 * ANSWERED — run 2026-08-12. It does not live anywhere: there is no `tagset` key
 * on the eventgroup record and no `content` wrapper. Tags are a flat top-level
 * array of bare strings, group.tags = ["Austin-Vegan-Association"], found by the
 * value search at tags[0]. Neither hypothesis below was right — see
 * tockifyAddTag_ (TockifyUtil.gs), which is written against this answer, and do
 * not write the public API's content.tagset.tags.default back to this endpoint.
 * The rest of this comment records the pre-probe reasoning, kept because it
 * explains why the value search was worth writing.
 *
 * Read-only: a single GET, no PUT. Run it from the editor and paste the log.
 *
 * We cannot guess this one. The public ngevent record nests the field at
 * content.tagset.tags.default, but the image write (now tockifyUpdateEventGroup_)
 * shows the authenticated eventgroup record is flattened at least for images — it
 * writes `imageIdNg` and reads `imageSets` at the top level, where ngevent has
 * both under `content`.
 * Writing the wrong body shape to this endpoint returns 404 Not found and
 * writing the wrong field returns a silent 200, so a guess fails quietly.
 *
 * The two named checks answer the likely question; the value search answers the
 * unlikely one, where the eventgroup calls the field something else entirely and
 * both named checks come back undefined. It reports paths and types only —
 * never values — so a description mentioning the tag cannot leak into the log.
 *
 * uid 111 is "Lunch at The Vegan Yacht", confirmed against the public ngevent
 * feed on 2026-08-12 to carry the Austin-Vegan-Association tag.
 */
function test_tockifyEventGroupShape_live() {
  var login = tockifySession_();
  if (login.error) throw new Error(login.error);

  var res = tockifyFetch_('/api/eventgroup/' + TOCKIFY_CALID + '/111', login.cookie);
  Logger.log('HTTP ' + res.getResponseCode());
  if (res.getResponseCode() !== 200) throw new Error(res.getContentText().substring(0, 300));

  var group;
  try {
    group = JSON.parse(res.getContentText());
  } catch (e) {
    throw new Error('eventgroup returned non-JSON: ' + res.getContentText().substring(0, 300));
  }

  // Describes a value without printing it: enough to tell a populated tagset
  // from an empty one, or an object from the array a wrapper would return.
  var describe = function (v) {
    if (v === null) return 'null';
    if (v instanceof Array) return 'array[' + v.length + ']';
    if (typeof v === 'object') return 'object{' + Object.keys(v).length + '}';
    return typeof v;
  };

  Logger.log('body is ' + describe(group));

  var summary = Object.keys(group).map(function (k) {
    return k + ':' + describe(group[k]);
  });
  Logger.log('top-level: ' + summary.join(', '));

  Logger.log('group.tagset = ' + JSON.stringify(group.tagset));
  Logger.log('group.content && group.content.tagset = ' +
    JSON.stringify(group.content && group.content.tagset));

  // Walks the record for the tag string itself, so an unexpected field name is
  // diagnosable from this one run rather than needing a second probe.
  var hits = [];
  var walk = function (node, path, depth) {
    if (hits.length >= 20 || depth > 8 || node === null || typeof node !== 'object') return;
    Object.keys(node).forEach(function (k) {
      var child = node[k];
      var childPath = (node instanceof Array) ? path + '[' + k + ']' : (path ? path + '.' + k : k);
      if (child === AVA_TOCKIFY_TAG) {
        hits.push(childPath);
      } else {
        walk(child, childPath, depth + 1);
      }
    });
  };
  walk(group, '', 0);

  Logger.log('paths holding "' + AVA_TOCKIFY_TAG + '": ' +
    (hits.length ? hits.join(', ')
      : '(none — the eventgroup record does not carry the tag at all)'));
}

/**
 * Logs in to Tockify and returns the session cookie, caching it for 6 hours.
 * Tockify issues no API token — auth is the httpOnly TKFSession cookie only.
 * @param {boolean} [forceFresh] - skip the cache after a rejected call
 * @returns {{cookie: string}|{error: string}}
 */
function tockifyLogin_(forceFresh) {
  var cache = CacheService.getScriptCache();
  if (!forceFresh) {
    var cached = cache.get('TOCKIFY_COOKIE');
    if (cached) return { cookie: cached };
  }

  var props = PropertiesService.getScriptProperties();
  var email = props.getProperty('TOCKIFY_EMAIL');
  var password = props.getProperty('TOCKIFY_PASSWORD');
  if (!email || !password) {
    return { error: 'TOCKIFY_EMAIL / TOCKIFY_PASSWORD not set in Script Properties' };
  }

  // stayLoggedIn asks for the long-lived session rather than a browser-session
  // cookie. nextUri is what the web UI sends; the API expects the field.
  var res = UrlFetchApp.fetch('https://tockify.com/api/sessions2', {
    method: 'post',
    contentType: 'application/json',
    headers: { 'Accept': 'application/json' },
    payload: JSON.stringify({
      stayLoggedIn: true,
      email: email,
      password: password,
      nextUri: '/'
    }),
    followRedirects: false,
    muteHttpExceptions: true
  });

  var cookie = tockifySessionCookie_(res.getAllHeaders()['Set-Cookie']);
  if (!cookie) {
    return { error: 'Tockify login failed: ' + tockifyLoginError_(res) };
  }
  cache.put('TOCKIFY_COOKIE', cookie, 21600);
  return { cookie: cookie };
}

/**
 * Human-readable reason a login was refused. Bad credentials come back as
 * HTTP 400 with {errors: {form: {message}}}; anything else falls back to the
 * status code.
 * @param {HTTPResponse} res
 * @returns {string}
 */
function tockifyLoginError_(res) {
  try {
    var body = JSON.parse(res.getContentText());
    if (body && body.errors && body.errors.form && body.errors.form.message) {
      return body.errors.form.message + ' (HTTP ' + res.getResponseCode() + ')';
    }
  } catch (e) { /* fall through to the status code */ }
  return 'HTTP ' + res.getResponseCode();
}

/**
 * Returns a session cookie known to be live.
 *
 * tockifyLogin_ will happily hand back a cached cookie that the server has
 * since expired — it has no way to tell. Without this check the first real
 * call fails with an HTTP error and the job gets reported as broken when all
 * it needed was a fresh login. So probe a cheap authenticated endpoint and
 * re-login if the cookie is dead.
 *
 * @returns {{cookie: string}|{error: string}}
 */
function tockifySession_() {
  var login = tockifyLogin_();
  if (login.error) return login;

  var probe = tockifyFetch_('/api/subscription-status', login.cookie);
  if (probe.getResponseCode() === 200) return login;

  return tockifyLogin_(true);
}

/**
 * UrlFetchApp wrapper that sends the session cookie and the headers Tockify's
 * API expects. Returns the raw response so callers can check the status.
 * @param {string} path - e.g. "/api/ngevent?..."
 * @param {string} cookie
 * @param {{method: string, payload: Object}} [opts]
 * @returns {HTTPResponse}
 */
function tockifyFetch_(path, cookie, opts) {
  opts = opts || {};
  var params = {
    method: opts.method || 'get',
    headers: { 'Cookie': cookie, 'Accept': 'application/json' },
    muteHttpExceptions: true
  };
  if (opts.payload) {
    params.contentType = 'application/json';
    params.payload = JSON.stringify(opts.payload);
  }
  return UrlFetchApp.fetch('https://tockify.com' + path, params);
}

/**
 * Finds the Tockify uid for an event synced from Google Calendar.
 * Searches from an hour before the expected start; the match itself is on the
 * exact start time, so the window only has to be wide enough to include it.
 * @param {string} cookie
 * @param {string} title
 * @param {number} startMillis
 * @returns {{uid: string}|{notFound: true}|{error: string}}
 */
function tockifyFindEvent_(cookie, title, startMillis) {
  var path = '/api/ngevent' +
    '?calname=' + encodeURIComponent(TOCKIFY_CALNAME) +
    '&startms=' + (startMillis - 3600000) +
    '&max=50&view=agenda&start-inclusive=true&showAll=true';

  var res = tockifyFetch_(path, cookie);
  if (res.getResponseCode() !== 200) {
    return { error: 'ngevent returned HTTP ' + res.getResponseCode() };
  }

  var body;
  try {
    body = JSON.parse(res.getContentText());
  } catch (e) {
    return { error: 'ngevent returned non-JSON' };
  }

  var uid = tockifyMatchEvent_(body.events, title, startMillis);
  return uid ? { uid: uid } : { notFound: true };
}

/**
 * Uploads an image to Uploadcare from its source URL and returns the uuid.
 * The public key is publishable — it is exposed in Tockify's own client-side
 * JavaScript. Do not pass store=1: autostore is disabled on this key and the
 * request fails with "Autostore is disabled".
 * @param {string} imageUrl
 * @returns {{uuid: string}|{error: string}}
 */
function tockifyUploadImage_(imageUrl) {
  var startUrl = 'https://upload.uploadcare.com/from_url/' +
    '?pub_key=' + UPLOADCARE_PUB_KEY +
    '&source_url=' + encodeURIComponent(imageUrl);

  var res = UrlFetchApp.fetch(startUrl, { muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) {
    return { error: 'Uploadcare from_url returned HTTP ' + res.getResponseCode() };
  }

  var started;
  try {
    started = JSON.parse(res.getContentText());
  } catch (e) {
    return { error: 'Uploadcare from_url returned: ' + res.getContentText().substring(0, 120) };
  }
  if (!started.token) return { error: 'Uploadcare returned no token' };

  var statusUrl = 'https://upload.uploadcare.com/from_url/status/?token=' + started.token;
  for (var i = 0; i < 12; i++) {
    var sres = UrlFetchApp.fetch(statusUrl, { muteHttpExceptions: true });
    var st = JSON.parse(sres.getContentText());
    if (st.status === 'success') return { uuid: st.uuid };
    if (st.status === 'error') return { error: 'Uploadcare failed: ' + (st.error || 'unknown') };
    Utilities.sleep(1000);
  }
  return { error: 'Uploadcare upload timed out' };
}

/**
 * Registers an uploaded image in Tockify's image library and returns its id.
 *
 * Two things make this endpoint easy to get wrong:
 *   - the field is `url` (the up.tockify.com CDN URL), not the uuid. A wrong
 *     body shape returns 404 Not found, not a validation error.
 *   - the response is `{}`, so the new id has to be read back from the list,
 *     which is ordered newest-first.
 *
 * @param {string} cookie
 * @param {string} uuid - from tockifyUploadImage_
 * @param {string} name - filename for the library entry
 * @returns {{imageSetId: string}|{error: string}}
 */
function tockifyRegisterImage_(cookie, uuid, name) {
  var res = tockifyFetch_('/api/imageset', cookie, {
    method: 'post',
    payload: { url: tockifyCdnUrl_(uuid), name: name, suffix: 'nosuffix' }
  });
  if (res.getResponseCode() !== 200) {
    return { error: 'imageset POST returned HTTP ' + res.getResponseCode() };
  }

  var listRes = tockifyFetch_('/api/imageset?offset=0&limit=1', cookie);
  if (listRes.getResponseCode() !== 200) {
    return { error: 'imageset list returned HTTP ' + listRes.getResponseCode() };
  }

  var list = JSON.parse(listRes.getContentText());
  if (!list.length) return { error: 'imageset list came back empty' };
  // Guards against reading back a concurrent upload.
  if (list[0].name !== name) {
    return { error: 'newest image is "' + list[0].name + '", expected "' + name + '"' };
  }
  return { imageSetId: list[0].id };
}

/**
 * Applies the image and/or the AVA tag to a Tockify event group in one write.
 *
 * One GET/PUT rather than two: both fields live in the same record, so separate
 * cycles would double the round trips and let the pair land half-applied.
 *
 * `imageIdNg` is the write field for the image — writing `imageSets` directly
 * returns 200 and is silently ignored. The server hydrates `imageSets` from
 * `imageIdNg`, so the read-back checks BOTH: `imageSets` non-empty proves the
 * server processed the write rather than just storing a string, and
 * `imageIdNg` equalling what we sent proves it stored OUR id. Neither implies
 * the other. Counting `imageSets` alone passes on an event that already had an
 * image and whose `imageIdNg` the server ignored — the record comes back with a
 * populated `imageSets` belonging to the old image.
 *
 * We PUT the whole record, so `imageSets` goes back up on every write even
 * though it is documented write-ignored. Harmless today. If Tockify ever makes
 * it writable, that echo becomes a stale write racing `imageIdNg` and this is
 * the first place to look.
 *
 * `tags` is the field for the tag: a flat top-level array of bare strings,
 * confirmed by live probe on 2026-08-12 (test_tockifyEventGroupShape_live)
 * against this same eventgroup record. The public ngevent API's nested
 * content.tagset.tags.default is NOT what this endpoint takes — there is no
 * `tagset` key and no `content` wrapper on this record at all, and an
 * unrecognised body field comes back as a silent 200, so writing the public
 * shape would look saved and change nothing.
 *
 * That probe was read-only — one GET, no PUT — so it establishes where the tag
 * LIVES, not that the field is writable. The read-back is what makes that safe
 * to act on: were `tags` a read-only projection, the server would echo the
 * pre-existing list, tockifyHasTag_ would return false, and this returns a loud
 * "tag did not stick" rather than a silent success. Writability is only ever
 * established by an end-to-end run against a live event that does NOT already
 * carry the tag — on an already-tagged event the read-back passes on a tag that
 * predates us and proves nothing.
 *
 * Callers must not pass an empty `changes`: there is deliberately no early
 * return, so it issues a full no-op rewrite of the record. Whether there is work
 * to do belongs to the caller that assembled `changes` — see tockifyApplyJob_ —
 * and defining it in two places is how the two definitions drift.
 *
 * @param {string} cookie
 * @param {string} uid
 * @param {{imageSetId?: string, addTag?: string}} changes
 * @returns {{success: true}|{error: string}}
 */
function tockifyUpdateEventGroup_(cookie, uid, changes) {
  // Every other failure here returns {error}; without this a missing argument
  // throws a TypeError instead, and only AFTER the GET has already gone out.
  changes = changes || {};

  var path = '/api/eventgroup/' + TOCKIFY_CALID + '/' + uid;

  var getRes = tockifyFetch_(path, cookie);
  if (getRes.getResponseCode() !== 200) {
    return { error: 'eventgroup GET returned HTTP ' + getRes.getResponseCode() };
  }

  // The body excerpt is the whole diagnostic: a non-JSON 200 is almost always an
  // HTML login or error page, and "session expired" reads differently from
  // "endpoint moved" in the first line. An unattended trigger produces nothing
  // but this email.
  var group;
  try {
    group = JSON.parse(getRes.getContentText());
  } catch (e) {
    return { error: 'eventgroup GET returned non-JSON: ' +
      getRes.getContentText().substring(0, 120) };
  }
  // `null` and bare scalars are valid JSON and parse without throwing. Defaulting
  // them to {} would be worse than throwing: we PUT the whole record, so it would
  // overwrite a real event with just the fields we set. Refuse.
  if (!group || typeof group !== 'object' || group instanceof Array) {
    return { error: 'eventgroup GET returned no record: ' +
      getRes.getContentText().substring(0, 120) };
  }

  if (changes.imageSetId) group.imageIdNg = changes.imageSetId;
  if (changes.addTag) {
    // tockifyAddTag_ falls back to [] on an unrecognised shape, which is right
    // for the helper alone but destructive here: we PUT the whole record, so
    // "ignore what I could not parse" becomes "replace the tag list with only
    // ours" — and it would report success. Refuse instead.
    if (group.tags && !(group.tags instanceof Array)) {
      return { error: 'eventgroup tags came back as ' + (typeof group.tags) +
        ', refusing to overwrite' };
    }
    group.tags = tockifyAddTag_(group.tags, changes.addTag);
  }

  var putRes = tockifyFetch_(path, cookie, { method: 'put', payload: group });
  if (putRes.getResponseCode() !== 200) {
    return { error: 'eventgroup PUT returned HTTP ' + putRes.getResponseCode() };
  }

  // A 200 alone does not mean the write was accepted — check each one stuck.
  var saved;
  try {
    saved = JSON.parse(putRes.getContentText());
  } catch (e) {
    return { error: 'eventgroup PUT returned non-JSON: ' +
      putRes.getContentText().substring(0, 120) };
  }
  // Same reasoning as the GET, and the checks below would throw on a null.
  // Unverifiable is a failure, not a success.
  if (!saved || typeof saved !== 'object' || saved instanceof Array) {
    return { error: 'eventgroup PUT returned no record: ' +
      putRes.getContentText().substring(0, 120) };
  }

  if (changes.imageSetId && (!saved.imageSets || !saved.imageSets.length)) {
    return { error: 'image did not stick — imageSets came back empty' };
  }
  // Counting imageSets is not enough on an event that already had an image: the
  // old one keeps that array populated while our id is quietly dropped. The
  // `saved.imageIdNg &&` guard leaves an absent field on the old behaviour, so
  // this cannot invent a failure before the field is confirmed on a live run.
  if (changes.imageSetId && saved.imageIdNg && saved.imageIdNg !== changes.imageSetId) {
    return { error: 'image did not stick — imageIdNg came back "' + saved.imageIdNg + '"' };
  }
  if (changes.addTag && !tockifyHasTag_(saved.tags, changes.addTag)) {
    // Naming the image explicitly: the two share one PUT, so a tag failure
    // reported bare reads as "nothing landed" and invites a rerun that
    // re-uploads and re-registers a second image set for the same event.
    return { error: 'tag did not stick — "' + changes.addTag +
      '" absent from the saved tags (any image in the same write did land)' };
  }
  return { success: true };
}

/**
 * Follows ONE redirect hop and returns the target URL.
 *
 * One hop, not a chain: the live meetu.ps link verified on 2026-08-12 lands on
 * the canonical www.meetup.com URL in a single 302, and an unbounded redirect
 * chase inside an unattended 5-minute job is a worse failure than a missed tag.
 *
 * Nothing here throws — every failure comes back as {error}. Reading the
 * response lives in tockifyRedirectTarget_ (TockifyUtil.gs), where it is
 * unit-testable without a network.
 *
 * @param {string} url
 * @returns {{url: string}|{error: string}}
 */
function tockifyResolveRedirect_(url) {
  var res;
  try {
    res = UrlFetchApp.fetch(url, {
      method: 'get',
      followRedirects: false,
      muteHttpExceptions: true
    });
  } catch (e) {
    // muteHttpExceptions suppresses error STATUSES; DNS, TLS and timeout still
    // throw. This dials a third-party shortener named in a human-pasted URL, and
    // an escaped throw skips the give-up counter and wedges the queue.
    return { error: 'fetch failed for ' + url + ': ' + e.message };
  }

  return tockifyRedirectTarget_(res.getAllHeaders(), url, res.getResponseCode());
}

/**
 * Whether a submitted event URL is an AVA-hosted Meetup event, paying for a
 * redirect fetch only when the URL is a shortener.
 *
 * A resolved URL that is STILL not classifiable is an error, not a `false` —
 * silently treating it as "not AVA" is how an event goes untagged with no
 * signal that anything was skipped.
 *
 * @param {string} sourceUrl
 * @returns {{isAva: boolean}|{error: string}}
 */
function tockifyIsAvaEvent_(sourceUrl) {
  var host = tockifyAvaHost_(sourceUrl);
  if (host !== 'unknown') return { isAva: host === 'yes' };

  var resolved = tockifyResolveRedirect_(sourceUrl);
  if (resolved.error) return { error: resolved.error };

  var host2 = tockifyAvaHost_(resolved.url);
  if (host2 === 'unknown') {
    return { error: 'redirect from ' + sourceUrl + ' reached ' + resolved.url +
      ', which is still not a canonical Meetup event URL' };
  }
  return { isAva: host2 === 'yes' };
}
