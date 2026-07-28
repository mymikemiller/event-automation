/**
 * Drains the Tockify image queue. Installed as a 5-minute time-driven trigger.
 * Jobs whose event has not appeared in Tockify within TOCKIFY_GIVE_UP_MS are
 * dropped with an email. Tockify syncs from Google within seconds, so that
 * window is pure safety margin.
 */
function processTockifyQueue_() {
  var jobs = tockifyQueueLoad_();
  if (!jobs.length) return;

  var login = tockifySession_();
  if (login.error) {
    tockifyNotify_('Tockify login failed', login.error);
    return; // leave the queue intact; next run tries again
  }

  var now = Date.now();
  var remaining = [];

  for (var i = 0; i < jobs.length; i++) {
    var job = jobs[i];
    var result = tockifyApplyImage_(login.cookie, job);

    if (result.success) continue; // done — drop from the queue

    if (result.notFound && !tockifyShouldGiveUp_(job, now)) {
      job.tries++;
      remaining.push(job); // not synced yet, try again next run
      continue;
    }

    tockifyNotify_(
      'Tockify image not set: ' + job.title,
      (result.error || 'event never appeared in Tockify') +
      '\n\nImage: ' + job.imageUrl +
      '\nTries: ' + job.tries
    );
  }

  tockifyQueueSave_(remaining);
}

/**
 * Runs one job end to end.
 * @param {string} cookie
 * @param {Object} job
 * @returns {{success: true}|{notFound: true}|{error: string}}
 */
function tockifyApplyImage_(cookie, job) {
  var found = tockifyFindEvent_(cookie, job.title, job.startMillis);
  if (found.notFound) return { notFound: true };
  if (found.error) return { error: found.error };

  var up = tockifyUploadImage_(job.imageUrl);
  if (up.error) return { error: up.error };

  var reg = tockifyRegisterImage_(cookie, up.uuid, tockifyImageName_(job.imageUrl));
  if (reg.error) return { error: reg.error };

  return tockifySetEventImage_(cookie, found.uid, reg.imageSetId);
}

/**
 * Emails the script owner. Failures here are loud on purpose — these endpoints
 * are undocumented and can change without notice.
 * @param {string} subject
 * @param {string} body
 */
function tockifyNotify_(subject, body) {
  // getActiveUser() returns "" in a time-driven trigger, which would send the
  // failure notice nowhere. getEffectiveUser() is the script owner either way.
  var to = Session.getEffectiveUser().getEmail();
  if (!to) {
    Logger.log('Tockify notify failed, no recipient: ' + subject + ' — ' + body);
    return;
  }
  MailApp.sendEmail(to, '[Event Automation] ' + subject, body);
}

/**
 * Installs the 5-minute trigger. Run once from the editor. Safe to re-run —
 * it removes any existing trigger for this handler first.
 */
function installTockifyTrigger() {
  var existing = ScriptApp.getProjectTriggers();
  for (var i = 0; i < existing.length; i++) {
    if (existing[i].getHandlerFunction() === 'processTockifyQueue_') {
      ScriptApp.deleteTrigger(existing[i]);
    }
  }
  ScriptApp.newTrigger('processTockifyQueue_').timeBased().everyMinutes(5).create();
  Logger.log('Tockify trigger installed');
}
