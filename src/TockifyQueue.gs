/**
 * Reads the pending job queue.
 * @returns {Array<Object>}
 */
function tockifyQueueLoad_() {
  var raw = PropertiesService.getScriptProperties().getProperty(TOCKIFY_QUEUE_KEY);
  if (!raw) return [];
  try { return JSON.parse(raw); } catch (e) { return []; }
}

/**
 * Writes the pending job queue.
 * @param {Array<Object>} jobs
 */
function tockifyQueueSave_(jobs) {
  PropertiesService.getScriptProperties()
    .setProperty(TOCKIFY_QUEUE_KEY, JSON.stringify(jobs));
}

/**
 * Adds a job. One job per event, including multi-date events — a repeating
 * event syncs to Tockify as a single record, so there is one image to set.
 *
 * `sourceUrl` is the link the submitter pasted; the job reads it to decide
 * whether the AVA tag applies. Jobs queued before that field existed have it
 * undefined, which classifies as 'no' and drains them as image-only.
 *
 * @param {string} title
 * @param {number} startMillis
 * @param {string} imageUrl - may be empty for a tag-only job
 * @param {string} sourceUrl
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
