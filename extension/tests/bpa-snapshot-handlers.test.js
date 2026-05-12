// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// FMN-164: unit tests for the bpa-snapshots:* handler set. Covers the
// three estimate branches (no API key / probe success / probe failure)
// and the in-flight pickup path for bpa-snapshots:status.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBpaSnapshotHandlers } from '../src/background/bpa-snapshot-handlers.js';
import { createStorageMock } from './fixtures/chrome-mocks.js';

// Fake panopta client: configurable response for listServers and an error
// switch so the probe-failure branch can be exercised without a real fetch.
function fakeClient({ totalCount = 0, throwOnList = false } = {}) {
  return {
    async listServers({ limit = 50, offset = 0 } = {}) {
      if (throwOnList) throw new Error('probe failed');
      // Mirror the live v2 envelope: { meta, server_list } per
      // fortimonitor_v2_list_wrapper_keys.md.
      return {
        meta: { total_count: totalCount, limit, offset },
        server_list: [],
      };
    },
  };
}

function makeHandlers({ getClient, local, session } = {}) {
  return createBpaSnapshotHandlers({
    getClient,
    storage: local ?? createStorageMock(),
    sessionStorage: session ?? createStorageMock(),
  });
}

// =============================================================================
// bpa-snapshots:estimate
// =============================================================================

test('estimate: no API key -> default 180s, basedOn:default', async () => {
  // getClient throwing simulates "no API key configured". The handler
  // must fall through silently to the conservative default.
  const handlers = makeHandlers({
    getClient: async () => { throw new Error('No API key configured.'); },
  });
  const out = await handlers['bpa-snapshots:estimate']();
  assert.equal(out.basedOn, 'default');
  assert.equal(out.estimatedSeconds, 180);
  assert.equal(out.serverCount, null);
  assert.equal(out.lastServerCount, null);
});

test('estimate: probe success -> basedOn:projected with serverCount and minutes-shaped seconds', async () => {
  // 200 servers / 0.7 sps = ~286s + 30s baseline = ~316s. Floor at the
  // 180s default applies only when projection falls below it; here we
  // expect the projected value.
  const handlers = makeHandlers({
    getClient: async () => fakeClient({ totalCount: 200 }),
  });
  const out = await handlers['bpa-snapshots:estimate']();
  assert.equal(out.basedOn, 'projected');
  assert.equal(out.serverCount, 200);
  // 30 baseline + 200/0.7 = ~316s. Tolerate +/- a few seconds for the
  // rounding choice if the constant is tweaked later.
  assert.ok(out.estimatedSeconds >= 300 && out.estimatedSeconds <= 330,
    `expected ~316s, got ${out.estimatedSeconds}`);
});

test('estimate: probe success but tiny tenant -> projection clamped to 180s default floor', async () => {
  // 5 servers projects to ~37s, but we never want to undersell first-run
  // wait. The handler floors the projected value at the 180s default.
  const handlers = makeHandlers({
    getClient: async () => fakeClient({ totalCount: 5 }),
  });
  const out = await handlers['bpa-snapshots:estimate']();
  assert.equal(out.basedOn, 'projected');
  assert.equal(out.serverCount, 5);
  assert.equal(out.estimatedSeconds, 180);
});

test('estimate: probe failure -> default 180s, basedOn:default', async () => {
  // listServers throws (network blip, expired key, server-side error).
  // The handler must not propagate the error; it falls back to the
  // 180s default. No probe cache write either.
  const session = createStorageMock();
  const handlers = makeHandlers({
    getClient: async () => fakeClient({ throwOnList: true }),
    session,
  });
  const out = await handlers['bpa-snapshots:estimate']();
  assert.equal(out.basedOn, 'default');
  assert.equal(out.estimatedSeconds, 180);
  // Nothing should have been cached because the probe didn't succeed.
  const raw = session.__raw();
  assert.equal(raw['fmn.bpaSnapshot.serverCountProbe'], undefined);
});

test('estimate: probe result is cached in session storage and reused on repeat call', async () => {
  // Counts how many times the fake client gets created. The cache hit on
  // the 2nd estimate call must skip the factory entirely.
  let factoryCalls = 0;
  const session = createStorageMock();
  const handlers = makeHandlers({
    getClient: async () => {
      factoryCalls += 1;
      return fakeClient({ totalCount: 120 });
    },
    session,
  });
  const a = await handlers['bpa-snapshots:estimate']();
  const b = await handlers['bpa-snapshots:estimate']();
  assert.equal(a.basedOn, 'projected');
  assert.equal(b.basedOn, 'projected');
  assert.equal(a.serverCount, 120);
  assert.equal(b.serverCount, 120);
  // First call hits the API, second call hits the cache.
  assert.equal(factoryCalls, 1, 'expected the 2nd estimate to use cached probe result');
});

test('estimate: last-snapshot duration wins over the probe', async () => {
  // If a snapshot has run before, its measured durationMs is the most
  // accurate signal we have. The probe must not be called at all.
  let factoryCalls = 0;
  const local = createStorageMock({
    // Matches STORAGE_KEY in extension/src/lib/bpa-snapshots.js.
    'fm:bpaSnapshots': {
      current: {
        takenAt: '2026-05-01T00:00:00.000Z',
        durationMs: 240_000,
        inventory: { servers: new Array(150).fill({}) },
      },
      previous: null,
    },
  });
  const handlers = makeHandlers({
    getClient: async () => { factoryCalls += 1; return fakeClient({ totalCount: 999 }); },
    local,
  });
  const out = await handlers['bpa-snapshots:estimate']();
  assert.equal(out.basedOn, 'last-run');
  assert.equal(out.estimatedSeconds, 240);
  assert.equal(out.lastServerCount, 150);
  assert.equal(factoryCalls, 0, 'probe must be skipped when a last-run duration exists');
});

// =============================================================================
// bpa-snapshots:status - in-flight pickup
// =============================================================================

test('status: idle state -> runInFlight false, runStartedAt null', async () => {
  const handlers = makeHandlers();
  const out = await handlers['bpa-snapshots:status']();
  assert.equal(out.runInFlight, false);
  assert.equal(out.runStartedAt, null);
  assert.equal(out.hasCurrent, false);
  assert.equal(out.hasPrevious, false);
});

test('status: in-flight pickup from persisted session storage', async () => {
  // Simulates a card mount AFTER the SW idled out mid-run. The in-memory
  // runInFlight flag is false (this is a fresh handler instance), but the
  // persisted run state on chrome.storage.session signals "a run started
  // at <startedAt> and we never wrote a completion record". The status
  // handler must surface runInFlight:true + runStartedAt so the UI can
  // resume the elapsed counter.
  const startedAt = Date.now() - 45_000;
  const session = createStorageMock({
    'fmn.bpaSnapshot.runState': { startedAt },
  });
  const handlers = makeHandlers({ session });
  const out = await handlers['bpa-snapshots:status']();
  assert.equal(out.runInFlight, true);
  assert.equal(out.runStartedAt, startedAt);
});

test('status: in-flight in-memory (same-SW-session) returns the runtime start time', async () => {
  // Park take() on a never-resolving getClient. While the take handler
  // is awaiting the factory, runInFlight is true and runStartedAt is
  // set; the status handler must surface both. We deliberately don't
  // resolve the factory so the finally block never runs - the test
  // process exits before the suspended take matters.
  const handlers = createBpaSnapshotHandlers({
    storage: createStorageMock(),
    sessionStorage: createStorageMock(),
    getClient: () => new Promise(() => { /* hangs forever */ }),
  });
  // Kick off the take in the background. Suppress an eventual
  // rejection so node doesn't whine on shutdown.
  const takePromise = handlers['bpa-snapshots:take']({}).catch(() => {});
  // Yield so the take handler runs past `runInFlight = true; runStartedAt = Date.now()`
  // and lands on the factory await.
  await new Promise((r) => setImmediate(r));
  const out = await handlers['bpa-snapshots:status']();
  assert.equal(out.runInFlight, true);
  assert.equal(typeof out.runStartedAt, 'number');
  // Don't await takePromise - it intentionally never resolves.
  void takePromise;
});
