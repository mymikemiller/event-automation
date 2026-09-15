#!/usr/bin/env node
// Covers the result wording in src/Index.html by running the page's REAL
// showResult against the shapes submitEvent returns, with the DOM stubbed.
//
// This exists because of a bug that shipped: the "one repeating event with no
// end date" message sat inside a branch gated on `occurrenceCount > 1`, which
// an open-ended series never satisfies — it carries exactly one date, its
// start, so that no invented date reaches the duplicate check or the Drive
// filename. The message was unreachable and the page reported an endless
// series as an ordinary single event.
//
// Nothing else covers Index.html, so anything gated on occurrenceCount or
// openEnded belongs here.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'Index.html'), 'utf8');
// The GAS scriptlet is not JavaScript; strip it before parsing.
const inline = html.match(/<script>([\s\S]*)<\/script>/)[1].replace(/'<\?=[^>]*\?>'/g, "''");

const stubEl = () => ({ value: '', textContent: '', innerHTML: '', style: {}, children: [], className: '' });

const sandbox = {
  console, Map, Math, Object, setTimeout, clearTimeout, encodeURIComponent,
  document: { getElementById: () => stubEl(), createElement: () => stubEl() },
  google: { script: { run: { withSuccessHandler() { return this; }, withFailureHandler() { return this; } } } }
};
sandbox.window = sandbox;
vm.createContext(sandbox);
vm.runInContext(inline, sandbox, { filename: 'Index.html' });

let status = null;
sandbox.setStatus = function (id, type, msg) {
  if (id === 'result-status') status = { type: type, msg: msg };
};

let pass = 0;
let fail = 0;

function check(label, result, expectedPrefix) {
  status = null;
  sandbox.showResult(result);
  if (status && status.msg.indexOf(expectedPrefix) === 0) {
    console.log('  PASS  ' + label);
    pass++;
  } else {
    console.log('  FAIL  ' + label +
                '\n        expected prefix: ' + expectedPrefix +
                '\n        got:             ' + (status ? status.msg : '(no status set)'));
    fail++;
  }
}

// An open-ended series: one date, openEnded true. The case that broke.
check('open-ended series',
  { success: true, method: 'rrule', openEnded: true, occurrenceCount: 1,
    title: 'Sober Saturday Strolls', calendarUrl: 'x' },
  'Created one repeating event with no end date.');

check('open-ended series whose start date is already taken',
  { success: true, method: 'rrule', openEnded: true, occurrenceCount: 1,
    duplicateDates: ['2026-09-26'], title: 'T', calendarUrl: 'x' },
  'Created one repeating event with no end date. Note: its start date (2026-09-26) already had');

// The paths that already worked, which the fix must not move.
check('series pinned with COUNT',
  { success: true, method: 'rrule', openEnded: false, occurrenceCount: 4, calendarUrl: 'x' },
  'Created one repeating event with 4 occurrences.');

check('separate-events fallback',
  { success: true, method: 'duplicate', openEnded: false, occurrenceCount: 3, calendarUrl: 'x' },
  'Created 3 separate events.');

check('ordinary single event',
  { success: true, method: 'single', openEnded: false, occurrenceCount: 1, calendarUrl: 'x' },
  'Event created successfully!');

check('single event on a date already taken',
  { success: true, method: 'single', openEnded: false, occurrenceCount: 1,
    duplicateDates: ['2026-09-26'], calendarUrl: 'x' },
  'Event created successfully! Note: 1 of 1 date(s) already had');

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
