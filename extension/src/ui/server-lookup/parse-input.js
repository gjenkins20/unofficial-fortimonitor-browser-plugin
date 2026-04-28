// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// Parse operator input for the Server Lookup tool (FMN-113).
//
// Each line dispatches to one of three kinds:
//   - URL  : matches a known FortiMonitor frontend URL pattern (initial set:
//            /\/instance\/(\d+)\b/). Server ID extracted from the URL.
//   - ID   : a bare numeric ID (/^\d+$/). Pass-through.
//   - NAME : anything else. Falls through to the existing exact-match path.
//
// URL patterns are kept as an array so future formats can be added without
// restructuring the dispatcher.
//
// Returns { entries, warnings, totalLines }, where each entry is one of:
//   { kind: 'url',  raw, serverId }
//   { kind: 'id',   raw, serverId }
//   { kind: 'name', raw, name }
//
// Dedup rules:
//   - URL and ID lines that resolve to the same server ID merge to one entry,
//     with a warning. (A URL pointing at server 1234 plus the literal "1234"
//     are the same target.)
//   - Repeated names dedupe to one entry, with a warning. (Existing behaviour.)
//
// Pure module - no chrome APIs, fully unit-testable.

/**
 * URL patterns that yield a server ID. Each entry pairs a regex (with the
 * server ID in capture group 1) and a label for diagnostics. Keep the most
 * specific patterns first if they ever overlap.
 */
export const URL_PATTERNS = [
  { regex: /\/instance\/(\d+)\b/, label: '/instance/N/...' }
];

const ID_PATTERN = /^\d+$/;

function splitLines(text) {
  return String(text ?? '').replace(/\r\n?/g, '\n').split('\n');
}

function stripComment(line) {
  const idx = line.indexOf('#');
  return idx === -1 ? line : line.slice(0, idx);
}

function firstCell(line) {
  // Accept either "name,extra,stuff" or plain "name". Quoting is rare so a
  // basic split is enough; we only look at the first cell.
  const firstComma = line.indexOf(',');
  const cell = firstComma === -1 ? line : line.slice(0, firstComma);
  return cell.trim().replace(/^"(.*)"$/, '$1');
}

/**
 * Try each URL pattern in order. Returns the parsed serverId on hit, or null.
 */
export function extractServerIdFromUrl(line) {
  for (const { regex } of URL_PATTERNS) {
    const m = line.match(regex);
    if (m) {
      const id = Number(m[1]);
      if (Number.isFinite(id) && id > 0) return id;
    }
  }
  return null;
}

/**
 * Classify a single trimmed line. The dispatcher prefers URL extraction over
 * the ID pattern: URL detection is the more specific check, and an
 * all-numeric URL is implausible.
 */
export function classifyLine(raw) {
  const trimmed = String(raw).trim();
  if (!trimmed) return null;
  const urlId = extractServerIdFromUrl(trimmed);
  if (urlId != null) return { kind: 'url', raw: trimmed, serverId: urlId };

  // Pull the leading cell so a CSV line like "FGVM01,extra" still classifies
  // on the first column for ID/name detection.
  const cell = firstCell(trimmed);
  if (!cell) return null;
  if (ID_PATTERN.test(cell)) {
    const id = Number(cell);
    if (Number.isFinite(id) && id > 0) return { kind: 'id', raw: trimmed, serverId: id };
  }
  return { kind: 'name', raw: trimmed, name: cell };
}

export function parseInput(input) {
  const warnings = [];
  const entries = [];
  const seenIds = new Set();
  const seenNames = new Set();
  let totalLines = 0;
  let headerChecked = false;

  for (const rawLine of splitLines(input)) {
    const stripped = stripComment(rawLine).trim();
    if (!stripped) continue;

    // First non-blank line: optional "name" header, mirrors the
    // fabric-connection tool's parse-csv. Only honoured when the line is
    // exactly the literal header (case-insensitive) - URL and ID lines are
    // never mistaken for headers.
    if (!headerChecked) {
      headerChecked = true;
      const cell = firstCell(stripped);
      if (cell.toLowerCase() === 'name'
          && extractServerIdFromUrl(stripped) == null
          && !ID_PATTERN.test(cell)) {
        continue;
      }
    }

    const entry = classifyLine(stripped);
    if (!entry) continue;
    totalLines++;

    if (entry.kind === 'url' || entry.kind === 'id') {
      if (seenIds.has(entry.serverId)) {
        warnings.push(`Duplicate server id ${entry.serverId} (from ${entry.kind === 'url' ? 'URL' : 'raw ID'} "${entry.raw}") - deduplicated`);
        continue;
      }
      seenIds.add(entry.serverId);
    } else {
      if (seenNames.has(entry.name)) {
        warnings.push(`Duplicate name "${entry.name}" - deduplicated`);
        continue;
      }
      seenNames.add(entry.name);
    }
    entries.push(entry);
  }

  return { entries, warnings, totalLines };
}
