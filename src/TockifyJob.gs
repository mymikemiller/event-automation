/**
 * Drains the Tockify update queue — image, tag, or both. Installed as a
 * 5-minute time-driven trigger. Jobs whose event has not appeared in Tockify
 * within TOCKIFY_GIVE_UP_MS are dropped with an email. Tockify syncs from
 * Google within seconds, so that window is pure safety margin.
 */
function processTockifyQueue_() {
  var jobs = tockifyQueueLoad_();
  if (!jobs.length) return;

  // tockifyLogin_ and the session probe both call UrlFetchApp.fetch bare, so a
  // DNS/TLS/timeout failure throws rather than returning {error}. That aborts
  // before the loop, which is harmless for the queue — nothing has been
  // dequeued and tockifyQueueSave_ was never going to run — but it would be the
  // one path in this file that fails an unattended trigger silently. Failures
  // here are loud by design, so mirror the login.error branch. Safe to notify
  // from here because tockifyNotify_ swallows its own send failures.
  var login;
  try {
    login = tockifySession_();
  } catch (e) {
    tockifyNotify_('Tockify login failed', 'unhandled exception: ' + e.message);
    return; // leave the queue intact; next run tries again
  }
  if (login.error) {
    tockifyNotify_('Tockify login failed', login.error);
    return; // leave the queue intact; next run tries again
  }

  var now = Date.now();
  var remaining = [];

  for (var i = 0; i < jobs.length; i++) {
    var job = jobs[i];

    // tockifyQueueSave_ runs AFTER the loop, so a throw that escapes here never
    // rewrites the queue: the whole batch stays pending, including the jobs that
    // already succeeded this run, which then re-upload to Uploadcare and
    // re-register an image set on the next tick. job.tries never increments, so
    // tockifyShouldGiveUp_ is never consulted and the loop repeats every five
    // minutes forever, silently. UrlFetchApp.fetch throws on DNS/TLS/timeout
    // (muteHttpExceptions only suppresses error STATUSES) and the poll loop in
    // tockifyUploadImage_ parses JSON unguarded, so this is reachable. Route it
    // into the same path as an {error} result: notify once, then dequeue.
    var result;
    try {
      result = tockifyApplyJob_(login.cookie, job);
    } catch (e) {
      result = { error: 'unhandled exception: ' + e.message };
    }

    if (result.success) {
      // Dequeue either way — the work that could be done was done. The email
      // exists so a skipped tag is never silent.
      if (result.warning) {
        tockifyNotify_(
          'Tockify tag skipped: ' + job.title,
          result.warning +
          '\n\nEvent link: ' + (job.sourceUrl || '(none)') +
          '\n\nIf this event is hosted by Austin Vegan Association, add the ' +
          AVA_TOCKIFY_TAG + ' tag by hand.'
        );
      }
      continue; // done — drop from the queue
    }

    if (result.notFound && !tockifyShouldGiveUp_(job, now)) {
      job.tries++;
      remaining.push(job); // not synced yet, try again next run
      continue;
    }

    tockifyNotify_(
      'Tockify update failed: ' + job.title,
      (result.error || 'event never appeared in Tockify') +
      (job.imageUrl ? '\n\nImage: ' + job.imageUrl : '') +
      '\nEvent link: ' + (job.sourceUrl || '(none)') +
      '\nTries: ' + job.tries
    );
  }

  tockifyQueueSave_(remaining);
}

/**
 * Runs one job end to end: image, tag, or both.
 *
 * A failure to identify the host group is a `warning`, not an `error` — the
 * image is still worth applying, and holding it hostage to a shortener being
 * down helps nobody. The caller emails the warning and dequeues.
 *
 * @param {string} cookie
 * @param {Object} job
 * @returns {{success: true, warning: string=}|{notFound: true}|{error: string}}
 */
function tockifyApplyJob_(cookie, job) {
  var found = tockifyFindEvent_(cookie, job.title, job.startMillis);
  if (found.notFound) return { notFound: true };
  if (found.error) return { error: found.error };

  var changes = {};

  if (job.imageUrl) {
    var up = tockifyUploadImage_(job.imageUrl);
    if (up.error) return { error: up.error };

    var reg = tockifyRegisterImage_(cookie, up.uuid, tockifyImageName_(job.imageUrl));
    if (reg.error) return { error: reg.error };

    changes.imageSetId = reg.imageSetId;
  }

  // Resolved here, not at submit time: this is the retryable context, and the
  // event has already been found, so the lookup happens once rather than on
  // every 5-minute poll while Tockify catches up.
  var warning = null;
  var ava = tockifyIsAvaEvent_(job.sourceUrl);
  if (ava.error) warning = 'Could not determine the host group: ' + ava.error;
  else if (ava.isAva) changes.addTag = AVA_TOCKIFY_TAG;

  if (!changes.imageSetId && !changes.addTag) return { success: true, warning: warning };

  var upd = tockifyUpdateEventGroup_(cookie, found.uid, changes);
  if (upd.error) return { error: upd.error };

  return { success: true, warning: warning };
}

/**
 * Emails the script owner. Failures here are loud on purpose — these endpoints
 * are undocumented and can change without notice.
 *
 * Sending is guarded because this is called from inside the queue loop, and
 * MailApp.sendEmail throws once the daily quota is exhausted. That throw would
 * escape the per-job try/catch — which wraps only tockifyApplyJob_ — and abort
 * the run before tockifyQueueSave_, wedging the queue in exactly the way that
 * catch exists to prevent: completed jobs re-uploading every five minutes with
 * no give-up. One lost notice, logged, beats a permanently stuck queue.
 *
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
  try {
    MailApp.sendEmail(to, '[Event Automation] ' + subject, body);
  } catch (e) {
    Logger.log('Tockify notify failed (' + e.message + '): ' + subject + ' — ' + body);
  }
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
