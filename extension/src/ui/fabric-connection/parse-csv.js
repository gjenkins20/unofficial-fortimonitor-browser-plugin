// Unofficial FortiMonitor Toolkit — Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// Parse the operator's CSV/paste input for the Add Fabric Connection tool.
//
// Each row is a FortiGate: serial, IP, port. Header optional.
//
// Returns:
//   {
//     devices: Array<{ serial, ip, port, lineNum }>
//     warnings: string[]
//     totalLines: number
//   }
//
// Pure module — no chrome APIs, fully unit-testable.

const SERIAL_RE = /^[A-Za-z0-9]{8,}$/;          // FortiGate serials are alphanumeric, ≥ 8 chars
const IP_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const PORT_MIN = 1;
const PORT_MAX = 65535;

function splitLines(text) {
  return String(text ?? '').replace(/\r\n?/g, '\n').split('\n');
}

function stripComment(line) {
  const idx = line.indexOf('#');
  return idx === -1 ? line : line.slice(0, idx);
}

function parseRow(line) {
  // Tiny CSV parser; matches the shape used elsewhere in the project.
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
  const lc = tokens.map((t) => t.toLowerCase());
  return lc.includes('serial') || lc.includes('serial_number')
      || lc.includes('ip') || lc.includes('ip_address')
      || lc.includes('host')
      || lc.includes('port');
}

function isValidIP(s) {
  const m = IP_RE.exec(s);
  if (!m) return false;
  for (let i = 1; i <= 4; i++) {
    const n = Number(m[i]);
    if (n < 0 || n > 255) return false;
  }
  return true;
}

function isValidPort(n) {
  return Number.isInteger(n) && n >= PORT_MIN && n <= PORT_MAX;
}

export function parseFortigateList(input, { defaultPort = 8013 } = {}) {
  const warnings = [];
  const devices = [];
  const seenSerials = new Set();
  let totalLines = 0;

  let headerCols = null;
  const rawLines = splitLines(input);

  for (let lineNum = 0; lineNum < rawLines.length; lineNum++) {
    const raw = stripComment(rawLines[lineNum]).trim();
    if (!raw) continue;
    totalLines++;

    const tokens = parseRow(raw);

    // First non-blank line decides whether this is a header row.
    if (headerCols === null) {
      if (looksLikeHeader(tokens)) {
        const lc = tokens.map((t) => t.toLowerCase());
        const find = (...names) => lc.findIndex((t) => names.includes(t));
        headerCols = {
          serialIdx: find('serial', 'serial_number', 'sn'),
          ipIdx: find('ip', 'ip_address', 'host', 'upstream_host'),
          portIdx: find('port', 'upstream_port')
        };
        if (headerCols.serialIdx === -1) headerCols.serialIdx = 0;
        if (headerCols.ipIdx === -1) headerCols.ipIdx = 1;
        // portIdx allowed to remain -1 → default port used
        totalLines--;
        continue;
      }
      // Positional layout: serial, ip, port
      headerCols = { serialIdx: 0, ipIdx: 1, portIdx: 2 };
    }

    const serial = tokens[headerCols.serialIdx] ?? '';
    const ip = tokens[headerCols.ipIdx] ?? '';
    const portRaw = headerCols.portIdx >= 0 ? (tokens[headerCols.portIdx] ?? '') : '';

    if (!serial) {
      warnings.push(`Line ${lineNum + 1}: missing serial — skipped`);
      continue;
    }
    if (!SERIAL_RE.test(serial)) {
      warnings.push(`Line ${lineNum + 1}: "${serial}" doesn't look like a FortiGate serial — skipped`);
      continue;
    }
    if (!ip) {
      warnings.push(`Line ${lineNum + 1}: missing IP for serial ${serial} — skipped`);
      continue;
    }
    if (!isValidIP(ip)) {
      warnings.push(`Line ${lineNum + 1}: "${ip}" is not a valid IPv4 address — skipped`);
      continue;
    }

    let port;
    if (portRaw === '') {
      port = defaultPort;
    } else {
      const parsed = Number(portRaw);
      if (!isValidPort(parsed)) {
        warnings.push(`Line ${lineNum + 1}: "${portRaw}" is not a valid port (1–65535) — skipped`);
        continue;
      }
      port = parsed;
    }

    if (seenSerials.has(serial)) {
      warnings.push(`Line ${lineNum + 1}: duplicate serial ${serial} — deduplicated`);
      continue;
    }
    seenSerials.add(serial);
    devices.push({ serial, ip, port, lineNum: lineNum + 1 });
  }

  return { devices, warnings, totalLines };
}
