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

function test_createRecurringEvent_live() {
  var result = createCalendarEvent({
    title: '[TEST] Recurring Series',
    occurrences: [
      { date: '2026-08-10', start_time: '19:00', end_time: '20:00' },
      { date: '2026-08-17', start_time: '19:00', end_time: '20:00' },
      { date: '2026-08-24', start_time: '19:00', end_time: '20:00' },
      { date: '2026-08-31', start_time: '19:00', end_time: '20:00' }
    ],
    location: '', description: 'Live recurrence test.'
  });
  if (result.error) throw new Error(result.error);

  var calendarId = PropertiesService.getScriptProperties().getProperty('CALENDAR_ID');
  try {
    if (result.method !== 'rrule') throw new Error('expected rrule, got ' + result.method);

    var items = Calendar.Events.instances(calendarId, result.eventId, {
      timeMin: '2026-08-01T00:00:00Z', timeMax: '2026-09-30T23:59:59Z'
    }).items;
    if (items.length !== 4) throw new Error('expected exactly 4 instances, got ' + items.length);

    var got = items.map(function (i) { return i.start.dateTime.slice(0, 10); }).join(',');
    if (got !== '2026-08-10,2026-08-17,2026-08-24,2026-08-31') {
      throw new Error('wrong instance dates: ' + got);
    }
  } finally {
    Calendar.Events.remove(calendarId, result.eventId);
  }
  Logger.log('test_createRecurringEvent_live: ALL PASSED');
}

function test_createRecurringWithException_live() {
  var result = createCalendarEvent({
    title: '[TEST] Recurring With Exception',
    occurrences: [
      { date: '2026-08-10', start_time: '19:00', end_time: '20:00' },
      { date: '2026-08-17', start_time: '19:00', end_time: '20:00' },
      { date: '2026-08-24', start_time: '18:00', end_time: '20:00' }
    ],
    location: '', description: 'Live exception test.'
  });
  if (result.error) throw new Error(result.error);

  var calendarId = PropertiesService.getScriptProperties().getProperty('CALENDAR_ID');
  try {
    if (result.warnings.length) throw new Error('unexpected warnings: ' + result.warnings.join('; '));

    var items = Calendar.Events.instances(calendarId, result.eventId, {
      timeMin: '2026-08-01T00:00:00Z', timeMax: '2026-09-30T23:59:59Z'
    }).items;
    var odd = null;
    for (var i = 0; i < items.length; i++) {
      if (items[i].start.dateTime.indexOf('2026-08-24') === 0) { odd = items[i]; break; }
    }
    if (!odd) throw new Error('could not find the Aug 24 instance');
    if (odd.start.dateTime.indexOf('T18:00') < 0) {
      throw new Error('Aug 24 should start at 18:00, got ' + odd.start.dateTime);
    }
  } finally {
    Calendar.Events.remove(calendarId, result.eventId);
  }
  Logger.log('test_createRecurringWithException_live: ALL PASSED');
}

function test_createIrregularSeries_live() {
  // The RDATE path — the one Google's UI handles least conventionally, so it
  // is worth proving the instances actually materialize on the right dates.
  var result = createCalendarEvent({
    title: '[TEST] Irregular Series',
    occurrences: [
      { date: '2026-08-10', start_time: '19:00', end_time: '20:00' },
      { date: '2026-08-17', start_time: '19:00', end_time: '20:00' },
      { date: '2026-09-03', start_time: '19:00', end_time: '20:00' },
      { date: '2026-09-20', start_time: '19:00', end_time: '20:00' }
    ],
    location: '', description: 'Live RDATE test.'
  });
  if (result.error) throw new Error(result.error);

  var calendarId = PropertiesService.getScriptProperties().getProperty('CALENDAR_ID');
  try {
    if (result.method !== 'rdate') throw new Error('expected rdate, got ' + result.method);

    var items = Calendar.Events.instances(calendarId, result.eventId, {
      timeMin: '2026-08-01T00:00:00Z', timeMax: '2026-10-31T23:59:59Z'
    }).items;
    var got = items.map(function (i) { return i.start.dateTime.slice(0, 10); }).join(',');
    if (got !== '2026-08-10,2026-08-17,2026-09-03,2026-09-20') {
      throw new Error('wrong RDATE instance dates: ' + got);
    }
  } finally {
    Calendar.Events.remove(calendarId, result.eventId);
  }
  Logger.log('test_createIrregularSeries_live: ALL PASSED');
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

/**
 * Applies per-date time overrides to individual instances of a recurring event.
 *
 * Instances are matched on the DATE portion of originalStartTime, because the
 * series was created at the modal time and each exception's real time differs.
 * A failure here is a warning, not an abort: the series already exists and is
 * correct apart from that one instance.
 * @returns {Array<string>} warnings
 */
function patchExceptions_(calendarId, eventId, plan, tz) {
  var warnings = [];

  // The query bounds are absolute instants (Z), but our dates are LOCAL calendar
  // dates. A 7pm event in Chicago starts at 00:00 UTC the NEXT day, so a window
  // ending at <last>T23:59:59Z silently excludes the final occurrence. Pad by a
  // day on each side — 24h exceeds the largest UTC offset in use (±14h) — and
  // let the date-prefix match below do the real selecting.
  var first = ymd_(dateUtc_(plan.dates[0].date) - 86400000);
  var last = ymd_(dateUtc_(plan.dates[plan.dates.length - 1].date) + 86400000);

  var instances;
  try {
    instances = Calendar.Events.instances(calendarId, eventId, {
      timeMin: first + 'T00:00:00Z',
      timeMax: last + 'T23:59:59Z',
      maxResults: 250
    }).items || [];
  } catch (e) {
    return ['Could not load event instances to adjust differing times: ' + e.message];
  }

  plan.exceptions.forEach(function (ex) {
    var match = null;
    for (var i = 0; i < instances.length; i++) {
      var ost = instances[i].originalStartTime || instances[i].start || {};
      var stamp = ost.dateTime || ost.date || '';
      if (stamp.indexOf(ex.date) === 0) { match = instances[i]; break; }
    }
    if (!match) {
      warnings.push('Could not find the ' + ex.date + ' occurrence to set its time.');
      return;
    }
    try {
      Calendar.Events.patch({
        start: { dateTime: ex.date + 'T' + ex.start_time + ':00', timeZone: tz },
        end:   { dateTime: ex.date + 'T' + ex.end_time + ':00', timeZone: tz }
      }, calendarId, match.id);
    } catch (e) {
      warnings.push('Could not set the time for ' + ex.date + ': ' + e.message);
    }
  });

  return warnings;
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
 * Last-resort path: create one standalone event per date. Only reached when a
 * recurring insert throws, never chosen by design.
 */
function duplicateEvents_(eventData, plan, calendarId, tz, reason) {
  var ids = [];
  var url = null;
  // Deliberately does not state a count — a per-date insert can still fail
  // below, and occurrenceCount carries the number actually created.
  var warnings = ['Could not create a repeating event (' + reason +
                  '), so separate events were created for each date instead.'];

  plan.dates.forEach(function (occ) {
    try {
      var ev = Calendar.Events.insert(buildEventResource_(eventData, occ, tz), calendarId);
      ids.push(ev.id);
      if (!url) url = ev.htmlLink;
    } catch (e) {
      warnings.push('Could not create the ' + occ.date + ' event: ' + e.message);
    }
  });

  if (!ids.length) return { error: 'Failed to create calendar events: ' + reason };

  return {
    eventId: ids[0],
    eventIds: ids,
    eventUrl: url,
    method: 'duplicate',
    occurrenceCount: ids.length,
    warnings: warnings
  };
}

/**
 * Attaches a Drive file to one or more Calendar events.
 *
 * A recurring master needs a single call and every instance inherits the
 * attachment; the duplicate fallback needs one call per event.
 * @param {Array<string>|string} eventIds - Calendar API event ID(s)
 * @param {string} fileId   - Drive file ID
 * @param {string} fileName - Display name for the attachment
 * @returns {{success: boolean}|{error: string}}
 */
function attachFileToCalendarEvent(eventIds, fileId, fileName) {
  try {
    var calendarId = PropertiesService.getScriptProperties().getProperty('CALENDAR_ID');
    var file = DriveApp.getFileById(fileId);
    var ids = [].concat(eventIds);

    ids.forEach(function (id) {
      Calendar.Events.patch(
        {
          attachments: [{
            fileUrl: 'https://drive.google.com/open?id=' + fileId,
            mimeType: file.getMimeType(),
            title: fileName
          }]
        },
        calendarId,
        id,
        { supportsAttachments: true }
      );
    });
    return { success: true };
  } catch (e) {
    return { error: 'Could not attach image to calendar event: ' + e.message };
  }
}

/**
 * Returns the dates that already hold an event with this title, so the result
 * screen can say "2 of 4 dates already had this event" instead of just "yes".
 * @param {string} title
 * @param {Array<string>} dates - YYYY-MM-DD
 * @returns {Array<string>} colliding dates
 */
function findDuplicateDates(title, dates) {
  var hits = [];
  try {
    var calendarId = PropertiesService.getScriptProperties().getProperty('CALENDAR_ID');
    var cal = CalendarApp.getCalendarById(calendarId);
    var lowerTitle = title.toLowerCase();
    dates.forEach(function (d) {
      var events = cal.getEvents(new Date(d + 'T00:00:00'), new Date(d + 'T23:59:59'));
      var clash = events.some(function (e) {
        return e.getTitle().toLowerCase() === lowerTitle;
      });
      if (clash) hits.push(d);
    });
  } catch (e) {
    return hits; // Don't block on duplicate check failure
  }
  return hits;
}

/**
 * Checks if an event with the same title already exists on the given date.
 * @param {string} title
 * @param {string} date - YYYY-MM-DD
 * @returns {boolean}
 */
function isDuplicateEvent(title, date) {
  return findDuplicateDates(title, [date]).length > 0;
}
