# Tockify Austin Vegan Association Tag — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Apply the Tockify tag `Austin-Vegan-Association` to events the Austin Vegan Association hosts on Meetup, in the same background job that already sets the event image.

**Architecture:** A pure classifier reads the submitted source URL and returns `'yes' | 'no' | 'unknown'`. Canonical Meetup URLs decide offline; only `meetu.ps` short links cost a network hop, resolved inside the retryable background job rather than at submit time. Image and tag are applied in a single eventgroup GET/PUT so they cannot land half-applied.

**Tech Stack:** Google Apps Script (V8, ES5-flavoured house style), `UrlFetchApp`, Tockify's private JSON API. Tests are `test_*` functions run under Node via `tests/run.js`; anything touching Google or the network is a `*_live` function run by hand from the Apps Script editor.

**Design doc:** `docs/plans/2026-08-12-tockify-ava-tag-design.md`

**Branch:** `tockify-ava-tag` (already created — do **not** create a worktree)

---

## Context you need before starting

**House style.** This codebase is ES5-flavoured Apps Script: `var` not `let`, no arrow functions, no template literals, no destructuring. Private helpers end with a trailing underscore (`tockifyAvaHost_`). Every non-trivial function carries a JSDoc block, and comments explain *why* a trap exists rather than restating the code. Match this — read `src/TockifyUtil.gs` before writing a line.

**Where code goes.** `tests/run.js` loads a `.gs` file into a bare Node `vm` context with only `console`, `Logger` and `Session` shimmed. A file that references `UrlFetchApp`, `PropertiesService` or `CacheService` at call time is fine, but a file whose *tests* reach them is not. So:

- `TockifyUtil.gs` — pure only. Runs under Node. New classifier, tag-merge and redirect-header helpers go here — including `tockifyRedirectTarget_` (Task 4), which parses a `Location` header away from the network for the same reason `tockifySessionCookie_` does.
- `TockifyService.gs` — network. Its tests are all `*_live`.

Split network functions on that seam: the `UrlFetchApp` call and its `try`/`catch` stay in `TockifyService.gs`, and everything that merely reads the response moves next door where a Node test can reach it. A shape that only appears against a live third-party server is exactly the shape a hand-run `*_live` test will not catch.

**Test conventions.** `TockifyUtil.gs` has exactly one Node-run test function, `test_tockifyUtil`, which asserts by `throw new Error(...)`. Add cases to it; do not create a second function. There is no assertion library — the pattern is `if (got !== want) throw new Error('helper(input) -> ' + got + ', want ' + want);`.

**Running tests.**

```bash
node tests/run.js TockifyUtil.gs
```

Expected on a clean tree: `1 passed, 0 failed`.

**Live tests.** `clasp run` does not work on this project (it is a web app, not an API executable). Live functions must be pushed with `clasp push` and then run by **the user** from the Apps Script editor — you cannot run them yourself. Tasks 3 and 9 are explicitly user-run and you must stop and ask.

**Do not run `clasp deploy`.** It mints a new deployment ID and breaks the bookmarked URL. `clasp push` is safe and is what these tasks use.

---

## Task 1: The host classifier — **DONE**

**Files:**
- Modify: `src/TockifyUtil.gs` (constants near line 77; new function; cases in `test_tockifyUtil`)

**Step 1: Write the failing test**

Add to the top of `test_tockifyUtil`, before the existing `tockifyImageName_` block:

```js
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
```

**Step 2: Run test to verify it fails**

Run: `node tests/run.js TockifyUtil.gs`
Expected: `FAIL test_tockifyUtil` with `tockifyAvaHost_ is not defined`

**Step 3: Write minimal implementation**

Add the constants alongside the existing ones (after `TOCKIFY_QUEUE_KEY`, `src/TockifyUtil.gs:81`):

```js
var AVA_MEETUP_SLUG = 'vegaustin';
var AVA_TOCKIFY_TAG = 'Austin-Vegan-Association';
```

Then the function:

```js
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
```

**Step 4: Run test to verify it passes**

Run: `node tests/run.js TockifyUtil.gs`
Expected: `1 passed, 0 failed`

**Step 5: Commit**

```bash
git add src/TockifyUtil.gs
git commit -m "feat: classify whether an event URL is hosted by Austin Vegan Association"
```

---

## Task 2: Tag merge helpers — **DONE** (reworked after Task 3's probe)

**Files:**
- Modify: `src/TockifyUtil.gs`

**Step 1: Write the failing test**

The shape below is the one Task 3's probe confirmed live on 2026-08-12 against
the authenticated eventgroup record: a **flat top-level array of strings**,
`group.tags = ["Austin-Vegan-Association"]`. Do **not** write the public
`ngevent` API's nested `content.tagset.tags.default` — see the design doc's
["The tag's shape"](2026-08-12-tockify-ava-tag-design.md#the-tags-shape). Build
every fixture inside the `.gs` file: `instanceof Array` is realm-sensitive under
the `vm` runner, so a host-realm array silently takes the malformed path.

Add to `test_tockifyUtil`, after the `tockifyAvaHost_` block:

```js
  // tockifyAddTag_ — merges, never replaces. Re-running a job must be a no-op.
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
  // tag, and a substring test there refuses to append forever, so the job's
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
```

Three mutants that pass a suite without those last two negatives and the sibling
append case, each a silent failure in production: `tags.join(',').indexOf(tag)`
and a per-element `String(tags[i]).indexOf(tag)` in `tockifyHasTag_` both report
"the tag stuck" for an event carrying only `Austin-Vegan-Association-Board`, and
`list.join(',').indexOf(tag) === -1` in `tockifyAddTag_` silently refuses to
append on any event with a sibling tag, producing a permanently failing job.

**Step 2: Run test to verify it fails**

Run: `node tests/run.js TockifyUtil.gs`
Expected: `FAIL test_tockifyUtil` with `tockifyAddTag_ is not defined`

**Step 3: Write minimal implementation**

```js
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
 * tockifySetEventImage_), so a nested tagset would look like it saved and
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
```

**Step 4: Run test to verify it passes**

Run: `node tests/run.js TockifyUtil.gs`
Expected: `1 passed, 0 failed`

**Step 5: Commit**

```bash
git add src/TockifyUtil.gs
git commit -m "feat: add tag merge helpers for Tockify events"
```

---

## Task 3: Probe the live eventgroup shape — STOP, USER-RUN — **DONE 2026-08-12**

**This task blocked Task 5 and could not be completed without the user.** It has been run; the answer is recorded in Step 4 below and is already applied to Tasks 2 and 5.

The public `ngevent` API nests the tag under `content.tagset.tags.default`. The authenticated **eventgroup** record appears to be flattened — `tockifySetEventImage_` (`src/TockifyService.gs:233`) writes `group.imageIdNg` and reads `saved.imageSets` at the top level, where the public shape has both under `content`. Top-level `tagset` is the strong expectation, but this API returns `404 Not found` for a wrong body shape and a silent `200` for a wrong field. Guessing fails quietly.

**Files:**
- Modify: `src/TockifyService.gs` (add near the other `*_live` tests at the top)

**Step 1: Write the probe**

```js
/**
 * Reports where `tagset` actually lives on an authenticated event group.
 *
 * uid 111 is "Lunch at The Vegan Yacht", confirmed via the public API on
 * 2026-08-12 to carry the Austin-Vegan-Association tag. Read-only.
 */
function test_tockifyEventGroupShape_live() {
  var login = tockifySession_();
  if (login.error) throw new Error(login.error);

  var res = tockifyFetch_('/api/eventgroup/' + TOCKIFY_CALID + '/111', login.cookie);
  Logger.log('HTTP ' + res.getResponseCode());
  if (res.getResponseCode() !== 200) throw new Error(res.getContentText().substring(0, 300));

  var group = JSON.parse(res.getContentText());
  Logger.log('top-level keys: ' + Object.keys(group).join(', '));
  Logger.log('group.tagset = ' + JSON.stringify(group.tagset));
  Logger.log('group.content && group.content.tagset = ' +
    JSON.stringify(group.content && group.content.tagset));
}
```

**Step 2: Push it**

```bash
./deploy.sh --push-only 2>/dev/null || clasp push
```

If `deploy.sh` has no such flag, just run `clasp push`. Do **not** run `clasp deploy`.

**Step 3: Ask the user to run it**

Stop here and ask the user to:

1. Run `clasp open-script`
2. Select `test_tockifyEventGroupShape_live` from the function dropdown
3. Click **Run**
4. Paste back the log lines from **View → Executions**

**Step 4: The answer — run 2026-08-12**

Neither candidate above was right. There is no `tagset` key on the eventgroup record at all, and no `content` wrapper. Tags are a **flat top-level array of bare strings**:

```
HTTP 200
body is object{19}
top-level: calid:string, uid:string, title:string, description:string, attachments:array[0],
           tags:array[1], where:object{1}, recurrence:object{1}, exdates:array[0],
           rdates:array[0], mods:array[0], version:number, imageIdNg:string,
           imageSets:array[1], externalId:string, priority:number, status:object{1},
           externalVLoc:boolean, performers:array[0]
group.tagset = undefined
group.content && group.content.tagset = undefined
paths holding "Austin-Vegan-Association": tags[0]
```

So the write field is `group.tags`, an `Array` of strings — the walk used an exact `===` string comparison and landed on `tags[0]`, so these are not objects. The public API's `content.tagset.tags.default` is a *read-only* projection and must not be written back.

This is what the `imageIdNg` analogy got only half right: it correctly predicted "flattened", and still got the field name and the nesting wrong. Tasks 2 and 5 are written against the probe, not the analogy.

`tockifyAddTag_`/`tockifyHasTag_` were first built against the nested shape and had to be reworked — the plan above now carries the corrected versions.

**Step 5: Commit**

```bash
git add src/TockifyService.gs docs/plans/2026-08-12-tockify-ava-tag-design.md
git commit -m "test: probe where tagset lives on a Tockify event group"
```

---

## Task 4: Resolve shortened Meetup links — **DONE** (live test not yet run — Task 9)

**Files:**
- Modify: `src/TockifyUtil.gs` (new `tockifyRedirectTarget_`; cases in `test_tockifyUtil`)
- Modify: `src/TockifyService.gs`

The fetch itself gets a `*_live` test like `test_tockifyUploadImage_live`. Reading the response does **not** — it is pure, so it goes in `TockifyUtil.gs` and is unit-tested there. Do not inline the header parsing into the resolver: every interesting case (relative `Location`, repeated header, a 200 carrying a stale `Location`) is one that only a live third-party server produces, which is precisely the set a hand-run live test never exercises.

**Step 1: Write the pure header parser in `src/TockifyUtil.gs`**

Place it after `tockifyAvaHost_`.

```js
/**
 * The absolute URL a redirect response points at.
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
```

Add cases to `test_tockifyUtil` covering: absolute, lowercase header key, array-valued header, protocol-relative, path-relative against `meetup.com/ls/click` (the case that actually recovers a canonical URL) and against the shortener, 307/308, plus the error table — 200-with-Location, 404, 302-without-Location, empty string, empty array, null headers, a non-absolute leftover, and a `javascript:` scheme.

Two traps in those fixtures:

- Build every one inside the `.gs` file. `instanceof Array` is realm-sensitive under the `vm` runner (see `tests/run.js`).
- Give the array-valued case **two** entries. A single-element array stringifies to exactly its element, so `{Location: ['https://…/events/2/']}` passes with `loc = loc[0]` deleted and pins nothing. Two entries yield `'https://…/events/2/,https://evil.test/'` without the coercion, and also pin *which* entry is taken.

**Step 2: Write the fetch in `src/TockifyService.gs`**

```js
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
```

The `try`/`catch` is not optional and is not defensive padding. `muteHttpExceptions` suppresses HTTP error *statuses* only; DNS, TLS and timeout failures still throw. Task 6 puts image and tag in a single GET/PUT that runs *after* classification, so a throw here means the PUT never happens and **the image is never applied** — catching it further up in `processTockifyQueue_` would send an email but still leave the event unstamped. Worse, an escaped throw skips `job.tries++` and `tockifyShouldGiveUp_` entirely, so one unresolvable host re-runs every five minutes forever, re-uploading images for every job ahead of it, with no email and no give-up. Recovering needs the script property cleared by hand. `meetupFetchGroupEvents_` (`src/MeetupService.gs:22-34`) is the same shape.

**Step 3: Write the classifier entry point in `src/TockifyService.gs`**

```js
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
```

**Step 4: Write the live test**

Add near the other `*_live` tests at the top of `src/TockifyService.gs`:

```js
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
```

The two `.error` checks are load-bearing, not belt-and-braces. `{error: ...}` has `isAva === undefined`, which is falsy, so `if (other.isAva)` passes on an error result — the offline-only claim is asserted by the `.error` line and by nothing else. Measured: regress `tockifyAvaHost_` so the Facebook URL returns `'unknown'` and the version without these two lines fetches `facebook.com` over the network and still logs `PASSED`.

**Step 5: Verify the Node suite**

`tockifyRedirectTarget_` and its cases are Node-runnable, so this genuinely covers the new parsing; the fetch and `tockifyIsAvaEvent_` remain live-only.

Run: `node tests/run.js TockifyUtil.gs`
Expected: `1 passed, 0 failed`

Then confirm nothing else regressed:

Run: `node tests/run.js MeetupService.gs TockifyUtil.gs`
Expected: `13 passed, 0 failed`

**Step 6: Commit**

```bash
git add src/TockifyUtil.gs src/TockifyService.gs
git commit -m "feat: resolve shortened Meetup links to identify the host group"
```

The live test runs in Task 9 alongside the end-to-end check — batching them saves the user a second trip to the editor.

---

## Task 5: One GET/PUT for image and tag — not started

**Task 3's answer is applied below.** The probe (2026-08-12) found tags in a flat top-level array of strings, `group.tags`. There is no `tagset` key on this record — do not reintroduce `group.tagset` or `group.content.tagset` from the public API's shape.

**Files:**
- Modify: `src/TockifyService.gs:258-280` — replace `tockifySetEventImage_` (was `233-255`; Task 4 added the live test and two functions above it)

**Step 1: Replace the function**

```js
/**
 * Applies the image and/or the AVA tag to a Tockify event group in one write.
 *
 * One GET/PUT rather than two: both fields live in the same record, so separate
 * cycles would double the round trips and let the pair land half-applied.
 *
 * `imageIdNg` is the write field for the image — writing `imageSets` directly
 * returns 200 and is silently ignored. The server hydrates `imageSets` from
 * `imageIdNg`, which is also why the read-back below checks `imageSets` and not
 * the field that was written.
 *
 * `tags` is the write field for the tag: a flat top-level array of strings,
 * confirmed by live probe on 2026-08-12 against this same record. The public
 * ngevent API's content.tagset.tags.default is a read-only projection and would
 * be accepted with a silent 200 while changing nothing.
 *
 * @param {string} cookie
 * @param {string} uid
 * @param {{imageSetId: string=, addTag: string=}} changes
 * @returns {{success: true}|{error: string}}
 */
function tockifyUpdateEventGroup_(cookie, uid, changes) {
  var path = '/api/eventgroup/' + TOCKIFY_CALID + '/' + uid;

  var getRes = tockifyFetch_(path, cookie);
  if (getRes.getResponseCode() !== 200) {
    return { error: 'eventgroup GET returned HTTP ' + getRes.getResponseCode() };
  }

  var group = JSON.parse(getRes.getContentText());
  if (changes.imageSetId) group.imageIdNg = changes.imageSetId;
  if (changes.addTag) group.tags = tockifyAddTag_(group.tags, changes.addTag);

  var putRes = tockifyFetch_(path, cookie, { method: 'put', payload: group });
  if (putRes.getResponseCode() !== 200) {
    return { error: 'eventgroup PUT returned HTTP ' + putRes.getResponseCode() };
  }

  // A 200 alone does not mean the write was accepted — check each one stuck.
  var saved = JSON.parse(putRes.getContentText());
  if (changes.imageSetId && (!saved.imageSets || !saved.imageSets.length)) {
    return { error: 'image did not stick — imageSets came back empty' };
  }
  if (changes.addTag && !tockifyHasTag_(saved.tags, changes.addTag)) {
    return { error: 'tag did not stick — "' + changes.addTag + '" absent from the saved tags' };
  }
  return { success: true };
}
```

**Step 2: Confirm nothing still calls the old name**

Run: `grep -rn "tockifySetEventImage_" src/`
Expected: one hit, `src/TockifyJob.gs:60` — fixed in Task 6. No other hits.

**Step 3: Commit**

```bash
git add src/TockifyService.gs
git commit -m "feat: apply image and tag to a Tockify event group in one write"
```

---

## Task 6: Rewire the job

**Files:**
- Modify: `src/TockifyJob.gs:7-61`

**Step 1: Replace `tockifyApplyImage_`**

```js
/**
 * Runs one job end to end: image, tag, or both.
 *
 * A failure to identify the host group is a `warning`, not an `error` — the
 * image is still worth applying, and holding it hostage to a shortener being
 * down helps nobody. The caller emails the warning and dequeues.
 *
 * @param {string} cookie
 * @param {Object} job
 * @returns {{success: true, warning: string=}|{notFound: true}|{error: string}}
 */
function tockifyApplyJob_(cookie, job) {
  var found = tockifyFindEvent_(cookie, job.title, job.startMillis);
  if (found.notFound) return { notFound: true };
  if (found.error) return { error: found.error };

  var changes = {};

  if (job.imageUrl) {
    var up = tockifyUploadImage_(job.imageUrl);
    if (up.error) return { error: up.error };

    var reg = tockifyRegisterImage_(cookie, up.uuid, tockifyImageName_(job.imageUrl));
    if (reg.error) return { error: reg.error };

    changes.imageSetId = reg.imageSetId;
  }

  // Resolved here, not at submit time: this is the retryable context, and the
  // event has already been found, so the lookup happens once rather than on
  // every 5-minute poll while Tockify catches up.
  var warning = null;
  var ava = tockifyIsAvaEvent_(job.sourceUrl);
  if (ava.error) warning = 'Could not determine the host group: ' + ava.error;
  else if (ava.isAva) changes.addTag = AVA_TOCKIFY_TAG;

  if (!changes.imageSetId && !changes.addTag) return { success: true, warning: warning };

  var upd = tockifyUpdateEventGroup_(cookie, found.uid, changes);
  if (upd.error) return { error: upd.error };

  return { success: true, warning: warning };
}
```

**Step 2: Handle the warning in the queue drain**

In `processTockifyQueue_`, replace `var result = tockifyApplyImage_(login.cookie, job);` with `tockifyApplyJob_`, and replace:

```js
    if (result.success) continue; // done — drop from the queue
```

with:

```js
    if (result.success) {
      // Dequeue either way — the work that could be done was done. The email
      // exists so a skipped tag is never silent.
      if (result.warning) {
        tockifyNotify_(
          'Tockify tag skipped: ' + job.title,
          result.warning +
          '\n\nEvent link: ' + (job.sourceUrl || '(none)') +
          '\n\nIf this event is hosted by Austin Vegan Association, add the ' +
          AVA_TOCKIFY_TAG + ' tag by hand.'
        );
      }
      continue;
    }
```

**Step 3: Update the give-up email**

The failure notice at `src/TockifyJob.gs:32-37` hardcodes `'Tockify image not set: '` and always prints `Image: `. A tag-only job has no image, so make it honest:

```js
    tockifyNotify_(
      'Tockify update failed: ' + job.title,
      (result.error || 'event never appeared in Tockify') +
      (job.imageUrl ? '\n\nImage: ' + job.imageUrl : '') +
      '\nEvent link: ' + (job.sourceUrl || '(none)') +
      '\nTries: ' + job.tries
    );
```

**Step 4: Verify no stale references**

Run: `grep -rn "tockifyApplyImage_\|tockifySetEventImage_" src/`
Expected: no output.

Run: `node tests/run.js TockifyUtil.gs`
Expected: `1 passed, 0 failed`

**Step 5: Commit**

```bash
git add src/TockifyJob.gs
git commit -m "feat: apply the AVA tag alongside the image in the Tockify job"
```

---

## Task 7: Carry the source URL and widen the enqueue gate

**Files:**
- Modify: `src/TockifyQueue.gs:20-37`
- Modify: `src/Code.gs:114-122`

**Step 1: Add `sourceUrl` to the job record**

In `src/TockifyQueue.gs`:

```js
/**
 * Adds a job. One job per event, including multi-date events — a repeating
 * event syncs to Tockify as a single record, so there is one image to set.
 *
 * `sourceUrl` is the link the submitter pasted; the job reads it to decide
 * whether the AVA tag applies. Jobs queued before that field existed have it
 * undefined, which classifies as 'no' and drains them as image-only.
 *
 * @param {string} title
 * @param {number} startMillis
 * @param {string} imageUrl - may be empty for a tag-only job
 * @param {string} sourceUrl
 */
function tockifyQueueAdd_(title, startMillis, imageUrl, sourceUrl) {
  var jobs = tockifyQueueLoad_();
  jobs.push({
    title: title,
    startMillis: startMillis,
    imageUrl: imageUrl || '',
    sourceUrl: sourceUrl || '',
    tries: 0,
    firstSeen: Date.now()
  });
  tockifyQueueSave_(jobs);
}
```

**Step 2: Widen the gate in `submitEvent`**

Replace `src/Code.gs:114-122` with:

```js
  // 6. Queue the Tockify update. Tockify syncs from Google within seconds, but
  //    not instantly, so a trigger applies this shortly after.
  //
  //    Queued when there is an image OR the event might be AVA-hosted — an AVA
  //    event submitted without a flyer still needs its tag. 'unknown' (a
  //    meetu.ps link) queues too: resolving it here would put a redirect fetch
  //    in the submit path, so the job does it instead and simply finds nothing
  //    to do when the link turns out to belong to another group.
  var avaHost = tockifyAvaHost_(eventData.source_url);
  if (plan.dates.length && (eventData.image_url || avaHost !== 'no')) {
    tockifyQueueAdd_(
      eventData.title,
      tockifyStartMillis_(plan.dates[0]),
      eventData.image_url,
      eventData.source_url
    );
  }
```

**Step 3: Verify**

Run: `node tests/run.js TockifyUtil.gs`
Expected: `1 passed, 0 failed`

Run: `grep -n "tockifyQueueAdd_" src/`
Expected: the definition in `TockifyQueue.gs` and exactly one call in `Code.gs`, now passing four arguments.

**Step 4: Commit**

```bash
git add src/TockifyQueue.gs src/Code.gs
git commit -m "feat: queue a Tockify job for AVA events without an image"
```

---

## Task 8: Documentation

**Files:**
- Modify: `README.md:96-127` (the `## Tockify` section)
- Modify: `README.md:264+` (the live test function table)

**Step 1: Extend the Tockify section**

After the paragraph ending "...no matter how many dates it has." (`README.md:109`), add:

```markdown
Events the Austin Vegan Association hosts on Meetup also get the Tockify tag
`Austin-Vegan-Association`. The host is read from the link the submitter pasted:
a canonical `meetup.com/vegaustin/events/…` URL decides it with no network call,
while a `meetu.ps` short link is resolved by following one redirect. The slug is
matched on the URL's **path**, because a real calendar entry reads
`meetup.com/vegaustin/events/313891224/?slug=vegaustin&eventId=307154188` — a
plain substring test also fires on other groups' events that carry that query
string.

Because a tag-only job needs no flyer, submitting an AVA event without an image
still queues Tockify work. If the host cannot be determined — the shortener is
down, say — the image is applied anyway and you get an email naming the event so
the tag can be added by hand.
```

Then extend the third bullet at `README.md:119-121` to cover the tag:

```markdown
- `imageIdNg` is the field that sets the image. Writing `imageSets` directly
  returns HTTP 200 and is silently ignored, so the code re-reads the response
  and treats an empty `imageSets` as a failure. The tag write is verified the
  same way, and both go over in a single PUT so they cannot land half-applied.
```

**Step 2: Add the live tests to the table**

Add rows to the test function table (`README.md:266`), matching the existing format:

```markdown
| `test_tockifyIsAvaEvent_live` | TockifyService.gs | Short-link resolution and host classification |
| `test_tockifyEventGroupShape_live` | TockifyService.gs | Read-only shape probe; run 2026-08-12, found tags in a flat top-level `tags` array |
```

**Step 3: Verify the counts quoted in the test section**

`README.md:241-243` quotes per-file test counts. `TockifyUtil.gs` is not listed there today; confirm whether it should be and add `node tests/run.js TockifyUtil.gs` if the omission looks accidental.

**Step 4: Commit**

```bash
git add README.md
git commit -m "docs: document the Austin Vegan Association tag"
```

---

## Task 9: End-to-end live verification — STOP, USER-RUN

**Files:**
- Modify: `src/TockifyJob.gs` (temporary scratch test, removed in Step 5)

**Step 1: Push everything**

```bash
clasp push
```

**Step 2: Write a scratch end-to-end test**

```js
/**
 * End-to-end: queues a job for an event that already exists in Tockify and
 * drains the queue once. Edit TITLE/START/SOURCE to a real upcoming event
 * before running. Verify in the Tockify UI afterwards, then delete this.
 */
function test_tockifyAvaTag_live() {
  var TITLE = '<<< paste the exact event title >>>';
  var START = tockifyStartMillis_({ date: '2026-08-20', start_time: '18:30' });
  var SOURCE = 'https://meetu.ps/e/Qbwn8/1qvFq/i';

  tockifyQueueAdd_(TITLE, START, '', SOURCE);
  processTockifyQueue_();
  Logger.log('queue after run: ' + JSON.stringify(tockifyQueueLoad_()));
}
```

**Also log `version` from both round trips.** Add a temporary `Logger.log` of
`group.version` after the GET and `saved.version` after the PUT in
`tockifyUpdateEventGroup_`. If it increments, that is a free universal "the
server really did mutate this record" signal — one that would independently
catch an ignored-field false positive for *any* field, not just the two we check
by name. If it does not move, we learn the field is decorative. This run has to
happen anyway; the extra line costs nothing and answers the optimistic-locking
question left open in Task 5.

**Step 3: Ask the user to run, in this order**

> **PRECONDITION — the test event must NOT already carry the AVA tag.**
> This is the whole point of the run. Offline work established where the tag
> *lives* on the record; only a live PUT can establish that the field is
> *writable*. On an already-tagged event `tockifyAddTag_` returns the list
> unchanged, the PUT is a no-op for tags, and `tockifyHasTag_` passes on a tag
> that predates us — the test goes green having verified nothing.
>
> So before running, open the event in the Tockify UI and confirm it carries no
> `Austin-Vegan-Association` tag. **Do not use uid 111** ("Lunch at The Vegan
> Yacht") — the Task 3 probe found it already tagged, making it the one event
> guaranteed to produce a vacuous pass. Pick an untagged upcoming AVA event, or
> remove the tag by hand first.

Stop and ask the user to run from the editor and report results:

1. `test_tockifyIsAvaEvent_live` — expect `PASSED` in the log
2. `test_tockifyAvaTag_live` — after editing the three constants to a real event, and after confirming the precondition above
3. Check the event on `https://tockify.com/austin.vegan.events` — the tag should now be present where it was absent before the run, and any tag it already had should still be there
4. Report the two `version` values. Expected: the PUT value is higher than the GET value

**Step 4: Confirm the regression case**

Ask the user to also submit one non-AVA event with an image through the web app and confirm the image still lands and no tag is added. This is the path most likely to break, since it shares the rewritten `tockifyUpdateEventGroup_`.

**Step 5: Remove the scratch test and commit**

```bash
git add src/TockifyJob.gs
git commit -m "test: verify the AVA tag end to end"
```

---

## Task 10: Finish the branch

**Step 1: Full test run**

```bash
node tests/run.js TockifyUtil.gs
node tests/run.js FacebookService.gs Extraction.gs RecurrenceService.gs Utilities.gs
node tests/run.js MeetupService.gs
node tests/calendar.test.js
```

Expected: every suite passes, at the counts quoted in `README.md:241-243`.

**Step 2: Review the diff**

```bash
git diff main...HEAD
```

**REQUIRED SUB-SKILL:** Use superpowers:requesting-code-review before merging.

**Step 3: Deploy**

Only after the user confirms the live checks in Task 9 passed:

```bash
./deploy.sh
```

**REQUIRED SUB-SKILL:** Use superpowers:finishing-a-development-branch to decide how `tockify-ava-tag` gets integrated.
