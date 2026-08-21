function test_parseClaudeResponse() {
  const validJson = JSON.stringify({
    title: 'Test Event',
    date: '2026-04-15',
    start_time: '19:00',
    end_time: '21:00',
    end_time_note: null,
    location: '123 Main St',
    description: 'A great event.',
    image_url: 'https://example.com/image.jpg',
    source_link_label: 'RSVP on Meetup'
  });

  const result = parseClaudeResponse_(validJson);
  if (result.title !== 'Test Event') throw new Error('title mismatch');
  if (result.source_link_label !== 'RSVP on Meetup') throw new Error('label mismatch');

  // Test malformed JSON triggers retry flag
  const bad = parseClaudeResponse_('not json at all');
  if (bad !== null) throw new Error('expected null for bad JSON');

  Logger.log('test_parseClaudeResponse: ALL PASSED');
}

function test_parseOccurrences() {
  // A response WITHOUT occurrences must degrade to today's behavior, not crash.
  var legacy = parseClaudeResponse_(JSON.stringify({
    title: 'One Night Only', date: '2026-08-10',
    start_time: '19:00', end_time: '20:00'
  }));
  if (!legacy.occurrences || legacy.occurrences.length !== 1) {
    throw new Error('legacy response should back-fill one occurrence');
  }
  if (legacy.occurrences[0].date !== '2026-08-10') throw new Error('back-fill used the wrong date');
  if (legacy.occurrences[0].start_time !== '19:00') throw new Error('back-fill lost the start time');

  var multi = parseClaudeResponse_(JSON.stringify({
    title: 'Vegan Book Club', date: '2026-08-10', start_time: '19:00', end_time: '20:00',
    occurrences: [
      { date: '2026-08-10', start_time: '19:00', end_time: '20:00' },
      { date: '2026-08-17', start_time: '19:00', end_time: '20:00' }
    ]
  }));
  if (multi.occurrences.length !== 2) throw new Error('multi-date list should survive parsing');

  // An empty array is as useless as a missing one — back-fill it too.
  var empty = parseClaudeResponse_(JSON.stringify({
    title: 'Empty', date: '2026-08-10', start_time: '19:00', end_time: null, occurrences: []
  }));
  if (empty.occurrences.length !== 1) throw new Error('empty occurrences should be back-filled');

  Logger.log('test_parseOccurrences: ALL PASSED');
}

function test_extractMeetupImage() {
  // Meetup embeds the full photo as highres_<id> in its page state; we should
  // rewrite it to a width-capped webp and ignore the square classic-events crop.
  var html =
    '<meta property="og:image" content="https://secure.meetupstatic.com/photos/event/8/0/1/1/600_534572785.jpeg"/>' +
    '<script type="application/ld+json">{"image":["https://secure-content.meetupstatic.com/images/classic-events/534572785/676x676.jpg"]}</script>' +
    '"displayPhoto":{"id":"534572785","source":"https://secure.meetupstatic.com/photos/event/8/0/1/1/highres_534572785.jpeg"}';

  var result = extractMeetupImage_(html);
  if (result !== 'https://secure.meetupstatic.com/photos/event/8/0/1/1/highres_534572785.webp?w=1080') {
    throw new Error('Unexpected Meetup image URL: ' + result);
  }

  // No highres photo present → null, so we fall back to Claude's pick.
  if (extractMeetupImage_('<html><img src="https://example.com/a.png"></html>') !== null) {
    throw new Error('expected null when no highres photo present');
  }

  Logger.log('test_extractMeetupImage: ALL PASSED');
}

function test_extractMeetupSeries() {
  var html = '"maxTickets":0,"series":{"__typename":"Series","description":' +
             '"Every week on Monday until August 31, 2026"},"rsvps":{}';
  var s = extractMeetupSeries_(html);
  if (s !== 'Every week on Monday until August 31, 2026') throw new Error('got: ' + s);
  if (extractMeetupSeries_('<html>no series here</html>') !== null) {
    throw new Error('expected null when the page has no series');
  }
  Logger.log('test_extractMeetupSeries: ALL PASSED');
}

function test_extractEventData_live() {
  // Replace with a real public event URL for testing
  var url = 'https://lu.ma/some-event';
  var result = extractEventData(url);
  Logger.log(JSON.stringify(result, null, 2));
  // Manually inspect output in Execution log
}

var CLAUDE_MODEL = 'claude-sonnet-4-6';
var CLAUDE_API_URL = 'https://api.anthropic.com/v1/messages';

var EXTRACTION_PROMPT = `You are extracting event details from a webpage. Return ONLY valid JSON with these exact fields:

{
  "title": "Event title (string, required)",
  "date": "YYYY-MM-DD (string, required)",
  "start_time": "HH:MM in 24h format (string, required)",
  "end_time": "HH:MM in 24h format, or null if unknown (string|null)",
  "end_time_note": "Explain your best guess for end time, or null if end time was explicit (string|null)",
  "occurrences": "Array of every date this event happens on: [{\"date\":\"YYYY-MM-DD\",\"start_time\":\"HH:MM\",\"end_time\":\"HH:MM|null\"}]. ALWAYS include at least one entry (array)",
  "location": "Full location string, or null (string|null)",
  "description": "COMPLETE event description as HTML. Copy ALL body text word-for-word — every paragraph, bullet point, and formatted text that describes the event. Do NOT use og:description or twitter:description meta tags as the source — those are truncated previews. Find the full description in the page body and copy it entirely without summarizing or omitting any text. Use only: <b>, <i>, <ul>, <li>, <a href>, <br>. Strip all other tags. Or null if no description. (string|null)",
  "image_url": "Direct URL to the main event image, or null (string|null)",
  "source_link_label": "One of: 'RSVP on Meetup', 'RSVP on Luma', 'RSVP on Eventbrite', 'RSVP on Facebook', or 'See Website for details' (string)"
}

Rules:
- Return ONLY the JSON object. No markdown, no explanation.
- If iCal event data is present (marked === ICAL EVENT DATA ===), use DTSTART as the authoritative date and start_time, DTEND for end_time. Times ending in Z are UTC — convert to the event's local timezone using the location as context (e.g., Texas = Central Time, UTC-5 CDT / UTC-6 CST).
- If JSON-LD structured data is present (marked with === STRUCTURED EVENT DATA ===), use it as the authoritative source for date, start_time, and end_time.
- For end_time: only guess if it is truly not stated anywhere on the page (including structured data and iCal). If you guess, always set end_time_note. Typical durations: networking dinner → 2-3h, workshop → 3h, coffee meetup → 1.5h.
- For source_link_label: infer from the URL domain if possible.
- For description: you are COPYING, not writing. Reproduce the page's description text EXACTLY as written, word for word. Never summarize, shorten, paraphrase, reword, rephrase or "improve" it, and never add wording of your own. Preserve every paragraph and list item. Reproduce URLs in full — never truncate one or replace part of it with an ellipsis, and never link to a shortened or redirect form of it. Preserve bold/italic/links/lists using only <b>, <i>, <ul>, <li>, <a href>, <br>. Strip all other HTML tags.
- Dates must be YYYY-MM-DD. Times must be HH:MM (24h).
- For dates where the year is not explicitly stated: use the nearest future occurrence relative to today. Never infer a date in the past.
- occurrences: list EVERY date the page states this event happens on. A normal single-date event returns an array of exactly one entry. The top-level date/start_time/end_time must always mirror occurrences[0].
- Do NOT extrapolate a recurrence beyond the dates actually shown. If the page gives both a rule ("every week on Monday until August 31") and an explicit list of dates, the explicit list wins.
- If a recurrence is described in prose WITH a stated end date but the individual dates are not listed, expand it into explicit dates yourself and stop at the stated end. Never invent dates past it.
- If a specific date has a different start or end time from the others, put that date's real time on its own entry. Otherwise repeat the common time on every entry.
- Apply the nearest-future-occurrence rule to the FIRST date only, then keep dates increasing, so a list like "12/20, 1/10" rolls into the following year.`;

/**
 * Fetches a URL and extracts event data using Claude.
 * Retries once with a stricter prompt if JSON parsing fails.
 * @param {string} url - The event page URL
 * @returns {{data: Object}|{error: string}}
 */
function extractEventData(url) {
  // Facebook server-renders the event into the page HTML for logged-out
  // visitors — the "See more on Facebook" dialog is only a client-side overlay
  // drawn on top of it. See FacebookService.gs and
  // docs/plans/2026-07-27-facebook-no-login-plan.md.
  if (url.indexOf('facebook.com/events/') >= 0) {
    var fbHtml = fetchFacebookEventPage_(url);
    var fbEvent = fbHtml ? parseFacebookEvent_(fbHtml) : null;

    if (fbEvent) {
      var fbContent = formatFacebookEventForClaude_(fbEvent, url);
      var fbResult = callClaude_(fbContent, false);
      if (fbResult === null) fbResult = callClaude_(fbContent, true);

      if (fbResult) {
        // Facebook gives us the exact text, so the description is copied
        // through verbatim rather than being rewritten by the model.
        if (fbEvent.descriptionHtml) fbResult.description = fbEvent.descriptionHtml;
        if (fbEvent.imageUrl) fbResult.image_url = fbEvent.imageUrl;
        if (fbEvent.location && !fbResult.location) fbResult.location = fbEvent.location;
        return { data: fbResult };
      }
    }

    return {
      error: 'Could not read this Facebook event automatically — Facebook may have changed its page format.',
      allowPaste: true,
      originalUrl: url
    };
  }

  // Instagram serves the post through its embed endpoint with no login — see
  // InstagramService.gs. The caption is often chatty rather than complete, so
  // the flyer is read whenever the caption leaves a field empty.
  if (instagramShortcode_(url)) {
    var post = fetchInstagramPost_(url);
    if (!post) {
      return {
        error: 'Could not read this Instagram post automatically — it may be private or ' +
               'deleted, or Instagram may have changed its embed format.',
        allowPaste: true,
        originalUrl: url
      };
    }

    var igContent = formatInstagramPostForClaude_(post, url, []);
    var igResult = callClaude_(igContent, false);
    if (igResult === null) igResult = callClaude_(igContent, true);

    // Second pass with the flyer attached. A caption that stated everything
    // never gets here, and so never pays for the image.
    var missing = igMissingFields_(igResult);
    if (post.imageUrl && missing.length) {
      var visionContent = formatInstagramPostForClaude_(post, url, missing);
      var visionResult = callClaude_(visionContent, false, post.imageUrl);
      if (visionResult === null) visionResult = callClaude_(visionContent, true, post.imageUrl);
      if (visionResult) igResult = visionResult;
    }

    if (!igResult) {
      return {
        error: 'Could not extract event data from this Instagram post.',
        allowPaste: true,
        originalUrl: url
      };
    }

    // The caption is the description, copied through verbatim rather than
    // rewritten by the model — the rule Facebook events already follow.
    if (post.captionHtml) igResult.description = post.captionHtml;
    // Always the uncropped original, whichever pass produced the fields.
    if (post.imageUrl) igResult.image_url = post.imageUrl;
    igResult.source_link_label = 'See the post on Instagram';
    return { data: igResult };
  }

  var html;
  try {
    var response = UrlFetchApp.fetch(url, { muteHttpExceptions: true, followRedirects: true });
    var code = response.getResponseCode();
    if (code !== 200) {
      return { error: 'Could not fetch the page (HTTP ' + code + '). It may be behind a login or paywall.' };
    }
    html = response.getContentText();
  } catch (e) {
    return { error: 'Could not reach the URL: ' + e.message };
  }

  // Extract JSON-LD structured data before stripping scripts — event sites like Luma
  // embed authoritative date/time here and it's the most reliable source.
  var jsonLdBlocks = [];
  var jsonLdRegex = /<script[^>]+type=['"]application\/ld\+json['"][^>]*>([\s\S]*?)<\/script>/gi;
  var jsonLdMatch;
  while ((jsonLdMatch = jsonLdRegex.exec(html)) !== null) {
    jsonLdBlocks.push(jsonLdMatch[1].trim());
  }

  // Strip non-structured scripts and styles to reduce token usage, then strip
  // noisy presentation attributes (class, style, data-*, aria-*) that waste
  // tokens without contributing text content.
  var cleaned = html
    .replace(/<script(?![^>]+type=['"]application\/ld\+json['"])[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/ (?:class|style|tabindex|onfocus|onmouseup|onclick|onload|onchange|onsubmit)="[^"]*"/gi, '')
    .replace(/ (?:data-|aria-)[a-z][a-z-]*="[^"]*"/gi, '')
    .substring(0, 30000);

  // Look for iCal download links — these are the authoritative date/time source
  // for sites like BetterUnite that render dates via JavaScript.
  var icalSection = extractICalSection_(html, url);

  // Prepend JSON-LD and iCal prominently so Claude sees them as authoritative
  var structuredPrefix = '';
  if (jsonLdBlocks.length > 0) {
    structuredPrefix += '=== STRUCTURED EVENT DATA (JSON-LD) — AUTHORITATIVE SOURCE FOR DATE/TIME/TITLE ===\n' +
                        jsonLdBlocks.join('\n') +
                        '\n=== END STRUCTURED DATA ===\n\n';
  }
  if (icalSection) {
    structuredPrefix += icalSection + '\n\n';
  }
  if (structuredPrefix) {
    cleaned = structuredPrefix + cleaned;
  }

  // Meetup hides its recurrence in page state as prose, and its JSON-LD only
  // carries the first occurrence — surface it so multi-date series are caught.
  if (url.indexOf('meetup.com') >= 0) {
    var series = extractMeetupSeries_(html);
    if (series) {
      cleaned = '=== EVENT SERIES RECURRENCE (from Meetup) ===\n' + series +
                '\nThis event repeats. Enumerate every date in occurrences[], ' +
                'stopping at the stated end date.\n=== END SERIES ===\n\n' + cleaned;
    }
  }

  var result = callClaude_(cleaned, false);
  if (result === null) {
    // Retry with stricter prompt
    result = callClaude_(cleaned, true);
  }
  if (result === null) {
    return { error: 'Could not extract event data from this page. Please try a different URL or fill in the fields manually.' };
  }

  // Meetup only surfaces square/small crops in og:image and JSON-LD, so Claude
  // picks a cropped image. Override with the full landscape photo when present.
  if (url.indexOf('meetup.com') >= 0) {
    var meetupImg = extractMeetupImage_(html);
    if (meetupImg) result.image_url = meetupImg;
  }

  return { data: result };
}

/**
 * Extracts the full-size landscape event photo from a Meetup page.
 *
 * Meetup's og:image and JSON-LD "image" array only expose square/small crops
 * (e.g. classic-events/<id>/676x676.jpg), so Claude tends to pick those and the
 * sides of the real photo get cut off. The full image the page actually displays
 * lives in the embedded JS state as highres_<id>.<ext>. We grab that and rewrite
 * it to a width-capped webp, matching what Meetup serves to the browser.
 * @param {string} html - Raw page HTML
 * @returns {string|null} Full image URL, or null if no highres photo is found
 */
function extractMeetupImage_(html) {
  var m = html.match(/https:\/\/secure\.meetupstatic\.com\/photos\/[^"'\\ ]*?highres_\d+\.(?:jpe?g|png|webp)/i);
  if (!m) return null;
  return m[0].replace(/\.(?:jpe?g|png|webp)$/i, '.webp') + '?w=1080';
}

/**
 * Pulls Meetup's recurrence description out of the embedded page state.
 *
 * Meetup's JSON-LD only ever exposes the FIRST occurrence of a series, so a
 * four-week book club looks like a one-off event. The only recurrence signal on
 * the page is prose: "series":{"description":"Every week on Monday until
 * August 31, 2026"}. We surface it to Claude as context rather than parsing it,
 * because the enumerated dates in the body remain authoritative.
 * @param {string} html - Raw page HTML
 * @returns {string|null}
 */
function extractMeetupSeries_(html) {
  var m = html.match(/"series"\s*:\s*\{[^}]*?"description"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  if (!m) return null;
  return m[1].replace(/\\"/g, '"').replace(/\\n/g, ' ').trim() || null;
}

/**
 * Looks for iCal download links in the HTML, fetches the first one found,
 * and returns a structured text block for Claude to use as authoritative
 * date/time. Returns null if no iCal link is found or fetch fails.
 * @param {string} html - Raw page HTML
 * @param {string} pageUrl - Original page URL (for resolving relative links)
 * @returns {string|null}
 */
function extractICalSection_(html, pageUrl) {
  // Match href values that look like iCal download links
  var icalRegex = /href="([^"]*(?:AddToCalendar[^"]*[Ii][Cc]al|type=[Ii][Cc]al|\.ics)[^"]*)"/i;
  var match = icalRegex.exec(html);
  if (!match) return null;

  var icalUrl = match[1];
  // Resolve relative URLs
  if (icalUrl.charAt(0) === '/') {
    var baseMatch = pageUrl.match(/^(https?:\/\/[^\/]+)/);
    if (baseMatch) icalUrl = baseMatch[1] + icalUrl;
  }

  try {
    var resp = UrlFetchApp.fetch(icalUrl, { muteHttpExceptions: true });
    if (resp.getResponseCode() !== 200) return null;
    var ical = resp.getContentText();

    var dtStart = (ical.match(/DTSTART[^:]*:(\S+)/) || [])[1];
    var dtEnd   = (ical.match(/DTEND[^:]*:(\S+)/)   || [])[1];
    var summary = (ical.match(/SUMMARY:(.+)/)        || [])[1];
    var loc     = (ical.match(/LOCATION:(.+)/)       || [])[1];

    if (!dtStart) return null;

    var lines = ['=== ICAL EVENT DATA — AUTHORITATIVE SOURCE FOR DATE/TIME ==='];
    lines.push('DTSTART: ' + dtStart + (dtStart.slice(-1) === 'Z' ? ' (UTC)' : ''));
    if (dtEnd) lines.push('DTEND: ' + dtEnd + (dtEnd.slice(-1) === 'Z' ? ' (UTC)' : ''));
    if (summary) lines.push('SUMMARY: ' + summary.trim());
    if (loc)     lines.push('LOCATION: ' + loc.trim());
    lines.push('=== END ICAL DATA ===');
    return lines.join('\n');
  } catch (e) {
    return null;
  }
}

/**
 * Calls Claude API and returns parsed JSON, or null on failure.
 * @param {string} htmlContent
 * @param {boolean} strict - Use stricter retry prompt
 * @param {string} [imageUrl] - Image to read alongside the text. Skipped
 *     silently if it cannot be fetched, so a flaky CDN degrades to a text-only
 *     answer rather than to no answer at all.
 * @returns {Object|null}
 */
function callClaude_(htmlContent, strict, imageUrl) {
  var apiKey = PropertiesService.getScriptProperties().getProperty('CLAUDE_API_KEY');
  var systemPrompt = strict
    ? EXTRACTION_PROMPT + '\n\nCRITICAL: Your previous response was not valid JSON. Return ONLY the raw JSON object starting with { and ending with }. Absolutely no other text.'
    : EXTRACTION_PROMPT;

  var today = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
  systemPrompt = 'Today\'s date is ' + today + '.\n\n' + systemPrompt;

  var userText = 'Extract event details from this HTML:\n\n' + htmlContent;
  var imageBlock = imageUrl ? claudeImageBlock_(imageUrl) : null;

  var payload = {
    model: CLAUDE_MODEL,
    max_tokens: 4096,
    system: systemPrompt,
    messages: [{
      role: 'user',
      content: imageBlock ? [imageBlock, { type: 'text', text: userText }] : userText
    }]
  };

  try {
    var response = UrlFetchApp.fetch(CLAUDE_API_URL, {
      method: 'post',
      contentType: 'application/json',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    });

    var body = JSON.parse(response.getContentText());
    if (!body.content || !body.content[0]) return null;
    return parseClaudeResponse_(body.content[0].text);
  } catch (e) {
    Logger.log('Claude API error: ' + e.message);
    return null;
  }
}

// Anthropic rejects a request image over 5MB once base64-encoded, and base64
// inflates by 4/3. Flyers run a few hundred KB, so this only ever catches
// something that is not a flyer.
var CLAUDE_MAX_IMAGE_BYTES = 3750000;

var CLAUDE_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];

/**
 * Downloads an image and packs it as a Claude content block.
 *
 * The bytes are sent inline rather than the URL being handed to Anthropic to
 * fetch: Instagram's CDN URLs are signed and short-lived, and are served from a
 * region-specific host that need not answer someone else's fetch.
 *
 * @param {string} imageUrl
 * @returns {Object|null} An image content block, or null if it cannot be sent
 */
function claudeImageBlock_(imageUrl) {
  try {
    var resp = UrlFetchApp.fetch(imageUrl, { muteHttpExceptions: true, followRedirects: true });
    if (resp.getResponseCode() !== 200) {
      Logger.log('claudeImageBlock_: HTTP ' + resp.getResponseCode());
      return null;
    }

    var blob = resp.getBlob();
    var mediaType = String(blob.getContentType() || '').toLowerCase().split(';')[0];
    if (CLAUDE_IMAGE_TYPES.indexOf(mediaType) < 0) {
      Logger.log('claudeImageBlock_: unusable content type ' + mediaType);
      return null;
    }

    var bytes = blob.getBytes();
    if (bytes.length > CLAUDE_MAX_IMAGE_BYTES) {
      Logger.log('claudeImageBlock_: image is ' + bytes.length + ' bytes, too large to send');
      return null;
    }

    return {
      type: 'image',
      source: { type: 'base64', media_type: mediaType, data: Utilities.base64Encode(bytes) }
    };
  } catch (e) {
    Logger.log('claudeImageBlock_ error: ' + e.message);
    return null;
  }
}

/**
 * Parses Claude's text response as JSON.
 * @param {string} text
 * @returns {Object|null}
 */
function parseClaudeResponse_(text) {
  try {
    // Extract JSON object if wrapped in extra text
    var match = text.match(/\{[\s\S]*\}/);
    if (!match) return null;
    var data = JSON.parse(match[0]);

    // Older/partial responses omit `occurrences`. Back-fill a one-element list
    // from the top-level fields so downstream code has a single shape to handle.
    if (!data.occurrences || !data.occurrences.length) {
      data.occurrences = data.date
        ? [{ date: data.date, start_time: data.start_time, end_time: data.end_time || null }]
        : [];
    }
    return data;
  } catch (e) {
    return null;
  }
}
