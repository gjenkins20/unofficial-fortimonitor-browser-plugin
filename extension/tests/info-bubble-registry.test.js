// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// FMN-169: unit tests for the info-bubble registry + settings helpers.
//
// Covers:
//   * Registry lookup by featureId (getInfoBubbleEntry).
//   * Per-surface filtering (getInfoBubblesForSurface).
//   * Every entry has the required fields with sane shapes.
//   * Dismissal-set add/read round-trip via the mocked storage.
//   * Global-toggle gate: defaults true on fresh installs (undefined),
//     persists false when explicitly set, falls open on storage error.
//   * Toggling the global flag back on preserves the dismissal set
//     (the two storage keys are independent).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  INFO_BUBBLE_REGISTRY,
  getInfoBubbleEntry,
  getInfoBubblesForSurface,
  listInfoBubbleFeatureIds,
} from '../src/lib/info-bubble-registry.js';
import {
  SHOW_INFO_BUBBLES_KEY,
  DISMISSED_INFO_BUBBLES_KEY,
  isShowInfoBubblesEnabled,
  setShowInfoBubblesEnabled,
  getDismissedInfoBubbles,
  addDismissedInfoBubble,
  clearDismissedInfoBubbles,
} from '../src/lib/settings.js';
import { createStorageMock } from './fixtures/chrome-mocks.js';

// ---------- Registry shape ----------

test('registry: every entry has required fields with the right shape', () => {
  assert.ok(INFO_BUBBLE_REGISTRY.length >= 8, 'expected >= 8 entries (per FMN-169 ticket)');
  for (const entry of INFO_BUBBLE_REGISTRY) {
    assert.equal(typeof entry.featureId, 'string', `featureId must be a string for ${JSON.stringify(entry)}`);
    assert.ok(entry.featureId.length > 0, `featureId must be non-empty`);
    assert.match(entry.featureId, /^[a-z][a-z0-9-]*$/, `featureId must be lowercase kebab-case: ${entry.featureId}`);
    assert.ok(['content', 'popup'].includes(entry.surface), `surface must be content or popup: ${entry.featureId}`);
    assert.equal(typeof entry.anchorSelector, 'string');
    assert.ok(entry.anchorSelector.length > 0);
    assert.ok(['self', 'icon'].includes(entry.anchorMode), `anchorMode self|icon: ${entry.featureId}`);
    assert.equal(typeof entry.title, 'string');
    assert.ok(entry.title.length > 0);
    assert.equal(typeof entry.body, 'string');
    assert.ok(entry.body.length > 0);
    assert.ok(entry.body.length <= 350, `body should be ~300 chars max: ${entry.featureId} got ${entry.body.length}`);
    // Per memory no_em_dashes.md: never emit U+2014.
    assert.ok(!entry.body.includes('—'), `em-dash banned in body: ${entry.featureId}`);
    assert.ok(!entry.title.includes('—'), `em-dash banned in title: ${entry.featureId}`);
    assert.equal(typeof entry.learnMoreUrl, 'string');
    assert.match(entry.learnMoreUrl, /^https:\/\//, `learnMoreUrl must be https: ${entry.featureId}`);
  }
});

test('registry: featureIds are unique', () => {
  const ids = INFO_BUBBLE_REGISTRY.map((e) => e.featureId);
  const set = new Set(ids);
  assert.equal(set.size, ids.length, 'duplicate featureIds');
});

test('registry: covers all ticket features (FMN-152, 153, 154, 155, 156, 157, 160, 71/151)', () => {
  const ids = new Set(listInfoBubbleFeatureIds());
  // Cross-check the FMN-169 ticket's enumerated features map to
  // registry entries. The mapping is logical (one entry can cover a
  // pair like 71/151); we assert presence by featureId.
  assert.ok(ids.has('omni-search'), 'FMN-152 omni-search');
  assert.ok(ids.has('search-by-id'), 'FMN-160 search-by-ID');
  assert.ok(ids.has('ip-dns-columns'), 'FMN-153 IP/DNS columns');
  assert.ok(ids.has('native-column-reorder'), 'FMN-71/FMN-151 native column reorder');
  assert.ok(ids.has('snapshot-diff-card'), 'FMN-154 Snapshot & Diff');
  assert.ok(ids.has('update-banner'), 'FMN-157 update banner');
  assert.ok(ids.has('bulk-composer'), 'FMN-155 Bulk Composer');
  assert.ok(ids.has('noise-analysis'), 'FMN-156 noise sections');
});

// ---------- Lookup helpers ----------

test('getInfoBubbleEntry: returns the matching entry for a known featureId', () => {
  const entry = getInfoBubbleEntry('omni-search');
  assert.ok(entry, 'expected an entry');
  assert.equal(entry.featureId, 'omni-search');
  assert.equal(entry.surface, 'content');
});

test('getInfoBubbleEntry: returns undefined for unknown / bad inputs', () => {
  assert.equal(getInfoBubbleEntry('does-not-exist'), undefined);
  assert.equal(getInfoBubbleEntry(''), undefined);
  assert.equal(getInfoBubbleEntry(null), undefined);
  assert.equal(getInfoBubbleEntry(undefined), undefined);
  assert.equal(getInfoBubbleEntry(42), undefined);
});

test('getInfoBubblesForSurface: filters by surface', () => {
  const popup = getInfoBubblesForSurface('popup');
  const content = getInfoBubblesForSurface('content');
  assert.ok(popup.length > 0, 'expected at least one popup entry');
  assert.ok(content.length > 0, 'expected at least one content entry');
  for (const e of popup) assert.equal(e.surface, 'popup');
  for (const e of content) assert.equal(e.surface, 'content');
  assert.equal(popup.length + content.length, INFO_BUBBLE_REGISTRY.length);
});

test('getInfoBubblesForSurface: unknown surface returns []', () => {
  assert.deepEqual(getInfoBubblesForSurface('weird'), []);
  assert.deepEqual(getInfoBubblesForSurface(undefined), []);
});

// ---------- Settings: global toggle ----------

test('isShowInfoBubblesEnabled: defaults true on fresh install (undefined key)', async () => {
  const storage = createStorageMock();
  const value = await isShowInfoBubblesEnabled(storage);
  assert.equal(value, true);
});

test('setShowInfoBubblesEnabled: persists false then reads back false', async () => {
  const storage = createStorageMock();
  await setShowInfoBubblesEnabled(false, storage);
  const value = await isShowInfoBubblesEnabled(storage);
  assert.equal(value, false);
});

test('setShowInfoBubblesEnabled: persists true then reads back true', async () => {
  const storage = createStorageMock({ [SHOW_INFO_BUBBLES_KEY]: false });
  await setShowInfoBubblesEnabled(true, storage);
  const value = await isShowInfoBubblesEnabled(storage);
  assert.equal(value, true);
});

test('isShowInfoBubblesEnabled: storage error fails open (returns true)', async () => {
  const erroringStorage = {
    get() { throw new Error('boom'); },
    set() { throw new Error('boom'); },
  };
  const value = await isShowInfoBubblesEnabled(erroringStorage);
  assert.equal(value, true);
});

// ---------- Settings: dismissal set ----------

test('getDismissedInfoBubbles: empty when nothing stored', async () => {
  const storage = createStorageMock();
  const dismissed = await getDismissedInfoBubbles(storage);
  assert.deepEqual(dismissed, []);
});

test('addDismissedInfoBubble: appends to the set, idempotent on duplicate', async () => {
  const storage = createStorageMock();
  await addDismissedInfoBubble('omni-search', storage);
  await addDismissedInfoBubble('bulk-composer', storage);
  await addDismissedInfoBubble('omni-search', storage); // duplicate
  const dismissed = await getDismissedInfoBubbles(storage);
  assert.equal(dismissed.length, 2);
  assert.ok(dismissed.includes('omni-search'));
  assert.ok(dismissed.includes('bulk-composer'));
});

test('addDismissedInfoBubble: ignores non-string / empty inputs', async () => {
  const storage = createStorageMock();
  await addDismissedInfoBubble(null, storage);
  await addDismissedInfoBubble('', storage);
  await addDismissedInfoBubble(undefined, storage);
  const dismissed = await getDismissedInfoBubbles(storage);
  assert.deepEqual(dismissed, []);
});

test('getDismissedInfoBubbles: ignores non-string entries from corrupt storage', async () => {
  const storage = createStorageMock({
    [DISMISSED_INFO_BUBBLES_KEY]: ['omni-search', 42, null, 'bulk-composer'],
  });
  const dismissed = await getDismissedInfoBubbles(storage);
  assert.deepEqual(dismissed, ['omni-search', 'bulk-composer']);
});

test('clearDismissedInfoBubbles: empties the set', async () => {
  const storage = createStorageMock({
    [DISMISSED_INFO_BUBBLES_KEY]: ['omni-search', 'bulk-composer'],
  });
  await clearDismissedInfoBubbles(storage);
  const dismissed = await getDismissedInfoBubbles(storage);
  assert.deepEqual(dismissed, []);
});

// ---------- Global flag and dismissal set are independent ----------

test('toggling the global flag does not touch the dismissal set', async () => {
  const storage = createStorageMock();
  // Operator dismisses two features.
  await addDismissedInfoBubble('omni-search', storage);
  await addDismissedInfoBubble('snapshot-diff-card', storage);

  // Operator flips master toggle off.
  await setShowInfoBubblesEnabled(false, storage);

  // Dismissal set is unchanged.
  const afterOff = await getDismissedInfoBubbles(storage);
  assert.equal(afterOff.length, 2);

  // Operator flips master toggle back on.
  await setShowInfoBubblesEnabled(true, storage);

  // Dismissal set is STILL unchanged (the acceptance criteria
  // explicitly calls this out: per-feature dismissals are
  // preserved across global-toggle flips).
  const afterOn = await getDismissedInfoBubbles(storage);
  assert.equal(afterOn.length, 2);
  assert.ok(afterOn.includes('omni-search'));
  assert.ok(afterOn.includes('snapshot-diff-card'));
});
