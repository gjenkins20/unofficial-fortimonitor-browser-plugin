// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// FMN-167: unit tests for the intro-tour step schema.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateStep,
  normalizeStep,
  stepMatchesPath,
  ADVANCE_MODES,
  PLACEMENTS,
  STEP_DEFAULTS
} from '../src/ui/intro-tour/step-schema.js';

const VALID_STEP = {
  id: 'dashboards-welcome',
  anchor: 'li.pa-side-nav__top-level-item',
  caption_html: '<p>hi</p>',
  advance: 'next-button'
};

test('validateStep accepts a minimal valid step and fills defaults', () => {
  const res = validateStep(VALID_STEP);
  assert.equal(res.ok, true);
  assert.equal(res.step.id, 'dashboards-welcome');
  assert.equal(res.step.anchor, 'li.pa-side-nav__top-level-item');
  assert.equal(res.step.anchor_fallback, STEP_DEFAULTS.anchor_fallback);
  assert.equal(res.step.advance, 'next-button');
  assert.equal(res.step.placement, 'auto');
  assert.equal(res.step.auto_ms, STEP_DEFAULTS.auto_ms);
  assert.deepEqual(res.step.when, { always: true });
  assert.equal(res.step.on_enter, null);
  assert.equal(res.step.on_exit, null);
  assert.equal(Object.isFrozen(res.step), true);
});

test('validateStep rejects null / non-object input', () => {
  for (const bad of [null, undefined, 'str', 42, [], true]) {
    const res = validateStep(bad);
    assert.equal(res.ok, false);
    assert.match(res.errors[0], /step must be a plain object/);
  }
});

test('validateStep rejects missing id', () => {
  const res = validateStep({ ...VALID_STEP, id: '' });
  assert.equal(res.ok, false);
  assert.ok(res.errors.some((e) => /id is required/.test(e)));
});

test('validateStep rejects missing anchor', () => {
  const res = validateStep({ ...VALID_STEP, anchor: undefined });
  assert.equal(res.ok, false);
  assert.ok(res.errors.some((e) => /anchor is required/.test(e)));
});

test('validateStep rejects step with neither caption_html nor caption_markdown', () => {
  const res = validateStep({ ...VALID_STEP, caption_html: undefined });
  assert.equal(res.ok, false);
  assert.ok(res.errors.some((e) => /caption_html or caption_markdown is required/.test(e)));
});

test('validateStep accepts markdown-only caption', () => {
  const res = validateStep({ ...VALID_STEP, caption_html: undefined, caption_markdown: '**bold**' });
  assert.equal(res.ok, true);
  assert.equal(res.step.caption_markdown, '**bold**');
  assert.equal(res.step.caption_html, null);
});

test('validateStep rejects invalid advance value', () => {
  const res = validateStep({ ...VALID_STEP, advance: 'whenever' });
  assert.equal(res.ok, false);
  assert.ok(res.errors.some((e) => /advance must be one of/.test(e)));
});

test('validateStep accepts every ADVANCE_MODES value', () => {
  for (const m of ADVANCE_MODES) {
    const res = validateStep({ ...VALID_STEP, advance: m });
    assert.equal(res.ok, true, `mode ${m} should validate`);
  }
});

test('validateStep rejects invalid placement', () => {
  const res = validateStep({ ...VALID_STEP, placement: 'corner' });
  assert.equal(res.ok, false);
  assert.ok(res.errors.some((e) => /placement must be one of/.test(e)));
});

test('validateStep accepts every PLACEMENTS value', () => {
  for (const p of PLACEMENTS) {
    const res = validateStep({ ...VALID_STEP, placement: p });
    assert.equal(res.ok, true);
    assert.equal(res.step.placement, p);
  }
});

test('validateStep rejects when with multiple keys', () => {
  const res = validateStep({ ...VALID_STEP, when: { path_includes: '/a', path_regex: '/b' } });
  assert.equal(res.ok, false);
  assert.ok(res.errors.some((e) => /when must have at most one/.test(e)));
});

test('validateStep rejects when with unknown keys', () => {
  const res = validateStep({ ...VALID_STEP, when: { is_tuesday: true } });
  assert.equal(res.ok, false);
  assert.ok(res.errors.some((e) => /when has unknown keys/.test(e)));
});

test('validateStep accepts path_includes when predicate', () => {
  const res = validateStep({ ...VALID_STEP, when: { path_includes: '/report' } });
  assert.equal(res.ok, true);
  assert.deepEqual(res.step.when, { path_includes: '/report' });
});

test('validateStep accepts path_regex when predicate', () => {
  const res = validateStep({ ...VALID_STEP, when: { path_regex: '/report/.*' } });
  assert.equal(res.ok, true);
  assert.deepEqual(res.step.when, { path_regex: '/report/.*' });
});

test('validateStep rejects auto_ms <= 0', () => {
  const r1 = validateStep({ ...VALID_STEP, advance: 'auto', auto_ms: 0 });
  const r2 = validateStep({ ...VALID_STEP, advance: 'auto', auto_ms: -100 });
  assert.equal(r1.ok, false);
  assert.equal(r2.ok, false);
});

test('validateStep collects all errors at once', () => {
  const res = validateStep({ id: '', anchor: '', advance: 'never', placement: 'inside' });
  assert.equal(res.ok, false);
  assert.ok(res.errors.length >= 4);
});

test('normalizeStep is idempotent', () => {
  const first = normalizeStep(VALID_STEP);
  const second = normalizeStep(first);
  assert.deepEqual(first, second);
});

test('normalizeStep freezes the result and its when object', () => {
  const s = normalizeStep(VALID_STEP);
  assert.equal(Object.isFrozen(s), true);
  assert.equal(Object.isFrozen(s.when), true);
});

test('stepMatchesPath: always predicate matches every path', () => {
  const s = normalizeStep(VALID_STEP);
  assert.equal(stepMatchesPath(s, '/'), true);
  assert.equal(stepMatchesPath(s, '/anywhere'), true);
  assert.equal(stepMatchesPath(s, ''), true);
});

test('stepMatchesPath: path_includes', () => {
  const s = normalizeStep({ ...VALID_STEP, when: { path_includes: '/report' } });
  assert.equal(stepMatchesPath(s, '/report/Instance/123'), true);
  assert.equal(stepMatchesPath(s, '/dashboards'), false);
});

test('stepMatchesPath: path_regex', () => {
  const s = normalizeStep({ ...VALID_STEP, when: { path_regex: '^/report/Instance/\\d+$' } });
  assert.equal(stepMatchesPath(s, '/report/Instance/42'), true);
  assert.equal(stepMatchesPath(s, '/report/Instance/x'), false);
  assert.equal(stepMatchesPath(s, '/'), false);
});

test('stepMatchesPath: invalid regex returns false (does not throw)', () => {
  const s = normalizeStep({ ...VALID_STEP, when: { path_regex: '[' } });
  assert.equal(stepMatchesPath(s, '/anything'), false);
});

// =====================================================================
// FMN-229: step_type + checklist support
// =====================================================================

const VALID_CHECKLIST_STEP = {
  id: 'network-access',
  step_type: 'checklist',
  caption_html: '<p>Before powering on the OnSight, confirm the following:</p>',
  checklist: [
    { id: 'outbound-443', label: 'Outbound TCP/443 to api.panopta.com' },
    { id: 'dns-resolve', label: 'DNS resolves api.panopta.com', help: 'Verify from same VLAN if possible.' }
  ]
};

test('validateStep: step_type defaults to "anchor" when not provided (backward compatible)', () => {
  const res = validateStep(VALID_STEP);
  assert.equal(res.ok, true);
  assert.equal(res.step.step_type, 'anchor');
});

test('validateStep: unknown step_type rejected', () => {
  const res = validateStep({ ...VALID_STEP, step_type: 'chcklist' });
  assert.equal(res.ok, false);
  assert.ok(res.errors.some((e) => /step_type/.test(e)));
});

test('validateStep: checklist step does NOT require anchor', () => {
  const { anchor, ...noAnchor } = VALID_CHECKLIST_STEP;
  void anchor;
  const res = validateStep(noAnchor);
  assert.equal(res.ok, true);
  assert.equal(res.step.anchor, null);
});

test('validateStep: anchor step still REQUIRES anchor', () => {
  const { anchor, ...noAnchor } = VALID_STEP;
  void anchor;
  const res = validateStep(noAnchor);
  assert.equal(res.ok, false);
  assert.ok(res.errors.some((e) => /anchor is required/.test(e)));
});

test('validateStep: checklist step requires checklist[] with >=1 entry', () => {
  const r1 = validateStep({ ...VALID_CHECKLIST_STEP, checklist: undefined });
  assert.equal(r1.ok, false);
  const r2 = validateStep({ ...VALID_CHECKLIST_STEP, checklist: [] });
  assert.equal(r2.ok, false);
  const r3 = validateStep(VALID_CHECKLIST_STEP);
  assert.equal(r3.ok, true);
});

test('validateStep: checklist items require id + label', () => {
  const r = validateStep({
    ...VALID_CHECKLIST_STEP,
    checklist: [{ id: '', label: 'no id' }, { id: 'ok', label: '' }]
  });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /checklist\[0\]\.id/.test(e)));
  assert.ok(r.errors.some((e) => /checklist\[1\]\.label/.test(e)));
});

test('validateStep: duplicate checklist ids rejected', () => {
  const r = validateStep({
    ...VALID_CHECKLIST_STEP,
    checklist: [{ id: 'a', label: 'first' }, { id: 'a', label: 'second' }]
  });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /duplicates an earlier entry/.test(e)));
});

test('validateStep: checklist step defaults advance to "all-checked"', () => {
  const { advance, ...noAdvance } = VALID_CHECKLIST_STEP;
  void advance;
  const r = validateStep(noAdvance);
  assert.equal(r.ok, true);
  assert.equal(r.step.advance, 'all-checked');
});

test('validateStep: anchor step defaults advance to "next-button"', () => {
  const { advance, ...noAdvance } = VALID_STEP;
  void advance;
  const r = validateStep(noAdvance);
  assert.equal(r.ok, true);
  assert.equal(r.step.advance, 'next-button');
});

test('validateStep: checklist step rejects advance="click"', () => {
  const r = validateStep({ ...VALID_CHECKLIST_STEP, advance: 'click' });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /checklist steps support advance/.test(e)));
});

test('normalizeStep: checklist items get help defaulted to null and are frozen', () => {
  const s = normalizeStep(VALID_CHECKLIST_STEP);
  assert.equal(s.checklist.length, 2);
  assert.equal(s.checklist[0].help, null);
  assert.equal(s.checklist[1].help, 'Verify from same VLAN if possible.');
  assert.ok(Object.isFrozen(s.checklist));
  assert.ok(Object.isFrozen(s.checklist[0]));
});
