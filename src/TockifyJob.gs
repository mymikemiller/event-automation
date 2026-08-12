/**
 * Drains the Tockify update queue — image, tag, or both. Installed as a
 * 5-minute time-driven trigger.
 *
 * A job leaves the queue three ways: it succeeds, it comes back {error}, or its
 * event never appeared within TOCKIFY_GIVE_UP_MS. The last two are emailed and
 * dropped. Only "not synced yet" is retried — Tockify syncs from Google within
 * seconds, so that window is pure safety margin.
 *
 * Dropping on {error} is not a policy invented for exceptions: every {error}
 * result has always been emailed and dequeued here. The per-job try/catch below
 * converts a thrown failure into an {error} so it follows the policy that
 * already exists rather than escaping it. What that costs is real and worth
 * naming: a transient Tockify 500 on the PUT drops the job with no retry, and
 * redoing it means re-submitting the event.
 *
 * The catch is needed because tockifyQueueSave_ runs AFTER the loop, so a throw
 * that escapes never rewrites the queue: the whole batch stays pending —
 * including jobs that already succeeded this run, which then re-upload to
 * Uploadcare and re-register an image set on the next tick — while job.tries
 * never increments, tockifyShouldGiveUp_ is never consulted, and no email goes
 * out. UrlFetchApp.fetch throws on DNS/TLS/timeout (muteHttpExceptions
 * suppresses error STATUSES only) and tockifyUploadImage_ parses JSON unguarded
 * in its poll loop, so this is reachable. It wraps the per-job call rather than
 * tockifyQueueSave_ deliberately: a bare finally around the save would drop the
 * throwing job with no email at all, which is worse.
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
    tockifyNotify_('Tockify login failed', 'unhandled exception: ' + tockifyErrorText_(e));
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

    // Routed into the same path as an {error} result — see the note above.
    // "aborted:" is not decoration: this error is built out here, outside the
    // problem list tockifyApplyJob_ collects, so without the prefix the email
    // carries no stage lines and reads under that function's documented rule as
    // "every stage worked" when the job in fact stopped mid-flight.
    var result;
    try {
      result = tockifyApplyJob_(login.cookie, job);
    } catch (e) {
      result = { error: 'aborted: unhandled exception: ' + tockifyErrorText_(e) };
    }

    if (result.success) continue; // done — drop from the queue

    if (result.notFound && !tockifyShouldGiveUp_(job, now)) {
      job.tries++;
      remaining.push(job); // not synced yet, try again next run
      continue;
    }

    tockifyNotify_(
      'Tockify update failed: ' + job.title,
      (result.error || 'event never appeared in Tockify') +
      // "Image URL:", not "Image:" — the problem list above can carry an
      // "image:" line, and two meanings one shift-key apart in a body someone
      // skims at 7am is how the wrong one gets read.
      (job.imageUrl ? '\n\nImage URL: ' + job.imageUrl : '') +
      '\nEvent link: ' + (job.sourceUrl || '(none)') +
      '\nTries: ' + job.tries
    );
  }

  tockifyQueueSave_(remaining);
}

/**
 * Runs one job end to end: image, tag, or both.
 *
 * Collects problems rather than returning at the first one, because the user's
 * decision was to do the work that can be done and report what could not. That
 * cuts both ways: a dead shortener must not cost a good image its write, and a
 * failed upload must not cost an AVA event its tag. Every stage that can still
 * run, runs, and the caller gets one email naming all of them.
 *
 * The rule the email leans on, in both halves, because half of it is a lie:
 *   - an `image:`, `host group:` or `write:` line means that stage failed, and
 *     a stage with no line ran and worked. That is why nothing separately
 *     reports what was applied — absence is the success signal.
 *   - a `find:` or `aborted:` line means the job stopped there, so no stage
 *     after it ran at all and none of them may be assumed either way.
 *
 * The prefixes on the two early exits are what make that vocabulary total. Both
 * of them leave before `problems` is ever collected — a failed lookup here, and
 * a throw caught by the caller — so unprefixed they produce an email carrying
 * no stage lines, which under the first half alone reads as "every stage
 * worked" when in fact none of them ran. The throw path is the sharper of the
 * two: tockifyUploadImage_ parses JSON unguarded in its poll loop, so it is the
 * likeliest way this file fails in anger, and it silently drops a due tag.
 *
 * There is deliberately no warning/error split any more. It never carried
 * behaviour — a warning and an error both emailed and both dequeued — so the
 * only thing it ever chose was the wording of an email. Once two stages can
 * fail independently, one binary cannot describe the outcome (image on and tag
 * unknown; image off and tag on; both off), and the list already does. The
 * remedy that justified the split now travels with the problem needing it.
 *
 * @param {string} cookie
 * @param {Object} job
 * @returns {{success: true}|{notFound: true}|{error: string}}
 */
function tockifyApplyJob_(cookie, job) {
  var found = tockifyFindEvent_(cookie, job.title, job.startMillis);
  if (found.notFound) return { notFound: true };
  if (found.error) return { error: 'find: ' + found.error };

  var problems = [];
  var changes = {};

  if (job.imageUrl) {
    var up = tockifyUploadImage_(job.imageUrl);
    if (up.error) {
      problems.push('image: ' + up.error);
    } else {
      var reg = tockifyRegisterImage_(cookie, up.uuid, tockifyImageName_(job.imageUrl));
      if (reg.error) problems.push('image: ' + reg.error);
      else changes.imageSetId = reg.imageSetId;
    }
  }

  // Resolved here, not at submit time: this is the retryable context, and the
  // event has already been found, so the lookup happens once rather than on
  // every 5-minute poll while Tockify catches up.
  var ava = tockifyIsAvaEvent_(job.sourceUrl);
  if (ava.error) {
    // The remedy rides with the problem, so it reaches whatever prints it
    // without the caller having to know which problem it belongs to.
    problems.push('host group: ' + ava.error +
      ' — if this event is hosted by Austin Vegan Association, add the ' +
      AVA_TOCKIFY_TAG + ' tag by hand');
  } else if (ava.isAva) {
    changes.addTag = AVA_TOCKIFY_TAG;
  }

  // Skip the write when there is nothing to write: tockifyUpdateEventGroup_
  // documents that it applies the fields it is handed, and an empty change set
  // would spend a GET and a PUT to say nothing.
  if (changes.imageSetId || changes.addTag) {
    var upd = tockifyUpdateEventGroup_(cookie, found.uid, changes);
    if (upd.error) problems.push('write: ' + upd.error);
  }

  // Newline-joined, not '; ' — this string is the body of an email a human
  // skims, and two failures run together on one line is how the second is
  // missed.
  if (problems.length) return { error: problems.join('\n') };
  return { success: true };
}

/**
 * Readable text for a caught throw.
 *
 * e.message alone discards e.stack, and the email is the only forensic record
 * an unattended trigger leaves behind — the execution log is gone in days and
 * nobody is watching it live. A non-Error throw (a bare string, a host object)
 * has no .message at all, and rendering it produced "unhandled exception:
 * undefined", an email that says nothing at the moment it matters most.
 *
 * @param {*} e - whatever was thrown; not necessarily an Error
 * @returns {string}
 */
function tockifyErrorText_(e) {
  // null and undefined first: String(undefined) is the truthy "undefined", so
  // an emptiness check never catches them and the email says nothing at the
  // moment it matters most — the case this function exists for.
  if (e === null || e === undefined) return '(' + String(e) + ' thrown)';

  var msg = e.message ? String(e.message) : String(e);
  if (!msg) msg = '(empty ' + (typeof e) + ' thrown)';

  var stack = e.stack ? String(e.stack) : '';
  if (!stack) return msg;

  // A V8 stack already opens with "Error: <message>", so prepending prints the
  // message twice. Guarded rather than assumed: a runtime whose stack omits it
  // still needs it, and this email is the only copy anyone gets.
  return stack.indexOf(msg) === -1 ? msg + '\n' + stack : stack;
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
 * no give-up.
 *
 * What the guard costs is more than one lost notice, and underselling it here
 * would be its own kind of silence. The quota is DAILY: once it is gone, every
 * failure until midnight is emailed nowhere, and each of those jobs is dequeued
 * and gone — the notice was the only record they existed, and all that survives
 * is a Logger line in the execution log. That is still the better trade, and
 * gating on getRemainingDailyQuota() is deliberately NOT done: it would block
 * all image and tag application for the rest of the day to protect the notices
 * of a job that only emails when something has already gone wrong.
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
