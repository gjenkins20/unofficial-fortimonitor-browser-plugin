import { test } from 'node:test';
import assert from 'node:assert/strict';
import { executeQueue, isRetryable } from '../src/background/executor.js';
import { FortimonitorError } from '../src/lib/fortimonitor-client.js';

const noSleep = async () => {};

function makeEntry(overrides = {}) {
  return {
    id: overrides.id ?? 'e_' + Math.random().toString(36).slice(2, 8),
    serverId: overrides.serverId ?? 42024060,
    deviceName: overrides.deviceName ?? 'FGT-Test',
    intendedAction: overrides.intendedAction ?? {
      portSelectionType: 'manual',
      selectedIndices: ['0', '1'],
      totalPortCount: 3
    },
    status: overrides.status ?? 'pending',
    attempts: overrides.attempts ?? []
  };
}

function fakeClient(saveImpl) {
  return {
    async savePortSelection(args) {
      return saveImpl(args);
    }
  };
}

// ----- isRetryable --------------------------------------------------

test('isRetryable returns true for network errors (no status)', () => {
  assert.equal(isRetryable(new FortimonitorError('timeout', { phase: 'write' })), true);
});

test('isRetryable returns true for 500/502/503/504/429/408', () => {
  for (const s of [500, 502, 503, 504, 429, 408]) {
    assert.equal(isRetryable(new FortimonitorError('x', { status: s, phase: 'write' })), true, `status ${s}`);
  }
});

test('isRetryable returns false for 4xx client errors except 408/429', () => {
  for (const s of [400, 401, 403, 404, 422]) {
    assert.equal(isRetryable(new FortimonitorError('x', { status: s, phase: 'write' })), false, `status ${s}`);
  }
});

test('isRetryable returns false for auth phase errors', () => {
  assert.equal(isRetryable(new FortimonitorError('no cookie', { phase: 'auth' })), false);
});

test('isRetryable returns false for AbortError', () => {
  const err = new Error('aborted'); err.name = 'AbortError';
  assert.equal(isRetryable(err), false);
});

// ----- executeQueue happy path --------------------------------------

test('executeQueue runs every pending entry and marks them succeeded', async () => {
  const client = fakeClient(async () => ({ success: true }));
  const entries = [makeEntry(), makeEntry(), makeEntry()];
  const results = await executeQueue(entries, { client, sleep: noSleep });
  assert.equal(results.length, 3);
  for (const r of results) {
    assert.equal(r.status, 'succeeded');
    assert.equal(r.attempts, 1);
  }
});

test('executeQueue retries a transient failure and records attempts', async () => {
  let calls = 0;
  const client = fakeClient(async () => {
    calls++;
    if (calls < 3) throw new FortimonitorError('x', { status: 503, phase: 'write' });
    return { success: true };
  });
  const results = await executeQueue([makeEntry()], { client, sleep: noSleep });
  assert.equal(results[0].status, 'succeeded');
  assert.equal(results[0].attempts, 3);
});

test('executeQueue gives up after maxAttempts and marks failed', async () => {
  const client = fakeClient(async () => {
    throw new FortimonitorError('x', { status: 503, phase: 'write' });
  });
  const results = await executeQueue([makeEntry()], { client, sleep: noSleep, maxAttempts: 3 });
  assert.equal(results[0].status, 'failed');
  assert.equal(results[0].attempts, 3);
});

test('executeQueue does NOT retry permanent failures', async () => {
  let calls = 0;
  const client = fakeClient(async () => {
    calls++;
    throw new FortimonitorError('forbidden', { status: 403, phase: 'write' });
  });
  const results = await executeQueue([makeEntry()], { client, sleep: noSleep, maxAttempts: 3 });
  assert.equal(results[0].status, 'failed');
  assert.equal(results[0].attempts, 1);
  assert.equal(calls, 1);
});

test('executeQueue does NOT retry auth failures', async () => {
  let calls = 0;
  const client = fakeClient(async () => {
    calls++;
    throw new FortimonitorError('no cookie', { phase: 'auth' });
  });
  const results = await executeQueue([makeEntry()], { client, sleep: noSleep });
  assert.equal(results[0].status, 'failed');
  assert.equal(calls, 1);
});

// ----- verbose mode -------------------------------------------------

test('verbose mode forces serial execution (concurrency 1)', async () => {
  let running = 0;
  let maxRunning = 0;
  const client = {
    async savePortSelection() {
      running++;
      if (running > maxRunning) maxRunning = running;
      await new Promise((r) => setTimeout(r, 10));
      running--;
      return { success: true };
    }
  };
  const entries = [makeEntry(), makeEntry(), makeEntry(), makeEntry()];
  await executeQueue(entries, { client, sleep: noSleep, verbose: true, concurrency: 3 });
  assert.equal(maxRunning, 1, 'verbose=true must force concurrency=1');
});

// ----- callbacks ----------------------------------------------------

test('executeQueue fires onEntryStart and onEntryDone per entry', async () => {
  const starts = [];
  const dones = [];
  const client = fakeClient(async () => ({ success: true }));
  const entries = [makeEntry(), makeEntry()];
  await executeQueue(entries, {
    client,
    sleep: noSleep,
    onEntryStart: (i, e) => starts.push({ i, id: e.id }),
    onEntryDone: (i, r) => dones.push({ i, status: r.status })
  });
  assert.equal(starts.length, 2);
  assert.equal(dones.length, 2);
});

test('executeQueue skips already-terminal entries', async () => {
  let calls = 0;
  const client = fakeClient(async () => { calls++; return { success: true }; });
  const entries = [
    makeEntry({ status: 'succeeded' }),
    makeEntry({ status: 'skipped' }),
    makeEntry({ status: 'pending' })
  ];
  const results = await executeQueue(entries, { client, sleep: noSleep });
  assert.equal(results.length, 1, 'only the pending entry should run');
  assert.equal(calls, 1);
});

// ----- arg validation -----------------------------------------------

test('executeQueue requires a client', async () => {
  await assert.rejects(() => executeQueue([]), TypeError);
});
