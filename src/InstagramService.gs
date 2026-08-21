// Reads public Instagram posts without logging in.
//
// The post URL itself is a dead end: a plain fetch gets a JavaScript shell with
// no caption and no image, and a crawler User-Agent gets og: tags whose
// og:image is a square 640x640 crop. The crop cannot be undone by editing the
// URL — the stp= crop specification is covered by the signed oh= token, so a
// rewritten URL is answered with HTTP 403.
//
// The embed endpoint, /p/<shortcode>/embed/captioned/, answers an Apps Script
// fetch with the whole post server-rendered: the full caption, and the
// uncropped original image. That is the door we use.
//
// The "Never miss a post from ..." dialog is a client-side overlay drawn over
// content the server has already sent, so there is nothing to click past here —
// the same shape as Facebook's "See more on Facebook" dialog, and ignorable for
// the same reason.
//
// See docs/plans/2026-08-21-instagram-posts-design.md for the measurements.

// ── Tests ─────────────────────────────────────────────────────────────────────

function test_instagramShortcode() {
  var cases = [
    ['https://www.instagram.com/p/DcHA9syRjX4/', 'DcHA9syRjX4'],
    ['https://www.instagram.com/p/DcHA9syRjX4/?utm_source=ig_web_copy_link&igsi=Mz', 'DcHA9syRjX4'],
    ['http://instagram.com/p/DcHA9syRjX4', 'DcHA9syRjX4'],
    // og:url writes the username into the path.
    ['https://www.instagram.com/midnight.grace.designs.2017/p/DcHA9syRjX4/', 'DcHA9syRjX4'],
    ['https://www.instagram.com/reel/Ab-cD_1234/', 'Ab-cD_1234'],
    ['https://www.instagram.com/reels/Ab-cD_1234/', 'Ab-cD_1234'],
    ['https://www.instagram.com/tv/Ab-cD_1234/', 'Ab-cD_1234'],
    // A shortcode that begins with a path keyword must not be eaten by it.
    ['https://www.instagram.com/p/pAbCdEfGh/', 'pAbCdEfGh'],
    ['https://www.instagram.com/p/tvXyZ12345/', 'tvXyZ12345']
  ];
  cases.forEach(function (c) {
    var got = instagramShortcode_(c[0]);
    if (got !== c[1]) throw new Error(c[0] + ' → ' + got + ', wanted ' + c[1]);
  });

  var notPosts = [
    'https://www.instagram.com/midnight.grace.designs.2017/',
    'https://www.instagram.com/explore/tags/vegan/',
    'https://www.meetup.com/vegaustin/events/12345/',
    'https://myinstagram.com/p/DcHA9syRjX4/',
    ''
  ];
  notPosts.forEach(function (u) {
    if (instagramShortcode_(u) !== null) throw new Error('should not match: ' + u);
  });

  Logger.log('test_instagramShortcode: ALL PASSED');
}

function test_instagramEmbedUrl() {
  // /reels/ is the one spelling Instagram itself 404s on the embed path, and
  // /p/, /reel/ and /tv/ all resolve the same shortcode — so everything is
  // normalised to /p/.
  var want = 'https://www.instagram.com/p/Ab-cD_1234/embed/captioned/';
  if (instagramEmbedUrl_('Ab-cD_1234') !== want) {
    throw new Error('got ' + instagramEmbedUrl_('Ab-cD_1234'));
  }
  Logger.log('test_instagramEmbedUrl: ALL PASSED');
}

function test_igFullImageUrl() {
  var base = 'https://instagram.fxxx-1.fna.fbcdn.net/v/t51.82787-15/777297829_1_2_n.jpg';
  var full = base + '?stp=dst-jpg_e35_tt6&amp;_nc_cat=102&amp;oh=00_AQ&amp;oe=6A8E3A8C';
  var html =
    '<img class="Avatar" src="' + base + '?stp=dst-jpg_s100x100_tt6&amp;oh=00_AV"/>' +
    '<img class="EmbeddedMediaImage" alt="x" src="' + full + '" srcset="' + full + ' 1440w"/>' +
    '<div>' + base + '?stp=c0.213.1440.1440a_dst-jpg_e35_s1080x1080_tt6&amp;oh=00_AW</div>';

  var got = igFullImageUrl_(html);
  var wantDecoded = base + '?stp=dst-jpg_e35_tt6&_nc_cat=102&oh=00_AQ&oe=6A8E3A8C';
  if (got !== wantDecoded) throw new Error('got ' + got);

  // Fallback path: the class name is the fragile part, so if it is gone we pick
  // the one variant that is neither cropped (c<box>a_) nor resized (_s/_pWxH).
  var noClass =
    '<img src="' + base + '?stp=dst-jpg_e35_p1080x1080_tt6&amp;oh=00_AX"/>' +
    '<img src="' + base + '?stp=c0.213.1440.1440a_dst-jpg_e35_s640x640_sh2.08_tt6&amp;oh=00_AY"/>' +
    '<img src="' + full + '"/>';
  if (igFullImageUrl_(noClass) !== wantDecoded) {
    throw new Error('fallback got ' + igFullImageUrl_(noClass));
  }

  // Every candidate cropped or resized → nothing we are willing to return.
  if (igFullImageUrl_('<img src="' + base + '?stp=dst-jpg_s100x100_tt6"/>') !== null) {
    throw new Error('expected null when only crops are present');
  }
  if (igFullImageUrl_('<html>no images</html>') !== null) throw new Error('expected null');

  Logger.log('test_igFullImageUrl: ALL PASSED');
}

function test_igCaptionHtml() {
  var html =
    '<div class="Caption">' +
    '<a class="CaptionUsername" href="https://www.instagram.com/mgd/?utm_source=ig_embed" ' +
    'data-log-event="captionProfileClick" target="_blank">mgd</a><br /><br />' +
    'Join us at the Summer Pop-Up Market ' +
    '<a href="/vegmexnissi/?utm_source=ig_embed">&#064;vegmexnissi</a> Saturday.<br />' +
    '<span class="x">ignored wrapper</span>' +
    '<a href="/explore/tags/vegan/?utm_source=ig_embed">#vegan</a>' +
    '<div class="CaptionComments"><a href="#">View all comments</a></div></div>';

  var caption = igCaptionHtml_(html);

  // The username byline and the comments footer are chrome, not caption.
  if (caption.indexOf('mgd') === 0) throw new Error('username byline survived: ' + caption);
  if (caption.indexOf('View all comments') >= 0) throw new Error('comments footer survived');

  // Relative hrefs would be dead links inside a calendar invite; the tracker
  // would follow the event around forever.
  if (caption.indexOf('href="https://www.instagram.com/vegmexnissi/"') < 0) {
    throw new Error('handle link not absolute: ' + caption);
  }
  if (caption.indexOf('href="https://www.instagram.com/explore/tags/vegan/"') < 0) {
    throw new Error('hashtag link not absolute: ' + caption);
  }
  if (caption.indexOf('utm_source') >= 0) throw new Error('tracker survived: ' + caption);

  // Only <a href> and <br> are allowed through.
  if (caption.indexOf('<span') >= 0) throw new Error('span survived: ' + caption);
  if (caption.indexOf('ignored wrapper') < 0) throw new Error('span text was dropped');
  if (caption.indexOf('<br>') < 0) throw new Error('line breaks were dropped');
  if (caption.indexOf('data-log-event') >= 0) throw new Error('attributes survived');

  if (igCaptionHtml_('<html>no caption here</html>') !== null) throw new Error('expected null');

  Logger.log('test_igCaptionHtml: ALL PASSED');
}

function test_igCaptionText() {
  var text = igCaptionText_('Market <a href="https://www.instagram.com/n/">&#064;n</a><br><br>11:30am &amp; up');
  if (text !== 'Market @n\n\n11:30am & up') throw new Error('got ' + JSON.stringify(text));
  Logger.log('test_igCaptionText: ALL PASSED');
}

function test_igMissingFields() {
  var complete = {
    title: 'Market', date: '2026-08-22', start_time: '11:30',
    end_time: '15:30', location: "Nissi's VegMex"
  };
  if (igMissingFields_(complete).length !== 0) {
    throw new Error('complete post should need nothing: ' + igMissingFields_(complete));
  }

  var partial = {
    title: 'Market', date: null, start_time: '11:30', end_time: '', location: '   '
  };
  var missing = igMissingFields_(partial);
  if (missing.join(',') !== 'date,end_time,location') throw new Error('got ' + missing.join(','));

  // A text pass that failed outright still gets the image its chance.
  if (igMissingFields_(null).length !== 5) throw new Error('null result should want every field');

  Logger.log('test_igMissingFields: ALL PASSED');
}

function test_formatInstagramPostForClaude() {
  var post = { username: 'mgd', captionText: 'Market Saturday', imageUrl: 'https://x.test/a.jpg' };

  // Text pass: guessing is what makes a missing field look present, and a field
  // that looks present never gets the image read.
  var textPass = formatInstagramPostForClaude_(post, 'https://www.instagram.com/p/A1/', []);
  if (textPass.indexOf('Market Saturday') < 0) throw new Error('caption missing');
  if (textPass.indexOf('mgd') < 0) throw new Error('username missing');
  if (textPass.indexOf('https://www.instagram.com/p/A1/') < 0) throw new Error('source url missing');
  if (!/do not guess/i.test(textPass)) throw new Error('text pass must forbid guessing');
  if (/attached as an image/i.test(textPass)) throw new Error('text pass has no image');

  // Image pass: name the gaps, and say which source wins a disagreement.
  var imagePass = formatInstagramPostForClaude_(post, 'https://www.instagram.com/p/A1/',
                                                ['date', 'location']);
  if (!/attached as an image/i.test(imagePass)) throw new Error('image pass must announce the image');
  if (imagePass.indexOf('date, location') < 0) throw new Error('gaps not named: ' + imagePass);
  if (!/flyer wins/i.test(imagePass)) throw new Error('image pass must settle disagreements');

  // Both passes: the caption is copied verbatim elsewhere, never written here.
  [textPass, imagePass].forEach(function (p) {
    if (p.indexOf('Return null for the description field.') < 0) {
      throw new Error('description must be left to the verbatim copy');
    }
  });

  Logger.log('test_formatInstagramPostForClaude: ALL PASSED');
}

function test_extractInstagramPost_live() {
  // Editor-only: hits the network. Replace with any public post URL.
  var post = fetchInstagramPost_('https://www.instagram.com/p/DcHA9syRjX4/');
  Logger.log(JSON.stringify(post, null, 2));
}

// ── Recognising a post ────────────────────────────────────────────────────────

/**
 * Pulls the shortcode out of an Instagram post, reel or IGTV URL.
 * @param {string} url
 * @returns {string|null} The shortcode, or null if this is not a post URL
 */
function instagramShortcode_(url) {
  var m = String(url || '').match(
    /^https?:\/\/(?:www\.)?instagram\.com\/(?:[A-Za-z0-9._]+\/)?(?:p|reels?|tv)\/([A-Za-z0-9_-]+)/i
  );
  return m ? m[1] : null;
}

/**
 * The server-rendered view of a post. /p/, /reel/ and /tv/ all resolve the same
 * shortcode namespace, and /reels/ is the one spelling this path 404s on, so
 * every form is normalised to /p/.
 * @param {string} shortcode
 * @returns {string}
 */
function instagramEmbedUrl_(shortcode) {
  return 'https://www.instagram.com/p/' + shortcode + '/embed/captioned/';
}

// ── Fetching and parsing ──────────────────────────────────────────────────────

/**
 * Fetches a public post and reads the caption and full-size image out of it.
 *
 * No User-Agent header: UrlFetchApp ignores the header anyway, and Instagram
 * answers Apps Script's own UA on this endpoint with the server-rendered page,
 * while a browser UA gets a JavaScript shell.
 *
 * @param {string} url - Any Instagram post, reel or IGTV URL
 * @returns {{username: string|null, captionHtml: string|null, captionText: string|null,
 *            imageUrl: string|null}|null} null if the post could not be read
 */
function fetchInstagramPost_(url) {
  var shortcode = instagramShortcode_(url);
  if (!shortcode) return null;

  var html;
  try {
    var resp = UrlFetchApp.fetch(instagramEmbedUrl_(shortcode), {
      muteHttpExceptions: true,
      followRedirects: true
    });
    if (resp.getResponseCode() !== 200) {
      Logger.log('fetchInstagramPost_: HTTP ' + resp.getResponseCode());
      return null;
    }
    html = resp.getContentText();
  } catch (e) {
    Logger.log('fetchInstagramPost_ error: ' + e.message);
    return null;
  }

  var captionHtml = igCaptionHtml_(html);
  var imageUrl = igFullImageUrl_(html);

  // A private or deleted post still returns HTTP 200, just with neither of
  // these in it. Nothing to extract from means nothing to extract.
  if (!captionHtml && !imageUrl) {
    Logger.log('fetchInstagramPost_: embed page carried no caption and no image');
    return null;
  }

  return {
    username: igUsername_(html),
    captionHtml: captionHtml,
    captionText: captionHtml ? igCaptionText_(captionHtml) : null,
    imageUrl: imageUrl
  };
}

/**
 * The account that posted, from the caption byline.
 * @param {string} html - Embed page HTML
 * @returns {string|null}
 */
function igUsername_(html) {
  var m = html.match(/<a class="CaptionUsername"[^>]*>([^<]+)<\/a>/i);
  return m ? igDecodeEntities_(m[1]).trim() : null;
}

/**
 * The uncropped original image.
 *
 * The embed page lists a dozen variants of the same photo — square crops for
 * the grid, padded thumbnails, the avatars of the poster and of tagged
 * accounts. Only one is the original the post displays, and picking a crop
 * costs the top and bottom of a portrait flyer.
 *
 * @param {string} html - Embed page HTML
 * @returns {string|null}
 */
function igFullImageUrl_(html) {
  // The page names it outright. Preferred, because it needs no reasoning about
  // what a given stp= value means.
  var tagged = html.match(/<img[^>]*class="[^"]*EmbeddedMediaImage[^"]*"[^>]*\ssrc="([^"]+)"/i);
  if (tagged) return igDecodeEntities_(tagged[1]);

  // The class name is the fragile part of that. Failing it, read the stp=
  // transform: the original is the one with neither a crop box (c0.213.1440.1440a_)
  // nor a resize (_s640x640, _p320x320).
  var re = /https:\/\/[^\s"'<>\\]+\?[^\s"'<>\\]*stp=[^\s"'<>\\]*/gi;
  var m;
  while ((m = re.exec(html)) !== null) {
    var url = igDecodeEntities_(m[0]);
    var stp = (url.match(/[?&]stp=([^&]*)/) || [])[1];
    if (!stp) continue;
    if (/^c[\d.]+a_/i.test(stp)) continue;
    if (/_[sp]\d+x\d+/i.test(stp)) continue;
    return url;
  }
  return null;
}

/**
 * The caption, as HTML safe to put in a calendar description.
 *
 * Instagram writes @handle and #hashtag links site-relative and hangs a
 * utm_source=ig_embed tracker off each one, so both are rewritten — a relative
 * href is a dead link once it leaves the page, and the tracker would follow the
 * event around forever. Only <a href> and <br> are kept.
 *
 * @param {string} html - Embed page HTML
 * @returns {string|null}
 */
function igCaptionHtml_(html) {
  var OPEN = '<div class="Caption">';
  var start = html.indexOf(OPEN);
  if (start < 0) return null;

  var body = html.substring(start + OPEN.length);
  var end = body.indexOf('<div class="CaptionComments"');
  if (end >= 0) body = body.substring(0, end);

  // The byline and the blank line under it are page chrome, not caption.
  body = body.replace(/^\s*<a class="CaptionUsername"[\s\S]*?<\/a>\s*(?:<br\s*\/?>\s*)*/i, '');

  var cleaned = body
    .replace(/<a\b[^>]*\shref="\/([^"]*)"[^>]*>/gi, function (_, path) {
      return '<a href="https://www.instagram.com/' + igStripTracker_(path) + '">';
    })
    .replace(/<a\b[^>]*\shref="(https?:\/\/[^"]*)"[^>]*>/gi, function (_, href) {
      return '<a href="' + igStripTracker_(href) + '">';
    })
    // Any <a> the two rewrites did not claim has no href we can trust; unwrap it
    // rather than let its attributes through.
    .replace(/<a\b(?![^>]*\shref="https:\/\/www\.instagram\.com)[^>]*>/gi, '')
    .replace(/<br\s*\/?>/gi, '<br>')
    .replace(/<(?!\/?(?:a|br)\b)[^>]*>/gi, '')
    .replace(/(?:\s*<br>\s*){3,}/g, '<br><br>')
    .trim();

  return cleaned || null;
}

/**
 * The caption as plain text, for the extraction prompt.
 * @param {string} captionHtml - From igCaptionHtml_
 * @returns {string}
 */
function igCaptionText_(captionHtml) {
  return igDecodeEntities_(
    captionHtml.replace(/<br>/gi, '\n').replace(/<[^>]+>/g, '')
  ).trim();
}

/**
 * Drops the analytics parameters Instagram hangs off its own links.
 * @param {string} url
 * @returns {string}
 */
function igStripTracker_(url) {
  return url
    .replace(/([?&])(?:utm_[a-z]+|ig_rid|igsh|igshid)=[^&]*/gi, '$1')
    .replace(/&{2,}/g, '&')
    .replace(/\?&/g, '?')
    .replace(/[?&]+$/, '');
}

function igDecodeEntities_(s) {
  return String(s)
    .replace(/&#x([0-9a-f]+);/gi, function (_, h) { return String.fromCharCode(parseInt(h, 16)); })
    .replace(/&#(\d+);/g, function (_, d) { return String.fromCharCode(parseInt(d, 10)); })
    .replace(/&quot;/gi, '"')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&');
}

// ── Handing the post to Claude ────────────────────────────────────────────────

/**
 * Which of the fields that make an event usable the caption did not supply.
 *
 * This is what decides whether the flyer gets read, so the text pass is told to
 * return null rather than guess — a guessed end time looks exactly like a
 * stated one from here, and would keep the image closed.
 *
 * @param {Object|null} result - Parsed response from the caption-only pass
 * @returns {Array<string>}
 */
function igMissingFields_(result) {
  var wanted = ['title', 'date', 'start_time', 'end_time', 'location'];
  if (!result) return wanted;
  return wanted.filter(function (field) {
    var value = result[field];
    return value === null || value === undefined || String(value).trim() === '';
  });
}

/**
 * Formats the post for Claude, for either pass.
 *
 * The description is deliberately absent from what is asked for: the caption is
 * copied through verbatim and must never be rewritten by the model.
 *
 * @param {Object} post - From fetchInstagramPost_
 * @param {string} sourceUrl
 * @param {Array<string>} missing - Fields the caption did not state. Empty on
 *     the caption-only pass; non-empty means the flyer is attached.
 * @returns {string}
 */
function formatInstagramPostForClaude_(post, sourceUrl, missing) {
  var lines = ['=== INSTAGRAM POST ==='];
  lines.push('Post URL: ' + sourceUrl);
  if (post.username) lines.push('Posted by: @' + post.username);
  lines.push('Caption:');
  lines.push(post.captionText || '(this post has no caption)');
  lines.push('=== END INSTAGRAM POST ===');
  lines.push('');

  if (missing && missing.length) {
    lines.push('The event flyer posted with this caption is attached as an image.');
    lines.push('The caption did not state: ' + missing.join(', ') + '. Read those off the flyer.');
    lines.push('Where the flyer and the caption disagree, the flyer wins — it is the ' +
               'event\'s own artwork, while the caption is chatter written around it. ' +
               'The flyer usually carries the year, the venue and the exact times the ' +
               'caption leaves out.');
    lines.push('The normal rules apply on this pass: guess an end time if neither the ' +
               'flyer nor the caption gives one, and set end_time_note when you do.');
  } else {
    lines.push('This caption is the only source for this pass — there is no page body, ' +
               'no structured data and no image.');
    lines.push('Report a field only if the caption states it outright. Do not guess, ' +
               'infer or fill in anything it does not say — return null instead, ' +
               'end_time and end_time_note included. A field left null is expected and ' +
               'useful here; an invented one is not.');
  }

  lines.push('The description is supplied separately and must not be written or ' +
             'rewritten by you. Return null for the description field.');
  lines.push('The image is supplied separately. Return null for the image_url field.');
  return lines.join('\n');
}
