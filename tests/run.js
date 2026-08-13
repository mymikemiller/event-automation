#!/usr/bin/env node
// Runs Apps Script test_* functions locally under Node.
// Only load PURE .gs files here — anything touching Calendar/Drive/Properties
// must stay an editor-only test.
//
// Build test fixtures inside the .gs file, or inside the vm context — never out
// here in the host realm. `instanceof Array` is realm-sensitive: a host-built
// array fails it inside the sandbox, so a function quietly takes its
// malformed-input path and a probe reports a false negative on code that is
// fine. That has cost several people an hour each on TockifyUtil.gs.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = path.join(__dirname, '..', 'src');
const files = process.argv.slice(2);
if (!files.length) {
  console.error('usage: node tests/run.js <File.gs> [File.gs ...]');
  process.exit(1);
}

const sandbox = {
  console,
  Logger: { log: function (m) { /* swallow; assertions throw */ } },
  Session: { getScriptTimeZone: function () { return 'America/Chicago'; } }
};
const context = vm.createContext(sandbox);

for (const f of files) {
  vm.runInContext(fs.readFileSync(path.join(SRC, f), 'utf8'), context, { filename: f });
}

const tests = Object.keys(context).filter(
  (k) => k.indexOf('test_') === 0 && typeof context[k] === 'function' && k.indexOf('_live') === -1
);

let pass = 0;
let fail = 0;
for (const name of tests) {
  try {
    context[name]();
    console.log('  PASS  ' + name);
    pass++;
  } catch (e) {
    console.log('  FAIL  ' + name + '\n        ' + e.message);
    fail++;
  }
}
console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
