function test_processEventUrl_badUrl() {
  var result = processEventUrl('https://this-domain-definitely-does-not-exist-xyz.com/event');
  if (!result.error) throw new Error('Expected error for unreachable URL');
  Logger.log('test_processEventUrl_badUrl: PASSED — ' + result.error);
}

/**
 * GAS Web App entry point — serves the HTML UI.
 */
function doGet() {
  return HtmlService.createHtmlOutputFromFile('Index')
    .setTitle('Event Automation')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/**
 * Called by the UI: fetches a URL and returns extracted event data for preview.
 * @param {string} url
 * @returns {{data: Object}|{error: string}}
 */
function processEventUrl(url) {
  if (!url || !url.startsWith('http')) {
    return { error: 'Please enter a valid URL starting with http.' };
  }
  return extractEventData(url);
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
    fullDescription += '\n\n' + eventData.source_link_label + ': ' + eventData.source_url;
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

  return {
    success: true,
    duplicate: duplicate,
    calendarUrl: calResult.eventUrl,
    driveUrl: driveResult ? driveResult.fileUrl : null,
    attachmentWarning: (driveResult && attachResult && attachResult.error) ? attachResult.error : null
  };
}
