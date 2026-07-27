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

  var t = HtmlService.createTemplateFromFile('Index');
  t.webAppUrl = webAppUrl;
  return t.evaluate()
    .setTitle('Event Automation')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/**
 * Called by the UI: fetches a URL and returns extracted event data for preview.
 * @param {string} url
 * @returns {{data: Object}|{error: string, allowPaste?: true, originalUrl?: string}}
 */
function processEventUrl(url) {
  if (!url || !url.startsWith('http')) {
    return { error: 'Please enter a valid URL starting with http.' };
  }
  return extractEventData(url);
}

/**
 * Called by the UI when automatic extraction fails and the user pastes the
 * event text in by hand. Passes the text to Claude.
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
 * @param {Object} eventData - Confirmed, user-edited event fields + imageUrl + sourceUrl.
 *   Carries occurrences[] for multi-date events.
 * @returns {{success: true, calendarUrl: string, driveUrl: string}|{error: string, partial: Object}}
 */
function submitEvent(eventData) {
  var driveResult = null;

  var occurrences = (eventData.occurrences && eventData.occurrences.length)
    ? eventData.occurrences
    : [{ date: eventData.date, start_time: eventData.start_time, end_time: eventData.end_time }];

  // Re-plan server-side. The UI's banner is only a preview; this is what runs.
  var plan = planRecurrence_(occurrences, Session.getScriptTimeZone());
  if (plan.method === 'none') return { error: 'Please provide at least one valid date.' };

  var dates = plan.dates.map(function (o) { return o.date; });

  // 1. Which of these dates already have this event?
  var duplicateDates = findDuplicateDates(eventData.title, dates);

  // 2. Save image to Drive (non-blocking), named for the first occurrence
  if (eventData.image_url) {
    driveResult = saveImageToDrive(eventData.image_url, eventData.title, dates[0]);
    if (driveResult.error) {
      driveResult = null; // Continue without image
    }
  }

  // 3. Build full description with source link appended
  var fullDescription = (eventData.description || '').trim();
  if (eventData.source_link_label && eventData.source_url) {
    fullDescription += '\n\n<a href="' + eventData.source_url + '">' + eventData.source_link_label + '</a>';
  }

  // 4. Create Calendar event(s)
  var calResult = createCalendarEvent({
    title: eventData.title,
    occurrences: occurrences,
    location: eventData.location,
    description: fullDescription
  });

  if (calResult.error) {
    return {
      error: calResult.error,
      partial: driveResult ? { driveUrl: driveResult.fileUrl } : null
    };
  }

  // 5. Attach Drive image to the Calendar event(s)
  var attachResult = null;
  if (driveResult) {
    attachResult = attachFileToCalendarEvent(
      calResult.eventIds,
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
    method: calResult.method,
    occurrenceCount: calResult.occurrenceCount,
    dates: dates,
    duplicateDates: duplicateDates,
    warnings: calResult.warnings || [],
    title: eventData.title,
    calendarUrl: calendarUrl,
    driveUrl: driveResult ? driveResult.fileUrl : null,
    imageUrl: eventData.image_url || null,
    attachmentWarning: (driveResult && attachResult && attachResult.error) ? attachResult.error : null
  };
}
