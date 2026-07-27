function test_utilities() {
  const cases = [
    { input: ['Hello World!', '2026-04-15'], expected: '2026-04-15_Hello-World' },
    { input: ['Café & Co.', '2026-01-01'], expected: '2026-01-01_Cafe-Co' },
    { input: ['  Spaces  ', '2026-06-30'], expected: '2026-06-30_Spaces' },
  ];

  cases.forEach(({ input, expected }) => {
    const result = buildFilename(input[0], input[1]);
    if (result !== expected) {
      throw new Error(`buildFilename('${input[0]}', '${input[1]}') → '${result}', expected '${expected}'`);
    }
  });

  Logger.log('test_utilities: ALL PASSED');
}

/**
 * Builds a Drive filename: YYYY-MM-DD_Slugified-Title
 * @param {string} title - Event title
 * @param {string} date  - ISO date string YYYY-MM-DD
 * @returns {string}
 */
function buildFilename(title, date) {
  return date + '_' + slugify(title);
}

/**
 * Converts a string to a URL-safe slug (hyphens, no special chars).
 * Handles basic accented characters.
 * @param {string} text
 * @returns {string}
 */
function slugify(text) {
  return text
    .normalize('NFD')                     // decompose accented chars
    .replace(/[\u0300-\u036f]/g, '')      // strip accent marks
    .replace(/[^a-zA-Z0-9\s-]/g, '')     // remove special chars
    .trim()
    .replace(/\s+/g, '-');               // spaces to hyphens
}

/**
 * Adds hours to an HH:MM string, wrapping past midnight.
 * @param {string} timeStr - HH:MM
 * @param {number} hours
 * @returns {string} HH:MM
 */
function addHours_(timeStr, hours) {
  var parts = timeStr.split(':');
  var totalMinutes = parseInt(parts[0], 10) * 60 + parseInt(parts[1], 10) + hours * 60;
  var h = Math.floor(totalMinutes / 60) % 24;
  var m = totalMinutes % 60;
  return (h < 10 ? '0' : '') + h + ':' + (m < 10 ? '0' : '') + m;
}
