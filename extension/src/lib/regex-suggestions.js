// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// FMN-234: Similarity-driven regex suggestion engine for Auto-tag by name.
//
// Given a list of instance names, produces 0-5 candidate { regex,
// tagTemplate, description, matches, source } suggestions derived from
// cheap heuristics (no ML). Operator clicks a suggestion chip to
// populate the regex + tag-template inputs in the Configure step.
//
// Heuristic families:
//   - digit-run-exact-prefix: identical alpha prefix followed by an
//     identical-length digit run across >= 3 names (e.g. "FGT-684-",
//     "FGT-712-", "FGT-301-" -> ^FGT-(\d{3})).
//   - digit-run-length-only:  identical-length digit run anywhere in
//     the name, when no exact-prefix candidate covers it.
//   - alpha-prefix:           leading alpha token that recurs in >= 3
//     names but not all (e.g. "FGT-" present 5/8 -> ^(FGT)).
//   - family-token:           lowercased alpha token at a recurring
//     delimiter-split position (e.g. "edge" / "core" / "spoke" at
//     position 3 -> \b(edge|core|spoke)\b).

const DEFAULT_MIN_MATCHES = 3;
const DEFAULT_MAX_SUGGESTIONS = 5;
const MIN_DIGIT_RUN_LENGTH = 2;
const FAMILY_TOKEN_RE = /^[a-z][a-z0-9]{1,11}$/;

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function splitTokens(name) {
  return String(name).split(/[-_./\s]+/).filter(Boolean);
}

function digitRunCandidates(names, minMatches) {
  const records = [];
  for (const n of names) {
    const m = n.match(/^(.*?)(\d+)/);
    if (m && m[2].length >= MIN_DIGIT_RUN_LENGTH) {
      records.push({ prefix: m[1], length: m[2].length });
    }
  }
  if (records.length < minMatches) return [];

  const cands = [];
  const coveredLengths = new Set();

  const exactPrefixGroups = new Map();
  for (const r of records) {
    const key = `${r.prefix}|${r.length}`;
    let bucket = exactPrefixGroups.get(key);
    if (!bucket) {
      bucket = [];
      exactPrefixGroups.set(key, bucket);
    }
    bucket.push(r);
  }
  for (const [, group] of exactPrefixGroups) {
    if (group.length < minMatches) continue;
    const prefix = group[0].prefix;
    const length = group[0].length;
    coveredLengths.add(length);
    if (prefix) {
      cands.push({
        regex: `^${escapeRegex(prefix)}(\\d{${length}})`,
        tagTemplate: 'sitecode=$1',
        description: `${length}-digit run after "${prefix}"`,
        source: 'digit-run-exact-prefix',
      });
    } else {
      cands.push({
        regex: `^(\\d{${length}})`,
        tagTemplate: 'sitecode=$1',
        description: `${length}-digit run at start of name`,
        source: 'digit-run-start',
      });
    }
  }

  const lengthGroups = new Map();
  for (const r of records) {
    let bucket = lengthGroups.get(r.length);
    if (!bucket) {
      bucket = [];
      lengthGroups.set(r.length, bucket);
    }
    bucket.push(r);
  }
  for (const [length, group] of lengthGroups) {
    if (group.length < minMatches) continue;
    if (coveredLengths.has(length)) continue;
    cands.push({
      regex: `(\\d{${length}})`,
      tagTemplate: 'sitecode=$1',
      description: `${length}-digit run anywhere in the name`,
      source: 'digit-run-length-only',
    });
  }

  return cands;
}

function alphaPrefixCandidates(names, minMatches) {
  const counts = new Map();
  for (const n of names) {
    const m = n.match(/^([A-Za-z]{2,})[-_.]/);
    if (!m) continue;
    counts.set(m[1], (counts.get(m[1]) ?? 0) + 1);
  }
  const cands = [];
  for (const [prefix, count] of counts) {
    if (count < minMatches) continue;
    if (count === names.length) continue;
    cands.push({
      regex: `^(${escapeRegex(prefix)})`,
      tagTemplate: 'family=$1',
      description: `name starts with "${prefix}"`,
      source: 'alpha-prefix',
    });
  }
  return cands;
}

function familyTokenCandidates(names, minMatches) {
  const records = names.map((n) => splitTokens(n));
  if (records.length < minMatches) return [];

  const positionCounts = new Map();
  for (const tokens of records) {
    for (let i = 0; i < tokens.length; i++) {
      const tok = tokens[i].toLowerCase();
      if (!FAMILY_TOKEN_RE.test(tok)) continue;
      let pos = positionCounts.get(i);
      if (!pos) {
        pos = new Map();
        positionCounts.set(i, pos);
      }
      pos.set(tok, (pos.get(tok) ?? 0) + 1);
    }
  }

  const cands = [];
  for (const [, counts] of positionCounts) {
    // Candidate tokens: appear at this position in >= 2 names (lower bound
    // for inclusion in an alternation; aggregate coverage gets validated
    // against minMatches by the suggestRegexPatterns scorer).
    const familyTokens = [];
    for (const [tok, count] of counts) familyTokens.push({ tok, count });
    if (familyTokens.length === 0) continue;
    familyTokens.sort((a, b) => b.count - a.count);

    if (familyTokens.length === 1) {
      const { tok, count } = familyTokens[0];
      // Single-token family is useful only when it splits the picked set
      // (count < total). A token covering 100% is a degenerate capture.
      if (count < minMatches || count >= records.length) continue;
      cands.push({
        regex: `\\b(${escapeRegex(tok)})\\b`,
        tagTemplate: 'family=$1',
        description: `family token "${tok}"`,
        source: 'family-token',
      });
    } else {
      // Alternation: include the top few tokens at this position. Each
      // token must appear in >= 2 names to be worth alternating; require
      // at least 2 distinct tokens in the alternation.
      const eligible = familyTokens.filter((f) => f.count >= 2);
      if (eligible.length < 2) continue;
      const top = eligible.slice(0, 6);
      cands.push({
        regex: `\\b(${top.map((f) => escapeRegex(f.tok)).join('|')})\\b`,
        tagTemplate: 'family=$1',
        description: `family tokens (${top.map((f) => f.tok).join(', ')})`,
        source: 'family-token-alt',
      });
    }
  }

  return cands;
}

export function suggestRegexPatterns(names, opts = {}) {
  const minMatches = opts.minMatches ?? DEFAULT_MIN_MATCHES;
  const maxSuggestions = opts.maxSuggestions ?? DEFAULT_MAX_SUGGESTIONS;

  if (!Array.isArray(names)) return [];
  const validNames = names.filter((n) => typeof n === 'string' && n.length > 0);
  if (validNames.length < minMatches) return [];

  const raw = [
    ...digitRunCandidates(validNames, minMatches),
    ...alphaPrefixCandidates(validNames, minMatches),
    ...familyTokenCandidates(validNames, minMatches),
  ];

  const seen = new Set();
  const scored = [];
  for (const c of raw) {
    if (seen.has(c.regex)) continue;
    seen.add(c.regex);
    let re;
    try {
      re = new RegExp(c.regex);
    } catch {
      continue;
    }
    let matches = 0;
    for (const n of validNames) {
      if (re.test(n)) matches++;
    }
    if (matches >= minMatches) scored.push({ ...c, matches });
  }

  scored.sort((a, b) => b.matches - a.matches || b.regex.length - a.regex.length);
  return scored.slice(0, maxSuggestions);
}
