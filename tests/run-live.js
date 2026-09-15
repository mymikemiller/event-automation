#!/usr/bin/env node
// Runs the test_*_live functions from impure .gs files against real services,
// using tests/gas-shim.js. tests/run.js stays the pure-only runner.
//
// This exists because `clasp run` cannot reach this project: it calls an API
// Executable deployment and appsscript.json publishes only a webapp. See
// docs/plans/2026-09-15-image-flyer-extraction-design.md.
//
// Same realm hazard as run.js: build fixtures inside the .gs file or inside the
// vm context, never out here in the host realm. `instanceof Array` is
// realm-sensitive, so a host-built array makes a function quietly take its
// malformed-input path and a probe reports a false negative on code that is fine.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { services } = require('./gas-shim');

const SRC = path.join(__dirname, '..', 'src');
const files = process.argv.slice(2);
if (!files.length) {
  console.error('usage: node tests/run-live.js <File.gs> [File.gs ...]');
  process.exit(1);
}

const sandbox = Object.assign({ console }, services);
const context = vm.createContext(sandbox);

for (const f of files) {
  vm.runInContext(fs.readFileSync(path.join(SRC, f), 'utf8'), context, { filename: f });
}

const tests = Object.keys(context).filter(
  (k) => k.indexOf('test_') === 0 && typeof context[k] === 'function' && k.indexOf('_live') >= 0
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
