#!/usr/bin/env node
// Node-only tests for CalendarService.gs, using a Calendar stub that models the
// real API's behavior closely enough to catch integration bugs.
//
// The stub deliberately FILTERS instances by timeMin/timeMax the way Google
// documents ("bound for an event's start time"), comparing absolute instants.
// An earlier, permissive stub that ignored those bounds hid a real timezone bug
// that only surfaced against the live API.
//
// Run: node tests/calendar.test.js
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = path.join(__dirname, '..', 'src');
// August/September 2026 in America/Chicago is CDT = UTC-5.
const OFFSET = '-05:00';

function makeContext(opts) {
  opts = opts || {};
  var stored = {};
  var seq = 0;
  var patches = [];

  var Calendar = {
    Events: {
      insert: function (resource) {
        if (opts.failRecurringInsert && resource.recurrence) throw new Error('Invalid recurrence');
        var id = 'evt' + (++seq);
        stored[id] = resource;
        return { id: id, htmlLink: 'https://calendar.example/' + id };
      },
      instances: function (calId, eventId, params) {
        var res = stored[eventId];
        var dates = expandStored(ctx, res);
        var startHHMM = res.start.dateTime.slice(11, 16);

        var items = dates.map(function (d, i) {
          var stamp = d + 'T' + startHHMM + ':00' + OFFSET;
          return {
            id: eventId + '_' + i,
            start: { dateTime: stamp },
            originalStartTime: { dateTime: stamp }
          };
        });

        // Google filters on the event's absolute start instant.
        if (params && params.timeMin) {
          var lo = Date.parse(params.timeMin);
          items = items.filter(function (it) { return Date.parse(it.start.dateTime) >= lo; });
        }
        if (params && params.timeMax) {
          var hi = Date.parse(params.timeMax);
          items = items.filter(function (it) { return Date.parse(it.start.dateTime) < hi; });
        }
        return { items: items };
      },
      patch: function (resource, calId, eventId) {
        patches.push({ eventId: eventId, resource: resource });
        return {};
      },
      remove: function () {}
    }
  };

  var ctx = vm.createContext({
    console: console,
    Logger: { log: function () {} },
    Session: { getScriptTimeZone: function () { return 'America/Chicago'; } },
    PropertiesService: { getScriptProperties: function () { return { getProperty: function () { return 'cal-id'; } }; } },
    DriveApp: { getFileById: function () { return { getMimeType: function () { return 'image/webp'; } }; } },
    Calendar: Calendar
  });

  ['Utilities.gs', 'RecurrenceService.gs', 'CalendarService.gs'].forEach(function (f) {
    vm.runInContext(fs.readFileSync(path.join(SRC, f), 'utf8'), ctx, { filename: f });
  });

  ctx.__patches = patches;
  return ctx;
}

/** Expands a stored resource's recurrence into local YYYY-MM-DD dates. */
function expandStored(ctx, res) {
  var base = res.start.dateTime.slice(0, 10);
  if (!res.recurrence) return [base];
  var line = res.recurrence[0];
  if (line.indexOf('RRULE') === 0) {
    var count = +(line.match(/COUNT=(\d+)/) || [])[1];
    return ctx.expandRule_(line, base, count);
  }
  // RDATE;TZID=...:20260817T190000,...
  var stamps = line.split(':')[1].split(',');
  return [base].concat(stamps.map(function (s) {
    return s.slice(0, 4) + '-' + s.slice(4, 6) + '-' + s.slice(6, 8);
  }));
}

// ── Tests ───────────────────────────────────────────────────────────────────

function test_patchesEveningExceptionOnFinalDate() {
  // Regression: the exception falls on the LAST date and starts in the evening,
  // so its UTC instant lands on the following day. A query window built from
  // local dates but labelled Z excluded it, and the patch silently no-op'd.
  var ctx = makeContext();
  var result = ctx.createCalendarEvent({
    title: 'Book Club',
    description: 'd',
    occurrences: [
      { date: '2026-08-10', start_time: '19:00', end_time: '20:00' },
      { date: '2026-08-17', start_time: '19:00', end_time: '20:00' },
      { date: '2026-08-24', start_time: '18:00', end_time: '20:00' }
    ]
  });

  if (result.error) throw new Error(result.error);
  if (result.warnings.length) throw new Error('unexpected warnings: ' + result.warnings.join('; '));
  if (ctx.__patches.length !== 1) throw new Error('expected 1 patch, got ' + ctx.__patches.length);

  var p = ctx.__patches[0].resource;
  if (p.start.dateTime !== '2026-08-24T18:00:00') {
    throw new Error('patched the wrong start: ' + p.start.dateTime);
  }
  console.log('  PASS  test_patchesEveningExceptionOnFinalDate');
}

function test_patchesExceptionOnFirstDate() {
  // Mirror case: the exception is the FIRST date, guarding the timeMin edge.
  var ctx = makeContext();
  var result = ctx.createCalendarEvent({
    title: 'Book Club',
    description: 'd',
    occurrences: [
      { date: '2026-08-10', start_time: '06:00', end_time: '07:00' },
      { date: '2026-08-17', start_time: '19:00', end_time: '20:00' },
      { date: '2026-08-24', start_time: '19:00', end_time: '20:00' }
    ]
  });

  if (result.error) throw new Error(result.error);
  if (result.warnings.length) throw new Error('unexpected warnings: ' + result.warnings.join('; '));
  if (ctx.__patches.length !== 1) throw new Error('expected 1 patch, got ' + ctx.__patches.length);
  if (ctx.__patches[0].resource.start.dateTime !== '2026-08-10T06:00:00') {
    throw new Error('patched the wrong start: ' + ctx.__patches[0].resource.start.dateTime);
  }
  console.log('  PASS  test_patchesExceptionOnFirstDate');
}

function test_recurringInsertIsSingleCall() {
  var ctx = makeContext();
  var result = ctx.createCalendarEvent({
    title: 'Book Club',
    description: 'd',
    occurrences: [
      { date: '2026-08-10', start_time: '19:00', end_time: '20:00' },
      { date: '2026-08-17', start_time: '19:00', end_time: '20:00' },
      { date: '2026-08-24', start_time: '19:00', end_time: '20:00' },
      { date: '2026-08-31', start_time: '19:00', end_time: '20:00' }
    ]
  });
  if (result.method !== 'rrule') throw new Error('method: ' + result.method);
  if (result.eventIds.length !== 1) throw new Error('should be one event, got ' + result.eventIds.length);
  if (result.occurrenceCount !== 4) throw new Error('occurrenceCount: ' + result.occurrenceCount);
  console.log('  PASS  test_recurringInsertIsSingleCall');
}

function test_fallsBackToDuplicatesOnRecurringFailure() {
  var ctx = makeContext({ failRecurringInsert: true });
  var result = ctx.createCalendarEvent({
    title: 'Book Club',
    description: 'd',
    occurrences: [
      { date: '2026-08-10', start_time: '19:00', end_time: '20:00' },
      { date: '2026-08-17', start_time: '19:00', end_time: '20:00' }
    ]
  });
  if (result.method !== 'duplicate') throw new Error('method: ' + result.method);
  if (result.eventIds.length !== 2) throw new Error('expected 2 events, got ' + result.eventIds.length);
  if (!result.warnings.length) throw new Error('fallback must warn');
  console.log('  PASS  test_fallsBackToDuplicatesOnRecurringFailure');
}

function test_singleDateHasNoRecurrence() {
  var ctx = makeContext();
  var result = ctx.createCalendarEvent({
    title: 'One Off', description: 'd',
    date: '2026-04-15', start_time: '19:00', end_time: '21:00'
  });
  if (result.method !== 'single') throw new Error('method: ' + result.method);
  if (ctx.__patches.length !== 0) throw new Error('single events need no patching');
  console.log('  PASS  test_singleDateHasNoRecurrence');
}

var tests = [
  test_patchesEveningExceptionOnFinalDate,
  test_patchesExceptionOnFirstDate,
  test_recurringInsertIsSingleCall,
  test_fallsBackToDuplicatesOnRecurringFailure,
  test_singleDateHasNoRecurrence
];

var pass = 0, fail = 0;
tests.forEach(function (t) {
  try { t(); pass++; }
  catch (e) { console.log('  FAIL  ' + t.name + '\n        ' + e.message); fail++; }
});
console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
