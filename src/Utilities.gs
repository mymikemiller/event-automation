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

function test_normalizeDescriptionHtml() {
  // The shape Claude returns for a Meetup event: real tags, pretty-printed with
  // newlines between them. Every one of those newlines used to reach Tockify as
  // an extra break.
  var pretty =
    'Join us Wednesday at Nissi VegMex!<br><br>\n' +
    '\u{1F449} <a href="https://nissivegmex.com/menu">Check out their menu</a><br><br>\n' +
    'How this meetup works:<br><br>\n' +
    '<ul>\n' +
    '<li>We\'ll gather at 6:30 PM.</li>\n' +
    '<li>Please order at the counter.</li>\n' +
    '</ul>\n' +
    'Please RSVP.';

  var got = normalizeDescriptionHtml_(pretty);
  var want =
    'Join us Wednesday at Nissi VegMex!<br><br>' +
    '\u{1F449} <a href="https://nissivegmex.com/menu">Check out their menu</a><br><br>' +
    'How this meetup works:<br><br>' +
    '<ul><li>We\'ll gather at 6:30 PM.</li><li>Please order at the counter.</li></ul>' +
    'Please RSVP.';
  if (got !== want) throw new Error('pretty-printed HTML\n  got:  ' + got + '\n  want: ' + want);

  // Idempotent: re-normalizing the stored description must not shrink it again.
  if (normalizeDescriptionHtml_(got) !== want) throw new Error('not idempotent');

  // A break at a list seam is an empty bullet however it got there.
  var seams = normalizeDescriptionHtml_('<ul><br><li>a</li><br><li>b</li><br></ul>');
  if (seams !== '<ul><li>a</li><li>b</li></ul>') throw new Error('list seams: ' + seams);

  // ...but a break inside an item is the author's own line break.
  var inItem = normalizeDescriptionHtml_('<ul><li>a<br>still a</li></ul>');
  if (inItem !== '<ul><li>a<br>still a</li></ul>') throw new Error('in-item break lost: ' + inItem);

  // Plain text with no tags at all still has to keep its paragraph breaks.
  var plain = normalizeDescriptionHtml_('First para.\n\nSecond para.');
  if (plain !== 'First para.<br><br>Second para.') throw new Error('plain text: ' + plain);

  // Blank lines the author actually typed are theirs — copied verbatim, not
  // tidied. Only the newline riding along with them goes.
  var triple = normalizeDescriptionHtml_('a<br><br><br>\nb');
  if (triple !== 'a<br><br><br>b') throw new Error('author blank lines: ' + triple);

  // Variant break spellings, and no leading/trailing breaks on the result.
  var edges = normalizeDescriptionHtml_('<br />\n  a<BR/>b\n<br>\n');
  if (edges !== 'a<br>b') throw new Error('edges: ' + edges);

  if (normalizeDescriptionHtml_(null) !== '') throw new Error('null should give empty string');

  Logger.log('test_normalizeDescriptionHtml: ALL PASSED');
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

/**
 * Collapses the redundant line breaks in an event description.
 *
 * The description travels as HTML — `<br>` for a break, `<ul>/<li>` for a list.
 * Claude (and a hand edit in the textarea) also pretty-prints it with real
 * newlines between the tags. In HTML a newline is insignificant whitespace, but
 * Tockify's importer renders one as a break anyway, so every `<br>\n` pair
 * arrived on the calendar as two breaks and every newline inside a `<ul>`
 * arrived as an empty bullet:
 *
 *     How this meetup works:      →   How this meetup works:
 *                                     (blank)
 *     (blank)                         (blank)
 *       *                             * We'll gather at 6:30 PM
 *       * We'll gather at 6:30 PM     * Please order at the counter
 *       *
 *       * Please order at the counter
 *
 * So: a newline that sits next to a `<br>` or a list tag is dropped as the
 * duplicate it is, and one between two runs of text becomes the `<br>` it was
 * standing in for. Runs of `<br>` are otherwise left alone — the description is
 * copied verbatim, and a blank line the author wrote is theirs to keep.
 *
 * Called from `submitEvent`, not from extraction: the description sits in a
 * textarea until then, and pretty-printed HTML is far easier to read and edit
 * there. Normalizing last also catches the newlines a hand edit adds.
 *
 * @param {string} html - Description HTML, possibly pretty-printed.
 * @returns {string} The same HTML with one break per intended break.
 */
function normalizeDescriptionHtml_(html) {
  if (!html) return '';

  var LIST_TAG = '</?(?:ul|ol|li)>';

  return String(html)
    .replace(/\r\n?/g, '\n')
    .replace(/<br\s*\/?>/gi, '<br>')
    // A newline beside a break or a list tag says nothing the tag has not.
    .replace(/[ \t]*\n\s*(?=<br>)/g, '')
    .replace(/<br>\s*\n[ \t]*/g, '<br>')
    .replace(new RegExp('[ \\t]*\\n\\s*(?=' + LIST_TAG + ')', 'gi'), '')
    .replace(new RegExp('(' + LIST_TAG + ')\\s*\\n[ \\t]*', 'gi'), '$1')
    // A break at the seam of a list item is an empty bullet, never a blank line.
    .replace(/(<(?:ul|ol)>|<\/li>|<li>)(?:\s*<br>)+/gi, '$1')
    .replace(/(?:<br>\s*)+(<\/(?:ul|ol)>|<\/li>|<li>)/gi, '$1')
    // Whatever newline is left stood in for the break nobody typed.
    .replace(/[ \t]*\n[ \t]*/g, '<br>')
    .replace(/^(?:\s|<br>)+|(?:\s|<br>)+$/g, '');
}
