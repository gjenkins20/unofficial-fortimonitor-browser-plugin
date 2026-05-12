// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// FMN-161: snapshot-io envelope / parser / filename tests.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  wrapSnapshot,
  unwrapSnapshot,
  parseEnvelopeJson,
  filenameFor,
  FORMAT_NAME,
  FORMAT_VERSION,
  SnapshotIoError,
} from '../src/lib/snapshot-io.js';

function makeSnapshot(overrides = {}) {
  return {
    schema: 1,
    takenAt: '2026-05-10T14:30:00.000Z',
    durationMs: 200_000,
    deep: false,
    maxServers: 0,
    customer: { id: 7, name: 'Acme Co', subdomain: 'acme' },
    inventory: {
      servers: [
        { id: 1, name: 'fw-01', fqdn: '10.0.0.1', status: 'ok', server_template: [], tags: [] },
      ],
      users: [],
      server_templates: [],
      server_groups: [],
    },
    ...overrides,
  };
}

// =============================================================================
// wrapSnapshot + unwrapSnapshot round-trip
// =============================================================================

test('wrap + unwrap: snapshot survives JSON round-trip unchanged', () => {
  const snap = makeSnapshot();
  const envelope = wrapSnapshot(snap, {
    extensionVersion: '1.6.3',
    now: new Date('2026-05-12T19:00:00.000Z'),
  });
  assert.equal(envelope.format, FORMAT_NAME);
  assert.equal(envelope.formatVersion, FORMAT_VERSION);
  assert.equal(envelope.exportedAt, '2026-05-12T19:00:00.000Z');
  assert.equal(envelope.extensionVersion, '1.6.3');
  const text = JSON.stringify(envelope);
  const { snapshot } = parseEnvelopeJson(text);
  assert.deepEqual(snapshot, snap);
});

test('wrap: extensionVersion defaults to null when not supplied', () => {
  const envelope = wrapSnapshot(makeSnapshot());
  assert.equal(envelope.extensionVersion, null);
});

test('wrap: refuses to package a null / non-object snapshot', () => {
  assert.throws(() => wrapSnapshot(null), (err) => err instanceof SnapshotIoError && err.code === 'empty');
  assert.throws(() => wrapSnapshot('hello'), (err) => err instanceof SnapshotIoError && err.code === 'empty');
});

// =============================================================================
// unwrapSnapshot schema validation
// =============================================================================

test('unwrap: rejects unknown envelope.format', () => {
  const envelope = { format: 'some-other-tool', formatVersion: 1, snapshot: makeSnapshot() };
  assert.throws(
    () => unwrapSnapshot(envelope),
    (err) => err instanceof SnapshotIoError && err.code === 'wrong-format'
  );
});

test('unwrap: rejects future formatVersion', () => {
  const envelope = { format: FORMAT_NAME, formatVersion: 99, snapshot: makeSnapshot() };
  assert.throws(
    () => unwrapSnapshot(envelope),
    (err) => err instanceof SnapshotIoError && err.code === 'wrong-format-version'
  );
});

test('unwrap: rejects missing snapshot payload', () => {
  const envelope = { format: FORMAT_NAME, formatVersion: 1 };
  assert.throws(
    () => unwrapSnapshot(envelope),
    (err) => err instanceof SnapshotIoError && err.code === 'missing-snapshot'
  );
});

test('unwrap: rejects unknown snapshot.schema', () => {
  const envelope = {
    format: FORMAT_NAME,
    formatVersion: 1,
    snapshot: makeSnapshot({ schema: 99 }),
  };
  assert.throws(
    () => unwrapSnapshot(envelope),
    (err) => err instanceof SnapshotIoError && err.code === 'wrong-schema'
  );
});

test('unwrap: rejects snapshot missing inventory.servers', () => {
  const envelope = {
    format: FORMAT_NAME,
    formatVersion: 1,
    snapshot: makeSnapshot({ inventory: { users: [] } }),
  };
  assert.throws(
    () => unwrapSnapshot(envelope),
    (err) => err instanceof SnapshotIoError && err.code === 'missing-inventory'
  );
});

test('unwrap: rejects snapshot missing takenAt', () => {
  const snap = makeSnapshot();
  delete snap.takenAt;
  const envelope = { format: FORMAT_NAME, formatVersion: 1, snapshot: snap };
  assert.throws(
    () => unwrapSnapshot(envelope),
    (err) => err instanceof SnapshotIoError && err.code === 'missing-taken-at'
  );
});

test('unwrap: rejects non-object input', () => {
  assert.throws(
    () => unwrapSnapshot(null),
    (err) => err instanceof SnapshotIoError && err.code === 'not-envelope'
  );
  assert.throws(
    () => unwrapSnapshot('hello'),
    (err) => err instanceof SnapshotIoError && err.code === 'not-envelope'
  );
});

// =============================================================================
// parseEnvelopeJson
// =============================================================================

test('parseEnvelopeJson: surfaces JSON syntax errors with code:not-json', () => {
  assert.throws(
    () => parseEnvelopeJson('this is not json'),
    (err) => err instanceof SnapshotIoError && err.code === 'not-json'
  );
});

// =============================================================================
// filenameFor
// =============================================================================

test('filenameFor: builds fmn-snapshot-<subdomain>-<YYYYMMDD-HHmm>.json', () => {
  const snap = makeSnapshot({ takenAt: '2026-05-10T14:30:45.000Z' });
  assert.equal(filenameFor(snap), 'fmn-snapshot-acme-20260510-1430.json');
});

test('filenameFor: subdomain falls back to "unknown" when missing', () => {
  const snap = makeSnapshot({ customer: null, takenAt: '2026-05-10T14:30:00.000Z' });
  assert.equal(filenameFor(snap), 'fmn-snapshot-unknown-20260510-1430.json');
});

test('filenameFor: sanitizes weird subdomain characters', () => {
  const snap = makeSnapshot({
    customer: { id: 1, name: 'Bad Co', subdomain: ' AC ME!/?  ' },
    takenAt: '2026-05-10T14:30:00.000Z',
  });
  assert.equal(filenameFor(snap), 'fmn-snapshot-acme-20260510-1430.json');
});

test('filenameFor: bad takenAt falls through to "now"', () => {
  const snap = makeSnapshot({ takenAt: 'not-a-date' });
  const name = filenameFor(snap, { now: new Date('2026-05-12T09:00:00.000Z') });
  // We can't pin the exact stamp because the fallback path uses real "now"
  // not the now option, but the prefix must be intact and the stamp must
  // not contain NaN.
  assert.match(name, /^fmn-snapshot-acme-\d{8}-\d{4}\.json$/);
  assert.ok(!name.includes('NaN'));
});
