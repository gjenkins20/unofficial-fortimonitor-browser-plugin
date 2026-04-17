import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fingerprintDevice, canonicalizePorts } from '../src/background/fingerprint.js';

const BASE_PORTS = [
  { name: 'wan2', admin_status: 'up', oper_status: 'down' },
  { name: 'port1', admin_status: 'up', oper_status: 'down' },
  { name: 'DATA', admin_status: 'up', oper_status: 'up' }
];

test('canonicalizePorts sorts by name for determinism', () => {
  const a = canonicalizePorts(BASE_PORTS);
  const b = canonicalizePorts([...BASE_PORTS].reverse());
  assert.equal(a, b);
  // sorted alphabetically: DATA, port1, wan2
  assert.match(a, /^DATA\|/);
});

test('canonicalizePorts lowercases statuses', () => {
  const canonical = canonicalizePorts([
    { name: 'wan2', admin_status: 'Up', oper_status: 'DOWN' }
  ]);
  assert.equal(canonical, 'wan2|up|down');
});

test('canonicalizePorts handles missing status fields', () => {
  const canonical = canonicalizePorts([{ name: 'wan2' }]);
  assert.equal(canonical, 'wan2||');
});

test('canonicalizePorts handles empty input', () => {
  assert.equal(canonicalizePorts([]), '');
  assert.equal(canonicalizePorts(null), '');
  assert.equal(canonicalizePorts(undefined), '');
});

test('fingerprintDevice is deterministic for the same logical input', async () => {
  const a = await fingerprintDevice({ ports: BASE_PORTS });
  const b = await fingerprintDevice({ ports: [...BASE_PORTS].reverse() });
  assert.equal(a, b);
});

test('fingerprintDevice produces 64-char hex (SHA-256)', async () => {
  const fp = await fingerprintDevice({ ports: BASE_PORTS });
  assert.match(fp, /^[0-9a-f]{64}$/);
});

test('fingerprintDevice is sensitive to status changes', async () => {
  const a = await fingerprintDevice({ ports: BASE_PORTS });
  const mutated = BASE_PORTS.map((p) => (p.name === 'wan2' ? { ...p, oper_status: 'up' } : p));
  const b = await fingerprintDevice({ ports: mutated });
  assert.notEqual(a, b);
});

test('fingerprintDevice is sensitive to adding a port', async () => {
  const a = await fingerprintDevice({ ports: BASE_PORTS });
  const b = await fingerprintDevice({
    ports: [...BASE_PORTS, { name: 'x2', admin_status: 'up', oper_status: 'down' }]
  });
  assert.notEqual(a, b);
});

test('fingerprintDevice treats case-mixed status as equivalent', async () => {
  const a = await fingerprintDevice({ ports: [{ name: 'wan2', admin_status: 'up', oper_status: 'down' }] });
  const b = await fingerprintDevice({ ports: [{ name: 'wan2', admin_status: 'UP', oper_status: 'Down' }] });
  assert.equal(a, b);
});
