# Instagram posts — design

Paste a public Instagram post URL and get an event out of it, reading the flyer
image when the caption alone does not say enough.

## What Instagram actually serves

Measured 2026-08-21 against
`https://www.instagram.com/p/DcHA9syRjX4/` (Summer Pop-Up Market).

| Request | Result |
|---|---|
| Post URL, browser User-Agent | 614KB JavaScript shell. No `og:` tags, no caption, no image. |
| Post URL, crawler User-Agent | `og:` tags present. `og:image` is a **640×640 square crop**. |
| `og:image` with `stp=` rewritten to the uncropped variant | **HTTP 403** |
| `/p/<code>/embed/captioned/`, Apps Script User-Agent | 233KB of server-rendered HTML: full caption, full **1440×1866** image. |

Three consequences shape the design:

1. **The embed endpoint is the only usable door.** It needs no login, no
   crawler disguise and no app credentials, and unlike the post URL it answers
   an Apps Script fetch with real content.
2. **The crop cannot be undone by editing the URL.** The `stp=` crop
   specification is covered by the signed `oh=` token, so any rewrite is
   rejected. The uncropped URL has to be *found*, and the embed page is where
   it is written down. On the test post the square crop cut off both the title
   and the bottom third of the flyer.
3. **There is no popup to get past.** The "Never miss a post from …" dialog is
   a client-side overlay drawn over content the server already sent. Nothing
   server-side ever sees it — same shape as the Facebook "See more on Facebook"
   dialog, and the same reason it does not matter. A browser is not in the loop.

The embed page carries no post timestamp, so relative wording ("this Saturday")
is resolved against today's date, as every other source already is.

## Flow

1. `instagramShortcode_` recognises the URL and pulls the shortcode. `/p/`,
   `/reel/` and `/tv/` all resolve the same shortcode namespace — verified —
   so every form is normalised to `/p/<code>/embed/captioned/`. `/reels/` is
   the one spelling Instagram itself 404s on that path, so it is rewritten.
2. Fetch and parse the embed page into caption HTML, caption text and the
   uncropped image URL.
3. **Text pass** — Claude reads the caption. The prompt tells it to report only
   what the caption states outright and return null for anything else, so the
   gaps are real gaps rather than guesses.
4. **Image pass, only if the caption fell short** — if title, date, start time,
   end time or location came back empty, call Claude again with the full image
   attached and the caption alongside, the flyer named as authoritative. A
   caption-complete post never pays for this call.
5. The image URL is always the uncropped one, whichever pass produced the
   fields.

## Description

Copied verbatim from the caption, never written or rewritten by the model —
the rule Facebook events already follow. Only `<a href>` and `<br>` survive
sanitising. Instagram writes `@handle` and `#hashtag` links as site-relative
hrefs with a `utm_source=ig_embed` tracker; both are made absolute so they
still work from a calendar invite.

## Failure

Any step that comes up empty returns the existing `allowPaste` error, so the
paste-the-text-in-by-hand path catches an Instagram change exactly as it
catches a Facebook one.

## Live run

Deployed as version 38 and run against
`https://www.instagram.com/p/DcHA9syRjX4/` on 2026-08-21. Confirmed working by
the person who ran it, against the four things worth checking:

| Checked | Expected | Why it is the tell |
|---|---|---|
| Date | 2026-08-22 | The caption says "this Saturday, August 22nd" with no year at all. |
| Location | Nissi's VegMex | Appears nowhere in the caption text — only in the artwork. |
| Title | Summer Pop-Up Market | |
| Image | The tall flyer | A square would mean a crop had slipped through. |

The year and the location are what make this a real test of the second pass:
neither is in the caption, so the caption pass has to return them null and the
flyer has to supply them. Times (11:30–15:30) are in both sources and prove
nothing on their own.

Not exercised by this run, and still unproven: a caption that states everything,
which should skip the image pass entirely; and `claudeImageBlock_`'s degrade
path, which logs and returns null on a failed fetch, an unusable content type or
an oversized image, leaving the caption-only answer standing.
