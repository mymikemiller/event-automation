# Facebook Event Extraction Without Login — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Extract public Facebook event details by reading the data Facebook already server-renders into the page, removing the Facebook login/OAuth flow entirely.

**Architecture:** Facebook's "See more on Facebook" dialog is a client-side overlay drawn on top of content that is already in the HTML. A server-side fetch that sends an `Accept: text/html` header gets the full event record embedded as JSON in `<script type="application/json" data-sjs>` blocks — title, exact epoch start/end timestamps, place, cover photo, and the complete description with its link ranges. We parse those fields in Apps Script, hand only the small structured block to Claude for date shaping, and pass the description through **verbatim**.

**Tech Stack:** Google Apps Script (V8), `UrlFetchApp`, Claude API, `tests/run.js` (Node `vm` sandbox for pure `.gs` files).

---

## Empirical findings this plan is built on

Verified against `https://www.facebook.com/events/1058029123674308/` on 2026-07-27:

| Finding | Detail |
|---|---|
| `Accept` header is required | With `Accept: text/html,...` → 685KB page containing event JSON. Without it → 586KB JS shell, zero event data. Reproducible across repeated fetches. |
| Do **not** set a browser User-Agent | `UrlFetchApp` cannot override User-Agent anyway, and its own Apps Script UA works. A Chrome UA returns HTTP 400. |
| No login needed | Page contains `"actor":{"__typename":"LoggedOutUser","id":"0"}`. |
| Description is complete | `event_description.text` held all 1515 chars — well past the "See more" cutoff. Facebook truncates only visually. |
| Links have three forms | `entity.url` = `l.facebook.com/l.php?u=…&h=…` tracking wrapper (signed, expires). `entity.external_url` = clean full destination. Use `external_url`. |
| **Link offsets are codepoints, not UTF-16** | For `"offset":1150,"length":115`, JS `substr(1150,115)` returns `"😊\n\nLink: https://…mqt2jofkz4e9"` (mangled, href broken). Counting codepoints returns the exact 115-char URL. 13 emoji precede the link. **This is the bug most likely to ship silently.** |
| Cover photo | `cover_photo…full_image.uri`, 1600x900, 462 chars incl. required `_nc_*` query params. Stripping params → 403. Has an `oe=` expiry, fine because `DriveService.gs` downloads immediately. |

---

## Design decisions

1. **Description is never rewritten by the language model.** The Facebook path builds the description HTML itself from `event_description.text` + `ranges[]` and passes it straight through to the calendar event. Claude is used only for title/date/time/`occurrences` shaping. Claude's returned `description` is discarded on this path.
2. **Links must work like they do on the rendered Facebook page.** Anchor text is the substring Facebook displays; `href` is `external_url` (full, unwrapped, no `l.facebook.com`).
3. **The login flow is removed entirely** — `FacebookAuth.gs`, `OAuthCallback.html`, the OAuth branch in `doGet`, the Facebook UI in `Index.html`, and the `FACEBOOK_APP_ID` / `FACEBOOK_APP_SECRET` script properties.
4. **The paste fallback survives**, rewired: it no longer triggers on login-wall detection (which is being deleted) but on Facebook extraction failure, so there is still a manual escape hatch if Facebook changes its markup.

---

## Task 1: Facebook page fetch and JSON field extraction

**Files:**
- Create: `src/FacebookService.gs`
- Test: `test_*` functions inside `src/FacebookService.gs`, run by `tests/run.js`

`tests/run.js` executes `.gs` files in a bare `vm` context with no `require`/`fs`, so fixtures must be inline string literals in the test function. Keep the fixture small but structurally identical to the real page.

**Step 1: Write the failing test**

```js
function test_fbFindString() {
  var s = '"name":"Movie Night","is_canceled":false,"day_time_sentence":"Sunday, August 2, 2026 at 8:30 AM – 10:30 AM CDT"';
  if (fbFindString_(s, 'day_time_sentence') !== 'Sunday, August 2, 2026 at 8:30 AM – 10:30 AM CDT') {
    throw new Error('day_time_sentence mismatch: ' + fbFindString_(s, 'day_time_sentence'));
  }
  if (fbFindString_(s, 'nope') !== null) throw new Error('missing key should be null');

  // Escaped quotes and slashes inside the value must survive.
  var esc = '"uri":"https:\\/\\/x.test\\/a?b=1&c=2","q":"say \\"hi\\""';
  if (fbFindString_(esc, 'uri') !== 'https://x.test/a?b=1&c=2') throw new Error('slash unescape failed');
  if (fbFindString_(esc, 'q') !== 'say "hi"') throw new Error('quote unescape failed');

  Logger.log('test_fbFindString: ALL PASSED');
}

function test_fbFindNumber() {
  var s = '"tz_display_name":"CDT","start_timestamp":1785677400,"end_timestamp":1785684600}';
  if (fbFindNumber_(s, 'start_timestamp') !== 1785677400) throw new Error('start mismatch');
  if (fbFindNumber_(s, 'end_timestamp') !== 1785684600) throw new Error('end mismatch');
  if (fbFindNumber_(s, 'absent') !== null) throw new Error('missing number should be null');
  Logger.log('test_fbFindNumber: ALL PASSED');
}
```

**Step 2: Run to verify it fails**

Run: `node tests/run.js FacebookService.gs`
Expected: FAIL — `fbFindString_ is not defined`

**Step 3: Implement the helpers**

Key-anchored scanning, not whole-page `JSON.parse` (the blobs are hundreds of KB and Apps Script has no DOM parser).

```js
/**
 * Reads a JSON string value by key out of raw page text.
 * Walks the value manually so escaped quotes don't end it early.
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
    out += ch; k++;
  }
  try { return JSON.parse('"' + out + '"'); } catch (e) { return null; }
}

function fbFindNumber_(text, key, fromIndex) {
  var m = new RegExp('"' + key + '":(-?\\d+)').exec(text.substring(fromIndex || 0));
  return m ? parseInt(m[1], 10) : null;
}
```

**Step 4: Run to verify it passes**

Run: `node tests/run.js FacebookService.gs`
Expected: PASS

**Step 5: Commit**

```bash
git add src/FacebookService.gs
git commit -m "feat: add Facebook page JSON field helpers"
```

---

## Task 2: Codepoint-correct description linkifying

This is the task that protects the working-links requirement.

**Files:**
- Modify: `src/FacebookService.gs`

**Step 1: Write the failing test**

The fixture deliberately puts emoji before the link so a UTF-16 `substr` fails.

```js
function test_fbLinkifyOffsets() {
  // 3 emoji (each 2 UTF-16 units) before the URL => codepoint offsets run 3 ahead.
  var text = '😊🎉✊ Link: https://ex.test/abc and more';
  var url = 'https://ex.test/abc';
  var offset = [].concat.apply([], text.split('')).length; // placeholder, real value below
  // codepoint index of the URL:
  var cps = Array.from(text);
  offset = cps.join('').indexOf(url) >= 0 ? Array.from(text.substring(0, text.indexOf(url))).length : -1;
  var ranges = [{ offset: offset, length: Array.from(url).length, url: 'https://ex.test/abc' }];

  var html = fbLinkify_(text, ranges);
  if (html.indexOf('<a href="https://ex.test/abc">https://ex.test/abc</a>') < 0) {
    throw new Error('link not built correctly: ' + html);
  }
  // The emoji must survive intact, not be split mid-surrogate.
  if (html.indexOf('😊🎉✊') !== 0) throw new Error('emoji corrupted: ' + html);

  Logger.log('test_fbLinkifyOffsets: ALL PASSED');
}

function test_fbLinkifyEscapesAndBreaks() {
  var html = fbLinkify_('a < b & c\n\nnext', []);
  if (html !== 'a &lt; b &amp; c<br><br>next') throw new Error('got: ' + html);
  Logger.log('test_fbLinkifyEscapesAndBreaks: ALL PASSED');
}

function test_fbParseDescriptionRanges() {
  // external_url must win over the l.facebook.com wrapper.
  var blob = '"ranges":[{"entity":{"__typename":"ExternalUrl",' +
    '"url":"https:\\/\\/l.facebook.com\\/l.php?u=https\\u00253A\\u00252F\\u00252Fex.test&h=AUA7",' +
    '"external_url":"https:\\/\\/ex.test\\/full-path"},"length":19,"offset":7}]';
  var r = fbParseRanges_(blob);
  if (r.length !== 1) throw new Error('expected 1 range, got ' + r.length);
  if (r[0].url !== 'https://ex.test/full-path') throw new Error('should prefer external_url, got ' + r[0].url);
  if (r[0].offset !== 7 || r[0].length !== 19) throw new Error('offset/length mismatch');
  Logger.log('test_fbParseDescriptionRanges: ALL PASSED');
}
```

**Step 2: Run to verify it fails**

Run: `node tests/run.js FacebookService.gs`
Expected: FAIL — `fbLinkify_ is not defined`

**Step 3: Implement**

```js
function fbEscapeHtml_(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Rebuilds Facebook's description as HTML with working links.
 *
 * Facebook reports link positions as offsets in Unicode CODEPOINTS, while
 * JavaScript strings are indexed in UTF-16 code units. Any emoji earlier in the
 * text shifts the two apart — a naive substr() slices mid-surrogate and yields a
 * mangled href. So we split to a codepoint array and index that.
 */
function fbLinkify_(text, ranges) {
  var cps = Array.from(text);
  var sorted = (ranges || []).slice().sort(function (a, b) { return a.offset - b.offset; });

  var out = '';
  var pos = 0;
  for (var i = 0; i < sorted.length; i++) {
    var r = sorted[i];
    if (r.offset < pos || r.offset + r.length > cps.length) continue; // ignore bad ranges
    out += fbEscapeHtml_(cps.slice(pos, r.offset).join(''));
    var label = cps.slice(r.offset, r.offset + r.length).join('');
    out += '<a href="' + fbEscapeHtml_(r.url) + '">' + fbEscapeHtml_(label) + '</a>';
    pos = r.offset + r.length;
  }
  out += fbEscapeHtml_(cps.slice(pos).join(''));

  return out.replace(/\r\n|\r|\n/g, '<br>');
}

/**
 * Pulls link ranges out of the description blob.
 * Prefers entity.external_url — entity.url is an l.facebook.com redirect
 * carrying a signed token that expires, which would break the calendar link.
 */
function fbParseRanges_(blob) {
  var i = blob.indexOf('"ranges":[');
  if (i < 0) return [];
  var out = [];
  var re = /\{"entity":\{[\s\S]*?\}[^{}]*?"length":(\d+),"offset":(\d+)\}/g;
  var seg = blob.substring(i);
  var m;
  while ((m = re.exec(seg)) !== null) {
    var chunk = m[0];
    var url = fbFindString_(chunk, 'external_url') ||
              fbFindString_(chunk, 'url');
    if (!url || url.indexOf('l.facebook.com') >= 0) {
      url = fbFindString_(chunk, 'external_url');
    }
    if (url) out.push({ url: url, length: parseInt(m[1], 10), offset: parseInt(m[2], 10) });
  }
  return out;
}
```

**Step 4: Run to verify it passes**

Run: `node tests/run.js FacebookService.gs`
Expected: PASS (5 tests)

**Step 5: Commit**

```bash
git add src/FacebookService.gs
git commit -m "feat: linkify Facebook descriptions using codepoint offsets"
```

---

## Task 3: Assemble the event record

**Files:**
- Modify: `src/FacebookService.gs`

**Step 1: Write the failing test**

```js
function test_fbParseEvent() {
  var html =
    '<meta property="og:title" content="Movie Night" />' +
    '<script type="application/json" data-sjs>{"data":{"event":' +
    '"is_canceled":false,"day_time_sentence":"Sunday, August 2, 2026 at 8:30 AM – 10:30 AM CDT",' +
    '"event_place":{"__typename":"FreeformPlace","name":"Pfluger Brg, Austin, TX"},' +
    '"cover_photo":{"photo":{"full_image":{"height":900,"uri":"https:\\/\\/scontent.test\\/img.webp?oh=1&oe=2"}}},' +
    '"event_description":{"text":"Hi 😊\\nLink: https:\\/\\/ex.test\\/abc",' +
    '"ranges":[{"entity":{"__typename":"ExternalUrl","external_url":"https:\\/\\/ex.test\\/abc"},"length":19,"offset":9}]},' +
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

  // A page with no event data must return null so the caller can fall back.
  if (parseFacebookEvent_('<html><body>nothing here</body></html>') !== null) {
    throw new Error('expected null for a non-event page');
  }
  Logger.log('test_fbParseEvent: ALL PASSED');
}
```

**Step 2: Run to verify it fails**

Run: `node tests/run.js FacebookService.gs` → FAIL, `parseFacebookEvent_ is not defined`

**Step 3: Implement**

```js
/**
 * Extracts the event record Facebook server-renders into the page.
 * Returns null when the page carries no event data, so callers can fall back.
 */
function parseFacebookEvent_(html) {
  var anchor = html.indexOf('"day_time_sentence"');
  if (anchor < 0) return null;

  var ev = {
    title: fbFindString_(html, 'og:title') || null,
    dayTimeSentence: fbFindString_(html, 'day_time_sentence'),
    startTimestamp: fbFindNumber_(html, 'start_timestamp'),
    endTimestamp: fbFindNumber_(html, 'end_timestamp'),
    timezone: fbFindString_(html, 'tz_display_name'),
    location: null,
    descriptionHtml: null,
    imageUrl: null
  };

  // og:title lives in a meta tag, not JSON — fbFindString_ won't see it.
  if (!ev.title) {
    var tm = html.match(/<meta property="og:title" content="([^"]*)"/);
    if (tm) ev.title = tm[1];
  }

  var pi = html.indexOf('"event_place"');
  if (pi >= 0) ev.location = fbFindString_(html, 'name', pi);

  var ci = html.indexOf('"full_image"');
  if (ci >= 0) ev.imageUrl = fbFindString_(html, 'uri', ci);

  var di = html.indexOf('"event_description"');
  if (di >= 0) {
    var blob = html.substring(di, di + 60000);
    var text = fbFindString_(blob, 'text');
    if (text) ev.descriptionHtml = fbLinkify_(text, fbParseRanges_(blob));
  }

  return ev;
}

/**
 * Fetches a Facebook event page.
 *
 * The Accept header is what makes this work: with it Facebook server-renders the
 * event into the HTML; without it the same URL returns a JavaScript shell with no
 * event data. Do NOT set a User-Agent — UrlFetchApp ignores it, and Facebook
 * returns HTTP 400 for a browser UA on this endpoint anyway.
 */
function fetchFacebookEventPage_(url) {
  var resp = UrlFetchApp.fetch(url, {
    muteHttpExceptions: true,
    followRedirects: true,
    headers: { 'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' }
  });
  if (resp.getResponseCode() !== 200) return null;
  return resp.getContentText();
}
```

**Step 4: Run** → PASS (6 tests)

**Step 5: Commit**

```bash
git add src/FacebookService.gs
git commit -m "feat: parse Facebook event record from server-rendered page"
```

---

## Task 4: Wire into extraction, with a verbatim description

**Files:**
- Modify: `src/Extraction.gs` (Facebook branch of `extractEventData`, and `detectLoginWall_`)
- Modify: `src/FacebookService.gs` (add `formatFacebookEventForClaude_`)

Claude still shapes title/date/`occurrences`, but the description it returns is **replaced** with the verbatim one. Timestamps go into the prompt block as both epoch and a rendered local sentence.

**Step 1: Write the failing test**

```js
function test_fbFormatForClaude() {
  var ev = {
    title: 'Movie Night',
    dayTimeSentence: 'Sunday, August 2, 2026 at 8:30 AM – 10:30 AM CDT',
    startTimestamp: 1785677400, endTimestamp: 1785684600, timezone: 'CDT',
    location: 'Pfluger Brg, Austin, TX',
    descriptionHtml: 'Hi<br>more',
    imageUrl: 'https://scontent.test/img.webp'
  };
  var block = formatFacebookEventForClaude_(ev, 'https://facebook.com/events/1/');
  if (block.indexOf('Movie Night') < 0) throw new Error('missing title');
  if (block.indexOf('Sunday, August 2, 2026') < 0) throw new Error('missing when');
  if (block.indexOf('1785677400') < 0) throw new Error('missing epoch start');
  if (block.indexOf('https://facebook.com/events/1/') < 0) throw new Error('missing source url');
  Logger.log('test_fbFormatForClaude: ALL PASSED');
}
```

**Step 2: Run** → FAIL

**Step 3: Implement the formatter and rewire the branch**

In `src/FacebookService.gs`:

```js
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
  lines.push('The description is supplied separately and must not be rewritten.');
  lines.push('=== END FACEBOOK EVENT DATA ===');
  return lines.join('\n');
}
```

Replace the Facebook branch at the top of `extractEventData` in `src/Extraction.gs`:

```js
  // Facebook renders the event into the page HTML for logged-out visitors; the
  // "See more on Facebook" dialog is only a client-side overlay on top of it.
  // See docs/plans/2026-07-27-facebook-no-login-plan.md for why the Accept
  // header matters and why we never set a User-Agent.
  if (url.indexOf('facebook.com/events/') >= 0) {
    var fbHtml = fetchFacebookEventPage_(url);
    var fbEvent = fbHtml ? parseFacebookEvent_(fbHtml) : null;
    if (fbEvent) {
      var content = formatFacebookEventForClaude_(fbEvent, url);
      var fbResult = callClaude_(content, false);
      if (fbResult === null) fbResult = callClaude_(content, true);
      if (fbResult) {
        // The description is copied verbatim from Facebook, never rewritten.
        if (fbEvent.descriptionHtml) fbResult.description = fbEvent.descriptionHtml;
        if (fbEvent.imageUrl) fbResult.image_url = fbEvent.imageUrl;
        if (fbEvent.location && !fbResult.location) fbResult.location = fbEvent.location;
        return { data: fbResult };
      }
    }
    return {
      error: 'Could not read this Facebook event. Facebook may have changed its page format. ' +
             'Open the event in your browser, close the login popup, copy the event text, and paste it below.',
      allowPaste: true,
      originalUrl: url
    };
  }
```

Delete `detectLoginWall_` and its call site in `extractEventData`, plus the `fetchFacebookPostContent_` fallback block that depended on it.

**Step 4: Run** → PASS (7 tests)

**Step 5: Commit**

```bash
git add src/FacebookService.gs src/Extraction.gs
git commit -m "feat: extract Facebook events without login, description verbatim"
```

---

## Task 5: Strengthen the no-rewriting rule in the prompt

**Files:**
- Modify: `src/Extraction.gs` (`EXTRACTION_PROMPT`)

The Facebook path bypasses Claude for descriptions outright. For every other site there is no structured verbatim source, so the prompt is the only lever — make the copy-don't-rewrite instruction unambiguous.

Change the `description` rule to:

```
- For description: reproduce the page's description text EXACTLY as written, word for word. You are copying, not writing. Never summarize, shorten, paraphrase, reword, or "improve" it. Never add text of your own. Preserve every paragraph and list item. Preserve full URLs exactly — never truncate a URL or replace part of it with an ellipsis. Use only <b>, <i>, <ul>, <li>, <a href>, <br>; strip all other tags.
```

**Commit:**

```bash
git add src/Extraction.gs
git commit -m "docs: make the verbatim-description rule explicit in the prompt"
```

---

## Task 6: Remove the Facebook login flow

**Files:**
- Delete: `src/FacebookAuth.gs`, `src/OAuthCallback.html`
- Modify: `src/Code.gs` (OAuth branch in `doGet`)
- Modify: `src/Index.html`

**Step 1:** Delete the files.

```bash
git rm src/FacebookAuth.gs src/OAuthCallback.html
```

**Step 2:** In `src/Code.gs`, remove the OAuth callback branch from `doGet` (the `if (e && e.parameter && e.parameter.code && e.parameter.state)` block and its comment).

**Step 3:** In `src/Index.html`, remove:
- CSS rules `.fb-bar`, `.fb-bar .fb-icon`, `.fb-bar .fb-label`, `.fb-bar .fb-label.connected`, `.fb-bar button`, `.fb-btn-connect`, `.fb-btn-disconnect` (lines ~27-33)
- The `#fb-bar` div and the `#fb-token-panel` div (lines ~58-77)
- `var fbConnected = false;` and the whole `── Facebook ──` JS section: `checkFacebookStatus`, `updateFbBar`, `handleFbButtonClick`, `startFacebookOAuth`, the `window.addEventListener('message', …)` OAuth listener, `showFbTokenPanel`, `hideFbTokenPanel`, `saveFbToken` (lines ~150-261)
- The `checkFacebookStatus();` call on load (~line 609)

**Step 4:** Rewire the paste fallback. Replace the `result.loginRequired` branch in `extractEvent`'s success handler with:

```js
          if (result.allowPaste) {
            showPasteSection(result.error, result.originalUrl);
            return;
          }
```

and replace `showPasteSection` with:

```js
    function showPasteSection(message, originalUrl) {
      document.getElementById('paste-login-notice').innerHTML =
        '<strong>&#9888; Could not read that page automatically</strong>' +
        message +
        (originalUrl ? ' <a href="' + originalUrl + '" target="_blank">Open the original page</a>.' : '');
      hide('url-section');
      show('paste-section');
      document.getElementById('paste-input').focus();
    }
```

Update the `#paste-input` placeholder to: `Open the event on Facebook, close the login popup, select the event text, and paste it here...`

**Step 5:** Verify nothing still references the removed functions.

Run:
```bash
grep -rn 'getFacebookStatus\|getFacebookAuthUrl\|saveFacebookToken\|disconnectFacebook\|fbConnected\|OAuthCallback\|loginRequired\|detectLoginWall_\|fetchFacebookPostContent_\|getFacebookAccessToken_\|getAppAccessToken_' src/
```
Expected: no output.

**Step 6: Commit**

```bash
git add -A
git commit -m "refactor: remove Facebook OAuth login flow"
```

---

## Task 7: Full test run and live verification

**Step 1:** Run the local suite.

```bash
node tests/run.js FacebookService.gs Extraction.gs RecurrenceService.gs
```
Expected: all pass, 0 failed.

**Step 2:** Add a live test in `src/FacebookService.gs` (skipped by the runner via the `_live` suffix):

```js
function test_extractFacebookEvent_live() {
  var result = extractEventData('https://www.facebook.com/events/1058029123674308/');
  Logger.log(JSON.stringify(result, null, 2));
  // Check in the Execution log: title, date 2026-08-02, 08:30–10:30,
  // location "Pfluger Pedestrian Brg", description ending with the full
  // getinvolved.activism.wtf URL inside a working <a href>.
}
```

**Step 3:** Deploy and confirm in the real app.

```bash
./deploy.sh
```

Then open the web app, paste `https://www.facebook.com/events/1058029123674308/`, and confirm on the confirmation screen:
- Title, date 2026-08-02, 08:30–10:30, location populated
- Description is the full Facebook text, unedited
- The `getinvolved.activism.wtf` link is complete and clickable in the created calendar event

**Step 4: Commit**

```bash
git add -A
git commit -m "test: add live Facebook extraction check"
```

---

## Task 8: Update the README

**Files:**
- Modify: `README.md`

- Delete the whole **Facebook Login (optional — needed for private/group events)** section and its setup subsections.
- Remove `FACEBOOK_APP_ID` / `FACEBOOK_APP_SECRET` from the Script Properties table.
- Add a short **Facebook events** section:

```markdown
### Facebook events

Public Facebook event URLs work with no login and no app credentials. Facebook
server-renders the event into the page; the "See more on Facebook" dialog is
only a client-side overlay on top of it. The script sends an `Accept: text/html`
header — without it Facebook returns a JavaScript shell with no event data — and
reads the title, exact start/end timestamps, location, cover photo, and full
description out of the embedded JSON.

The description is copied **verbatim**: it is never passed through the language
model for rewriting. Links keep their real destinations rather than Facebook's
`l.facebook.com` redirect wrapper, so they still work from the calendar event.

If Facebook changes its page format, the app falls back to asking you to paste
the event text.
```

**Commit:**

```bash
git add README.md
git commit -m "docs: document login-free Facebook event extraction"
```

---

## Risks

- **Facebook markup changes.** Key-anchored parsing is looser than a schema, but these are Relay field names that change rarely. Mitigated by returning `null` → paste fallback rather than producing garbage.
- **Rate limiting.** Repeated fetches from one Apps Script egress IP could get throttled; failure degrades to the paste fallback.
- **Multi-date Facebook events.** Recurring Facebook events expose sibling occurrences under different keys and are out of scope here — a repeating Facebook event will come through as its first occurrence. Worth a follow-up if it comes up.
