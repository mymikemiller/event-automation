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
  "description": "Event description as HTML, preserving bold/italic/links/lists from the source page. Use only: <b>, <i>, <ul>, <li>, <a href>, <br>. Strip all other tags. Or null if no description. (string|null)",
  "image_url": "Direct URL to the main event image, or null (string|null)",
  "source_link_label": "One of: 'RSVP on Meetup', 'RSVP on Luma', 'RSVP on Eventbrite', 'RSVP on Facebook', or 'See Website for details' (string)"
}

Rules:
- Return ONLY the JSON object. No markdown, no explanation.
- For end_time: if not explicitly stated, make a best guess from context (e.g. 'networking dinner' → 2-3 hours, 'workshop' → 3 hours, 'coffee meetup' → 1.5 hours). Always set end_time_note when guessing.
- For source_link_label: infer from the URL domain if possible.
- For description: preserve bold/italic/links/lists using only <b>, <i>, <ul>, <li>, <a href>, <br>. Strip all other HTML tags.
- Dates must be YYYY-MM-DD. Times must be HH:MM (24h).`;

/**
 * Fetches a URL and extracts event data using Claude.
 * Retries once with a stricter prompt if JSON parsing fails.
 * @param {string} url - The event page URL
 * @returns {{data: Object}|{error: string}}
 */
function extractEventData(url) {
  var html;
  try {
    var response = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
    var code = response.getResponseCode();
    if (code !== 200) {
      return { error: 'Could not fetch the page (HTTP ' + code + '). It may be behind a login or paywall.' };
    }
    html = response.getContentText();
  } catch (e) {
    return { error: 'Could not reach the URL: ' + e.message };
  }

  // Strip script/style tags to reduce token usage
  var cleaned = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .substring(0, 30000); // cap at ~30k chars

  var result = callClaude_(cleaned, false);
  if (result === null) {
    // Retry with stricter prompt
    result = callClaude_(cleaned, true);
  }
  if (result === null) {
    return { error: 'Could not extract event data from this page. Please try a different URL or fill in the fields manually.' };
  }
  return { data: result };
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

  var payload = {
    model: CLAUDE_MODEL,
    max_tokens: 1024,
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
