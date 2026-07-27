function test_createAndDeleteEvent() {
  var eventData = {
    title: '[TEST] Event Automation Test',
    date: '2026-04-15',
    start_time: '19:00',
    end_time: '21:00',
    location: '123 Test St',
    description: 'Test description.\n\n<a href="https://meetup.com/test">RSVP on Meetup</a>'
  };

  var result = createCalendarEvent(eventData);
  if (!result.eventId) throw new Error('No eventId returned: ' + JSON.stringify(result));

  // Clean up using Advanced Service (matches the ID format we now return)
  var calendarId = PropertiesService.getScriptProperties().getProperty('CALENDAR_ID');
  Calendar.Events.remove(calendarId, result.eventId);

  Logger.log('test_createAndDeleteEvent: ALL PASSED');
}

function test_duplicateDetection() {
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
  var calendarId = PropertiesService.getScriptProperties().getProperty('CALENDAR_ID');
  Calendar.Events.remove(calendarId, created.eventId);

  if (!isDuplicate) throw new Error('Expected duplicate to be detected');
  Logger.log('test_duplicateDetection: ALL PASSED');
}

/**
 * Creates a Google Calendar event from one or more occurrences.
 *
 * Prefers a single repeating event (RRULE, or RDATE for irregular dates) so the
 * description and flyer live in one place. Occurrences whose time differs from
 * the series are patched individually afterwards. Falls back to N duplicated
 * events only if the recurring insert fails.
 *
 * Passing timeZone explicitly ensures DST is handled correctly by the API.
 * @param {Object} eventData - title, occurrences[], location, description.
 *   Legacy date/start_time/end_time fields are still accepted.
 * @returns {{eventId:string, eventIds:Array<string>, eventUrl:string,
 *            method:string, occurrenceCount:number, warnings:Array<string>}
 *          |{error:string}}
 */
function createCalendarEvent(eventData) {
  try {
    var calendarId = PropertiesService.getScriptProperties().getProperty('CALENDAR_ID');
    var tz = Session.getScriptTimeZone();

    var occurrences = (eventData.occurrences && eventData.occurrences.length)
      ? eventData.occurrences
      : [{ date: eventData.date, start_time: eventData.start_time, end_time: eventData.end_time }];

    var plan = planRecurrence_(occurrences, tz);
    if (plan.method === 'none') return { error: 'No valid dates to create.' };

    var warnings = [];

    try {
      var resource = buildEventResource_(eventData, plan.base, tz);
      if (plan.recurrence) resource.recurrence = plan.recurrence;

      var event = Calendar.Events.insert(resource, calendarId);

      if (plan.exceptions.length) {
        warnings = warnings.concat(patchExceptions_(calendarId, event.id, plan, tz));
      }

      return {
        eventId: event.id,
        eventIds: [event.id],
        eventUrl: event.htmlLink,
        method: plan.method,
        occurrenceCount: plan.dates.length,
        warnings: warnings
      };
    } catch (recurErr) {
      // A single-date insert failing is a real error, not something duplication fixes.
      if (plan.method === 'single') throw recurErr;
      return duplicateEvents_(eventData, plan, calendarId, tz, recurErr.message);
    }
  } catch (e) {
    return { error: 'Failed to create calendar event: ' + e.message };
  }
}

/** Shared resource builder so the recurring and duplicated paths cannot drift. */
function buildEventResource_(eventData, occ, tz) {
  var resource = {
    summary: eventData.title,
    start: { dateTime: occ.date + 'T' + occ.start_time + ':00', timeZone: tz },
    end:   { dateTime: occ.date + 'T' + occ.end_time + ':00', timeZone: tz },
    description: eventData.description || ''
  };
  if (eventData.location) resource.location = eventData.location;
  return resource;
}

/**
 * Attaches a Drive file to a Calendar event using the Advanced Calendar Service.
 * @param {string} eventId  - Calendar API event ID (from Calendar.Events.insert)
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
