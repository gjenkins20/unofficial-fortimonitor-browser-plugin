// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// FMN-164: unit tests for the bpa-snapshots:* handler set. Covers the
// two estimate branches (last-run wins / 180s default) and the in-flight
// pickup path for bpa-snapshots:status.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBpaSnapshotHandlers } from '../src/background/bpa-snapshot-handlers.js';
import { createStorageMock } from './fixtures/chrome-mocks.js';

function makeHandlers({ local, session } = {}) {
  return createBpaSnapshotHandlers({
    storage: local ?? createStorageMock(),
    sessionStorage: session ?? createStorageMock(),
  });
}

// =============================================================================
// bpa-snapshots:estimate
// =============================================================================

test('estimate: no prior snapshot -> default 180s, basedOn:default', async () => {
  const handlers = makeHandlers();
  const out = await handlers['bpa-snapshots:estimate']();
  assert.equal(out.basedOn, 'default');
  assert.equal(out.estimatedSeconds, 180);
  assert.equal(out.lastServerCount, null);
});

test('estimate: last-snapshot duration is returned verbatim', async () => {
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
  const handlers = makeHandlers({ local });
  const out = await handlers['bpa-snapshots:estimate']();
  assert.equal(out.basedOn, 'last-run');
  assert.equal(out.estimatedSeconds, 240);
  assert.equal(out.lastServerCount, 150);
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
