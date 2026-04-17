import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mapConcurrent } from '../src/background/concurrency.js';

test('mapConcurrent returns fulfilled/rejected per item', async () => {
  const results = await mapConcurrent([1, 2, 3], async (n) => {
    if (n === 2) throw new Error('two is bad');
    return n * 10;
  }, { concurrency: 2 });
  assert.equal(results[0].status, 'fulfilled');
  assert.equal(results[0].value, 10);
  assert.equal(results[1].status, 'rejected');
  assert.equal(results[1].reason.message, 'two is bad');
  assert.equal(results[2].status, 'fulfilled');
  assert.equal(results[2].value, 30);
});

test('mapConcurrent preserves result order regardless of finish order', async () => {
  const delays = [30, 10, 20];
  const results = await mapConcurrent(delays, async (ms, i) => {
    await new Promise((r) => setTimeout(r, ms));
    return { i, ms };
  }, { concurrency: 3 });
  assert.deepEqual(results.map((r) => r.value.i), [0, 1, 2]);
});

test('mapConcurrent respects the concurrency limit', async () => {
  let running = 0;
  let maxRunning = 0;
  const items = Array.from({ length: 10 }, (_, i) => i);
  await mapConcurrent(items, async () => {
    running++;
    if (running > maxRunning) maxRunning = running;
    await new Promise((r) => setTimeout(r, 10));
    running--;
    return null;
  }, { concurrency: 3 });
  assert.ok(maxRunning <= 3, `maxRunning was ${maxRunning}`);
  assert.ok(maxRunning >= 2, 'should run concurrently, not fully serial');
});

test('mapConcurrent calls onItem once per item', async () => {
  const calls = [];
  await mapConcurrent([1, 2, 3], async (n) => n * 2, {
    concurrency: 2,
    onItem: (i, res) => calls.push({ i, value: res.value })
  });
  calls.sort((a, b) => a.i - b.i);
  assert.deepEqual(calls, [{ i: 0, value: 2 }, { i: 1, value: 4 }, { i: 2, value: 6 }]);
});

test('mapConcurrent handles empty input', async () => {
  const results = await mapConcurrent([], async () => 'nope', { concurrency: 3 });
  assert.deepEqual(results, []);
});

test('mapConcurrent honors AbortSignal and stops dispatching', async () => {
  const ac = new AbortController();
  const started = [];
  const p = mapConcurrent([1, 2, 3, 4, 5, 6, 7, 8], async (n) => {
    started.push(n);
    await new Promise((r) => setTimeout(r, 20));
    return n;
  }, { concurrency: 2, signal: ac.signal });
  setTimeout(() => ac.abort(), 5);
  await p;
  // First 2 start immediately; abort fires before further dispatch.
  assert.ok(started.length < 8, 'abort should prevent full dispatch');
});

test('mapConcurrent validates arguments', async () => {
  await assert.rejects(() => mapConcurrent('not-array', async () => {}), TypeError);
  await assert.rejects(() => mapConcurrent([], 'not-fn'), TypeError);
  await assert.rejects(() => mapConcurrent([], async () => {}, { concurrency: 0 }), TypeError);
});
