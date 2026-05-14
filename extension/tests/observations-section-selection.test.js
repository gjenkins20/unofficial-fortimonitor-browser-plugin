import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ALL_SECTION_ID,
  ANALYZER_SECTION_IDS,
  defaultSelection,
  isAllSelection,
  nextSectionsSelection,
  sanitize
} from '../src/ui/tenant-observations/section-selection.js';

test('defaultSelection() returns ["all"]', () => {
  assert.deepEqual(defaultSelection(), ['all']);
});

test('analyzer section IDs match the planning-doc taxonomy', () => {
  // FMN-156 rework: noise analysis folded into Incident Summary; no
  // separate section id in the wizard pill row.
  assert.deepEqual(
    [...ANALYZER_SECTION_IDS].sort(),
    [
      'incidents',
      'instance-analysis',
      'monitoring-policy',
      'template-recommendations',
      'user-activity'
    ]
  );
});

test('plain click on an analyzer pill replaces ["all"] with [that pill]', () => {
  const next = nextSectionsSelection(['all'], 'user-activity');
  assert.deepEqual(next, ['user-activity']);
});

test('plain click on a different analyzer replaces the current single selection', () => {
  const next = nextSectionsSelection(['user-activity'], 'incidents');
  assert.deepEqual(next, ['incidents']);
});

test('clicking [All] resets a single-section selection to ["all"]', () => {
  const next = nextSectionsSelection(['user-activity'], ALL_SECTION_ID);
  assert.deepEqual(next, ['all']);
});

test('clicking [All] resets a multi-select to ["all"]', () => {
  const next = nextSectionsSelection(
    ['template-recommendations', 'monitoring-policy'],
    ALL_SECTION_ID
  );
  assert.deepEqual(next, ['all']);
});

test('shift-click adds a second analyzer to a single selection', () => {
  const next = nextSectionsSelection(
    ['template-recommendations'],
    'monitoring-policy',
    { shift: true }
  );
  assert.deepEqual(next, ['template-recommendations', 'monitoring-policy']);
});

test('shift-click toggles off when the pill is already selected and others remain', () => {
  const next = nextSectionsSelection(
    ['template-recommendations', 'monitoring-policy'],
    'template-recommendations',
    { shift: true }
  );
  assert.deepEqual(next, ['monitoring-policy']);
});

test('shift-click is a no-op when it would empty the selection', () => {
  const next = nextSectionsSelection(['user-activity'], 'user-activity', { shift: true });
  assert.deepEqual(next, ['user-activity']);
});

test('shift-click while ["all"] is selected behaves like a plain click', () => {
  const next = nextSectionsSelection(['all'], 'instance-analysis', { shift: true });
  assert.deepEqual(next, ['instance-analysis']);
});

test('plain click of the only-selected pill is a no-op (single-section default)', () => {
  // Per the ticket: "Clicking the only-selected non-[All] pill while it's
  // already selected is a no-op (avoid empty selection)." A plain click
  // returns [clicked], which equals the current selection - effectively
  // a no-op.
  const next = nextSectionsSelection(['incidents'], 'incidents');
  assert.deepEqual(next, ['incidents']);
});

test('clicking an unknown section id returns the current selection unchanged', () => {
  const next = nextSectionsSelection(['user-activity'], 'not-a-section');
  assert.deepEqual(next, ['user-activity']);
});

test('sanitize: empty / non-array inputs default to ["all"]', () => {
  assert.deepEqual(sanitize(undefined), ['all']);
  assert.deepEqual(sanitize(null), ['all']);
  assert.deepEqual(sanitize([]), ['all']);
  assert.deepEqual(sanitize('user-activity'), ['all']);
});

test('sanitize: presence of "all" wins regardless of other entries', () => {
  assert.deepEqual(sanitize(['all', 'user-activity']), ['all']);
});

test('sanitize: filters unknown ids and dedupes', () => {
  assert.deepEqual(
    sanitize(['user-activity', 'bogus', 'user-activity', 'incidents']),
    ['user-activity', 'incidents']
  );
});

test('sanitize: when nothing valid remains, falls back to ["all"]', () => {
  assert.deepEqual(sanitize(['bogus', 42, null]), ['all']);
});

test('isAllSelection identifies ["all"] vs analyzer-scoped selections', () => {
  assert.equal(isAllSelection(['all']), true);
  assert.equal(isAllSelection(['user-activity']), false);
  assert.equal(isAllSelection(['all', 'user-activity']), false);
  assert.equal(isAllSelection([]), false);
  assert.equal(isAllSelection(undefined), false);
});
