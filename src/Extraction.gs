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
- For description: copy ALL body text word-for-word. Do NOT summarize or truncate. Preserve bold/italic/links/lists using only <b>, <i>, <ul>, <li>, <a href>, <br>. Strip all other HTML tags.
- Dates must be YYYY-MM-DD. Times must be HH:MM (24h).
- For dates where the year is not explicitly stated: use the nearest future occurrence relative to today. Never infer a date in the past.`;

/**
 * Fetches a URL and extracts event data using Claude.
 * Retries once with a stricter prompt if JSON parsing fails.
 * @param {string} url - The event page URL
 * @returns {{data: Object}|{error: string}}
 */
function extractEventData(url) {
  // Facebook event pages are heavily JS-rendered — the HTML GAS fetches
  // server-side is mostly empty. Use the Graph API Events endpoint instead,
  // which works for public events using just app credentials (no user login).
  if (url.indexOf('facebook.com/events/') >= 0) {
    var fbEvent = fetchFacebookEventViaApi_(url);
    if (fbEvent && !fbEvent.apiError) {
      var content = formatFacebookEventForClaude_(fbEvent, url);
      var result = callClaude_(content, false);
      if (result === null) result = callClaude_(content, true);
      if (result) {
        if (!result.image_url && fbEvent.cover && fbEvent.cover.source) {
          result.image_url = fbEvent.cover.source;
        }
        return { data: result };
      }
    }
    // Fall through to HTML extraction if API unavailable (no credentials)
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

  var loginWall = detectLoginWall_(html, url);
  if (loginWall) {
    // If we're authenticated with Facebook, try the Graph API before giving up
    if (loginWall.platform === 'Facebook') {
      var fbPost = fetchFacebookPostContent_(url);
      if (fbPost && !fbPost.apiError) {
        var result = callClaude_(fbPost.text, false);
        if (result === null) result = callClaude_(fbPost.text, true);
        if (result) {
          if (!result.image_url && fbPost.imageUrl) result.image_url = fbPost.imageUrl;
          return { data: result };
        }
      } else if (fbPost && fbPost.apiError) {
        loginWall.apiError = fbPost.apiError;
      }
    }
    return loginWall;
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
 * Detects if the fetched page is a login wall rather than actual event content.
 * Returns a loginRequired result object, or null if no wall detected.
 * @param {string} html - Raw page HTML
 * @param {string} url - Original URL
 * @returns {{loginRequired: true, platform: string, creatorUrl: string|null}|null}
 */
function detectLoginWall_(html, url) {
  if (url.indexOf('facebook.com') >= 0) {
    var t = html.toLowerCase();

    // Only flag pages where the response IS the login page, not pages that
    // merely include login UI in their header/footer (which is all of Facebook).
    // Reliable signals: the page <title> is login-related, or the actual login
    // form fields (email + password) are the primary page content.
    var isFbLoginWall =
      t.indexOf('<title>log in to facebook') >= 0 ||
      t.indexOf('<title>facebook – log in') >= 0 ||
      t.indexOf('<title>facebook - log in') >= 0 ||
      t.indexOf('<title>facebook — log in') >= 0 ||
      (html.indexOf('id="login_form"') >= 0 &&
       html.indexOf('name="email"') >= 0 &&
       html.indexOf('name="pass"') >= 0);

    if (isFbLoginWall) {
      var groupMatch = url.match(/facebook\.com\/groups\/([^\/\?#]+)/);
      var creatorUrl = groupMatch
        ? 'https://www.facebook.com/groups/' + groupMatch[1] + '/'
        : url;
      return { loginRequired: true, platform: 'Facebook', creatorUrl: creatorUrl, originalUrl: url };
    }
  }

  return null;
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
 * @returns {Object|null}
 */
function callClaude_(htmlContent, strict) {
  var apiKey = PropertiesService.getScriptProperties().getProperty('CLAUDE_API_KEY');
  var systemPrompt = strict
    ? EXTRACTION_PROMPT + '\n\nCRITICAL: Your previous response was not valid JSON. Return ONLY the raw JSON object starting with { and ending with }. Absolutely no other text.'
    : EXTRACTION_PROMPT;

  var today = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
  systemPrompt = 'Today\'s date is ' + today + '.\n\n' + systemPrompt;

  var payload = {
    model: CLAUDE_MODEL,
    max_tokens: 4096,
    system: systemPrompt,
    messages: [{ role: 'user', content: 'Extract event details from this HTML:\n\n' + htmlContent }]
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
    return JSON.parse(match[0]);
  } catch (e) {
    return null;
  }
}
