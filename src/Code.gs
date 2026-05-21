function test_processEventUrl_badUrl() {
  var result = processEventUrl('https://this-domain-definitely-does-not-exist-xyz.com/event');
  if (!result.error) throw new Error('Expected error for unreachable URL');
  Logger.log('test_processEventUrl_badUrl: PASSED — ' + result.error);
}

/**
 * GAS Web App entry point — serves the HTML UI.
 * Uses createTemplateFromFile so the web app URL can be reliably embedded
 * into the page at serve time (ScriptApp.getService().getUrl() only works
 * in doGet context, not when called via google.script.run).
 */
function doGet(e) {
  var webAppUrl = ScriptApp.getService().getUrl();

  // Facebook OAuth callback arrives as ?code=...&state=...
  if (e && e.parameter && e.parameter.code && e.parameter.state) {
    var cb = HtmlService.createTemplateFromFile('OAuthCallback');
    cb.webAppUrl = webAppUrl;
    return cb.evaluate()
      .setTitle('Connecting...')
      .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
  }

  var t = HtmlService.createTemplateFromFile('Index');
  t.webAppUrl = webAppUrl;
  return t.evaluate()
    .setTitle('Event Automation')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/**
 * Called by the UI: fetches a URL and returns extracted event data for preview.
 * @param {string} url
 * @returns {{data: Object}|{error: string}|{loginRequired: true, ...}}
 */
function processEventUrl(url) {
  if (!url || !url.startsWith('http')) {
    return { error: 'Please enter a valid URL starting with http.' };
  }
  return extractEventData(url);
}

/**
 * Called by the UI when the user pastes raw event content (e.g. from a
 * Facebook post they can see while logged in). Passes the text to Claude.
 * @param {string} text - Pasted post/page content
 * @param {string} sourceUrl - Original URL for context
 * @returns {{data: Object}|{error: string}}
 */
function processEventText(text, sourceUrl) {
  if (!text || text.trim().length < 20) {
    return { error: 'Please paste more content — not enough text to extract from.' };
  }
  var content = '=== PASTED EVENT CONTENT ===\nSource URL: ' + (sourceUrl || '') + '\n\n' + text.trim() + '\n=== END PASTED CONTENT ===';
  var result = callClaude_(content, false);
  if (result === null) result = callClaude_(content, true);
  if (result === null) return { error: 'Could not extract event data from the pasted text. Try including more of the post.' };
  return { data: result };
}

/**
 * Called by the UI after the user confirms: creates Drive file, Calendar event, attaches image.
 * @param {Object} eventData - Confirmed, user-edited event fields + imageUrl + sourceUrl
 * @returns {{success: true, calendarUrl: string, driveUrl: string}|{error: string, partial: Object}}
 */
function submitEvent(eventData) {
  var driveResult = null;
  var calResult = null;

  // 1. Check for duplicates
  var duplicate = isDuplicateEvent(eventData.title, eventData.date);

  // 2. Save image to Drive (non-blocking)
  if (eventData.image_url) {
    driveResult = saveImageToDrive(eventData.image_url, eventData.title, eventData.date);
    if (driveResult.error) {
      driveResult = null; // Continue without image
    }
  }

  // 3. Build full description with source link appended
  var fullDescription = (eventData.description || '').trim();
  if (eventData.source_link_label && eventData.source_url) {
    fullDescription += '\n\n<a href="' + eventData.source_url + '">' + eventData.source_link_label + '</a>';
  }

  // 4. Create Calendar event
  calResult = createCalendarEvent({
    title: eventData.title,
    date: eventData.date,
    start_time: eventData.start_time,
    end_time: eventData.end_time,
    location: eventData.location,
    description: fullDescription
  });

  if (calResult.error) {
    return {
      error: calResult.error,
      partial: driveResult ? { driveUrl: driveResult.fileUrl } : null
    };
  }

  // 5. Attach Drive image to Calendar event
  var attachResult = null;
  if (driveResult) {
    attachResult = attachFileToCalendarEvent(
      calResult.eventId,
      driveResult.fileId,
      driveResult.fileName
    );
  }

  var userEmail = Session.getActiveUser().getEmail();
  var calendarUrl = calResult.eventUrl +
    (calResult.eventUrl.indexOf('?') >= 0 ? '&' : '?') +
    'authuser=' + userEmail;

  return {
    success: true,
    duplicate: duplicate,
    title: eventData.title,
    calendarUrl: calendarUrl,
    driveUrl: driveResult ? driveResult.fileUrl : null,
    imageUrl: eventData.image_url || null,
    attachmentWarning: (driveResult && attachResult && attachResult.error) ? attachResult.error : null
  };
}
