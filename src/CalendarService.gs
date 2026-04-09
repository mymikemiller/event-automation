function test_createAndDeleteEvent() {
  var eventData = {
    title: '[TEST] Event Automation Test',
    date: '2026-04-15',
    start_time: '19:00',
    end_time: '21:00',
    location: '123 Test St',
    description: 'Test description.\n\nRSVP on Meetup: https://meetup.com/test'
  };

  var result = createCalendarEvent(eventData);
  if (!result.eventId) throw new Error('No eventId returned: ' + JSON.stringify(result));

  // Clean up
  var cal = CalendarApp.getCalendarById(
    PropertiesService.getScriptProperties().getProperty('CALENDAR_ID')
  );
  cal.getEventById(result.eventId).deleteEvent();

  Logger.log('test_createAndDeleteEvent: ALL PASSED');
}

function test_duplicateDetection() {
  // Create an event, then check duplicate detection finds it, then clean up
  var eventData = {
    title: '[TEST] Duplicate Check',
    date: '2026-04-15',
    start_time: '19:00',
    end_time: '21:00',
    location: '',
    description: 'Test'
  };

  var created = createCalendarEvent(eventData);
  var isDuplicate = isDuplicateEvent('[TEST] Duplicate Check', '2026-04-15');

  // Clean up
  var cal = CalendarApp.getCalendarById(
    PropertiesService.getScriptProperties().getProperty('CALENDAR_ID')
  );
  cal.getEventById(created.eventId).deleteEvent();

  if (!isDuplicate) throw new Error('Expected duplicate to be detected');
  Logger.log('test_duplicateDetection: ALL PASSED');
}

/**
 * Creates a Google Calendar event.
 * @param {Object} eventData - Fields: title, date, start_time, end_time, location, description
 * @returns {{eventId: string, eventUrl: string}|{error: string}}
 */
function createCalendarEvent(eventData) {
  try {
    var calendarId = PropertiesService.getScriptProperties().getProperty('CALENDAR_ID');
    var cal = CalendarApp.getCalendarById(calendarId);
    if (!cal) return { error: 'Calendar not found. Check CALENDAR_ID script property.' };

    var startDate = parseDateTimeToDate_(eventData.date, eventData.start_time);
    var endDate = parseDateTimeToDate_(eventData.date, eventData.end_time || eventData.start_time);
    // If end == start (no end time given), default to +2 hours
    if (endDate <= startDate) {
      endDate = new Date(startDate.getTime() + 2 * 60 * 60 * 1000);
    }

    var options = { description: eventData.description || '' };
    if (eventData.location) options.location = eventData.location;

    var event = cal.createEvent(eventData.title, startDate, endDate, options);
    return {
      eventId: event.getId(),
      eventUrl: 'https://calendar.google.com/calendar/event?eid=' +
                Utilities.base64Encode(event.getId())
    };
  } catch (e) {
    return { error: 'Failed to create calendar event: ' + e.message };
  }
}

/**
 * Attaches a Drive file to a Calendar event using the Advanced Calendar Service.
 * @param {string} eventId  - Calendar event ID
 * @param {string} fileId   - Drive file ID
 * @param {string} fileName - Display name for the attachment
 * @returns {{success: boolean}|{error: string}}
 */
function attachFileToCalendarEvent(eventId, fileId, fileName) {
  try {
    var calendarId = PropertiesService.getScriptProperties().getProperty('CALENDAR_ID');
    var file = DriveApp.getFileById(fileId);

    Calendar.Events.patch(
      {
        attachments: [{
          fileUrl: 'https://drive.google.com/open?id=' + fileId,
          mimeType: file.getMimeType(),
          title: fileName
        }]
      },
      calendarId,
      eventId,
      { supportsAttachments: true }
    );
    return { success: true };
  } catch (e) {
    return { error: 'Could not attach image to calendar event: ' + e.message };
  }
}

/**
 * Checks if an event with the same title already exists on the given date.
 * @param {string} title
 * @param {string} date - YYYY-MM-DD
 * @returns {boolean}
 */
function isDuplicateEvent(title, date) {
  try {
    var calendarId = PropertiesService.getScriptProperties().getProperty('CALENDAR_ID');
    var cal = CalendarApp.getCalendarById(calendarId);
    var start = new Date(date + 'T00:00:00');
    var end = new Date(date + 'T23:59:59');
    var events = cal.getEvents(start, end);
    var lowerTitle = title.toLowerCase();
    return events.some(function(e) {
      return e.getTitle().toLowerCase() === lowerTitle;
    });
  } catch (e) {
    return false; // Don't block on duplicate check failure
  }
}

/**
 * Parses YYYY-MM-DD and HH:MM into a JS Date.
 * @param {string} date - YYYY-MM-DD
 * @param {string} time - HH:MM (24h)
 * @returns {Date}
 */
function parseDateTimeToDate_(date, time) {
  var parts = time.split(':');
  var d = new Date(date + 'T00:00:00');
  d.setHours(parseInt(parts[0], 10));
  d.setMinutes(parseInt(parts[1], 10));
  return d;
}
