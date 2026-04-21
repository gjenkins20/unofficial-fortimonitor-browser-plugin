// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// Parse operator input for the Server Name → ID Lookup tool.
//
// Input is a single column of server names - one per line. Accepts a
// bare list or a CSV whose first line is the `name` header. No format
// validation is applied to the names themselves: FortiMonitor lets
// users pick arbitrary server names (hostnames, friendly labels, etc.),
// so we trust whatever the operator pastes in and exact-match it later.
//
// Returns { names, warnings, totalLines }.
//
// Pure module - no chrome APIs, fully unit-testable.

function splitLines(text) {
  return String(text ?? '').replace(/\r\n?/g, '\n').split('\n');
}

function stripComment(line) {
  const idx = line.indexOf('#');
  return idx === -1 ? line : line.slice(0, idx);
}

function firstCell(line) {
  // Accept either "name,extra,stuff" or plain "name". Quoting is rare
  // here so a basic split is enough - we only look at the first cell.
  const firstComma = line.indexOf(',');
  const cell = firstComma === -1 ? line : line.slice(0, firstComma);
  return cell.trim().replace(/^"(.*)"$/, '$1');
}

export function parseNameList(input) {
  const warnings = [];
  const names = [];
  const seen = new Set();
  let totalLines = 0;
  let headerChecked = false;

  for (const raw of splitLines(input)) {
    const stripped = stripComment(raw).trim();
    if (!stripped) continue;

    const cell = firstCell(stripped);
    if (!cell) continue;
    totalLines++;

    // If the first non-blank line is literally "name" (any case), treat
    // it as a header row and skip it. Matches the convention used by
    // the fabric-connection tool's parse-csv.
    if (!headerChecked) {
      headerChecked = true;
      if (cell.toLowerCase() === 'name') {
        totalLines--;
        continue;
      }
    }

    if (seen.has(cell)) {
      warnings.push(`Duplicate name "${cell}" - deduplicated`);
      continue;
    }
    seen.add(cell);
    names.push(cell);
  }

  return { names, warnings, totalLines };
}
