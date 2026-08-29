/**
 * Hourly watch on the Meetup groups in MEETUP_GROUPS. Emails MEETUP_NOTIFY_EMAIL
 * when a group has published an event that is not yet on the Google Calendar.
 *
 * Meetup has no usable "new event" notification, and events reach the calendar
 * by hand through the web app, so without this a new post can sit unnoticed for
 * days.
 */

var MEETUP_NOTIFIED_KEY = 'MEETUP_NOTIFIED_IDS';
var MEETUP_ERROR_STAMP_KEY = 'MEETUP_ERROR_LAST_SENT';
var MEETUP_ERROR_THROTTLE_MS = 24 * 60 * 60 * 1000;

/**
 * Trigger entry point. Installed hourly by installMeetupTrigger().
 */
function checkMeetupForNewEvents() {
  meetupRun_(false);
}

/**
 * Dry run: reports what would be emailed without sending anything and without
 * touching stored state. Run this from the editor before installing the
 * trigger — it is how "the first run stays silent" gets verified rather than
 * assumed.
 * @returns {string} The same summary written to the log.
 */
function previewMeetupCheck() {
  var summary = meetupRun_(true);
  Logger.log(summary);
  return summary;
}

/**
 * One pass over every configured group.
 * @param {boolean} dryRun - When true, send no mail and persist no state.
 * @returns {string} Human-readable summary.
 */
function meetupRun_(dryRun) {
  var lines = [];
  var allEvents = [];
  var seenBySlug = {};
  var failedSlugs = [];

  // 1. Fetch every group. A group that fails is recorded, not fatal — another
  //    group's events should still be reported.
  for (var i = 0; i < MEETUP_GROUPS.length; i++) {
    var slug = MEETUP_GROUPS[i];
    var result = meetupFetchGroupEvents_(slug);

    if (result.error) {
      failedSlugs.push(slug);
      lines.push('ERROR ' + slug + ': ' + result.error);
      if (!dryRun) meetupNotifyError_('feed:' + slug, result.error);
      continue;
    }

    seenBySlug[slug] = {};
    for (var j = 0; j < result.events.length; j++) {
      var ev = result.events[j];
      ev.slug = slug;
      allEvents.push(ev);
      seenBySlug[slug][ev.id] = true;
    }
    lines.push(slug + ': ' + result.events.length + ' upcoming event(s) in the feed');
  }

  if (!allEvents.length) {
    // Nothing fetched successfully, or genuinely no upcoming events. Either way
    // there is nothing to compare and pruning here would be destructive.
    lines.push('No events to check; leaving stored state untouched.');
    return lines.join('\n');
  }

  // 2. Read the calendar across the span the feed covers.
  var calEntries;
  try {
    calEntries = meetupLoadCalendarEntries_(allEvents);
  } catch (e) {
    var msg = 'could not read the calendar: ' + e.message;
    lines.push('ERROR ' + msg);
    if (!dryRun) meetupNotifyError_('calendar', msg);
    return lines.join('\n'); // newness is undecidable — email nothing, prune nothing
  }
  lines.push('calendar: ' + calEntries.length + ' event(s) in range');

  // 3. Decide, and notify.
  var notified = meetupNotifiedLoad_();
  var newCount = 0;

  for (var k = 0; k < allEvents.length; k++) {
    var event = allEvents[k];

    if (notified[event.id]) continue;
    if (meetupIsOnCalendar_(event, calEntries, meetupFormatLocal_)) continue;

    newCount++;
    lines.push('NEW  ' + event.title + '  ' + event.url);

    if (dryRun) continue;

    // Record only after the send succeeds; marking first would let a transient
    // mail failure suppress this event permanently.
    if (meetupSendNewEventEmail_(event)) {
      notified[event.id] = event.slug;
    }
  }

  if (!newCount) lines.push('No new events.');

  // 4. Prune, then save. Meetup never reuses event IDs, so once an event drops
  //    out of the upcoming feed its ID is dead weight. Only groups that fetched
  //    successfully are pruned — otherwise one Meetup outage would wipe the set
  //    and the next good run would re-email everything.
  if (!dryRun) {
    meetupNotifiedSave_(meetupPruneNotified_(notified, seenBySlug, failedSlugs));
  }

  return lines.join('\n');
}

/**
 * Loads calendar events spanning the feed, reduced to what matching needs.
 *
 * The window is padded by a day on each side so it does not depend on timezone
 * arithmetic — it only has to be wide enough to contain the candidates.
 *
 * @param {Array<Object>} meetupEvents
 * @returns {Array<{meetupIds: Array<string>, title: string, start: Date}>}
 */
function meetupLoadCalendarEntries_(meetupEvents) {
  var DAY = 24 * 60 * 60 * 1000;
  var latest = 0;
  meetupEvents.forEach(function (e) {
    var t = meetupApproxInstant_(e.startLocal);
    if (t > latest) latest = t;
  });

  var calendarId = PropertiesService.getScriptProperties().getProperty('CALENDAR_ID');
  if (!calendarId) throw new Error('CALENDAR_ID script property is not set');

  var events = CalendarApp.getCalendarById(calendarId)
    .getEvents(new Date(Date.now() - DAY), new Date(latest + 2 * DAY));

  return events.map(function (e) {
    var desc = '';
    try { desc = e.getDescription() || ''; } catch (err) { desc = ''; }
    return {
      meetupIds: meetupIdsInText_(desc),
      title: e.getTitle(),
      start: e.getStartTime()
    };
  });
}

/**
 * The Apps Script half of the comparison injected into meetupIsOnCalendar_.
 * @param {Date} date
 * @param {string} tzid
 * @returns {string} 'yyyyMMddTHHmmss' in tzid
 */
function meetupFormatLocal_(date, tzid) {
  return Utilities.formatDate(date, tzid, "yyyyMMdd'T'HHmmss");
}

/**
 * Sends one "new event" email.
 * @param {Object} event
 * @returns {boolean} true when the send succeeded
 */
function meetupSendNewEventEmail_(event) {
  var when = Utilities.formatDate(
    new Date(meetupApproxInstant_(event.startLocal)), 'UTC', 'EEEE, MMMM d, yyyy'
  ) + ' at ' + meetupPrettyTime_(event.startLocal);

  var body =
    event.title + '\n' +
    when + '\n\n' +
    event.url + '\n\n' +
    'This is on meetup.com/' + event.slug + ' but not yet on the calendar.\n' +
    'Add it here: ' + meetupWebAppLink_(event.url) + '\n';

  try {
    MailApp.sendEmail(MEETUP_NOTIFY_EMAIL, '[Event Automation] New Meetup event: ' + event.title, body);
    return true;
  } catch (e) {
    Logger.log('Meetup email failed for ' + event.id + ': ' + e.message);
    return false;
  }
}

/**
 * Emails about a broken run, at most once per 24h per key.
 *
 * Loud on purpose: if Meetup moves the feed URL, a job that only logged would
 * leave months of events unannounced while looking healthy. Throttled so a
 * sustained outage costs one email a day rather than twenty-four.
 *
 * @param {string} key - distinguishes error sources, e.g. 'feed:vegaustin'
 * @param {string} message
 */
function meetupNotifyError_(key, message) {
  var props = PropertiesService.getScriptProperties();
  var stamps = {};
  try { stamps = JSON.parse(props.getProperty(MEETUP_ERROR_STAMP_KEY) || '{}'); } catch (e) { stamps = {}; }

  var now = Date.now();
  if (stamps[key] && now - stamps[key] < MEETUP_ERROR_THROTTLE_MS) return;

  try {
    MailApp.sendEmail(
      MEETUP_NOTIFY_EMAIL,
      '[Event Automation] Meetup check failed',
      'The hourly Meetup check could not complete.\n\n' + message +
      '\n\nNo new-event emails can be sent until this is fixed. ' +
      'This notice repeats at most once a day.\n'
    );
    stamps[key] = now;
    props.setProperty(MEETUP_ERROR_STAMP_KEY, JSON.stringify(stamps));
  } catch (e) {
    Logger.log('Meetup error notice failed: ' + e.message);
  }
}

/**
 * Reads the notified-ID map.
 * @returns {Object} id -> slug
 */
function meetupNotifiedLoad_() {
  var raw = PropertiesService.getScriptProperties().getProperty(MEETUP_NOTIFIED_KEY);
  if (!raw) return {};
  try { return JSON.parse(raw); } catch (e) { return {}; }
}

/**
 * Writes the notified-ID map.
 * @param {Object} map - id -> slug
 */
function meetupNotifiedSave_(map) {
  PropertiesService.getScriptProperties()
    .setProperty(MEETUP_NOTIFIED_KEY, JSON.stringify(map));
}

/**
 * Installs the hourly trigger. Run once from the editor, as the account that
 * owns the script. Safe to re-run — it removes any existing trigger for this
 * handler first.
 */
function installMeetupTrigger() {
  var existing = ScriptApp.getProjectTriggers();
  for (var i = 0; i < existing.length; i++) {
    if (existing[i].getHandlerFunction() === 'checkMeetupForNewEvents') {
      ScriptApp.deleteTrigger(existing[i]);
    }
  }
  ScriptApp.newTrigger('checkMeetupForNewEvents').timeBased().everyHours(1).create();
  Logger.log('Meetup hourly trigger installed');
}
