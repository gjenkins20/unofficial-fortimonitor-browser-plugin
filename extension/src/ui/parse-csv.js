// Parse the operator's CSV/paste input from the batch-start screen.
//
// Accepts two shapes:
//   1. Plain list of server IDs, one per line (blank lines and # comments ignored).
//   2. CSV with a `server_id` column; an optional `device_name` column is
//      captured for display in later steps.
//
// Returns a structured result:
//   {
//     serverIds: string[]          // deduplicated, in first-seen order
//     nameById: Record<id, string> // optional display names
//     warnings: string[]           // human-readable notes (dedupe, malformed, etc.)
//     totalLines: number           // non-blank input lines (excluding header)
//   }
//
// Pure module — no chrome APIs, fully unit-testable.

const SERVER_ID_RE = /^\d{1,20}$/;

function splitLines(text) {
  return String(text ?? '').replace(/\r\n?/g, '\n').split('\n');
}

function stripComment(line) {
  const idx = line.indexOf('#');
  return idx === -1 ? line : line.slice(0, idx);
}

function parseCsvRow(line) {
  // Tiny CSV parser sufficient for our narrow use case (no embedded quotes
  // with commas inside server IDs or device names). If we ever need full
  // CSV semantics, switch to a real library.
  const out = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') { field += '"'; i++; continue; }
      if (ch === '"') { inQuotes = false; continue; }
      field += ch;
    } else {
      if (ch === '"' && field === '') { inQuotes = true; continue; }
      if (ch === ',') { out.push(field); field = ''; continue; }
      field += ch;
    }
  }
  out.push(field);
  return out.map((f) => f.trim());
}

function looksLikeHeader(tokens) {
  if (tokens.length < 1) return false;
  const lc = tokens.map((t) => t.toLowerCase());
  return lc.includes('server_id') || lc.includes('serverid') || lc.includes('id');
}

export function parseServerList(input) {
  const warnings = [];
  const serverIds = [];
  const nameById = {};
  const seen = new Set();
  let totalLines = 0;

  let headerCols = null; // { idIdx, nameIdx }
  const rawLines = splitLines(input);

  for (let lineNum = 0; lineNum < rawLines.length; lineNum++) {
    const raw = stripComment(rawLines[lineNum]).trim();
    if (!raw) continue;
    totalLines++;

    const tokens = parseCsvRow(raw);

    // First non-blank line determines whether this is a CSV with a header.
    if (headerCols === null) {
      if (looksLikeHeader(tokens)) {
        const lc = tokens.map((t) => t.toLowerCase());
        const idIdx = lc.findIndex((t) => t === 'server_id' || t === 'serverid' || t === 'id');
        const nameIdx = lc.findIndex((t) => t === 'device_name' || t === 'devicename' || t === 'name');
        headerCols = { idIdx, nameIdx };
        totalLines--; // header doesn't count as a data row
        continue;
      }
      headerCols = { idIdx: 0, nameIdx: -1 };
    }

    const idRaw = tokens[headerCols.idIdx] ?? '';
    const nameRaw = headerCols.nameIdx >= 0 ? tokens[headerCols.nameIdx] ?? '' : '';

    if (!idRaw) {
      warnings.push(`Line ${lineNum + 1}: no server ID — skipped`);
      continue;
    }
    if (!SERVER_ID_RE.test(idRaw)) {
      warnings.push(`Line ${lineNum + 1}: "${idRaw}" is not a numeric server ID — skipped`);
      continue;
    }
    if (seen.has(idRaw)) {
      warnings.push(`Line ${lineNum + 1}: duplicate server ID ${idRaw} — deduplicated`);
      continue;
    }
    seen.add(idRaw);
    serverIds.push(idRaw);
    if (nameRaw) nameById[idRaw] = nameRaw;
  }

  return { serverIds, nameById, warnings, totalLines };
}
