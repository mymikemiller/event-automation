# Image Flyer Extraction Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Paste a flyer image URL and get an event out of it — details read off the picture, the event link decoded from a QR code, and an open-ended recurrence created as a repeating calendar event.

**Architecture:** A new `image/*` branch in `extractEventData` decodes QR codes server-side via goqr.me (browser fallback with zxing), sends the flyer to Claude as inline bytes, and lets Claude state a recurrence as an RRULE with no `COUNT`. `planRecurrence_` gains a rule argument that produces an open-ended series pinned to one computed start date.

**Tech Stack:** Google Apps Script (V8), Anthropic Messages API, `api.qrserver.com`, `@zxing/library` (browser only), Node + `curl` for local tests.

**Design doc:** `docs/plans/2026-09-15-image-flyer-extraction-design.md` — read it first.

**Branch:** `image-flyer-extraction` (already created; no worktree).

---

## Ground rules

- **TDD.** Write the failing test, run it, see it fail for the right reason, then implement. @superpowers:test-driven-development
- **Never claim a step passed without running it.** @superpowers:verification-before-completion
- **Commit after every task.** Messages end with the attribution lines used on this branch's existing commits.
- **Apps Script has one global scope** across all `.gs` files — a function in `QrService.gs` is callable from `Extraction.gs` with no import.
- **A function whose name ends in `_` is private** and cannot be called from `google.script.run`. `chooseEventLink` and `planRecurrence` deliberately have no underscore.
- **Test fixtures go inside the `.gs` file or inside the vm context, never in the Node host realm** — `instanceof Array` is realm-sensitive and a host-built array silently takes malformed-input paths. `tests/run.js` documents this; it has cost people hours.

---

## Task 1: Node shim for Google services

Everything after this task is testable locally. Nothing here ships to Apps Script — `.claspignore` already excludes `tests/`.

**Files:**
- Create: `tests/gas-shim.js`
- Create: `tests/run-live.js`

**Step 1: Write the shim**

```js
// tests/gas-shim.js
//
// Minimal Google Apps Script services backed by curl, so the .gs files that do
// I/O can run under Node instead of only in the Apps Script editor.
//
// Why curl and not fetch: UrlFetchApp.fetch is SYNCHRONOUS in Apps Script and
// Node's fetch is not. execFileSync('curl') is what closes that gap — there is
// no way to await inside a .gs function without rewriting it.
//
// clasp run cannot do this job: it needs an API Executable deployment, and this
// script publishes only a webapp. See the design doc.
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const KEY_FILE = path.join(os.homedir(), '.config', 'event-automation', 'claude_api_key');

function claudeApiKey() {
  if (process.env.CLAUDE_API_KEY) return process.env.CLAUDE_API_KEY;
  if (fs.existsSync(KEY_FILE)) return fs.readFileSync(KEY_FILE, 'utf8').trim();
  throw new Error(
    'No Claude API key. Copy it from Script Properties, then run:\n' +
    '  mkdir -p ~/.config/event-automation && ' +
    '(umask 077; pbpaste > ~/.config/event-automation/claude_api_key)'
  );
}

function makeBlob(buf, contentType, name) {
  return {
    _buf: buf,
    getBytes: () => Array.from(buf),
    getContentType: () => contentType,
    getName: () => name || 'blob',
    getDataAsString: () => buf.toString('utf8')
  };
}

const UrlFetchApp = {
  fetch(url, params) {
    params = params || {};
    const out = path.join(os.tmpdir(), 'gasfetch-' + process.pid + '-' + Date.now());
    const args = ['-sS', '-o', out, '-w', '%{http_code}\n%{content_type}'];
    if (params.followRedirects !== false) args.push('-L');

    const parts = [];
    const payload = params.payload;
    if (payload && typeof payload === 'object' && !Buffer.isBuffer(payload)) {
      // An object payload is multipart in Apps Script; a blob value is a file part.
      for (const [k, v] of Object.entries(payload)) {
        if (v && v._buf) {
          const f = path.join(os.tmpdir(), 'gaspart-' + process.pid + '-' + k);
          fs.writeFileSync(f, v._buf);
          parts.push(f);
          args.push('-F', `${k}=@${f};type=${v.getContentType()}`);
        } else {
          args.push('-F', `${k}=${v}`);
        }
      }
    } else if (payload !== undefined) {
      args.push('--data-binary', String(payload));
    }

    if (params.contentType) args.push('-H', 'Content-Type: ' + params.contentType);
    for (const [k, v] of Object.entries(params.headers || {})) {
      args.push('-H', `${k}: ${v}`);
    }
    if (params.method) args.push('-X', params.method.toUpperCase());
    args.push(url);

    let meta;
    try {
      meta = execFileSync('curl', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).split('\n');
    } finally {
      parts.forEach((f) => fs.existsSync(f) && fs.unlinkSync(f));
    }
    const buf = fs.readFileSync(out);
    fs.unlinkSync(out);

    const code = parseInt(meta[0], 10);
    const type = (meta[1] || '').split(';')[0].trim();
    return {
      getResponseCode: () => code,
      getContentText: () => buf.toString('utf8'),
      getBlob: () => makeBlob(buf, type, 'response')
    };
  }
};

const Utilities = {
  base64Encode: (bytes) =>
    Buffer.from(typeof bytes === 'string' ? Buffer.from(bytes, 'utf8') : Uint8Array.from(bytes))
      .toString('base64'),
  newBlob: (bytes, contentType, name) =>
    makeBlob(Buffer.from(typeof bytes === 'string' ? Buffer.from(bytes, 'utf8') : Uint8Array.from(bytes)),
             contentType || 'application/octet-stream', name),
  formatDate(date, tz, fmt) {
    // Only the formats the .gs files actually ask for.
    const p = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit'
    }).formatToParts(date).reduce((a, x) => (a[x.type] = x.value, a), {});
    if (fmt === 'yyyy-MM-dd') return `${p.year}-${p.month}-${p.day}`;
    throw new Error('gas-shim: unsupported date format ' + fmt);
  }
};

const PropertiesService = {
  getScriptProperties: () => ({
    getProperty(k) {
      if (k === 'CLAUDE_API_KEY') return claudeApiKey();
      return process.env[k] || null;
    }
  })
};

module.exports = {
  services: {
    UrlFetchApp,
    Utilities,
    PropertiesService,
    Session: { getScriptTimeZone: () => 'America/Chicago', getActiveUser: () => ({ getEmail: () => 'test@example.com' }) },
    Logger: { log: (m) => { if (process.env.GAS_VERBOSE) console.log('   log: ' + m); } }
  },
  makeBlob,
  claudeApiKey
};
```

**Step 2: Write the live runner**

```js
#!/usr/bin/env node
// Runs the test_*_live functions from impure .gs files against real services,
// using tests/gas-shim.js. tests/run.js stays the pure-only runner.
//
// Same realm hazard as run.js: build fixtures inside the .gs file or inside the
// vm context, never out here in the host realm.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { services } = require('./gas-shim');

const SRC = path.join(__dirname, '..', 'src');
const files = process.argv.slice(2);
if (!files.length) {
  console.error('usage: node tests/run-live.js <File.gs> [File.gs ...]');
  process.exit(1);
}

const sandbox = Object.assign({ console }, services);
const context = vm.createContext(sandbox);
for (const f of files) {
  vm.runInContext(fs.readFileSync(path.join(SRC, f), 'utf8'), context, { filename: f });
}

const tests = Object.keys(context).filter(
  (k) => k.indexOf('test_') === 0 && typeof context[k] === 'function' && k.indexOf('_live') >= 0
);

let pass = 0, fail = 0;
for (const name of tests) {
  try {
    context[name]();
    console.log('  PASS  ' + name);
    pass++;
  } catch (e) {
    console.log('  FAIL  ' + name + '\n        ' + e.message);
    fail++;
  }
}
console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
```

**Step 3: Prove the shim works before building on it**

Run: `node -e "const {services,makeBlob}=require('./tests/gas-shim');const r=services.UrlFetchApp.fetch('https://horizons-cdn.hostinger.com/c3648fa5-28bf-4fa9-adf5-de27dbf4d0e8/sss-QlOin.png',{});console.log(r.getResponseCode(),r.getBlob().getContentType(),r.getBlob().getBytes().length)"`

Expected: `200 image/png 490730`

**Step 4: Confirm the pure runner still works**

Run: `node tests/run.js RecurrenceService.gs`
Expected: all PASS, `0 failed`

**Step 5: Commit**

```bash
git add tests/gas-shim.js tests/run-live.js
git commit -m "test: run impure .gs files locally with a curl-backed GAS shim"
```

---

## Task 2: QR response parsing and link selection (pure)

**Files:**
- Create: `src/QrService.gs`
- Test: same file, `test_*` functions run by `tests/run.js`

**Step 1: Write the failing tests**

Put these at the top of `src/QrService.gs`, matching the house style (throw on failure, `Logger.log` at the end):

```js
function test_parseQrResponse() {
  // The real goqr.me response for the People Sanctuary flyer, captured
  // 2026-09-15. All three codes arrive inside ONE symbol[0].data string,
  // newline-separated, every code after the first prefixed "QR-Code:".
  var body = '[{"type":"qrcode","symbol":[{"seq":0,"data":' +
    '"https://www.instagram.com/thepeoplesanctuary?igsh=MXB4eWxjanF4andvbQ%3D%3D&utm_source=qr\\n' +
    'QR-Code:https://www.facebook.com/profile.php?id=61592091920619\\n' +
    'QR-Code:https://peoplesanctuary.org","error":null}]}]';

  var out = parseQrResponse_(body);
  if (out.length !== 3) throw new Error('expected 3 codes, got ' + out.length);
  if (out[2] !== 'https://peoplesanctuary.org') throw new Error('third code: ' + out[2]);
  if (out[1].indexOf('QR-Code:') === 0) throw new Error('prefix not stripped: ' + out[1]);

  if (parseQrResponse_('[{"type":"qrcode","symbol":[{"seq":0,"data":null,"error":"download error"}]}]').length !== 0) {
    throw new Error('an error response must yield no codes');
  }
  if (parseQrResponse_('not json').length !== 0) throw new Error('garbage must yield no codes');

  Logger.log('test_parseQrResponse: ALL PASSED');
}

function test_chooseEventLink() {
  // The flyer's three codes: the website wins over both social links.
  var pick = chooseEventLink([
    'https://www.instagram.com/thepeoplesanctuary?igsh=MXB4eWxjanF4andvbQ%3D%3D&utm_source=qr',
    'https://www.facebook.com/profile.php?id=61592091920619',
    'https://peoplesanctuary.org'
  ]);
  if (pick.url !== 'https://peoplesanctuary.org') throw new Error('picked ' + pick.url);
  if (pick.label !== 'See Website for details') throw new Error('label: ' + pick.label);

  // A ticketing link outranks a plain website.
  var tix = chooseEventLink(['https://peoplesanctuary.org', 'https://www.eventbrite.com/e/12345']);
  if (tix.label !== 'RSVP on Eventbrite') throw new Error('ticketing tier: ' + tix.label);

  // Social only: still used, but the trackers come off.
  var social = chooseEventLink(['https://www.instagram.com/p/ABC?igsh=xyz&utm_source=qr']);
  if (social.url !== 'https://www.instagram.com/p/ABC') throw new Error('trackers: ' + social.url);
  if (social.label !== 'See the post on Instagram') throw new Error('social label: ' + social.label);

  // Ties break on order of appearance.
  var tie = chooseEventLink(['https://first.org/a', 'https://second.org/b']);
  if (tie.url !== 'https://first.org/a') throw new Error('tie: ' + tie.url);

  // Non-URL payloads (vCard, wifi, plain text) are not links.
  if (chooseEventLink(['WIFI:S:net;T:WPA;P:pw;;', 'BEGIN:VCARD']) !== null) {
    throw new Error('non-URL payloads must not be chosen');
  }
  if (chooseEventLink([]) !== null) throw new Error('empty must be null');

  Logger.log('test_chooseEventLink: ALL PASSED');
}
```

**Step 2: Run to verify they fail**

Run: `node tests/run.js QrService.gs`
Expected: both FAIL with `parseQrResponse_ is not defined` / `chooseEventLink is not defined`

**Step 3: Implement**

```js
var QR_API_URL = 'https://api.qrserver.com/v1/read-qr-code/';

// Tier 1: a code that leads straight to an RSVP page. Tier 3: social profiles.
// Anything else is tier 2, a real website, which is what most flyers want.
var QR_TICKETING_HOSTS = {
  'eventbrite.com': 'RSVP on Eventbrite',
  'lu.ma': 'RSVP on Luma',
  'luma.com': 'RSVP on Luma',
  'meetup.com': 'RSVP on Meetup',
  'meetu.ps': 'RSVP on Meetup'
};

var QR_SOCIAL_HOSTS = {
  'facebook.com': 'RSVP on Facebook',
  'fb.me': 'RSVP on Facebook',
  'instagram.com': 'See the post on Instagram',
  'x.com': 'See Website for details',
  'twitter.com': 'See Website for details',
  'tiktok.com': 'See Website for details',
  'threads.net': 'See Website for details'
};

// Trackers a QR generator bolts on. Stripped for the same reason the Instagram
// and Facebook paths strip theirs: the link has to still work from a calendar
// event months later, and nothing here needs attribution.
var QR_TRACKING_PARAMS = /^(igsh|si|fbclid|gclid|mc_cid|mc_eid|ref|ref_src|utm_[a-z_]+)$/i;

/**
 * Every decoded string in a goqr.me read-qr-code response.
 *
 * The shape is a trap. Several codes come back inside ONE symbol[0].data
 * string, newline-separated, with every code after the first prefixed
 * "QR-Code:" — so reading symbol[0].data verbatim gives one unusable
 * three-line "URL" rather than three codes.
 *
 * @param {string} text - raw response body
 * @returns {Array<string>} decoded payloads, in the order they were found
 */
function parseQrResponse_(text) {
  var out = [];
  var body;
  try {
    body = JSON.parse(text);
  } catch (e) {
    return out;
  }
  if (!body || !body.length) return out;

  for (var i = 0; i < body.length; i++) {
    var symbols = body[i].symbol || [];
    for (var j = 0; j < symbols.length; j++) {
      if (!symbols[j] || !symbols[j].data) continue;
      var lines = String(symbols[j].data).split('\n');
      for (var k = 0; k < lines.length; k++) {
        var v = lines[k].replace(/^QR-Code:/, '').trim();
        if (v) out.push(v);
      }
    }
  }
  return out;
}

/** Lowercased host with any leading www., or '' if this is not an http(s) URL. */
function qrHost_(url) {
  var m = /^https?:\/\/([^\/?#]+)/i.exec(url);
  return m ? m[1].toLowerCase().replace(/^www\./, '') : '';
}

/** The label for a host in `table`, matching the host or any subdomain of it. */
function qrLookupHost_(host, table) {
  var keys = Object.keys(table);
  for (var i = 0; i < keys.length; i++) {
    if (host === keys[i] || host.slice(-(keys[i].length + 1)) === '.' + keys[i]) return table[keys[i]];
  }
  return null;
}

/** Drops tracking parameters, and the '?' with them if nothing else remains. */
function qrStripTrackers_(url) {
  var q = url.indexOf('?');
  if (q < 0) return url;
  var base = url.slice(0, q);
  var hash = '';
  var rest = url.slice(q + 1);
  var h = rest.indexOf('#');
  if (h >= 0) { hash = rest.slice(h); rest = rest.slice(0, h); }

  var kept = rest.split('&').filter(function (pair) {
    return pair && !QR_TRACKING_PARAMS.test(pair.split('=')[0]);
  });
  return base + (kept.length ? '?' + kept.join('&') : '') + hash;
}

/**
 * The best event link among decoded QR payloads, or null.
 *
 * Ranked by host: a ticketing platform first, then any other website, then
 * social. A flyer usually carries its Instagram and Facebook alongside the one
 * link actually worth putting on a calendar event, and on the flyer this was
 * built for the social codes come first in reading order — so order alone is
 * not a usable rule, and only breaks ties.
 *
 * No trailing underscore: called from the browser via google.script.run when
 * the client-side decoder is the one that found the codes.
 *
 * @param {Array<string>} urls - decoded QR payloads
 * @returns {{url: string, label: string}|null}
 */
function chooseEventLink(urls) {
  var best = null;

  for (var i = 0; i < (urls || []).length; i++) {
    var raw = String(urls[i]);
    var host = qrHost_(raw);
    if (!host) continue; // vCard, wifi credentials, plain text

    var label = qrLookupHost_(host, QR_TICKETING_HOSTS);
    var tier = 1;
    if (!label) {
      label = qrLookupHost_(host, QR_SOCIAL_HOSTS);
      tier = label ? 3 : 2;
      if (!label) label = 'See Website for details';
    }

    // Strict <, so an equal tier leaves the earlier code in place.
    if (!best || tier < best.tier) best = { tier: tier, url: qrStripTrackers_(raw), label: label };
  }

  return best ? { url: best.url, label: best.label } : null;
}
```

**Step 4: Run to verify they pass**

Run: `node tests/run.js QrService.gs`
Expected: `2 passed, 0 failed`

**Step 5: Commit**

```bash
git add src/QrService.gs
git commit -m "feat: parse goqr.me responses and rank QR links"
```

---

## Task 3: Decoding against the real service

**Files:**
- Modify: `src/QrService.gs`

**Step 1: Write the failing live test**

```js
function test_decodeQrCodes_live() {
  var resp = UrlFetchApp.fetch(
    'https://horizons-cdn.hostinger.com/c3648fa5-28bf-4fa9-adf5-de27dbf4d0e8/sss-QlOin.png',
    { muteHttpExceptions: true, followRedirects: true });
  if (resp.getResponseCode() !== 200) throw new Error('flyer fetch: HTTP ' + resp.getResponseCode());

  var codes = decodeQrCodes_(resp.getBlob());
  if (codes.length !== 3) throw new Error('expected 3 codes, got ' + codes.length + ': ' + codes.join(' | '));

  var pick = chooseEventLink(codes);
  if (pick.url !== 'https://peoplesanctuary.org') throw new Error('picked ' + pick.url);

  Logger.log('test_decodeQrCodes_live: ALL PASSED');
}
```

**Step 2: Run to verify it fails**

Run: `node tests/run-live.js QrService.gs`
Expected: FAIL with `decodeQrCodes_ is not defined`

**Step 3: Implement**

```js
/**
 * Decodes every QR code in an image, or [] if the service cannot.
 *
 * The bytes are POSTed rather than the URL being handed over as `fileurl=`:
 * measured 2026-09-15, goqr.me's own fetcher could not reach the Hostinger CDN
 * the test flyer is on ("download error (could not establish connection)"),
 * and the caller has the bytes in hand anyway.
 *
 * Never throws. An empty result is the caller's signal to ask the browser to
 * try instead — goqr.me is a free service with no SLA.
 *
 * @param {Blob} blob - the image
 * @returns {Array<string>} decoded payloads
 */
function decodeQrCodes_(blob) {
  try {
    var resp = UrlFetchApp.fetch(QR_API_URL, {
      method: 'post',
      payload: { file: blob },
      muteHttpExceptions: true
    });
    if (resp.getResponseCode() !== 200) {
      Logger.log('decodeQrCodes_: HTTP ' + resp.getResponseCode());
      return [];
    }
    return parseQrResponse_(resp.getContentText());
  } catch (e) {
    Logger.log('decodeQrCodes_ error: ' + e.message);
    return [];
  }
}
```

**Step 4: Run to verify it passes**

Run: `node tests/run-live.js QrService.gs`
Expected: `1 passed, 0 failed`

Also confirm the pure runner still skips it: `node tests/run.js QrService.gs` → `2 passed`.

**Step 5: Commit**

```bash
git add src/QrService.gs
git commit -m "feat: decode QR codes from a flyer image"
```

---

## Task 4: Multi-BYDAY rules in RecurrenceService

`expandRule_` and `describeCadence_` both match `BYDAY=(\d*)([A-Z]{2})`, which captures one weekday. Given `BYDAY=2SA,4SA` they silently use `2SA` alone — a rule that looks right and drops half the dates.

**Files:**
- Modify: `src/RecurrenceService.gs`

**Step 1: Write the failing test**

```js
function test_expandRuleMultiByDay() {
  // 2nd and 4th Saturday: Sep 2026 has Saturdays on 5, 12, 19, 26.
  var out = expandRule_('RRULE:FREQ=MONTHLY;BYDAY=2SA,4SA', '2026-09-12', 5);
  var want = ['2026-09-12', '2026-09-26', '2026-10-10', '2026-10-24', '2026-11-14'];
  if (out.join(',') !== want.join(',')) throw new Error('got ' + out.join(','));

  // Anchored mid-month: candidates before the start date are skipped, not
  // emitted — the 2nd Saturday of September has already gone.
  var later = expandRule_('RRULE:FREQ=MONTHLY;BYDAY=2SA,4SA', '2026-09-26', 3);
  if (later[0] !== '2026-09-26') throw new Error('first: ' + later[0]);
  if (later[1] !== '2026-10-10') throw new Error('second: ' + later[1]);

  // The single-BYDAY path the fitted rules use must be unchanged.
  var single = expandRule_('RRULE:FREQ=MONTHLY;BYDAY=2TU;COUNT=3', '2026-08-11', 3);
  if (single.join(',') !== '2026-08-11,2026-09-08,2026-10-13') throw new Error('single: ' + single.join(','));

  Logger.log('test_expandRuleMultiByDay: ALL PASSED');
}

function test_describeCadenceMultiByDay() {
  var d = describeCadence_('FREQ=MONTHLY;BYDAY=2SA,4SA');
  if (d !== 'every month on the second and fourth Saturday') throw new Error(d);

  // Unchanged for the rules fitRule_ produces.
  if (describeCadence_('RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=4') !== 'every week on Monday') {
    throw new Error('weekly wording changed');
  }
  if (describeCadence_('RRULE:FREQ=MONTHLY;BYDAY=2TU;COUNT=3') !== 'every month on the second Tuesday') {
    throw new Error('single monthly wording changed');
  }

  Logger.log('test_describeCadenceMultiByDay: ALL PASSED');
}
```

**Step 2: Run to verify it fails**

Run: `node tests/run.js RecurrenceService.gs`
Expected: `test_expandRuleMultiByDay` FAILs (only 2SA dates emitted), `test_describeCadenceMultiByDay` FAILs on the "second and fourth" wording.

**Step 3: Implement**

Add the parser near the other date helpers:

```js
/**
 * BYDAY as a list: [{ord, dow}], where ord 0 means "no ordinal given".
 * Replaces a single-weekday regex — `BYDAY=2SA,4SA` must not read as `2SA`.
 * @param {string} rule
 * @returns {Array<{ord:number, dow:number}>}
 */
function parseByDay_(rule) {
  var m = rule.match(/BYDAY=([0-9A-Z,\-]+)/);
  if (!m) return [];
  var out = [];
  var tokens = m[1].split(',');
  for (var i = 0; i < tokens.length; i++) {
    var t = /^(-?\d*)([A-Z]{2})$/.exec(tokens[i]);
    if (!t) continue;
    var dow = DOW_CODES.indexOf(t[2]);
    if (dow < 0) continue;
    out.push({ ord: t[1] ? +t[1] : 0, dow: dow });
  }
  return out;
}
```

Replace the `MONTHLY` branch of `expandRule_` with:

```js
  if (freq === 'MONTHLY') {
    var p = startYmd.split('-');
    var y = +p[0];
    var m = +p[1] - 1;
    var dom = +p[2];
    var byd = parseByDay_(rule);
    var guard = 0;
    while (out.length < n && guard++ < 600) {
      var cands = [];
      if (byd.length) {
        for (var b = 0; b < byd.length; b++) {
          var hit = byd[b].ord ? nthWeekdayOfMonth_(y, m, byd[b].ord, byd[b].dow) : null;
          if (hit) cands.push(hit);
        }
        cands.sort();
      } else {
        var exact = exactDayOfMonth_(y, m, dom);
        if (exact) cands.push(exact);
      }
      for (var c = 0; c < cands.length && out.length < n; c++) {
        // A rule anchored mid-month starts at its DTSTART, not at the first
        // candidate of that month — the earlier ones already happened.
        if (cands[c] >= startYmd) out.push(cands[c]);
      }
      m += interval;
      y += Math.floor(m / 12);
      m = ((m % 12) + 12) % 12;
    }
    return out;
  }
```

Delete the now-unused `var byday = rule.match(...)` line at the top of `expandRule_`.

Replace the `MONTHLY` clause of `describeCadence_` (and its `byday` variable) with:

```js
  var byd = parseByDay_(rule);

  if (freq === 'WEEKLY' && byd.length) {
    return every + ' on ' + DAY_NAMES_FULL[byd[0].dow];
  }
  if (freq === 'MONTHLY' && byd.length && byd[0].ord) {
    var ordinals = ['', 'first', 'second', 'third', 'fourth', 'fifth'];
    // "second and fourth Saturday" rather than "second Saturday and fourth
    // Saturday" when every entry names the same weekday, which is the common case.
    var sameDow = byd.every(function (b) { return b.dow === byd[0].dow; });
    var parts = byd.map(function (b) {
      return ordinals[b.ord] + (sameDow ? '' : ' ' + DAY_NAMES_FULL[b.dow]);
    });
    var joined = parts.length > 1
      ? parts.slice(0, -1).join(', ') + ' and ' + parts[parts.length - 1]
      : parts[0];
    return every + ' on the ' + joined + (sameDow ? ' ' + DAY_NAMES_FULL[byd[0].dow] : '');
  }
  return every;
```

**Step 4: Run to verify**

Run: `node tests/run.js RecurrenceService.gs`
Expected: all PASS, including every pre-existing test — `fitWeekly_`/`fitMonthlyByWeekday_` verification goes through `expandRule_`, so a regression here shows up immediately.

**Step 5: Commit**

```bash
git add src/RecurrenceService.gs
git commit -m "fix: expand and describe rules with more than one BYDAY"
```

---

## Task 5: Next occurrences and rule membership

**Files:**
- Modify: `src/RecurrenceService.gs`

**Step 1: Write the failing test**

```js
function test_nextOccurrencesAndFit() {
  // From Tue 2026-09-15 the 2nd Saturday (Sep 12) has passed; Sep 26 is next.
  var next = nextOccurrences_('FREQ=MONTHLY;BYDAY=2SA,4SA', '2026-09-15', 3);
  if (next.join(',') !== '2026-09-26,2026-10-10,2026-10-24') throw new Error('got ' + next.join(','));

  if (!dateFitsRule_('2026-09-26', 'FREQ=MONTHLY;BYDAY=2SA,4SA')) throw new Error('Sep 26 is the 4th Saturday');
  if (!dateFitsRule_('2026-10-10', 'FREQ=MONTHLY;BYDAY=2SA,4SA')) throw new Error('Oct 10 is the 2nd Saturday');
  if (dateFitsRule_('2026-10-03', 'FREQ=MONTHLY;BYDAY=2SA,4SA')) throw new Error('Oct 3 is the 1st Saturday');
  if (dateFitsRule_('2026-10-12', 'FREQ=MONTHLY;BYDAY=2SA,4SA')) throw new Error('Oct 12 is a Monday');

  // Interval alignment is deliberately NOT checked: the rule carries no anchor,
  // so whichever date is picked becomes DTSTART and defines the phase.
  if (!dateFitsRule_('2026-11-14', 'FREQ=MONTHLY;INTERVAL=2;BYDAY=2SA')) throw new Error('any 2nd Saturday anchors');

  if (!dateFitsRule_('2026-09-16', 'FREQ=WEEKLY;BYDAY=WE')) throw new Error('Sep 16 is a Wednesday');
  if (dateFitsRule_('2026-09-16', 'FREQ=WEEKLY;BYDAY=TH')) throw new Error('Sep 16 is not a Thursday');
  if (!dateFitsRule_('2026-09-16', 'FREQ=DAILY')) throw new Error('daily fits any date');

  var msg = describeDateMismatch_('2026-10-03', 'FREQ=MONTHLY;BYDAY=2SA,4SA');
  if (msg.indexOf('first Saturday') < 0) throw new Error('should name the ordinal: ' + msg);
  if (msg.indexOf('second and fourth Saturday') < 0) throw new Error('should name the rule: ' + msg);

  Logger.log('test_nextOccurrencesAndFit: ALL PASSED');
}
```

**Step 2: Run to verify it fails**

Run: `node tests/run.js RecurrenceService.gs`
Expected: FAIL with `nextOccurrences_ is not defined`

**Step 3: Implement**

```js
/**
 * The next n dates a rule generates on or after `fromYmd`.
 *
 * expandRule_ already skips candidates earlier than its start date, so this is
 * an expansion anchored at today rather than at an occurrence.
 *
 * @param {string} rule - RRULE body, with or without the RRULE: prefix
 * @param {string} fromYmd - inclusive lower bound, YYYY-MM-DD
 * @param {number} n
 * @returns {Array<string>}
 */
function nextOccurrences_(rule, fromYmd, n) {
  return expandRule_(rule, fromYmd, n);
}

/**
 * Whether a date could be the start of a series following `rule`.
 *
 * Checks the BYDAY / BYMONTHDAY constraint only, never interval alignment: an
 * open-ended rule carries no anchor, so DTSTART *is* the anchor and any date
 * matching the weekday-and-ordinal constraint is a legitimate phase. Validating
 * INTERVAL as well would mean inventing an anchor that does not exist.
 *
 * @param {string} ymd - YYYY-MM-DD
 * @param {string} rule
 * @returns {boolean}
 */
function dateFitsRule_(ymd, rule) {
  var freq = (rule.match(/FREQ=([A-Z]+)/) || [])[1];
  var byd = parseByDay_(rule);

  if (freq === 'WEEKLY') {
    if (!byd.length) return true;
    for (var i = 0; i < byd.length; i++) if (byd[i].dow === dowOf_(ymd)) return true;
    return false;
  }

  if (freq === 'MONTHLY') {
    if (byd.length) {
      for (var j = 0; j < byd.length; j++) {
        if (byd[j].dow === dowOf_(ymd) && (!byd[j].ord || byd[j].ord === ordinalInMonth_(ymd))) return true;
      }
      return false;
    }
    var md = (rule.match(/BYMONTHDAY=(\d+)/) || [])[1];
    return !md || +md === dayOfMonth_(ymd);
  }

  return true; // DAILY, or a FREQ we do not constrain
}

/**
 * Why a date does not fit a rule, in the vocabulary the source used.
 * @param {string} ymd
 * @param {string} rule
 * @returns {string}
 */
function describeDateMismatch_(ymd, rule) {
  var ordinals = ['', 'first', 'second', 'third', 'fourth', 'fifth'];
  return formatDateOnly_(ymd) + ' is the ' + ordinals[ordinalInMonth_(ymd)] + ' ' +
         DAY_NAMES_FULL[dowOf_(ymd)] + '; this repeats ' + describeCadence_(rule) + '.';
}
```

**Step 4: Run to verify**

Run: `node tests/run.js RecurrenceService.gs`
Expected: all PASS

**Step 5: Commit**

```bash
git add src/RecurrenceService.gs
git commit -m "feat: find the next occurrence of a rule and validate a start date"
```

---

## Task 6: Open-ended plans in planRecurrence_

**Files:**
- Modify: `src/RecurrenceService.gs` — `planRecurrence_`, `planRecurrence`

**Step 1: Write the failing test**

```js
function test_planRecurrenceOpenEnded() {
  var occ = [{ date: '2026-09-26', start_time: '19:00', end_time: '21:00' }];
  var rule = 'FREQ=MONTHLY;BYDAY=2SA,4SA';

  var plan = planRecurrence_(occ, 'America/Chicago', rule, null);
  if (plan.method !== 'rrule') throw new Error('method: ' + plan.method);
  if (!plan.openEnded) throw new Error('should be open-ended');
  if (plan.recurrence[0] !== 'RRULE:FREQ=MONTHLY;BYDAY=2SA,4SA') throw new Error('rule: ' + plan.recurrence[0]);
  if (/COUNT|UNTIL/.test(plan.recurrence[0])) throw new Error('open-ended rule must not terminate');
  // Only the real start date reaches the caller — no invented dates leak into
  // the duplicate check, the Drive filename or the Tockify start.
  if (plan.dates.length !== 1 || plan.dates[0].date !== '2026-09-26') throw new Error('dates: ' + JSON.stringify(plan.dates));
  if (plan.previewDates[1] !== '2026-10-10') throw new Error('preview: ' + plan.previewDates.join(','));
  if (plan.summary.indexOf('second and fourth Saturday') < 0) throw new Error('summary: ' + plan.summary);
  if (plan.summary.indexOf('no end date') < 0) throw new Error('summary should say it never ends: ' + plan.summary);

  // Capped by count.
  var capped = planRecurrence_(occ, 'America/Chicago', rule, { mode: 'count', count: 6 });
  if (capped.recurrence[0].indexOf(';COUNT=6') < 0) throw new Error('count cap: ' + capped.recurrence[0]);
  if (capped.openEnded) throw new Error('a capped series is not open-ended');

  // Capped by date, converted to COUNT — never UNTIL.
  var until = planRecurrence_(occ, 'America/Chicago', rule, { mode: 'until', date: '2026-11-30' });
  if (until.recurrence[0] !== 'RRULE:FREQ=MONTHLY;BYDAY=2SA,4SA;COUNT=5') throw new Error('until cap: ' + until.recurrence[0]);
  if (/UNTIL/.test(until.recurrence[0])) throw new Error('UNTIL must never be emitted');

  // A start date that does not fit is rejected with a readable reason.
  var bad = planRecurrence_([{ date: '2026-10-03', start_time: '19:00', end_time: '21:00' }],
                            'America/Chicago', rule, null);
  if (bad.method !== 'invalid') throw new Error('method: ' + bad.method);
  if (bad.summary.indexOf('first Saturday') < 0) throw new Error('reason: ' + bad.summary);

  // No rule: every existing path is untouched.
  var plain = planRecurrence_([
    { date: '2026-08-10', start_time: '19:00', end_time: '20:00' },
    { date: '2026-08-17', start_time: '19:00', end_time: '20:00' }
  ], 'America/Chicago', null, null);
  if (plain.method !== 'rrule' || plain.openEnded) throw new Error('fitted path changed: ' + JSON.stringify(plain));
  if (plain.recurrence[0].indexOf('COUNT=2') < 0) throw new Error('fitted rules still use COUNT');

  Logger.log('test_planRecurrenceOpenEnded: ALL PASSED');
}
```

**Step 2: Run to verify it fails**

Run: `node tests/run.js RecurrenceService.gs`
Expected: FAIL — `planRecurrence_` ignores the extra arguments, so `method` is `single`.

**Step 3: Implement**

Insert into `planRecurrence_` immediately after the `occ.length === 0` guard:

```js
  if (rule) {
    var stated = statedRulePlan_(occ, rule, ends);
    if (stated) return stated;
  }
```

Change the signature to `function planRecurrence_(occurrences, tz, rule, ends)` and add:

```js
var RULE_MAX_EXPANSION = 400;
var RULE_PREVIEW_COUNT = 6;

/**
 * A plan for a recurrence the source stated as a rule rather than as dates.
 *
 * Unlike a fitted rule, this one is open-ended by default: "every 2nd and 4th
 * Saturday every month" states no last date, so pinning a COUNT would invent an
 * end the source never gave and the series would die silently a year on. The
 * COUNT-always invariant still holds everywhere it earns its keep — a rule
 * fitted from a list of dates must never outrun that list.
 *
 * A cap the user chooses is always expressed as COUNT, including the "ends on a
 * date" case, so UNTIL never appears and there is no DST or timezone ambiguity
 * about where the series stops.
 *
 * @param {Array} occ - normalized occurrences; occ[0] is the start
 * @param {string} rule - RRULE body from extraction
 * @param {{mode:string, count:number, date:string}|null} ends
 * @returns {Object} plan
 */
function statedRulePlan_(occ, rule, ends) {
  var clean = String(rule).replace(/^RRULE:/, '').replace(/;?(COUNT|UNTIL)=[^;]*/g, '');
  if (!/FREQ=(DAILY|WEEKLY|MONTHLY)/.test(clean)) return null; // fall through to the fitted path

  var start = occ[0];
  if (!dateFitsRule_(start.date, clean)) {
    return { method: 'invalid', summary: describeDateMismatch_(start.date, clean),
             base: null, recurrence: null, exceptions: [], dates: [], previewDates: [] };
  }

  var count = 0;
  if (ends && ends.mode === 'count' && ends.count > 0) {
    count = Math.min(+ends.count, RULE_MAX_EXPANSION);
  } else if (ends && ends.mode === 'until' && ends.date) {
    count = expandRule_(clean, start.date, RULE_MAX_EXPANSION).filter(function (d) {
      return d <= ends.date;
    }).length;
    if (!count) {
      return { method: 'invalid',
               summary: 'That end date is before the first occurrence on ' + formatDateOnly_(start.date) + '.',
               base: null, recurrence: null, exceptions: [], dates: [], previewDates: [] };
    }
  }

  var line = 'RRULE:' + clean + (count ? ';COUNT=' + count : '');
  var preview = expandRule_(clean, start.date, count ? Math.min(count, RULE_PREVIEW_COUNT) : RULE_PREVIEW_COUNT);

  return {
    method: 'rrule',
    openEnded: !count,
    summary: summarizeStatedRule_(clean, start, count, preview),
    base: { date: start.date, start_time: start.start_time, end_time: start.end_time },
    recurrence: [line],
    exceptions: [],
    // Only the real start date. Everything downstream — findDuplicateDates, the
    // Drive filename, tockifyStartMillis_ — reads plan.dates, and none of them
    // should ever see a date the calendar has not been told about.
    dates: [{ date: start.date, start_time: start.start_time, end_time: start.end_time, isException: false }],
    previewDates: preview
  };
}

/** Banner text for a stated rule. */
function summarizeStatedRule_(rule, start, count, preview) {
  var head = 'Repeating event — ' + describeCadence_(rule) + ' at ' +
             formatTime12_(start.start_time) + ', starting ' + formatDateOnly_(start.date) + '. ';
  head += count
    ? count + ' occurrences, ending ' + formatDateOnly_(preview[preview.length - 1]) + '.'
    : 'No end date — it repeats indefinitely.';
  if (preview.length > 1) {
    head += ' Next: ' + preview.slice(0, 3).map(formatDateOnly_).join(', ') + '…';
  }
  return head;
}
```

Note `summarizeStatedRule_` reports the *capped* end from `preview`, so when `count` is set, expand to `count` (not the preview cap) for that last date — adjust by expanding once more inside the `count` branch if `count > RULE_PREVIEW_COUNT`.

Then widen the public wrapper:

```js
/**
 * @param {Array} occurrences
 * @param {string|null} rule - stated recurrence rule, if extraction found one
 * @param {Object|null} ends - {mode:'never'|'count'|'until', count, date}
 */
function planRecurrence(occurrences, rule, ends) {
  return planRecurrence_(occurrences, Session.getScriptTimeZone(), rule || null, ends || null);
}
```

**Step 4: Run to verify**

Run: `node tests/run.js RecurrenceService.gs`
Expected: all PASS, every pre-existing recurrence test included.

**Step 5: Commit**

```bash
git add src/RecurrenceService.gs
git commit -m "feat: plan an open-ended series from a stated recurrence rule"
```

---

## Task 7: Reading the flyer

**Files:**
- Modify: `src/Extraction.gs` — `EXTRACTION_PROMPT`, `extractEventData`, `callClaude_`, `claudeImageBlock_`

**Step 1: Split the image block so bytes are not fetched twice**

```js
/**
 * Packs already-downloaded image bytes as a Claude content block.
 * @param {Blob} blob
 * @param {string} mediaType - lowercased, no parameters
 * @returns {Object|null}
 */
function claudeImageBlockFromBlob_(blob, mediaType) {
  if (CLAUDE_IMAGE_TYPES.indexOf(mediaType) < 0) {
    Logger.log('claudeImageBlockFromBlob_: unusable content type ' + mediaType);
    return null;
  }
  var bytes = blob.getBytes();
  if (bytes.length > CLAUDE_MAX_IMAGE_BYTES) {
    Logger.log('claudeImageBlockFromBlob_: image is ' + bytes.length + ' bytes, too large to send');
    return null;
  }
  return {
    type: 'image',
    source: { type: 'base64', media_type: mediaType, data: Utilities.base64Encode(bytes) }
  };
}
```

Rewrite `claudeImageBlock_(imageUrl)` to fetch, then delegate to it — the Instagram path keeps working unchanged.

Add a fourth parameter to `callClaude_(htmlContent, strict, imageUrl, imageBlock)`:

```js
  var imageBlock = imageBlockArg || (imageUrl ? claudeImageBlock_(imageUrl) : null);
```

**Step 2: Add the prompt fields**

In `EXTRACTION_PROMPT`, after `image_url`:

```
  "recurrence_rule": "An RRULE body with NO COUNT and NO UNTIL, e.g. 'FREQ=MONTHLY;BYDAY=2SA,4SA' — ONLY when the source states a repeating pattern with no end. Otherwise null (string|null)",
  "recurrence_note": "The source's own words for that pattern, e.g. '7pm every 2nd and 4th Saturday every month'. Null when recurrence_rule is null (string|null)",
```

And in Rules:

```
- recurrence_rule: set it ONLY when the source states a pattern that has no stated end ("every 2nd and 4th Saturday every month", "every Tuesday"). When it is set, put exactly ONE entry in occurrences[] — the next date the pattern produces — and do not enumerate any others. A pattern WITH a stated end date is not this case: expand it into explicit dates as above and leave recurrence_rule null.
```

**Step 3: Write the image branch**

```js
var FLYER_PREAMBLE =
  'This is an event flyer image. There is no HTML — read the event details off the picture itself.\n' +
  'For the description, transcribe the flyer\'s own words: copy the text it prints, verbatim, in\n' +
  'reading order. Never compose a description of your own, never describe the artwork, and never\n' +
  'describe the QR codes. If the flyer states a repeating schedule, set recurrence_rule and\n' +
  'recurrence_note. Do not attempt to read any QR code — those are decoded separately.';

/**
 * Extracts an event from a flyer image: QR codes decoded for the link, the
 * picture itself read by Claude for the details.
 *
 * @param {string} url - the image URL that was pasted
 * @param {Blob} blob - already downloaded
 * @param {string} contentType - lowercased, no parameters
 * @returns {{data: Object}|{error: string, allowPaste?: true, originalUrl?: string}}
 */
function extractFromFlyerImage_(url, blob, contentType) {
  if (CLAUDE_IMAGE_TYPES.indexOf(contentType) < 0) {
    return { error: 'This is a ' + contentType + ' image, which cannot be read. ' +
                    'Save it as JPEG or PNG, or paste the flyer text instead.',
             allowPaste: true, originalUrl: url };
  }

  var bytes = blob.getBytes();
  if (bytes.length > CLAUDE_MAX_IMAGE_BYTES) {
    return { error: 'This image is ' + (Math.round(bytes.length / 100000) / 10) +
                    'MB, too large to read. Paste the flyer text instead.',
             allowPaste: true, originalUrl: url };
  }

  var codes = decodeQrCodes_(blob);
  var link = chooseEventLink(codes);

  var block = claudeImageBlockFromBlob_(blob, contentType);
  var content = FLYER_PREAMBLE + '\n\nSource URL: ' + url;
  var result = callClaude_(content, false, null, block);
  if (result === null) result = callClaude_(content, true, null, block);
  if (result === null) {
    return { error: 'Could not read this flyer. Paste the event text instead.',
             allowPaste: true, originalUrl: url };
  }

  result.image_url = url;
  if (link) {
    result.source_url = link.url;
    result.source_link_label = link.label;
  } else {
    // Nothing decoded server-side. Hand the browser the bytes so it can try:
    // a cross-origin <img> would taint the canvas and make the pixels
    // unreadable, but a data: URI is same-origin by definition.
    result.qr_pending = true;
    result.image_data_uri = 'data:' + contentType + ';base64,' + Utilities.base64Encode(bytes);
  }
  return { data: result };
}
```

**Step 4: Branch on content type in `extractEventData`**

Replace the generic fetch block (`src/Extraction.gs`, the `var html; try { ... }` section) with:

```js
  var response, blob, contentType;
  try {
    response = UrlFetchApp.fetch(url, { muteHttpExceptions: true, followRedirects: true });
    var code = response.getResponseCode();
    if (code !== 200) {
      return { error: 'Could not fetch the page (HTTP ' + code + '). It may be behind a login or paywall.' };
    }
    blob = response.getBlob();
    contentType = String(blob.getContentType() || '').toLowerCase().split(';')[0];
  } catch (e) {
    return { error: 'Could not reach the URL: ' + e.message };
  }

  // A flyer image rather than a page. Sniffed from the response rather than the
  // file extension, so a CDN URL with no .png on the end still works — and the
  // bytes are already here for both the QR decode and Claude.
  if (contentType.indexOf('image/') === 0) {
    return extractFromFlyerImage_(url, blob, contentType);
  }

  var html = response.getContentText();
```

**Step 5: Write the live test**

```js
function test_extractFlyerImage_live() {
  var r = extractEventData('https://horizons-cdn.hostinger.com/c3648fa5-28bf-4fa9-adf5-de27dbf4d0e8/sss-QlOin.png');
  if (r.error) throw new Error(r.error);
  var d = r.data;

  if (!/Sober Saturday Strolls/i.test(d.title)) throw new Error('title: ' + d.title);
  if (d.start_time !== '19:00') throw new Error('start_time: ' + d.start_time);
  if (!/Rock|Town Lake/i.test(d.location || '')) throw new Error('location: ' + d.location);
  if (d.source_url !== 'https://peoplesanctuary.org') throw new Error('source_url: ' + d.source_url);
  if (d.source_link_label !== 'See Website for details') throw new Error('label: ' + d.source_link_label);
  if (!/BYDAY=2SA,4SA/.test(d.recurrence_rule || '')) throw new Error('recurrence_rule: ' + d.recurrence_rule);
  if (d.occurrences.length !== 1) throw new Error('a stated rule gets one occurrence, got ' + d.occurrences.length);
  if (!dateFitsRule_(d.occurrences[0].date, d.recurrence_rule)) {
    throw new Error('extracted date ' + d.occurrences[0].date + ' does not fit its own rule');
  }
  if (d.image_url !== 'https://horizons-cdn.hostinger.com/c3648fa5-28bf-4fa9-adf5-de27dbf4d0e8/sss-QlOin.png') {
    throw new Error('image_url: ' + d.image_url);
  }

  Logger.log('test_extractFlyerImage_live: ALL PASSED');
}
```

**Step 6: Run it**

Run: `node tests/run-live.js Extraction.gs QrService.gs RecurrenceService.gs`
Expected: `1 passed, 0 failed`. This calls the real Claude API — it costs a request and needs the key file from the top of this plan.

Then confirm nothing else broke: `node tests/run.js Extraction.gs` and `node tests/run.js RecurrenceService.gs`.

**Step 7: Commit**

```bash
git add src/Extraction.gs
git commit -m "feat: extract events from flyer images"
```

---

## Task 8: Carrying the rule to the calendar

**Files:**
- Modify: `src/CalendarService.gs:154-175` — `createCalendarEvent`
- Modify: `src/Code.gs` — `submitEvent`

**Step 1: Pass the rule through both planners**

In `createCalendarEvent`:

```js
    var plan = planRecurrence_(occurrences, tz, eventData.recurrence_rule || null,
                               eventData.recurrence_ends || null);
    if (plan.method === 'none') return { error: 'No valid dates to create.' };
    if (plan.method === 'invalid') return { error: plan.summary };
```

In `submitEvent`, the same two lines, replacing:

```js
  var plan = planRecurrence_(occurrences, Session.getScriptTimeZone());
  if (plan.method === 'none') return { error: 'Please provide at least one valid date.' };
```

**Step 2: Report an open-ended series honestly**

`submitEvent` returns `occurrenceCount: calResult.occurrenceCount`, which is `plan.dates.length` — 1 for an open-ended series, which would read as "1 occurrence". Add `openEnded: plan.openEnded || false` to the returns of both `createCalendarEvent` and `submitEvent`, and let the UI phrase it (Task 9).

**Step 3: Verify**

`planRecurrence_` is exercised by `node tests/run.js RecurrenceService.gs`; these two call sites are `Calendar`/`Drive`-bound and are verified by the live submit in Task 12.

Run: `node tests/run.js RecurrenceService.gs CalendarService.gs`
Expected: all PASS (`CalendarService.gs` contributes only its pure tests).

**Step 4: Commit**

```bash
git add src/CalendarService.gs src/Code.gs
git commit -m "feat: carry a stated recurrence rule through to the calendar"
```

---

## Task 9: Confirmation screen — rule banner, Ends control, date validation

**Files:**
- Modify: `src/Index.html`

**Step 1: Hold the rule in page state**

Beside `var sourceUrl = '';` (≈ line 341) add:

```js
    var recurrenceRule = null;   // set by populateForm when extraction states one
    var recurrenceEnds = { mode: 'never' };
```

Reset both in the same place `sourceUrl` is reset (≈ line 783).

**Step 2: Markup for the Ends control**

Directly after the `recurrence-banner` element add:

```html
      <div id="rule-controls" style="display:none">
        <label for="ends-mode">Ends</label>
        <select id="ends-mode" onchange="onEndsChanged()">
          <option value="never">Never</option>
          <option value="count">After…</option>
          <option value="until">On date…</option>
        </select>
        <input id="ends-count" type="number" min="1" max="400" value="12"
               style="display:none" onchange="onEndsChanged()"> <span id="ends-count-label"
               style="display:none">occurrences</span>
        <input id="ends-date" type="date" style="display:none" onchange="onEndsChanged()">
        <button type="button" class="linkish" onclick="clearRecurrenceRule()">Use a date list instead</button>
      </div>
```

Match the surrounding class names and spacing conventions rather than these inline styles where the file already has a suitable class.

**Step 3: Wire it up**

```js
    function onEndsChanged() {
      var mode = document.getElementById('ends-mode').value;
      document.getElementById('ends-count').style.display = mode === 'count' ? '' : 'none';
      document.getElementById('ends-count-label').style.display = mode === 'count' ? '' : 'none';
      document.getElementById('ends-date').style.display = mode === 'until' ? '' : 'none';
      recurrenceEnds = {
        mode: mode,
        count: +document.getElementById('ends-count').value,
        date: document.getElementById('ends-date').value
      };
      onDatesChanged();
    }

    // A rule and a hand-built date list are two contradictory sources of truth,
    // so only one is ever active. Clearing the rule restores the multi-date UI.
    function clearRecurrenceRule() {
      recurrenceRule = null;
      recurrenceEnds = { mode: 'never' };
      applyRuleMode();
      onDatesChanged();
    }

    function applyRuleMode() {
      var active = !!recurrenceRule;
      document.getElementById('rule-controls').style.display = active ? '' : 'none';
      document.getElementById('add-date').style.display = active ? 'none' : '';
      if (active) {
        // One row only: the rule supplies every date after the first.
        var rows = document.getElementById('date-rows');
        while (rows.children.length > 1) rows.removeChild(rows.lastChild);
      }
      onDatesChanged();
    }
```

(Use the real id of the **Add date** button; add one if it has none.)

**Step 4: Pass the rule to the planner and block an unfitting date**

In `onDatesChanged`, change the call to:

```js
          .planRecurrence(occ, recurrenceRule, recurrenceEnds);
```

In `renderPlan`:

```js
    function renderPlan(plan) {
      var banner = document.getElementById('recurrence-banner');
      planInvalid = plan.method === 'invalid';
      banner.className = 'rec-banner' +
        (planInvalid ? ' error' : plan.method === 'single' ? ' single' : '');
      banner.textContent = (planInvalid ? '⚠ ' : plan.method === 'single' ? '' : '↻ ') + plan.summary;
      ...
```

Declare `var planInvalid = false;` alongside the other page state, and in `submitEvent()` add, next to the existing title check:

```js
      if (planInvalid) {
        setStatus('submit-status', 'error', document.getElementById('recurrence-banner').textContent);
        return;
      }
```

Add `recurrence_rule: recurrenceRule` and `recurrence_ends: recurrenceEnds` to the object passed to `google.script.run...submitEvent(...)` (≈ line 611).

**Step 5: Populate from extraction**

In `populateForm`, after the date rows are built:

```js
      recurrenceRule = data.recurrence_rule || null;
      recurrenceEnds = { mode: 'never' };
      document.getElementById('ends-mode').value = 'never';
      applyRuleMode();
```

And in the success message (≈ line 644), phrase an open-ended series honestly:

```js
            : result.openEnded
              ? 'Created one repeating event with no end date.'
              : 'Created one repeating event with ' + result.occurrenceCount + ' occurrences.'
```

**Step 6: Verify in the browser**

There is no local harness for `Index.html`. Deploy to the web app and check by hand:

```bash
./deploy.sh "flyer image extraction — UI"
```

Paste the test flyer URL and confirm: one date row showing 2026-09-26, **Add date** hidden, the banner reading "every month on the second and fourth Saturday at 7:00 PM… No end date", and typing `2026-10-03` into the date turning the banner into the "Oct 3 is the first Saturday" error with submit refused.

Note the memory rule: deploy from merged `main`, not from a branch. For this mid-branch check, deploy and then redeploy `main` afterwards if the branch is not ready to merge — or defer this verification to Task 12 and only read the code here.

**Step 7: Commit**

```bash
git add src/Index.html
git commit -m "feat: confirm an open-ended series and validate its start date"
```

---

## Task 10: Browser QR fallback

**Files:**
- Modify: `src/Index.html`

**Step 1: Load the decoder**

In `<head>`, pinned to an exact version:

```html
<script src="https://cdn.jsdelivr.net/npm/@zxing/library@0.21.3/umd/index.min.js"></script>
```

**Step 2: Decode when the server could not**

```js
    // Server-side decoding found nothing, so try in the browser. The image
    // arrives as a data: URI rather than by URL on purpose: reading pixels back
    // from a canvas that loaded a cross-origin image throws unless the host
    // sends Access-Control-Allow-Origin, and flyer CDNs generally do not.
    //
    // zxing's multi-format reader finds every symbol in one image. jsQR returns
    // only the first, which on a flyer carrying Instagram, website and Facebook
    // codes means the social one and nothing else.
    function decodeQrInBrowser(dataUri) {
      if (!window.ZXing) return;
      var img = new Image();
      img.onload = function () {
        var canvas = document.createElement('canvas');
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        canvas.getContext('2d').drawImage(img, 0, 0);
        var urls = [];
        try {
          var reader = new ZXing.MultiFormatReader();
          var hints = new Map();
          hints.set(ZXing.DecodeHintType.POSSIBLE_FORMATS, [ZXing.BarcodeFormat.QR_CODE]);
          hints.set(ZXing.DecodeHintType.TRY_HARDER, true);
          var source = new ZXing.HTMLCanvasElementLuminanceSource(canvas);
          var results = new ZXing.GenericMultipleBarcodeReader(reader)
            .decodeMultiple(new ZXing.BinaryBitmap(new ZXing.HybridBinarizer(source)), hints);
          for (var i = 0; i < results.length; i++) urls.push(results[i].getText());
        } catch (e) {
          return; // no codes found; the event just has no source link
        }
        if (!urls.length) return;
        google.script.run
          .withSuccessHandler(function (link) {
            if (!link) return;
            sourceUrl = link.url;
            document.getElementById('f-link-label').value = link.label;
          })
          .chooseEventLink(urls);
      };
      img.src = dataUri;
    }
```

**Step 3: Call it, and honour a server-chosen link**

In `populateForm`, replacing the unconditional `sourceUrl = url` behaviour:

```js
      if (data.source_url) sourceUrl = data.source_url;
      if (data.qr_pending && data.image_data_uri) decodeQrInBrowser(data.image_data_uri);
```

`sourceUrl` is assigned at ≈ line 362 from the pasted URL; for a flyer that URL is the PNG itself, and a calendar event whose "See Website for details" link opens a bare image is worse than no link. Confirm the extraction path overwrites it rather than the other way round.

**Step 4: Verify**

Temporarily force the fallback by making `decodeQrCodes_` return `[]` at the top, deploy, paste the flyer URL, and confirm the link label and source still resolve to `peoplesanctuary.org`. Remove the stub afterwards and confirm the server path still wins.

**Step 5: Commit**

```bash
git add src/Index.html
git commit -m "feat: decode flyer QR codes in the browser when the API cannot"
```

---

## Task 11: README

**Files:**
- Modify: `README.md`

Add an **Image flyers** section after **Instagram posts**, in the established voice — what was measured, what the trap is, why each decision went the way it did. It must cover:

- Content-type sniffing rather than file extensions
- The goqr.me response shape (all codes in one `data` string, `QR-Code:` prefixes) — the single most re-breakable detail here
- Why the bytes are POSTed rather than `fileurl=` passed
- Why the browser fallback needs a `data:` URI (canvas tainting) and zxing rather than jsQR (multi-code)
- The link ranking, and that the chosen link replaces the pasted image URL as the source link
- Open-ended rules: why `COUNT` is right for fitted rules and wrong for stated ones, and that a user-chosen cap still becomes `COUNT`, never `UNTIL`
- Why start-date validation checks weekday-and-ordinal but not interval alignment
- The Node shim: why `clasp run` cannot work here, and that `tests/run-live.js` replaces it

Also add a short **Running the tests** note if none exists:

```
node tests/run.js RecurrenceService.gs QrService.gs   # pure, no network
node tests/run-live.js QrService.gs Extraction.gs     # real services, needs the Claude key
```

**Commit:**

```bash
git add README.md
git commit -m "docs: record image flyer extraction"
```

---

## Task 12: Verify end to end, then merge and deploy

**Step 1: Full local suite**

```bash
node tests/run.js RecurrenceService.gs QrService.gs Extraction.gs CalendarService.gs TockifyUtil.gs
node tests/run-live.js QrService.gs Extraction.gs
```

Expected: `0 failed` from both. Paste the real output into the PR — @superpowers:verification-before-completion.

**Step 2: Open the PR**

```bash
git push -u origin image-flyer-extraction
gh pr create --title "Extract events from flyer images" --body "..."
```

**Step 3: Merge, then deploy from `main`**

```bash
gh pr merge --merge
git checkout main && git pull
./deploy.sh "flyer image extraction"
```

Deploying from the branch is what the memory rule forbids; `deploy.sh` redeploys the fixed deployment ID so the bookmarked URL survives.

**Step 4: Live check in the web app**

Paste `https://horizons-cdn.hostinger.com/c3648fa5-28bf-4fa9-adf5-de27dbf4d0e8/sss-QlOin.png` and confirm:

- Title, 7:00 PM, and "The Rock at Town Lake" are filled in
- The banner reads "every month on the second and fourth Saturday… No end date"
- One date row, showing the next 2nd-or-4th Saturday
- The source link is `peoplesanctuary.org`, labelled "See Website for details"
- Submitting creates **one** repeating Google Calendar event whose later instances land on the 2nd and 4th Saturdays, with the flyer attached

**Step 5: Clean up**

Delete the created test event from the calendar and its flyer from Drive, and check the Tockify queue drained or was cleared.
