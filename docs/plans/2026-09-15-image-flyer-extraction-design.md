# Image flyers — design

Paste the URL of a flyer image and get an event out of it: details read off the
picture, the event link decoded from a QR code on it, and an open-ended
recurrence ("every 2nd and 4th Saturday every month") created as a repeating
event rather than a single date.

## What a flyer actually gives us

Measured 2026-09-15 against
`https://horizons-cdn.hostinger.com/c3648fa5-28bf-4fa9-adf5-de27dbf4d0e8/sss-QlOin.png`
(The People Sanctuary, "Sober Saturday Strolls"). A 1545×1999 PNG, 490KB,
carrying:

| On the flyer | Value |
|---|---|
| Title | Sober Saturday Strolls |
| Schedule, as prose | `7pm every 2nd and 4th Saturday every month` |
| Location | Meet at The Rock at Town Lake |
| Body text | "Sober or curious, and looking for compassionate, supportive community?" |
| Plain-text URLs | **none** — only `@THEPEOPLESANCTUARY` under a QR code |
| QR codes | three, labelled Instagram / Website / Facebook |

Three consequences shape the design:

1. **The link is only reachable by decoding.** No URL is written out in text
   anywhere on the flyer. Without QR decoding the event gets no source link at
   all, or worse, a link to the PNG itself.
2. **There are several codes, and the right one is not the first.** Scanned in
   reading order the first code is Instagram. The one worth linking is the
   third.
3. **The schedule has no end.** "every month" states a rule and states no last
   date, which collides head-on with the `COUNT`-always invariant the
   multi-date design rests on (see
   `2026-07-27-multi-date-events-design.md`).

## QR decoding

`api.qrserver.com/v1/read-qr-code/` (goqr.me) decodes all three codes in one
call. Measured, same date:

| Request | Result |
|---|---|
| `GET ?fileurl=<the CDN URL>` | `"download error (could not establish connection)"` — their fetcher cannot reach the Hostinger CDN |
| `POST` the bytes as multipart `file` | All three codes, HTTP 200 |

So the bytes are posted, not the URL — which suits us anyway, since the script
has already downloaded the image to send it to Claude.

**The response shape is a trap.** All three codes come back inside a *single*
`symbol[0].data` string, newline-separated, with every code after the first
prefixed `QR-Code:`:

```json
[{"type":"qrcode","symbol":[{"seq":0,"data":
  "https://www.instagram.com/thepeoplesanctuary?igsh=MXB4eWxjanF4andvbQ%3D%3D&utm_source=qr
QR-Code:https://www.facebook.com/profile.php?id=61592091920619
QR-Code:https://peoplesanctuary.org","error":null}]}]
```

Reading `symbol[0].data` verbatim — the obvious thing — yields one unusable
three-line "URL". `parseQrResponse_` splits on newlines and strips the prefix.

### The browser fallback

goqr.me is a free third-party service with no SLA, and the whole feature turns
on getting a real URL off the flyer, so a second decoder backs it up.

It cannot simply point an `<img>` at the flyer URL: reading pixels back from a
canvas that loaded a cross-origin image throws unless the host sends
`Access-Control-Allow-Origin`, and flyer CDNs generally do not. So when the
server-side decode comes back empty, `extractEventData` returns the extracted
fields plus `qr_pending: true` and the image as a base64 `data:` URI, which is
same-origin by definition and leaves the canvas readable. 490KB of PNG is about
650KB encoded — carried by `google.script.run`, and paid only in the fallback
case.

The page decodes with `@zxing/library` from a CDN, whose multi-code reader
finds several symbols in one image. `jsQR` returns only the first, which on this
flyer means Instagram and nothing else.

The decoded URLs go back to `chooseEventLink(urls)` on the server, so the
selection rule below lives in exactly one place.

If both decoders fail the event still extracts. It simply arrives with no
source link, reported through the existing "Could not find:" warning.

## Choosing the link

`chooseEventLink` keeps only `http(s)` results — QR codes also carry vCards,
wifi credentials and plain text — then ranks by host:

1. A ticketing or event platform (Eventbrite, Luma, Meetup) → the matching
   `RSVP on …` label
2. Any other domain → `See Website for details`
3. Social (Facebook, Instagram, X, TikTok, Threads) → `RSVP on Facebook`, or
   `See the post on Instagram`

Ties break on order of appearance. On the test flyer this picks
`peoplesanctuary.org` over both social codes.

Tier 1 sits above a plain website on the reasoning that a flyer carrying an
Eventbrite QR code wants you sent to the RSVP page rather than to somebody's
homepage.

The winner becomes `source_url`, **replacing the pasted image URL**. The UI
currently hard-wires `sourceUrl` to whatever was typed into the box, and a
calendar event whose "See Website for details" link opens a bare PNG is worse
than an event with no link. If a social URL wins by default its tracking
parameters (`igsh`, `utm_source=qr`) are stripped first — the same treatment the
Instagram and Facebook paths already give their links.

## Flow

1. **Detection.** The generic path in `extractEventData` fetches the URL and
   immediately calls `getContentText()`, which returns binary garbage for a PNG.
   It instead inspects `blob.getContentType()` first: `image/*` takes the new
   branch, anything else carries on into the existing HTML path unchanged.

   Sniffing the response rather than the file extension means a CDN URL with no
   `.png` on the end still works, and it costs nothing extra — the bytes are
   already in hand for both Claude and the QR decode. The Facebook and Instagram
   branches stay ahead of this check, untouched.

2. **Decode** the QR codes (above).

3. **Read the flyer.** The image goes to Claude through `claudeImageBlock_`,
   refactored to accept a blob the caller already holds so the flyer is not
   downloaded twice, under the existing `EXTRACTION_PROMPT` plus a preamble:
   this is a flyer, there is no HTML, transcribe its words rather than composing
   a description. The verbatim rule that governs Facebook and Instagram still
   applies — the source is just pixels this time.

4. **Pick the link** and set `source_url` / `source_link_label`.

5. `image_url` is the flyer itself, so Drive and Tockify need no changes.

## Recurrence stated as a rule

`EXTRACTION_PROMPT` gains two fields:

- `recurrence_rule` — an RRULE line with **no `COUNT` and no `UNTIL`**, e.g.
  `FREQ=MONTHLY;BYDAY=2SA,4SA`. Null unless the source states an open-ended
  pattern in prose.
- `recurrence_note` — the source's own words, `7pm every 2nd and 4th Saturday
  every month`, for the confirmation banner.

The existing "do not extrapolate a recurrence beyond the dates actually shown"
rule stays exactly as written, and gains one carve-out: state the rule, do not
enumerate dates from it.

**Why open-ended at all.** The `COUNT`-always invariant exists so that no date
is ever created that the source did not state. Here an endless rule *is* what
the source states; choosing a horizon and expanding twelve dates would be the
invention, and the series would then die silently a year later with nothing to
prompt a renewal.

**The first date is computed, not extracted.** `nextOccurrences_(rule, fromYmd,
n)` walks forward from today and returns the next matching dates — Sat 2026-09-26
for the test flyer, the 2nd Saturday (Sep 12) having passed. Claude supplies the
time; arithmetic supplies the date.

### Changes to RecurrenceService.gs

**`expandRule_` must handle a `BYDAY` list.** Its `BYDAY=(\d*)([A-Z]{2})` regex
captures one weekday, so `2SA,4SA` expands as `2SA` alone — a rule that looks
right and silently drops half the occurrences. It becomes a comma-list parse
emitting every match within a month, sorted.

`fitRule_` and the `COUNT`-always path above it are untouched. A multi-`BYDAY`
rule only ever arrives from a stated rule, never from fitting a list of dates.

**`planRecurrence_(occurrences, tz, rule)`** takes the rule as a third argument.
With one present it returns `method: 'rrule'`, `openEnded: true`,
`recurrence: ['RRULE:' + rule]`, and `dates` holding **only the first
occurrence** — so the duplicate check, the Drive filename and the Tockify start
millis all keep working on a real date and no invented date leaks downstream. A
separate `previewDates` feeds the banner.

`createCalendarEvent` re-plans server-side from `occurrences` alone today, so
the rule has to travel with `eventData` and be passed through to
`planRecurrence_` there as well as in `submitEvent`.

### The Ends control

The confirmation screen shows the rule with `Ends: Never ▾`, defaulted to Never:

- **After N occurrences** → `COUNT=N`
- **On date** → expand the rule and emit `COUNT=` however many fall on or before
  that date

So capping a series never introduces an `UNTIL`, and the invariant survives even
when the user chooses an end.

### Editing the start date

The date row stays an editable input; what is new is that a rule constrains it.

**Validation is weekday-and-ordinal only, not full membership.** The rule
carries no anchor, so `DTSTART` *is* the anchor — whichever date is picked
defines the phase for any `INTERVAL`. `dateFitsRule_(ymd, rule)` therefore checks
only the `BYDAY` / `BYMONTHDAY` constraint: for `FREQ=MONTHLY;BYDAY=2SA,4SA`, is
this a Saturday whose ordinal within its month is 2 or 4. Sep 26 passes, Oct 3
(1st Saturday) fails, Oct 10 (2nd) passes. Validating interval alignment as well
would mean inventing an anchor that does not exist.

The banner already re-plans on every edit through the debounced
`planRecurrence(occ)` call; that gains the rule as a second argument, so
validation lives server-side beside the rule logic instead of being duplicated
in the browser. A date that does not fit turns the banner into an error phrased
in the flyer's own vocabulary — "Oct 3 is the 1st Saturday; this repeats on the
2nd and 4th Saturday" — and blocks submit the way a missing title does. The
series is then created with that date as `DTSTART`, so every later occurrence
follows from it.

**One date row while a rule is active.** A rule and a hand-built date list are
two contradictory sources of truth, so **Add date** is hidden and a small *Use a
date list instead* control sits beside the Ends dropdown. Clearing the rule
restores the existing multi-date UI untouched — which is also the escape hatch
when a pattern is read off a flyer that does not really have one.

## Failure modes

All degrade rather than block:

| What fails | What happens |
|---|---|
| goqr.me errors or finds nothing | Browser fallback runs |
| Both decoders fail, or no `http` code on the flyer | Event extracts with no source link; joins the existing "Could not find:" warning |
| Image is HEIC/SVG/BMP | `CLAUDE_IMAGE_TYPES` rejects it → error naming the format, `allowPaste: true` |
| Image over ~3.75MB | Existing `CLAUDE_MAX_IMAGE_BYTES` guard → same paste fallback |
| Claude reads no pattern | `recurrence_rule` is null and the flyer becomes an ordinary single event — today's path exactly |

## Testing

### Why not `clasp run`

`clasp run` needs an **API Executable** deployment. `src/appsscript.json`
declares only a `webapp` block, and publishing an `executionApi` one means
attaching the script to a standard GCP project and re-running OAuth — against a
script owned by `mike.miller@atxveg.org` whose bookmarked `/exec` URL is pinned
to a single deployment ID. Not worth the risk to run a test.

### A GAS shim in Node instead

`tests/run.js` only loads pure `.gs` files because the sandbox provides no
Google services. The gap that actually matters is `UrlFetchApp`, and the reason
it looks hard is that `UrlFetchApp.fetch` is **synchronous** while Node's `fetch`
is not.

`curl` under `execFileSync` closes that gap. Proven 2026-09-15: a ~50-line shim
posted the flyer to goqr.me as multipart and got all three codes back, and
fetched the PNG as 490730 real bytes with `image/png` intact — synchronous,
binary-safe, redirect-following.

So `tests/gas-shim.js` provides `UrlFetchApp` (curl-backed), `PropertiesService`
(env vars, so `CLAUDE_API_KEY` comes from the shell), `Utilities`
(`base64Encode`, `formatDate`, `newBlob`) and `Session`. A second runner,
`tests/run-live.js`, loads the impure files against it and runs the `_live`
tests locally.

That covers everything this feature adds — fetch, content-type detection, QR
decode, the Claude call — with no editor runs at all. Only `Calendar` and
`Drive` remain editor-only, and this feature touches neither.

Realm hazard, as `tests/run.js` already warns: build fixtures inside the vm
context, never in the host realm, or `instanceof Array` fails inside the sandbox
and a function quietly takes its malformed-input path.

### Unit tests

The design keeps the testable logic pure and the I/O thin — `parseQrResponse_`
separate from the fetch, `chooseEventLink` as pure ranking — so these run under
the existing `tests/run.js`:

- the three-tier link ranking, and tracker stripping
- the `QR-Code:`-prefixed multi-symbol response, using the captured string above
- multi-`BYDAY` expansion in `expandRule_`
- `nextOccurrences_` from a given "today"
- `dateFitsRule_` accepting Sep 26 / Oct 10 and rejecting Oct 3
- `planRecurrence_` with a rule: one date in `dates`, `openEnded` set, no
  `COUNT` in the emitted rule

## Files

| File | Change |
|---|---|
| `src/QrService.gs` | New. `decodeQrCodes_`, `parseQrResponse_`, `chooseEventLink` |
| `src/Extraction.gs` | Image branch, prompt fields, `claudeImageBlock_` takes a blob |
| `src/RecurrenceService.gs` | `BYDAY` list, `nextOccurrences_`, `dateFitsRule_`, rule arg to `planRecurrence_` |
| `src/CalendarService.gs` | Pass the rule through to `planRecurrence_` |
| `src/Code.gs` | `submitEvent` carries the rule; expose `chooseEventLink` |
| `src/Index.html` | Ends control, rule banner, single date row, zxing fallback |
| `tests/gas-shim.js` | New. Curl-backed Google services |
| `tests/run-live.js` | New. Runs `_live` tests locally |
| `README.md` | "Image flyers" section |
