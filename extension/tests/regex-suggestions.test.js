import { test } from 'node:test';
import assert from 'node:assert/strict';
import { suggestRegexPatterns } from '../src/lib/regex-suggestions.js';

// =====================================================================
// FMN-234: Similarity-driven regex suggestion engine
// =====================================================================

test('returns empty when names array is missing or too small', () => {
  assert.deepEqual(suggestRegexPatterns(), []);
  assert.deepEqual(suggestRegexPatterns(null), []);
  assert.deepEqual(suggestRegexPatterns([]), []);
  assert.deepEqual(suggestRegexPatterns(['only-one']), []);
  assert.deepEqual(suggestRegexPatterns(['a', 'b']), []);
});

test('returns empty when names are unrecognisable', () => {
  const names = ['abc', 'xyz', 'mno', 'pqr'];
  const out = suggestRegexPatterns(names);
  assert.deepEqual(out, []);
});

test('suggests digit-run with exact alpha prefix on FGT fleet', () => {
  const names = ['FGT-684-edge-01', 'FGT-712-edge-02', 'FGT-301-edge-03'];
  const out = suggestRegexPatterns(names);
  assert.ok(out.length > 0, 'expected at least one suggestion');
  const digit = out.find((c) => c.source === 'digit-run-exact-prefix');
  assert.ok(digit, `expected digit-run-exact-prefix; got ${JSON.stringify(out.map((c) => c.source))}`);
  assert.equal(digit.regex, '^FGT-(\\d{3})');
  assert.equal(digit.tagTemplate, 'sitecode=$1');
  assert.equal(digit.matches, 3);
});

test('suggests digit-run-start when names lead with the digit run', () => {
  const names = ['684-edge', '712-edge', '301-edge', '904-core'];
  const out = suggestRegexPatterns(names);
  const start = out.find((c) => c.source === 'digit-run-start');
  assert.ok(start, `expected digit-run-start; got ${JSON.stringify(out.map((c) => c.source))}`);
  assert.equal(start.regex, '^(\\d{3})');
});

test('falls back to length-only digit run when prefixes differ', () => {
  const names = ['FGT-684-edge', 'FAP-712-edge', 'FSW-301-edge', 'FGT-904-edge'];
  const out = suggestRegexPatterns(names);
  // Either exact-prefix (FGT shared) OR length-only (\d{3} anywhere) should cover all 4.
  const exactFGT = out.find((c) => c.source === 'digit-run-exact-prefix' && c.regex.startsWith('^FGT'));
  const lengthOnly = out.find((c) => c.source === 'digit-run-length-only');
  assert.ok(exactFGT || lengthOnly, 'expected at least one digit-run candidate');
  // The length-only candidate must NOT be emitted when an exact-prefix candidate of the same length already covers it.
  if (exactFGT && lengthOnly) {
    // Allowed only if lengths differ.
    assert.notEqual(exactFGT.regex.match(/\\d\{(\d+)\}/)[1], lengthOnly.regex.match(/\\d\{(\d+)\}/)[1]);
  }
});

test('alpha-prefix suggestion when prefix recurs but not in all names', () => {
  const names = ['FGT-684', 'FGT-712', 'FGT-301', 'FAP-904', 'FSW-101'];
  const out = suggestRegexPatterns(names);
  const alpha = out.find((c) => c.source === 'alpha-prefix' && c.regex.includes('FGT'));
  assert.ok(alpha, `expected alpha-prefix FGT suggestion; got ${JSON.stringify(out.map((c) => `${c.source}:${c.regex}`))}`);
  assert.equal(alpha.tagTemplate, 'family=$1');
  assert.equal(alpha.matches, 3);
});

test('alpha-prefix suppressed when ALL names share the prefix (degenerate capture)', () => {
  const names = ['FGT-684', 'FGT-712', 'FGT-301'];
  const out = suggestRegexPatterns(names);
  const alpha = out.find((c) => c.source === 'alpha-prefix');
  assert.equal(alpha, undefined, 'alpha-prefix capturing 100% of the set is degenerate; expected none');
});

test('family-token alternation when several tier tokens cluster at same position', () => {
  const names = [
    'FGT-684-edge-01',
    'FGT-712-edge-02',
    'FGT-301-core-01',
    'FGT-904-core-02',
    'FGT-104-spoke-01',
    'FGT-205-spoke-02',
  ];
  const out = suggestRegexPatterns(names);
  const fam = out.find((c) => c.source === 'family-token-alt' || c.source === 'family-token');
  assert.ok(fam, `expected family-token candidate; got ${JSON.stringify(out.map((c) => c.source))}`);
  assert.match(fam.regex, /\\b\(.*edge.*\)\\b|\\b\(.*core.*\)\\b|\\b\(.*spoke.*\)\\b/);
  assert.equal(fam.tagTemplate, 'family=$1');
});

test('respects minMatches threshold', () => {
  // Two FGT names share an exact 3-digit-run pattern; the other names
  // share no detectable structure. minMatches=3 yields nothing; minMatches=2
  // lets the FGT pair surface.
  const names = ['FGT-684', 'FGT-712', 'wholly-other-thing', 'separately-named-host', 'lonely-isolated-asset'];
  const strict = suggestRegexPatterns(names, { minMatches: 3 });
  assert.deepEqual(strict, []);
  const lenient = suggestRegexPatterns(names, { minMatches: 2 });
  assert.ok(lenient.length > 0, 'expected at least one suggestion at minMatches=2');
  assert.ok(lenient.some((c) => c.source === 'digit-run-exact-prefix' && c.regex.includes('FGT')));
});

test('caps results at maxSuggestions', () => {
  const names = [
    'FGT-684-edge-01', 'FGT-712-edge-02', 'FGT-301-core-01',
    'FAP-904-edge-01', 'FAP-104-core-02', 'FSW-205-spoke-01',
    'FSW-306-edge-02', 'FEX-407-core-01',
  ];
  const out = suggestRegexPatterns(names, { maxSuggestions: 3 });
  assert.ok(out.length <= 3);
});

test('sorts by match count then specificity', () => {
  const names = [
    'FGT-684-edge', 'FGT-712-edge', 'FGT-301-edge',  // 3 share FGT + edge
    'FAP-904-edge', 'FAP-104-edge',                  // 2 share FAP + edge
  ];
  const out = suggestRegexPatterns(names);
  // The FGT-anchored 3-digit-run should outrank any 5-match candidate that's less specific.
  // Match counts dominate first; specificity (regex length) is a tiebreaker.
  for (let i = 1; i < out.length; i++) {
    assert.ok(
      out[i - 1].matches >= out[i].matches,
      `not sorted by matches desc at ${i}: ${out[i - 1].matches} -> ${out[i].matches}`
    );
  }
});

test('every suggestion regex is valid and matches >= minMatches names', () => {
  const names = ['FGT-684-edge', 'FGT-712-edge', 'FAP-301-core', 'FAP-904-core', 'FSW-104-spoke'];
  const out = suggestRegexPatterns(names);
  for (const sug of out) {
    const re = new RegExp(sug.regex);
    let count = 0;
    for (const n of names) if (re.test(n)) count++;
    assert.equal(count, sug.matches, `match-count mismatch for ${sug.regex}`);
    assert.ok(count >= 3, `low-coverage suggestion leaked through: ${sug.regex} matches ${count}`);
  }
});

test('handles names with whitespace / dot / slash delimiters', () => {
  const names = ['edge 684 site', 'edge 712 site', 'edge 301 site'];
  const out = suggestRegexPatterns(names);
  // Should still produce something useful (digit-run or family-token).
  assert.ok(out.length > 0, `expected suggestion on space-delimited names; got ${JSON.stringify(out)}`);
});

test('ignores non-string entries in the names array', () => {
  const names = ['FGT-684-edge', 'FGT-712-edge', 'FGT-301-edge', null, undefined, 42, ''];
  const out = suggestRegexPatterns(names);
  assert.ok(out.length > 0);
});
