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
 * Sets the featured image on a Tockify event group.
 * `imageIdNg` is the write field — writing `imageSets` directly returns 200
 * and is silently ignored. The server hydrates `imageSets` from `imageIdNg`.
 * @param {string} cookie
 * @param {string} uid
 * @param {string} imageSetId
 * @returns {{success: true}|{error: string}}
 */
function tockifySetEventImage_(cookie, uid, imageSetId) {
  var path = '/api/eventgroup/' + TOCKIFY_CALID + '/' + uid;

  var getRes = tockifyFetch_(path, cookie);
  if (getRes.getResponseCode() !== 200) {
    return { error: 'eventgroup GET returned HTTP ' + getRes.getResponseCode() };
  }

  var group = JSON.parse(getRes.getContentText());
  group.imageIdNg = imageSetId;

  var putRes = tockifyFetch_(path, cookie, { method: 'put', payload: group });
  if (putRes.getResponseCode() !== 200) {
    return { error: 'eventgroup PUT returned HTTP ' + putRes.getResponseCode() };
  }

  // A 200 alone does not mean the image was accepted — check it stuck.
  var saved = JSON.parse(putRes.getContentText());
  if (!saved.imageSets || !saved.imageSets.length) {
    return { error: 'image did not stick — imageSets came back empty' };
  }
  return { success: true };
}
