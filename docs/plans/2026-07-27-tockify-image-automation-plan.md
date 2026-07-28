# Tockify Image Automation Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** After the app creates a Google Calendar event, automatically set the flyer as the featured image on the matching Tockify event, with no manual login-and-paste step.

**Architecture:** `submitEvent` enqueues a job into Script Properties. A time-driven trigger drains the queue every 5 minutes: it logs in to Tockify, finds the synced event by title and start time, pushes the image URL through Uploadcare, registers it in Tockify's image library, and sets `imageIdNg` on the event group. Pure helpers live in `TockifyUtil.gs` and are unit-tested locally under Node; everything that touches the network or `PropertiesService` stays editor-only.

**Tech Stack:** Google Apps Script (ES5-style `var`, no arrow functions in `.gs`), `UrlFetchApp`, `PropertiesService`, `CacheService`, Tockify's private REST API, Uploadcare upload API.

**Design doc:** `docs/plans/2026-07-27-tockify-image-automation-design.md`

---

## Conventions in this repo

- Tests are `test_*` functions co-located in the `.gs` file they test.
- `node tests/run.js <File.gs>` runs them locally. **Only pure files can run
  locally** — anything touching `UrlFetchApp`, `PropertiesService`, `DriveApp`
  or `CalendarApp` must be an editor-only test.
- Test functions with `_live` in the name are skipped by the local runner. Use
  that suffix for tests that hit the real Tockify API.
- Deploy with `./deploy.sh`. Never `clasp deploy` — it breaks the bookmarked URL.

---

## Task 1: Capture the login request

**This task is a prerequisite for Task 3 and blocks nothing else.** Tasks 2, 4,
5, 6 and 7 can all proceed in parallel.

The login form is `<form name="fLogin" novalidate>` with inputs named `email`
and `password` bound to `login.email` / `login.password`. It has no `action`
attribute — Angular submits it — and the POST target is not discoverable by
probing, because this server returns `404 Not found` for a correct path with an
unexpected body (confirmed: `/api/imageset` did exactly that).

**Step 1: Ask Mike to capture it**

He should log out of Tockify, open DevTools → Network, log back in, find the
login POST, and report:

- the request URL and method
- the `content-type` request header
- the JSON keys or form field names in the payload

**He must redact the password value.** Field *names* are needed; the value is
not. Do not ask for an unredacted cURL of the login request.

**Step 2: Record the answer**

Write it into the design doc under "Authentication", replacing the assumption
there.

---

## Task 2: Pure helpers

**Files:**
- Create: `src/TockifyUtil.gs`

**Step 1: Write the failing tests**

Add to `src/TockifyUtil.gs`:

```javascript
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

  Logger.log('test_tockifyUtil: ALL PASSED');
}
```

**Step 2: Run to verify it fails**

Run: `node tests/run.js TockifyUtil.gs`
Expected: `FAIL test_tockifyUtil` with a "not defined" error.

**Step 3: Write the implementation**

Append to `src/TockifyUtil.gs`:

```javascript
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
```

**Step 4: Run to verify it passes**

Run: `node tests/run.js TockifyUtil.gs`
Expected: `PASS test_tockifyUtil`, `1 passed, 0 failed`

**Step 5: Commit**

```bash
git add src/TockifyUtil.gs
git commit -m "feat: add pure helpers for Tockify image automation"
```

---

## Task 3: Login

**Files:**
- Create: `src/TockifyService.gs`

**Depends on Task 1.** Do not guess the endpoint or payload shape.

**Step 1: Write the implementation**

```javascript
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

  // TODO(Task 1): url, method, contentType and payload shape come from the
  // captured login request. The shape below is the assumption to replace.
  var res = UrlFetchApp.fetch('https://tockify.com/i/site/login', {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify({ email: email, password: password }),
    followRedirects: false,
    muteHttpExceptions: true
  });

  var cookie = tockifySessionCookie_(res.getAllHeaders()['Set-Cookie']);
  if (!cookie) {
    return { error: 'Tockify login failed (HTTP ' + res.getResponseCode() + ')' };
  }
  cache.put('TOCKIFY_COOKIE', cookie, 21600);
  return { cookie: cookie };
}

/**
 * UrlFetchApp wrapper that sends the session cookie and the headers Tockify's
 * API expects. Returns the raw response so callers can check the status.
 * @param {string} path - e.g. "/api/ngevent?..."
 * @param {string} cookie
 * @param {Object} [opts] - method, payload
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
```

**Step 2: Verify in the Apps Script editor**

Add an editor-only test:

```javascript
function test_tockifyLogin_live() {
  var r = tockifyLogin_(true);
  if (r.error) throw new Error(r.error);
  if (r.cookie.indexOf('TKFSession=') !== 0) throw new Error('unexpected cookie: ' + r.cookie);
  Logger.log('test_tockifyLogin_live: PASSED');
}
```

Run `./deploy.sh`, then run `test_tockifyLogin_live` from the editor.
Expected: PASSED. The `_live` suffix keeps it out of the local runner.

**Step 3: Commit**

```bash
git add src/TockifyService.gs
git commit -m "feat: add Tockify login and authenticated fetch helper"
```

---

## Task 4: Find the synced event

**Files:**
- Modify: `src/TockifyService.gs`

**Step 1: Write the implementation**

```javascript
/**
 * Finds the Tockify uid for an event synced from Google Calendar.
 * Searches from one hour before the expected start, which is ample — the
 * events are looked up by exact start time anyway.
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
```

**Step 2: Verify in the editor**

```javascript
function test_tockifyFindEvent_live() {
  var login = tockifyLogin_();
  if (login.error) throw new Error(login.error);
  // Pick a title and exact start time from the calendar before running.
  var r = tockifyFindEvent_(login.cookie, 'REPLACE_WITH_REAL_TITLE', 0);
  Logger.log(JSON.stringify(r));
}
```

Expected: `{"uid":"..."}` for a real title/time pair, `{"notFound":true}` otherwise.

**Step 3: Commit**

```bash
git add src/TockifyService.gs
git commit -m "feat: find synced Tockify event by title and start time"
```

---

## Task 5: Ingest the image through Uploadcare

**Files:**
- Modify: `src/TockifyService.gs`

**Step 1: Write the implementation**

```javascript
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
    return { error: 'Uploadcare from_url returned: ' + res.getContentText().slice(0, 120) };
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
```

**Step 2: Verify in the editor**

```javascript
function test_tockifyUploadImage_live() {
  var r = tockifyUploadImage_('https://www.google.com/images/branding/googlelogo/2x/googlelogo_color_272x92dp.png');
  if (r.error) throw new Error(r.error);
  if (!r.uuid) throw new Error('no uuid');
  Logger.log('uuid: ' + r.uuid);
}
```

Expected: logs a uuid.

**Step 3: Commit**

```bash
git add src/TockifyService.gs
git commit -m "feat: upload event images to Uploadcare from source URL"
```

---

## Task 6: Register the image in Tockify's library

**Files:**
- Modify: `src/TockifyService.gs`

**Step 1: Write the implementation**

```javascript
/**
 * Registers an uploaded image in Tockify's image library and returns its id.
 *
 * Two things make this endpoint hard to get right:
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
  if (list[0].name !== name) {
    return { error: 'newest image is "' + list[0].name + '", expected "' + name + '"' };
  }
  return { imageSetId: list[0].id };
}
```

The name check guards against reading back somebody else's concurrent upload.

**Step 2: Verify in the editor**

```javascript
function test_tockifyRegisterImage_live() {
  var login = tockifyLogin_();
  var up = tockifyUploadImage_('https://www.google.com/images/branding/googlelogo/2x/googlelogo_color_272x92dp.png');
  var r = tockifyRegisterImage_(login.cookie, up.uuid, 'googlelogo_color_272x92dp.png');
  if (r.error) throw new Error(r.error);
  Logger.log('imageSetId: ' + r.imageSetId);
}
```

Expected: logs an id. **Delete the resulting library entry in Tockify afterwards.**

**Step 3: Commit**

```bash
git add src/TockifyService.gs
git commit -m "feat: register uploaded images in the Tockify image library"
```

---

## Task 7: Set the image on the event

**Files:**
- Modify: `src/TockifyService.gs`

**Step 1: Write the implementation**

```javascript
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

  var saved = JSON.parse(putRes.getContentText());
  if (!saved.imageSets || !saved.imageSets.length) {
    return { error: 'image did not stick — imageSets came back empty' };
  }
  return { success: true };
}
```

The `imageSets` check is the real verification: a 200 alone does not mean the
image was accepted.

**Step 2: Commit**

```bash
git add src/TockifyService.gs
git commit -m "feat: set featured image on a Tockify event group"
```

---

## Task 8: The job queue

**Files:**
- Create: `src/TockifyQueue.gs`

**Step 1: Write the implementation**

```javascript
/**
 * Reads the pending job queue.
 * @returns {Array<Object>}
 */
function tockifyQueueLoad_() {
  var raw = PropertiesService.getScriptProperties().getProperty(TOCKIFY_QUEUE_KEY);
  if (!raw) return [];
  try { return JSON.parse(raw); } catch (e) { return []; }
}

/**
 * Writes the pending job queue.
 * @param {Array<Object>} jobs
 */
function tockifyQueueSave_(jobs) {
  PropertiesService.getScriptProperties()
    .setProperty(TOCKIFY_QUEUE_KEY, JSON.stringify(jobs));
}

/**
 * Adds a job. One job per event, including multi-date events — a repeating
 * event syncs to Tockify as a single record.
 * @param {string} title
 * @param {number} startMillis
 * @param {string} imageUrl
 */
function tockifyQueueAdd_(title, startMillis, imageUrl) {
  var jobs = tockifyQueueLoad_();
  jobs.push({
    title: title,
    startMillis: startMillis,
    imageUrl: imageUrl,
    tries: 0,
    firstSeen: Date.now()
  });
  tockifyQueueSave_(jobs);
}
```

**Step 2: Commit**

```bash
git add src/TockifyQueue.gs
git commit -m "feat: add Script Properties job queue for Tockify image updates"
```

---

## Task 9: The trigger

**Files:**
- Create: `src/TockifyJob.gs`

**Step 1: Write the implementation**

```javascript
/**
 * Drains the Tockify image queue. Installed as a 5-minute time-driven trigger.
 * Jobs that have not appeared in Tockify within TOCKIFY_GIVE_UP_MS are dropped
 * with an email. Tockify syncs from Google within seconds, so the window is
 * pure safety margin.
 */
function processTockifyQueue_() {
  var jobs = tockifyQueueLoad_();
  if (!jobs.length) return;

  var login = tockifyLogin_();
  if (login.error) {
    login = tockifyLogin_(true); // cached cookie may have expired
    if (login.error) {
      tockifyNotify_('Tockify login failed', login.error);
      return;
    }
  }

  var now = Date.now();
  var remaining = [];

  for (var i = 0; i < jobs.length; i++) {
    var job = jobs[i];
    var result = tockifyApplyImage_(login.cookie, job);

    if (result.success) continue;              // done, drop from queue

    if (result.notFound && !tockifyShouldGiveUp_(job, now)) {
      job.tries++;
      remaining.push(job);                     // try again next run
      continue;
    }

    tockifyNotify_(
      'Tockify image not set: ' + job.title,
      (result.error || 'event never appeared in Tockify') +
      '\n\nImage: ' + job.imageUrl +
      '\nTries: ' + job.tries
    );
  }

  tockifyQueueSave_(remaining);
}

/**
 * Runs one job end to end.
 * @param {string} cookie
 * @param {Object} job
 * @returns {{success: true}|{notFound: true}|{error: string}}
 */
function tockifyApplyImage_(cookie, job) {
  var found = tockifyFindEvent_(cookie, job.title, job.startMillis);
  if (found.notFound) return { notFound: true };
  if (found.error) return { error: found.error };

  var up = tockifyUploadImage_(job.imageUrl);
  if (up.error) return { error: up.error };

  var reg = tockifyRegisterImage_(cookie, up.uuid, tockifyImageName_(job.imageUrl));
  if (reg.error) return { error: reg.error };

  return tockifySetEventImage_(cookie, found.uid, reg.imageSetId);
}

/**
 * Emails the script owner. Failures here must be loud — these endpoints are
 * undocumented and can change without notice.
 * @param {string} subject
 * @param {string} body
 */
function tockifyNotify_(subject, body) {
  MailApp.sendEmail(Session.getActiveUser().getEmail(), '[Event Automation] ' + subject, body);
}

/**
 * Installs the 5-minute trigger. Run once from the editor. Safe to re-run —
 * it removes any existing trigger for this handler first.
 */
function installTockifyTrigger() {
  var existing = ScriptApp.getProjectTriggers();
  for (var i = 0; i < existing.length; i++) {
    if (existing[i].getHandlerFunction() === 'processTockifyQueue_') {
      ScriptApp.deleteTrigger(existing[i]);
    }
  }
  ScriptApp.newTrigger('processTockifyQueue_').timeBased().everyMinutes(5).create();
  Logger.log('Tockify trigger installed');
}
```

**Step 2: Commit**

```bash
git add src/TockifyJob.gs
git commit -m "feat: add trigger that applies queued images to Tockify events"
```

---

## Task 10: Wire into submitEvent

**Files:**
- Modify: `src/Code.gs:104-131`

**Step 1: Enqueue after the calendar event is created**

In `submitEvent`, after the attachment step (`src/Code.gs:106-112`) and before
building `userEmail`, add:

```javascript
  // 6. Queue the Tockify image update. Tockify syncs from Google within
  //    seconds, but not instantly — a trigger picks this up shortly.
  if (eventData.image_url && plan.dates.length) {
    var first = plan.dates[0];
    tockifyQueueAdd_(
      eventData.title,
      tockifyStartMillis_(first),
      eventData.image_url
    );
  }
```

**Step 2: Add the start-time helper to `src/TockifyUtil.gs`**

The queue needs the same epoch-milliseconds value Tockify reports in
`when.start.millis`. Derive it from the occurrence's date and start time in the
script timezone:

```javascript
/**
 * Epoch milliseconds for an occurrence, matching Tockify's when.start.millis.
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
```

**Step 3: Add a test for it in `src/TockifyUtil.gs`**

Add to `test_tockifyUtil`:

```javascript
  // tockifyStartMillis_ — matches the local timezone the runner pins
  var ms = tockifyStartMillis_({ date: '2026-08-10', start_time: '18:30' });
  var back = new Date(ms);
  if (back.getFullYear() !== 2026 || back.getMonth() !== 7 || back.getDate() !== 10) {
    throw new Error('tockifyStartMillis_ wrong date');
  }
  if (back.getHours() !== 18 || back.getMinutes() !== 30) {
    throw new Error('tockifyStartMillis_ wrong time');
  }
```

**Step 4: Run the tests**

Run: `node tests/run.js TockifyUtil.gs`
Expected: `1 passed, 0 failed`

**Step 5: Commit**

```bash
git add src/Code.gs src/TockifyUtil.gs
git commit -m "feat: queue a Tockify image update when an event is submitted"
```

---

## Task 11: Live verification on a real synced event

**This is the task that closes the one open risk in the design.** Everything so
far was verified against a *native* Tockify event. Google-synced events show
"This event is managed outside of Tockify so some fields can't be changed here",
which greys out title, date and description. The Change Image control stays
enabled and synced events demonstrably carry images, so `imageIdNg` is expected
to be writable — but that is an expectation, not a measurement.

**Step 1: Set Script Properties**

In the Apps Script editor, Project Settings → Script Properties, add
`TOCKIFY_EMAIL` and `TOCKIFY_PASSWORD`.

**Step 2: Deploy and install the trigger**

```bash
./deploy.sh
```

Then run `installTockifyTrigger` once from the editor.

**Step 3: Run one real event through**

Submit an event through the web app that has a flyer image. Watch for:

- the job appearing in the `TOCKIFY_IMAGE_QUEUE` script property
- the event appearing in Tockify within a minute
- the image appearing on it within 5 minutes
- the queue property emptying

**Step 4: If `imageIdNg` is rejected on external events**

Report it rather than working around it. The likely fallbacks, in order of
preference, are `POST /api/google/resync/:id` before the PUT, or setting the
image through `/api/eventmod`. Neither has been characterised.

**Step 5: Commit nothing**

This task changes no code unless Step 4 fires.

---

## Task 12: Documentation

**Files:**
- Modify: `README.md`

**Step 1: Add a Tockify section**

After the "Facebook events" section, add:

```markdown
## Tockify

Events reach Tockify by Google Calendar sync, which carries no image. The script
closes that gap: when you submit an event, it queues a job, and a trigger
running every five minutes sets the flyer as the featured image on the matching
Tockify event.

The image goes to Tockify as the original source URL, not the Drive copy —
Tockify downloads and keeps its own copy, so the link only has to survive one
fetch.

Two details worth knowing:

- Tockify issues no API token. Auth is a session cookie obtained by logging in
  with `TOCKIFY_EMAIL` and `TOCKIFY_PASSWORD` from Script Properties. Enabling
  MFA on the Tockify account breaks this and there is no fallback.
- Cropping is skipped deliberately. Tockify applies crops at display time as CDN
  URL operations, and the editor's cropper defaults to the whole image — so
  skipping it produces exactly the result that accepting the default by hand
  produces.

If an event has not appeared in Tockify within two hours, the job is dropped and
you get an email. These endpoints are undocumented, so failures are loud by
design.
```

**Step 2: Add the new Script Properties to the table**

In the existing Script Properties table, add:

| `TOCKIFY_EMAIL` | The Tockify account email |
| `TOCKIFY_PASSWORD` | The Tockify account password |

**Step 3: Commit**

```bash
git add README.md
git commit -m "docs: document Tockify image automation"
```
