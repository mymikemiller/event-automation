var FB_GRAPH_VERSION = 'v21.0';
var FB_GRAPH_BASE = 'https://graph.facebook.com/' + FB_GRAPH_VERSION;
var FB_DIALOG_URL = 'https://www.facebook.com/' + FB_GRAPH_VERSION + '/dialog/oauth';
var FB_TOKEN_ENDPOINT = FB_GRAPH_BASE + '/oauth/access_token';

// ── OAuth flow ────────────────────────────────────────────────────────────────

/**
 * Returns the Facebook OAuth authorization URL.
 * redirectUri is passed from the client, where it was embedded by doGet()
 * using ScriptApp.getService().getUrl() — the only reliable call site.
 */
function getFacebookAuthUrl(redirectUri) {
  var appId = PropertiesService.getScriptProperties().getProperty('FACEBOOK_APP_ID');
  if (!appId) {
    return { error: 'FACEBOOK_APP_ID not set in Script Properties.' };
  }
  if (!redirectUri) {
    return { error: 'Could not determine web app URL.' };
  }

  var state = Utilities.base64Encode(
    Utilities.computeDigest(
      Utilities.DigestAlgorithm.SHA_256,
      Session.getActiveUser().getEmail() + new Date().getTime() + Math.random()
    )
  ).replace(/[^a-zA-Z0-9]/g, '').substring(0, 32);

  PropertiesService.getUserProperties().setProperty('fb_oauth_state', state);
  // Store redirectUri so handleFacebookCallback can use the exact same value
  PropertiesService.getUserProperties().setProperty('fb_oauth_redirect_uri', redirectUri);

  var authUrl = FB_DIALOG_URL +
    '?client_id=' + encodeURIComponent(appId) +
    '&redirect_uri=' + encodeURIComponent(redirectUri) +
    '&state=' + encodeURIComponent(state) +
    '&scope=public_profile' +
    '&response_type=code';

  return { authUrl: authUrl };
}

/**
 * Exchanges the OAuth code for an access token and stores it.
 * Called from OAuthCallback.html via google.script.run after Facebook redirects back.
 */
function handleFacebookCallback(code, state) {
  var userProps = PropertiesService.getUserProperties();
  var savedState = userProps.getProperty('fb_oauth_state');
  var redirectUri = userProps.getProperty('fb_oauth_redirect_uri');
  userProps.deleteProperty('fb_oauth_state');
  userProps.deleteProperty('fb_oauth_redirect_uri');

  if (!savedState || savedState !== state) {
    return { error: 'OAuth state mismatch. Please try again.' };
  }
  if (!redirectUri) {
    return { error: 'Redirect URI not found in session. Please try again.' };
  }

  var scriptProps = PropertiesService.getScriptProperties();
  var appId = scriptProps.getProperty('FACEBOOK_APP_ID');
  var appSecret = scriptProps.getProperty('FACEBOOK_APP_SECRET');
  if (!appId || !appSecret) {
    return { error: 'FACEBOOK_APP_ID or FACEBOOK_APP_SECRET not configured.' };
  }

  var tokenUrl = FB_TOKEN_ENDPOINT +
    '?client_id=' + encodeURIComponent(appId) +
    '&client_secret=' + encodeURIComponent(appSecret) +
    '&redirect_uri=' + encodeURIComponent(redirectUri) +
    '&code=' + encodeURIComponent(code);

  try {
    var resp = UrlFetchApp.fetch(tokenUrl, { muteHttpExceptions: true });
    if (resp.getResponseCode() !== 200) {
      return { error: 'Token exchange failed (HTTP ' + resp.getResponseCode() + ').' };
    }
    var body = JSON.parse(resp.getContentText());
    if (body.error) return { error: body.error.message || 'Token exchange failed.' };

    var accessToken = body.access_token;
    var meResp = UrlFetchApp.fetch(
      FB_GRAPH_BASE + '/me?fields=name&access_token=' + encodeURIComponent(accessToken),
      { muteHttpExceptions: true }
    );
    var me = JSON.parse(meResp.getContentText());
    if (me.error) return { error: me.error.message };

    var name = me.name || 'Facebook User';
    userProps.setProperties({ 'fb_access_token': accessToken, 'fb_user_name': name });
    return { success: true, name: name };
  } catch (e) {
    return { error: 'Login failed: ' + e.message };
  }
}

// ── Manual token fallback ─────────────────────────────────────────────────────

/**
 * Validates a manually pasted access token, exchanges it for a long-lived
 * token (~60 days) if app credentials are present, then stores it.
 */
function saveFacebookToken(token) {
  token = (token || '').trim();
  if (!token) return { error: 'No token provided.' };

  try {
    var meResp = UrlFetchApp.fetch(
      FB_GRAPH_BASE + '/me?fields=name&access_token=' + encodeURIComponent(token),
      { muteHttpExceptions: true }
    );
    var me = JSON.parse(meResp.getContentText());
    if (me.error) return { error: 'Token rejected by Facebook: ' + me.error.message };

    var name = me.name || 'Facebook User';
    var finalToken = token;
    var extended = false;

    var scriptProps = PropertiesService.getScriptProperties();
    var appId = scriptProps.getProperty('FACEBOOK_APP_ID');
    var appSecret = scriptProps.getProperty('FACEBOOK_APP_SECRET');
    if (appId && appSecret) {
      var exResp = UrlFetchApp.fetch(
        FB_GRAPH_BASE + '/oauth/access_token' +
          '?grant_type=fb_exchange_token' +
          '&client_id=' + encodeURIComponent(appId) +
          '&client_secret=' + encodeURIComponent(appSecret) +
          '&fb_exchange_token=' + encodeURIComponent(token),
        { muteHttpExceptions: true }
      );
      var ex = JSON.parse(exResp.getContentText());
      if (ex.access_token) { finalToken = ex.access_token; extended = true; }
    }

    PropertiesService.getUserProperties().setProperties({
      'fb_access_token': finalToken,
      'fb_user_name': name
    });
    return { success: true, name: name, extended: extended };
  } catch (e) {
    return { error: 'Failed to save token: ' + e.message };
  }
}

// ── Status / disconnect ───────────────────────────────────────────────────────

function getFacebookStatus() {
  var token = PropertiesService.getUserProperties().getProperty('fb_access_token');
  if (!token) return { connected: false };
  var name = PropertiesService.getUserProperties().getProperty('fb_user_name') || 'Facebook User';
  return { connected: true, name: name };
}

function disconnectFacebook() {
  var props = PropertiesService.getUserProperties();
  props.deleteProperty('fb_access_token');
  props.deleteProperty('fb_user_name');
  return { success: true };
}

function getFacebookAccessToken_() {
  return PropertiesService.getUserProperties().getProperty('fb_access_token');
}

// ── Graph API content fetch ───────────────────────────────────────────────────

/**
 * Returns an app access token using the stored app credentials.
 * Uses the "app_id|app_secret" shorthand Facebook accepts for server-side calls.
 * Returns null if credentials are not configured.
 */
function getAppAccessToken_() {
  var props = PropertiesService.getScriptProperties();
  var appId = props.getProperty('FACEBOOK_APP_ID');
  var appSecret = props.getProperty('FACEBOOK_APP_SECRET');
  if (!appId || !appSecret) return null;
  return appId + '|' + appSecret;
}

/**
 * Fetches a public Facebook event via the Graph API Events endpoint.
 * Works without user login for public events — only needs app credentials.
 * Returns the raw API data object, or {apiError: string} on failure.
 */
function fetchFacebookEventViaApi_(url) {
  var token = getAppAccessToken_();
  if (!token) return null;

  var match = url.match(/\/events\/(\d+)/);
  if (!match) return null;

  var eventId = match[1];
  var fields = 'name,description,start_time,end_time,place,cover,owner';

  try {
    var resp = UrlFetchApp.fetch(
      FB_GRAPH_BASE + '/' + eventId +
        '?fields=' + encodeURIComponent(fields) +
        '&access_token=' + encodeURIComponent(token),
      { muteHttpExceptions: true }
    );
    var data = JSON.parse(resp.getContentText());
    if (data.error) {
      Logger.log('Facebook Event API error: ' + JSON.stringify(data.error));
      return { apiError: '(code ' + data.error.code + ') ' + data.error.message };
    }
    return data;
  } catch (e) {
    Logger.log('fetchFacebookEventViaApi_ error: ' + e.message);
    return { apiError: e.message };
  }
}

/**
 * Formats a Facebook Graph API event object into a structured text block
 * for Claude to extract from.
 */
function formatFacebookEventForClaude_(event, sourceUrl) {
  var lines = ['=== FACEBOOK EVENT DATA (GRAPH API) — AUTHORITATIVE SOURCE FOR ALL FIELDS ==='];
  if (event.name)        lines.push('Title: ' + event.name);
  if (event.start_time)  lines.push('Start: ' + event.start_time);
  if (event.end_time)    lines.push('End: ' + event.end_time);
  if (event.place) {
    var loc = event.place.name || '';
    if (event.place.location) {
      var l = event.place.location;
      var parts = [l.street, l.city, l.state, l.zip, l.country].filter(Boolean);
      if (parts.length) loc += (loc ? ', ' : '') + parts.join(', ');
    }
    if (loc) lines.push('Location: ' + loc);
  }
  if (event.owner)       lines.push('Organizer: ' + (event.owner.name || ''));
  if (event.description) lines.push('Description:\n' + event.description);
  lines.push('Source URL: ' + sourceUrl);
  if (event.cover && event.cover.source) lines.push('Image URL: ' + event.cover.source);
  lines.push('=== END FACEBOOK EVENT DATA ===');
  return lines.join('\n');
}

/**
 * Fetches Facebook group post content via the Graph API.
 * Note: Facebook removed the Groups API in April 2024, so this will fail
 * for group posts. The paste-content fallback handles that case.
 */
function fetchFacebookPostContent_(url) {
  var token = getFacebookAccessToken_();
  if (!token) return null;

  var match = url.match(/\/groups\/(\d+)\/permalink\/(\d+)/);
  if (!match) return null;

  var groupId = match[1];
  var postId = match[2];
  var fields = 'message,story,full_picture,from,created_time';
  var candidates = [groupId + '_' + postId, postId];

  for (var i = 0; i < candidates.length; i++) {
    try {
      var apiUrl = FB_GRAPH_BASE + '/' + candidates[i] +
        '?fields=' + encodeURIComponent(fields) +
        '&access_token=' + encodeURIComponent(token);
      var resp = UrlFetchApp.fetch(apiUrl, { muteHttpExceptions: true });
      var data = JSON.parse(resp.getContentText());

      if (data.error) {
        Logger.log('Graph API error [' + candidates[i] + ']: ' + JSON.stringify(data.error));
        if (data.error.code === 190) {
          PropertiesService.getUserProperties().deleteProperty('fb_access_token');
          PropertiesService.getUserProperties().deleteProperty('fb_user_name');
        }
        return { apiError: '(code ' + data.error.code + ') ' + data.error.message };
      }

      if (data.message || data.story) {
        return {
          text: buildFacebookPromptContent_(data, url),
          imageUrl: data.full_picture || null
        };
      }
    } catch (e) {
      Logger.log('fetchFacebookPostContent_ error: ' + e.message);
      return { apiError: e.message };
    }
  }

  return { apiError: 'Post not found via Graph API. Facebook removed the Groups API in April 2024 — use the paste fallback instead.' };
}

function buildFacebookPromptContent_(post, sourceUrl) {
  var lines = ['=== FACEBOOK POST CONTENT ==='];
  if (post.from) lines.push('Posted by: ' + post.from.name);
  if (post.created_time) lines.push('Posted: ' + post.created_time);
  if (post.story) lines.push('Context: ' + post.story);
  lines.push('Source URL: ' + sourceUrl);
  lines.push('');
  if (post.message) lines.push(post.message);
  lines.push('=== END FACEBOOK POST ===');
  return lines.join('\n');
}
