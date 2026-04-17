import { test } from 'node:test';
import assert from 'node:assert/strict';
import { backoffDelayMs, withRetry } from '../src/lib/retry.js';

// No-op sleep for fast tests.
const noSleep = async () => {};

test('backoffDelayMs grows exponentially within cap', () => {
  const noJitter = { jitter: 0, random: () => 0.5 };
  assert.equal(backoffDelayMs(0, noJitter), 500);
  assert.equal(backoffDelayMs(1, noJitter), 1000);
  assert.equal(backoffDelayMs(2, noJitter), 2000);
  assert.equal(backoffDelayMs(3, noJitter), 4000);
  assert.equal(backoffDelayMs(10, noJitter), 10000); // capped at max
});

test('backoffDelayMs applies jitter within band', () => {
  // With jitter=0.2 and random=0 → offset = -0.2 * capped
  let low = backoffDelayMs(0, { jitter: 0.2, random: () => 0 });
  // With random=1 → offset = +0.2 * capped
  let high = backoffDelayMs(0, { jitter: 0.2, random: () => 1 });
  assert.ok(low < 500, `expected low < 500, got ${low}`);
  assert.ok(high > 500, `expected high > 500, got ${high}`);
  assert.ok(Math.abs(high - low - 200) < 2, 'jitter band = 2 * 0.2 * 500 = 200');
});

test('withRetry returns the first success immediately', async () => {
  let calls = 0;
  const result = await withRetry(async () => { calls++; return 'ok'; }, { sleep: noSleep });
  assert.equal(result, 'ok');
  assert.equal(calls, 1);
});

test('withRetry retries up to maxAttempts before giving up', async () => {
  let calls = 0;
  await assert.rejects(
    withRetry(async () => { calls++; throw new Error('nope'); }, { maxAttempts: 3, sleep: noSleep }),
    /nope/
  );
  assert.equal(calls, 3);
});

test('withRetry succeeds on a later attempt', async () => {
  let calls = 0;
  const result = await withRetry(async () => {
    calls++;
    if (calls < 3) throw new Error('flake');
    return 'eventually';
  }, { maxAttempts: 5, sleep: noSleep });
  assert.equal(result, 'eventually');
  assert.equal(calls, 3);
});

test('withRetry does not retry when shouldRetry returns false', async () => {
  let calls = 0;
  await assert.rejects(
    withRetry(async () => { calls++; throw new Error('permanent'); }, {
      maxAttempts: 5,
      shouldRetry: () => false,
      sleep: noSleep
    }),
    /permanent/
  );
  assert.equal(calls, 1);
});

test('withRetry aborts when signal fires before attempt', async () => {
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(
    withRetry(async () => 'ok', { signal: ac.signal, sleep: noSleep }),
    (err) => err.name === 'AbortError'
  );
});

test('withRetry uses injected sleep (no wall-clock delays in tests)', async () => {
  const sleeps = [];
  const sleep = async (ms) => { sleeps.push(ms); };
  let calls = 0;
  await assert.rejects(
    withRetry(async () => { calls++; throw new Error('x'); }, {
      maxAttempts: 3,
      sleep,
      backoff: (attempt) => 100 * (attempt + 1)
    })
  );
  assert.deepEqual(sleeps, [100, 200]); // 2 sleeps between 3 attempts
});
