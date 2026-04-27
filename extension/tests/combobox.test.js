import { test } from 'node:test';
import assert from 'node:assert/strict';
import { filterItems } from '../src/lib/combobox.js';

const ITEMS = [
  { value: 'u/1', label: 'Model', hint: 'dem.model' },
  { value: 'u/2', label: 'Operating System', hint: 'server.os' },
  { value: 'u/3', label: 'Datacenter', hint: 'cust.dc' },
  { value: 'u/4', label: 'Datacenter Tier', hint: 'cust.dc.tier' },
  { value: 'u/5', label: 'Owner', hint: null }
];

test('filterItems: empty query returns all items (cloned)', () => {
  const out = filterItems(ITEMS, '');
  assert.equal(out.length, ITEMS.length);
  assert.notEqual(out, ITEMS, 'returns a copy');
});

test('filterItems: whitespace-only query returns all', () => {
  assert.equal(filterItems(ITEMS, '   ').length, ITEMS.length);
});

test('filterItems: matches against label substring (case-insensitive)', () => {
  const out = filterItems(ITEMS, 'data');
  assert.deepEqual(out.map((i) => i.value), ['u/3', 'u/4']);
});

test('filterItems: matches against hint substring', () => {
  const out = filterItems(ITEMS, 'server.os');
  assert.deepEqual(out.map((i) => i.value), ['u/2']);
});

test('filterItems: matches both label and hint', () => {
  const out = filterItems(ITEMS, 'os');
  // Operating System (label) + server.os (hint match)
  assert.equal(out.length, 1);
  assert.equal(out[0].value, 'u/2');
});

test('filterItems: no matches returns empty array', () => {
  assert.deepEqual(filterItems(ITEMS, 'zzzzzz'), []);
});

test('filterItems: handles items without hint', () => {
  const out = filterItems(ITEMS, 'owner');
  assert.deepEqual(out.map((i) => i.value), ['u/5']);
});

test('filterItems: query is trimmed', () => {
  assert.equal(filterItems(ITEMS, '  Model  ').length, 1);
});
