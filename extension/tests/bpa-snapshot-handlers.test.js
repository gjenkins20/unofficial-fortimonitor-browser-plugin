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

// =============================================================================
// FMN-161: bpa-snapshots:export
// =============================================================================

function snapFixture(overrides = {}) {
  return {
    schema: 1,
    takenAt: '2026-05-10T14:30:00.000Z',
    durationMs: 200_000,
    deep: false,
    maxServers: 0,
    customer: { id: 7, name: 'Acme Co', subdomain: 'acme' },
    inventory: { servers: [{ id: 1, name: 'fw-01' }], users: [], server_templates: [], server_groups: [] },
    ...overrides,
  };
}

test('export: current slot returns filename + JSON contents containing the snapshot', async () => {
  const local = createStorageMock({
    'fm:bpaSnapshots': { current: snapFixture(), previous: null },
  });
  const handlers = makeHandlers({ local });
  const out = await handlers['bpa-snapshots:export']({ slot: 'current' });
  assert.equal(out.ok, true);
  assert.equal(out.slot, 'current');
  assert.match(out.filename, /^fmn-snapshot-acme-\d{8}-\d{4}\.json$/);
  const parsed = JSON.parse(out.contents);
  assert.equal(parsed.format, 'fmn-toolkit-snapshot');
  assert.equal(parsed.formatVersion, 1);
  assert.equal(parsed.snapshot.schema, 1);
  assert.equal(parsed.snapshot.customer.subdomain, 'acme');
});

test('export: previous slot is selectable; empty slot returns ok:false reason:empty-slot', async () => {
  const local = createStorageMock({
    'fm:bpaSnapshots': { current: snapFixture(), previous: null },
  });
  const handlers = makeHandlers({ local });
  const previousOut = await handlers['bpa-snapshots:export']({ slot: 'previous' });
  assert.equal(previousOut.ok, false);
  assert.equal(previousOut.reason, 'empty-slot');
});

test('export: unknown slot value falls through to "current"', async () => {
  const local = createStorageMock({
    'fm:bpaSnapshots': { current: snapFixture(), previous: null },
  });
  const handlers = makeHandlers({ local });
  const out = await handlers['bpa-snapshots:export']({ slot: 'totally-bogus' });
  assert.equal(out.ok, true);
  assert.equal(out.slot, 'current');
});

// =============================================================================
// FMN-161: bpa-snapshots:import
// =============================================================================

function envelopeFor(snapshot) {
  return {
    format: 'fmn-toolkit-snapshot',
    formatVersion: 1,
    exportedAt: '2026-05-12T19:00:00.000Z',
    extensionVersion: '1.6.3',
    snapshot,
  };
}

test('import: lands snapshot in previous slot when slot is empty', async () => {
  const local = createStorageMock({
    'fm:bpaSnapshots': { current: snapFixture({ takenAt: '2026-05-12T10:00:00.000Z' }), previous: null },
  });
  const handlers = makeHandlers({ local });
  const importedAt = '2026-05-01T08:00:00.000Z';
  const out = await handlers['bpa-snapshots:import']({
    envelope: envelopeFor(snapFixture({ takenAt: importedAt })),
  });
  assert.equal(out.ok, true);
  assert.equal(out.replaced, false);
  assert.equal(out.previousTakenAt, importedAt);
  const slots = local.__raw()['fm:bpaSnapshots'];
  assert.equal(slots.previous.takenAt, importedAt);
  // current must be untouched
  assert.equal(slots.current.takenAt, '2026-05-12T10:00:00.000Z');
});

test('import: refuses to overwrite an existing previous without force flag', async () => {
  const existingPrev = snapFixture({ takenAt: '2026-05-05T00:00:00.000Z' });
  const local = createStorageMock({
    'fm:bpaSnapshots': { current: snapFixture(), previous: existingPrev },
  });
  const handlers = makeHandlers({ local });
  const incoming = snapFixture({ takenAt: '2026-04-01T00:00:00.000Z' });
  const out = await handlers['bpa-snapshots:import']({ envelope: envelopeFor(incoming) });
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'previous-exists');
  assert.equal(out.existingPreviousTakenAt, '2026-05-05T00:00:00.000Z');
  assert.equal(out.incomingTakenAt, '2026-04-01T00:00:00.000Z');
  // storage untouched
  const slots = local.__raw()['fm:bpaSnapshots'];
  assert.equal(slots.previous.takenAt, '2026-05-05T00:00:00.000Z');
});

test('import: force:true overwrites an existing previous', async () => {
  const local = createStorageMock({
    'fm:bpaSnapshots': {
      current: snapFixture(),
      previous: snapFixture({ takenAt: '2026-05-05T00:00:00.000Z' }),
    },
  });
  const handlers = makeHandlers({ local });
  const incoming = snapFixture({ takenAt: '2026-04-01T00:00:00.000Z' });
  const out = await handlers['bpa-snapshots:import']({
    envelope: envelopeFor(incoming),
    force: true,
  });
  assert.equal(out.ok, true);
  assert.equal(out.replaced, true);
  const slots = local.__raw()['fm:bpaSnapshots'];
  assert.equal(slots.previous.takenAt, '2026-04-01T00:00:00.000Z');
});

test('import: bad envelope returns ok:false with schema-io error code', async () => {
  const handlers = makeHandlers();
  const out = await handlers['bpa-snapshots:import']({
    envelope: { format: 'something-else', formatVersion: 1, snapshot: snapFixture() },
  });
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'wrong-format');
});

test('import: future formatVersion rejected with wrong-format-version', async () => {
  const handlers = makeHandlers();
  const bad = { format: 'fmn-toolkit-snapshot', formatVersion: 99, snapshot: snapFixture() };
  const out = await handlers['bpa-snapshots:import']({ envelope: bad });
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'wrong-format-version');
});

// =============================================================================
// FMN-161: export -> import -> diff round-trip
// =============================================================================

test('round-trip: exported snapshot imports back identically into previous slot', async () => {
  // Tenant takes a snapshot, exports it, then later (after a reinstall)
  // imports the file and runs diff against a fresh current.
  const exportSourceLocal = createStorageMock({
    'fm:bpaSnapshots': {
      current: snapFixture({ takenAt: '2026-05-01T00:00:00.000Z' }),
      previous: null,
    },
  });
  const exportHandlers = makeHandlers({ local: exportSourceLocal });
  const exportOut = await exportHandlers['bpa-snapshots:export']({ slot: 'current' });
  assert.equal(exportOut.ok, true);

  // ... time passes, profile reset, new current taken ...
  const importTargetLocal = createStorageMock({
    'fm:bpaSnapshots': {
      current: snapFixture({
        takenAt: '2026-05-12T00:00:00.000Z',
        inventory: { servers: [{ id: 2, name: 'new-fw' }], users: [], server_templates: [], server_groups: [] },
      }),
      previous: null,
    },
  });
  const importHandlers = makeHandlers({ local: importTargetLocal });
  const importOut = await importHandlers['bpa-snapshots:import']({
    envelope: JSON.parse(exportOut.contents),
  });
  assert.equal(importOut.ok, true);
  assert.equal(importOut.previousTakenAt, '2026-05-01T00:00:00.000Z');

  // Diff handler sees the imported snapshot as previous, fresh as current.
  const diffOut = await importHandlers['bpa-snapshots:diff']();
  assert.equal(diffOut.ok, true);
  assert.equal(diffOut.prevTakenAt, '2026-05-01T00:00:00.000Z');
  assert.equal(diffOut.currTakenAt, '2026-05-12T00:00:00.000Z');
  // server id 1 was in the imported snapshot but not the new current -> removed.
  // server id 2 is in current only -> added.
  assert.equal(diffOut.counts.added, 1);
  assert.equal(diffOut.counts.removed, 1);
});

// =====================================================================
// Phase 2.3: bpa-snapshots:list + diff-by-id
// =====================================================================

test('list: empty store returns ok:true with empty items', async () => {
  const handlers = makeHandlers();
  const out = await handlers['bpa-snapshots:list']();
  assert.equal(out.ok, true);
  assert.deepEqual(out.items, []);
});

test('list: returns one summary per stored snapshot, most-recent first', async () => {
  const local = createStorageMock({
    'fm:bpaSnapshots': {
      schema: 2,
      maxSnapshots: 10,
      current: snapFixture({ takenAt: '2026-05-12T00:00:00.000Z', id: 'snap-c' }),
      previous: snapFixture({ takenAt: '2026-05-11T00:00:00.000Z', id: 'snap-p' }),
      history: [snapFixture({ takenAt: '2026-05-10T00:00:00.000Z', id: 'snap-h0' })],
    },
  });
  const handlers = makeHandlers({ local });
  const out = await handlers['bpa-snapshots:list']();
  assert.equal(out.ok, true);
  assert.equal(out.items.length, 3);
  assert.equal(out.items[0].id, 'snap-c');
  assert.equal(out.items[1].id, 'snap-p');
  assert.equal(out.items[2].id, 'snap-h0');
});

test('diff: with baselineId + currentId pair from history, computes diff', async () => {
  const local = createStorageMock({
    'fm:bpaSnapshots': {
      schema: 2,
      maxSnapshots: 10,
      current: snapFixture({
        takenAt: '2026-05-12T00:00:00.000Z',
        id: 'snap-c',
        inventory: { servers: [{ id: 1, name: 'fw' }, { id: 2, name: 'sw' }], users: [], server_templates: [], server_groups: [] },
      }),
      previous: snapFixture({
        takenAt: '2026-05-11T00:00:00.000Z',
        id: 'snap-p',
        inventory: { servers: [{ id: 1, name: 'fw' }], users: [], server_templates: [], server_groups: [] },
      }),
      history: [
        snapFixture({
          takenAt: '2026-05-10T00:00:00.000Z',
          id: 'snap-h0',
          inventory: { servers: [], users: [], server_templates: [], server_groups: [] },
        }),
      ],
    },
  });
  const handlers = makeHandlers({ local });
  // Diff history vs current.
  const out = await handlers['bpa-snapshots:diff']({ baselineId: 'snap-h0', currentId: 'snap-c' });
  assert.equal(out.ok, true);
  assert.equal(out.prevTakenAt, '2026-05-10T00:00:00.000Z');
  assert.equal(out.currTakenAt, '2026-05-12T00:00:00.000Z');
  assert.equal(out.counts.added, 2);
});

test('diff: with unknown id returns ok:false reason:unknown-id', async () => {
  const local = createStorageMock({
    'fm:bpaSnapshots': { current: snapFixture(), previous: null },
  });
  const handlers = makeHandlers({ local });
  const out = await handlers['bpa-snapshots:diff']({ baselineId: 'nope', currentId: 'also-nope' });
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'unknown-id');
});

test('diff: default (no payload) still diffs current vs previous', async () => {
  const local = createStorageMock({
    'fm:bpaSnapshots': {
      current: snapFixture({
        takenAt: '2026-05-12T00:00:00.000Z',
        inventory: { servers: [{ id: 1, name: 'fw' }], users: [], server_templates: [], server_groups: [] },
      }),
      previous: snapFixture({
        takenAt: '2026-05-11T00:00:00.000Z',
        inventory: { servers: [], users: [], server_templates: [], server_groups: [] },
      }),
    },
  });
  const handlers = makeHandlers({ local });
  const out = await handlers['bpa-snapshots:diff']();
  assert.equal(out.ok, true);
  assert.equal(out.counts.added, 1);
});

test('diff: response carries .sections with all four sections', async () => {
  const local = createStorageMock({
    'fm:bpaSnapshots': {
      current: snapFixture(),
      previous: snapFixture(),
    },
  });
  const handlers = makeHandlers({ local });
  const out = await handlers['bpa-snapshots:diff']();
  assert.ok(out.sections);
  assert.ok(out.sections.servers);
  assert.ok(out.sections.users);
  assert.ok(out.sections.server_templates);
  assert.ok(out.sections.server_groups);
});

// =====================================================================
// Phase 2.5 prerequisites: get-config / set-max / clear-all
// =====================================================================

test('get-config: defaults to 10 when nothing stored', async () => {
  const handlers = makeHandlers();
  const out = await handlers['bpa-snapshots:get-config']();
  assert.equal(out.ok, true);
  assert.equal(out.maxSnapshots, 10);
});

test('set-max: applies clamped value and persists', async () => {
  const local = createStorageMock();
  const handlers = makeHandlers({ local });
  const out = await handlers['bpa-snapshots:set-max']({ maxSnapshots: 5 });
  assert.equal(out.ok, true);
  assert.equal(out.maxSnapshots, 5);
  const get = await handlers['bpa-snapshots:get-config']();
  assert.equal(get.maxSnapshots, 5);
});

test('set-max: rejects non-finite input', async () => {
  const handlers = makeHandlers();
  const out = await handlers['bpa-snapshots:set-max']({ maxSnapshots: 'a lot' });
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'bad-input');
});

test('clear-all: wipes the store, list returns empty after', async () => {
  const local = createStorageMock({
    'fm:bpaSnapshots': { current: snapFixture(), previous: snapFixture() },
  });
  const handlers = makeHandlers({ local });
  await handlers['bpa-snapshots:clear-all']();
  const list = await handlers['bpa-snapshots:list']();
  assert.deepEqual(list.items, []);
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
