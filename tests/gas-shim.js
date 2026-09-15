// Minimal Google Apps Script services backed by curl, so the .gs files that do
// I/O can run under Node instead of only in the Apps Script editor.
//
// Why curl and not fetch: UrlFetchApp.fetch is SYNCHRONOUS in Apps Script and
// Node's fetch is not. execFileSync('curl') is what closes that gap — there is
// no way to await inside a .gs function without rewriting it.
//
// clasp run cannot do this job: it needs an API Executable deployment, and this
// script publishes only a webapp. See
// docs/plans/2026-09-15-image-flyer-extraction-design.md.
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const KEY_FILE = path.join(os.homedir(), '.config', 'event-automation', 'claude_api_key');

function claudeApiKey() {
  if (process.env.CLAUDE_API_KEY) return process.env.CLAUDE_API_KEY;
  if (fs.existsSync(KEY_FILE)) return fs.readFileSync(KEY_FILE, 'utf8').trim();
  throw new Error(
    'No Claude API key. Copy it from Script Properties, then run:\n' +
    '  mkdir -p ~/.config/event-automation && ' +
    '(umask 077; pbpaste > ~/.config/event-automation/claude_api_key)'
  );
}

function makeBlob(buf, contentType, name) {
  return {
    _buf: buf,
    getBytes: () => Array.from(buf),
    getContentType: () => contentType,
    getName: () => name || 'blob',
    getDataAsString: () => buf.toString('utf8')
  };
}

const UrlFetchApp = {
  fetch(url, params) {
    params = params || {};
    const out = path.join(os.tmpdir(), 'gasfetch-' + process.pid + '-' + Date.now());
    const args = ['-sS', '-o', out, '-w', '%{http_code}\n%{content_type}'];
    if (params.followRedirects !== false) args.push('-L');

    const parts = [];
    const payload = params.payload;
    if (payload && typeof payload === 'object' && !Buffer.isBuffer(payload)) {
      // An object payload is multipart in Apps Script; a blob value is a file part.
      for (const [k, v] of Object.entries(payload)) {
        if (v && v._buf) {
          const f = path.join(os.tmpdir(), 'gaspart-' + process.pid + '-' + k);
          fs.writeFileSync(f, v._buf);
          parts.push(f);
          args.push('-F', `${k}=@${f};type=${v.getContentType()}`);
        } else {
          args.push('-F', `${k}=${v}`);
        }
      }
    } else if (payload !== undefined) {
      args.push('--data-binary', String(payload));
    }

    if (params.contentType) args.push('-H', 'Content-Type: ' + params.contentType);
    for (const [k, v] of Object.entries(params.headers || {})) {
      args.push('-H', `${k}: ${v}`);
    }
    if (params.method) args.push('-X', params.method.toUpperCase());
    args.push(url);

    let meta;
    try {
      meta = execFileSync('curl', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).split('\n');
    } finally {
      parts.forEach((f) => fs.existsSync(f) && fs.unlinkSync(f));
    }
    const buf = fs.readFileSync(out);
    fs.unlinkSync(out);

    const code = parseInt(meta[0], 10);
    const type = (meta[1] || '').split(';')[0].trim();
    return {
      getResponseCode: () => code,
      getContentText: () => buf.toString('utf8'),
      getBlob: () => makeBlob(buf, type, 'response')
    };
  }
};

function toBuffer(bytes) {
  return typeof bytes === 'string' ? Buffer.from(bytes, 'utf8') : Buffer.from(Uint8Array.from(bytes));
}

const Utilities = {
  base64Encode: (bytes) => toBuffer(bytes).toString('base64'),
  newBlob: (bytes, contentType, name) =>
    makeBlob(toBuffer(bytes), contentType || 'application/octet-stream', name),
  formatDate(date, tz, fmt) {
    // Only the formats the .gs files actually ask for.
    const p = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit'
    }).formatToParts(date).reduce((a, x) => ((a[x.type] = x.value), a), {});
    if (fmt === 'yyyy-MM-dd') return `${p.year}-${p.month}-${p.day}`;
    throw new Error('gas-shim: unsupported date format ' + fmt);
  }
};

const PropertiesService = {
  getScriptProperties: () => ({
    getProperty(k) {
      if (k === 'CLAUDE_API_KEY') return claudeApiKey();
      return process.env[k] || null;
    }
  })
};

module.exports = {
  services: {
    UrlFetchApp,
    Utilities,
    PropertiesService,
    Session: {
      getScriptTimeZone: () => 'America/Chicago',
      getActiveUser: () => ({ getEmail: () => 'test@example.com' })
    },
    Logger: { log: (m) => { if (process.env.GAS_VERBOSE) console.log('   log: ' + m); } }
  },
  makeBlob,
  claudeApiKey
};
