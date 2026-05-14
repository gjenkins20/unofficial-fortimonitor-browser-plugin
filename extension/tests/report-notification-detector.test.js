// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// FMN-191: unit tests for the report-notification detector state machine.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  initialState,
  classifyPoll,
  notificationText,
  appendHistory,
  extractCompletedReports,
  MAX_HISTORY_ENTRIES,
} from '../src/lib/report-notification-detector.js';

test('initialState: baseline null + zero notification count', () => {
  const s = initialState();
  assert.equal(s.baseline, null);
  assert.equal(s.lastPollAt, null);
  assert.equal(s.notifiedCount, 0);
});

test('first poll calibrates baseline without firing a notification', () => {
  const { nextState, notify } = classifyPoll(initialState(), 33, 1_700_000_000_000);
  assert.equal(notify, null);
  assert.equal(nextState.baseline, 33);
  assert.equal(nextState.notifiedCount, 0);
  assert.equal(typeof nextState.lastPollAt, 'string');
});

test('second poll with unchanged count: no notification, lastPollAt refreshes', () => {
  const first = classifyPoll(initialState(), 33, 1_700_000_000_000).nextState;
  const { nextState, notify } = classifyPoll(first, 33, 1_700_000_300_000);
  assert.equal(notify, null);
  assert.equal(nextState.baseline, 33);
  assert.notEqual(nextState.lastPollAt, first.lastPollAt);
});

test('count increase by 1 fires single-report notification + updates baseline', () => {
  const baseline = classifyPoll(initialState(), 33, 1_700_000_000_000).nextState;
  const { nextState, notify } = classifyPoll(baseline, 34, 1_700_000_300_000);
  assert.ok(notify);
  assert.equal(notify.delta, 1);
  assert.equal(notify.baseline, 33);
  assert.equal(notify.newTotal, 34);
  assert.equal(nextState.baseline, 34);
  assert.equal(nextState.notifiedCount, 1);
});

test('count jump of 3 fires one notification with delta=3', () => {
  const baseline = classifyPoll(initialState(), 33).nextState;
  const { nextState, notify } = classifyPoll(baseline, 36);
  assert.equal(notify.delta, 3);
  assert.equal(notify.baseline, 33);
  assert.equal(notify.newTotal, 36);
  assert.equal(nextState.baseline, 36);
});

test('count regression (33 -> 32) does NOT lower baseline or notify', () => {
  const baseline = classifyPoll(initialState(), 33).nextState;
  const { nextState, notify } = classifyPoll(baseline, 32);
  assert.equal(notify, null);
  assert.equal(nextState.baseline, 33);
});

test('after regression, next legitimate increase re-fires from the held baseline', () => {
  const baseline = classifyPoll(initialState(), 33).nextState;
  const afterDip = classifyPoll(baseline, 32).nextState;
  const { notify } = classifyPoll(afterDip, 34);
  assert.equal(notify.delta, 1); // 34 - 33 (the held baseline), not 34 - 32
});

test('invalid input keeps state unchanged', () => {
  const baseline = classifyPoll(initialState(), 33).nextState;
  const { nextState, notify } = classifyPoll(baseline, NaN);
  assert.equal(notify, null);
  assert.equal(nextState.baseline, 33);
  const negative = classifyPoll(baseline, -1);
  assert.equal(negative.notify, null);
  assert.equal(negative.nextState.baseline, 33);
});

test('notifiedCount increments across multiple notifications', () => {
  let s = classifyPoll(initialState(), 33).nextState;
  s = classifyPoll(s, 34).nextState;
  s = classifyPoll(s, 35).nextState;
  s = classifyPoll(s, 37).nextState;
  assert.equal(s.notifiedCount, 3);
  assert.equal(s.baseline, 37);
});

test('notificationText: singular for delta=1', () => {
  const { title, message } = notificationText({ delta: 1 });
  assert.equal(title, 'FortiMonitor report ready');
  assert.match(message, /finished generating/i);
  assert.match(message, /^A canned report/);
});

test('notificationText: plural for delta>1', () => {
  const { message } = notificationText({ delta: 3 });
  assert.match(message, /^3 canned reports/);
});

// =====================================================================
// History ring buffer (appendHistory)
// =====================================================================

test('appendHistory: empty prior + valid notify yields a single entry', () => {
  const out = appendHistory(null, { delta: 1, baseline: 33, newTotal: 34 }, 1_700_000_000_000);
  assert.equal(out.length, 1);
  assert.equal(out[0].delta, 1);
  assert.equal(out[0].baseline, 33);
  assert.equal(out[0].newTotal, 34);
  assert.equal(typeof out[0].id, 'string');
  assert.equal(typeof out[0].takenAt, 'string');
});

test('appendHistory: most-recent entry is first', () => {
  let h = [];
  h = appendHistory(h, { delta: 1, baseline: 33, newTotal: 34 }, 1_700_000_000_000);
  h = appendHistory(h, { delta: 2, baseline: 34, newTotal: 36 }, 1_700_000_300_000);
  assert.equal(h.length, 2);
  assert.equal(h[0].delta, 2);
  assert.equal(h[1].delta, 1);
});

test('appendHistory: caps at MAX_HISTORY_ENTRIES', () => {
  let h = [];
  for (let i = 1; i <= MAX_HISTORY_ENTRIES + 5; i++) {
    h = appendHistory(h, { delta: 1, baseline: i, newTotal: i + 1 }, 1_700_000_000_000 + i * 1000);
  }
  assert.equal(h.length, MAX_HISTORY_ENTRIES);
  // Latest entry's baseline = MAX_HISTORY_ENTRIES + 5
  assert.equal(h[0].baseline, MAX_HISTORY_ENTRIES + 5);
});

test('appendHistory: invalid notify is a no-op', () => {
  const before = [{ id: 'x', delta: 1 }];
  assert.deepEqual(appendHistory(before, null), before);
  assert.deepEqual(appendHistory(before, { delta: 0 }), before);
  assert.deepEqual(appendHistory(before, { delta: -1 }), before);
});

// =====================================================================
// extractCompletedReports + appendHistory with per-report rows
// =====================================================================

const SAMPLE_HISTORY_ROW = [
  [5, 'Agent Status Report'],
  "Agent Status Report&nbsp;<span style='margin-left:5px;' class='pa-badge pa-badge_info' title='You receive this report'>Me</span> ",
  'Greg Jenkins -TCSM',
  '2026-05-14 07:55 PDT',
  'gjenkins20+fortimonitor@gmail.com',
  'gjenkins20+fortimonitor@gmail.com',
  { title: 'Download', link: '/report/downloadCannedReport?report_history_id=1147270' },
  -1778770520.0,
];

test('extractCompletedReports: returns clean field set for one row', () => {
  const out = extractCompletedReports([SAMPLE_HISTORY_ROW], 1);
  assert.equal(out.length, 1);
  const r = out[0];
  assert.equal(r.reportTypeId, 5);
  assert.equal(r.reportTypeName, 'Agent Status Report');
  // HTML stripped + pa-badge content excluded (no trailing "Me").
  assert.equal(r.reportName, 'Agent Status Report');
  assert.equal(r.createdBy, 'Greg Jenkins -TCSM');
  assert.equal(r.lastSent, '2026-05-14 07:55 PDT');
  assert.equal(r.downloadLink, '/report/downloadCannedReport?report_history_id=1147270');
  assert.equal(r.historyId, 1147270);
});

test('extractCompletedReports: respects the limit', () => {
  const out = extractCompletedReports([SAMPLE_HISTORY_ROW, SAMPLE_HISTORY_ROW, SAMPLE_HISTORY_ROW], 2);
  assert.equal(out.length, 2);
});

test('extractCompletedReports: empty / invalid input returns empty array', () => {
  assert.deepEqual(extractCompletedReports(null, 1), []);
  assert.deepEqual(extractCompletedReports([], 1), []);
  assert.deepEqual(extractCompletedReports([SAMPLE_HISTORY_ROW], 0), []);
  assert.deepEqual(extractCompletedReports([SAMPLE_HISTORY_ROW], NaN), []);
});

test('extractCompletedReports: missing optional fields fall back to nulls', () => {
  const minimal = [[null, null], '', '', '', '', '', null, 0];
  const [r] = extractCompletedReports([minimal], 1);
  assert.equal(r.reportTypeId, null);
  assert.equal(r.reportTypeName, null);
  assert.equal(r.downloadLink, null);
  assert.equal(r.historyId, null);
});

test('appendHistory: when reports[] is provided, one entry per report', () => {
  const notify = {
    delta: 2,
    baseline: 33,
    newTotal: 35,
    reports: [
      { reportName: 'Agent Status Report', lastSent: '2026-05-14 07:55 PDT', downloadLink: '/report/downloadCannedReport?report_history_id=1', historyId: 1, reportTypeName: 'Agent Status Report' },
      { reportName: 'Incident Report', lastSent: '2026-05-14 07:50 PDT', downloadLink: '/report/downloadCannedReport?report_history_id=2', historyId: 2, reportTypeName: 'Incident Report' },
    ],
  };
  const out = appendHistory([], notify, 1_700_000_000_000);
  assert.equal(out.length, 2);
  assert.equal(out[0].reportName, 'Agent Status Report');
  assert.equal(out[0].downloadLink, '/report/downloadCannedReport?report_history_id=1');
  assert.equal(out[1].reportName, 'Incident Report');
});

test('appendHistory: per-report entries respect the cap (newest wins)', () => {
  let h = [];
  for (let i = 0; i < MAX_HISTORY_ENTRIES + 3; i++) {
    h = appendHistory(h, {
      delta: 1,
      baseline: i,
      newTotal: i + 1,
      reports: [{ reportName: `Report ${i}`, lastSent: `T${i}`, historyId: i }],
    }, 1_700_000_000_000 + i * 1000);
  }
  assert.equal(h.length, MAX_HISTORY_ENTRIES);
  // Newest entry's name = highest i.
  assert.equal(h[0].reportName, `Report ${MAX_HISTORY_ENTRIES + 3 - 1}`);
});

test('appendHistory: legacy notify (no reports) still produces a count entry', () => {
  const out = appendHistory([], { delta: 2, baseline: 5, newTotal: 7 }, 1_700_000_000_000);
  assert.equal(out.length, 1);
  assert.equal(out[0].delta, 2);
  assert.equal(out[0].reportName, undefined);
});
