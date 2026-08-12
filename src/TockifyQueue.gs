/**
 * Reads the pending job queue.
 *
 * TOCKIFY_QUEUE_KEY is the string 'TOCKIFY_IMAGE_QUEUE', which is now a
 * misnomer — jobs carry a tag as well as an image, and a tag-only job has no
 * image at all. Do NOT rename it. The live queue is stored under that exact
 * string, so changing it orphans every job already pending: they would never be
 * read again, never drained, and never reported.
 *
 * @returns {Array<Object>}
 */
function tockifyQueueLoad_() {
  var raw = PropertiesService.getScriptProperties().getProperty(TOCKIFY_QUEUE_KEY);
  if (!raw) return [];
  try { return JSON.parse(raw); } catch (e) { return []; }
}

/**
 * Writes the pending job queue.
 *
 * The whole queue is one JSON string in one script property, and a property
 * value is capped at 9KB — the same limit meetupPruneNotified_ (MeetupService.gs)
 * exists to stay under. A job runs roughly 336 bytes with a canonical Meetup
 * source URL and up to ~475 with a heavily tracked ls/click one, so between
 * about 19 and 27 jobs fit. Past that setProperty throws 'Argument too large:
 * value' and the job is not stored; submitEvent catches that and warns rather
 * than failing a submission whose calendar event is already created.
 *
 * Nothing prunes this queue, and it is not reliably self-draining. Jobs are
 * dropped on success and abandoned after TOCKIFY_GIVE_UP_MS, but
 * tockifyShouldGiveUp_ is consulted ONLY on the notFound branch, and
 * processTockifyQueue_ returns before the loop when the Tockify login fails —
 * deliberately, to keep the queue intact. So during a sustained login outage
 * nothing dequeues at all, the give-up clock never runs, and the queue only
 * grows. The ceiling is far above what a hand-driven submission tool reaches in
 * a day, which is why there is no pruning here, but it is a real ceiling and it
 * does not correct itself.
 *
 * @param {Array<Object>} jobs
 */
function tockifyQueueSave_(jobs) {
  PropertiesService.getScriptProperties()
    .setProperty(TOCKIFY_QUEUE_KEY, JSON.stringify(jobs));
}

/**
 * Adds a job. One job per event, including multi-date events — a repeating
 * event syncs to Tockify as a single record, so there is one image to set and
 * one tag to apply.
 *
 * `sourceUrl` is the link the submitter pasted; the job reads it to decide
 * whether the AVA tag applies. Jobs queued before that field existed have it
 * undefined, which classifies as 'no' and drains them as image-only.
 *
 * @param {string} title
 * @param {number} startMillis
 * @param {string} imageUrl - may be empty for a tag-only job
 * @param {string} sourceUrl - may be empty; an absent link classifies as 'no',
 *   so the job applies the image only and never reaches the network
 */
function tockifyQueueAdd_(title, startMillis, imageUrl, sourceUrl) {
  var jobs = tockifyQueueLoad_();
  jobs.push({
    title: title,
    startMillis: startMillis,
    imageUrl: imageUrl || '',
    sourceUrl: sourceUrl || '',
    tries: 0,
    firstSeen: Date.now()
  });
  tockifyQueueSave_(jobs);
}
