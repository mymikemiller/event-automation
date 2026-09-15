function test_parseQrResponse() {
  // The real goqr.me response for the People Sanctuary flyer, captured
  // 2026-09-15. All three codes arrive inside ONE symbol[0].data string,
  // newline-separated, every code after the first prefixed "QR-Code:".
  var body = '[{"type":"qrcode","symbol":[{"seq":0,"data":' +
    '"https://www.instagram.com/thepeoplesanctuary?igsh=MXB4eWxjanF4andvbQ%3D%3D&utm_source=qr\\n' +
    'QR-Code:https://www.facebook.com/profile.php?id=61592091920619\\n' +
    'QR-Code:https://peoplesanctuary.org","error":null}]}]';

  var out = parseQrResponse_(body);
  if (out.length !== 3) throw new Error('expected 3 codes, got ' + out.length);
  if (out[2] !== 'https://peoplesanctuary.org') throw new Error('third code: ' + out[2]);
  if (out[1].indexOf('QR-Code:') === 0) throw new Error('prefix not stripped: ' + out[1]);

  if (parseQrResponse_('[{"type":"qrcode","symbol":[{"seq":0,"data":null,"error":"download error"}]}]').length !== 0) {
    throw new Error('an error response must yield no codes');
  }
  if (parseQrResponse_('not json').length !== 0) throw new Error('garbage must yield no codes');

  Logger.log('test_parseQrResponse: ALL PASSED');
}

function test_chooseEventLink() {
  // The flyer's three codes: the website wins over both social links.
  var pick = chooseEventLink([
    'https://www.instagram.com/thepeoplesanctuary?igsh=MXB4eWxjanF4andvbQ%3D%3D&utm_source=qr',
    'https://www.facebook.com/profile.php?id=61592091920619',
    'https://peoplesanctuary.org'
  ]);
  if (pick.url !== 'https://peoplesanctuary.org') throw new Error('picked ' + pick.url);
  if (pick.label !== 'See Website for details') throw new Error('label: ' + pick.label);

  // A ticketing link outranks a plain website.
  var tix = chooseEventLink(['https://peoplesanctuary.org', 'https://www.eventbrite.com/e/12345']);
  if (tix.label !== 'RSVP on Eventbrite') throw new Error('ticketing tier: ' + tix.label);

  // Social only: still used, but the trackers come off.
  var social = chooseEventLink(['https://www.instagram.com/p/ABC?igsh=xyz&utm_source=qr']);
  if (social.url !== 'https://www.instagram.com/p/ABC') throw new Error('trackers: ' + social.url);
  if (social.label !== 'See the post on Instagram') throw new Error('social label: ' + social.label);

  // A Facebook profile id is not a tracker and must survive.
  var fb = chooseEventLink(['https://www.facebook.com/profile.php?id=61592091920619&fbclid=xyz']);
  if (fb.url !== 'https://www.facebook.com/profile.php?id=61592091920619') throw new Error('fb: ' + fb.url);

  // Ties break on order of appearance.
  var tie = chooseEventLink(['https://first.org/a', 'https://second.org/b']);
  if (tie.url !== 'https://first.org/a') throw new Error('tie: ' + tie.url);

  // Subdomains count as the same host.
  var sub = chooseEventLink(['https://events.eventbrite.com/e/9']);
  if (sub.label !== 'RSVP on Eventbrite') throw new Error('subdomain: ' + sub.label);

  // Non-URL payloads (vCard, wifi, plain text) are not links.
  if (chooseEventLink(['WIFI:S:net;T:WPA;P:pw;;', 'BEGIN:VCARD']) !== null) {
    throw new Error('non-URL payloads must not be chosen');
  }
  if (chooseEventLink([]) !== null) throw new Error('empty must be null');
  if (chooseEventLink(null) !== null) throw new Error('null must be null');

  Logger.log('test_chooseEventLink: ALL PASSED');
}

function test_decodeQrCodes_live() {
  var resp = UrlFetchApp.fetch(
    'https://horizons-cdn.hostinger.com/c3648fa5-28bf-4fa9-adf5-de27dbf4d0e8/sss-QlOin.png',
    { muteHttpExceptions: true, followRedirects: true });
  if (resp.getResponseCode() !== 200) throw new Error('flyer fetch: HTTP ' + resp.getResponseCode());

  var codes = decodeQrCodes_(resp.getBlob());
  if (codes.length !== 3) throw new Error('expected 3 codes, got ' + codes.length + ': ' + codes.join(' | '));

  var pick = chooseEventLink(codes);
  if (pick.url !== 'https://peoplesanctuary.org') throw new Error('picked ' + pick.url);

  Logger.log('test_decodeQrCodes_live: ALL PASSED');
}

var QR_API_URL = 'https://api.qrserver.com/v1/read-qr-code/';

// Tier 1: a code that leads straight to an RSVP page. Tier 3: social profiles.
// Anything else is tier 2, a real website, which is what most flyers want.
var QR_TICKETING_HOSTS = {
  'eventbrite.com': 'RSVP on Eventbrite',
  'lu.ma': 'RSVP on Luma',
  'luma.com': 'RSVP on Luma',
  'meetup.com': 'RSVP on Meetup',
  'meetu.ps': 'RSVP on Meetup'
};

var QR_SOCIAL_HOSTS = {
  'facebook.com': 'RSVP on Facebook',
  'fb.me': 'RSVP on Facebook',
  'instagram.com': 'See the post on Instagram',
  'x.com': 'See Website for details',
  'twitter.com': 'See Website for details',
  'tiktok.com': 'See Website for details',
  'threads.net': 'See Website for details'
};

// Trackers a QR generator bolts on. Stripped for the same reason the Instagram
// and Facebook paths strip theirs: the link has to still work from a calendar
// event months later, and nothing here needs attribution.
var QR_TRACKING_PARAMS = /^(igsh|si|fbclid|gclid|mc_cid|mc_eid|ref|ref_src|utm_[a-z_]+)$/i;

/**
 * Every decoded string in a goqr.me read-qr-code response.
 *
 * The shape is a trap. Several codes come back inside ONE symbol[0].data
 * string, newline-separated, with every code after the first prefixed
 * "QR-Code:" — so reading symbol[0].data verbatim gives one unusable
 * three-line "URL" rather than three codes.
 *
 * @param {string} text - raw response body
 * @returns {Array<string>} decoded payloads, in the order they were found
 */
function parseQrResponse_(text) {
  var out = [];
  var body;
  try {
    body = JSON.parse(text);
  } catch (e) {
    return out;
  }
  if (!body || !body.length) return out;

  for (var i = 0; i < body.length; i++) {
    var symbols = body[i].symbol || [];
    for (var j = 0; j < symbols.length; j++) {
      if (!symbols[j] || !symbols[j].data) continue;
      var lines = String(symbols[j].data).split('\n');
      for (var k = 0; k < lines.length; k++) {
        var v = lines[k].replace(/^QR-Code:/, '').trim();
        if (v) out.push(v);
      }
    }
  }
  return out;
}

/** Lowercased host with any leading www., or '' if this is not an http(s) URL. */
function qrHost_(url) {
  var m = /^https?:\/\/([^\/?#]+)/i.exec(url);
  return m ? m[1].toLowerCase().replace(/^www\./, '') : '';
}

/** The label for a host in `table`, matching the host itself or a subdomain of it. */
function qrLookupHost_(host, table) {
  var keys = Object.keys(table);
  for (var i = 0; i < keys.length; i++) {
    if (host === keys[i] || host.slice(-(keys[i].length + 1)) === '.' + keys[i]) return table[keys[i]];
  }
  return null;
}

/** Drops tracking parameters, and the '?' with them if nothing else remains. */
function qrStripTrackers_(url) {
  var q = url.indexOf('?');
  if (q < 0) return url;

  var base = url.slice(0, q);
  var rest = url.slice(q + 1);
  var hash = '';
  var h = rest.indexOf('#');
  if (h >= 0) {
    hash = rest.slice(h);
    rest = rest.slice(0, h);
  }

  var kept = rest.split('&').filter(function (pair) {
    return pair && !QR_TRACKING_PARAMS.test(pair.split('=')[0]);
  });
  return base + (kept.length ? '?' + kept.join('&') : '') + hash;
}

/**
 * The best event link among decoded QR payloads, or null.
 *
 * Ranked by host: a ticketing platform first, then any other website, then
 * social. A flyer usually carries its Instagram and Facebook alongside the one
 * link actually worth putting on a calendar event, and on the flyer this was
 * built for the social codes come FIRST in reading order — so position alone is
 * not a usable rule, and only breaks ties.
 *
 * No trailing underscore: called from the browser via google.script.run when
 * the client-side decoder is the one that found the codes.
 *
 * @param {Array<string>} urls - decoded QR payloads
 * @returns {{url: string, label: string}|null}
 */
function chooseEventLink(urls) {
  var best = null;
  var list = urls || [];

  for (var i = 0; i < list.length; i++) {
    var raw = String(list[i]);
    var host = qrHost_(raw);
    if (!host) continue; // vCard, wifi credentials, plain text

    var tier = 1;
    var label = qrLookupHost_(host, QR_TICKETING_HOSTS);
    if (!label) {
      label = qrLookupHost_(host, QR_SOCIAL_HOSTS);
      tier = label ? 3 : 2;
      if (!label) label = 'See Website for details';
    }

    // Strict <, so an equal tier leaves the earlier code in place.
    if (!best || tier < best.tier) best = { tier: tier, url: qrStripTrackers_(raw), label: label };
  }

  return best ? { url: best.url, label: best.label } : null;
}

/**
 * Decodes every QR code in an image, or [] if the service cannot.
 *
 * The bytes are POSTed rather than the URL handed over as `fileurl=`: measured
 * 2026-09-15, goqr.me's own fetcher could not reach the Hostinger CDN the test
 * flyer sits on ("download error (could not establish connection)"), and the
 * caller has the bytes in hand anyway.
 *
 * Never throws. An empty result is the caller's signal to ask the browser to
 * decode instead — goqr.me is a free service with no SLA, and the whole feature
 * turns on getting a real URL off the flyer.
 *
 * @param {Blob} blob - the image
 * @returns {Array<string>} decoded payloads
 */
function decodeQrCodes_(blob) {
  try {
    var resp = UrlFetchApp.fetch(QR_API_URL, {
      method: 'post',
      payload: { file: blob },
      muteHttpExceptions: true
    });
    if (resp.getResponseCode() !== 200) {
      Logger.log('decodeQrCodes_: HTTP ' + resp.getResponseCode());
      return [];
    }
    return parseQrResponse_(resp.getContentText());
  } catch (e) {
    Logger.log('decodeQrCodes_ error: ' + e.message);
    return [];
  }
}
