// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// Parse the operator's CSV/paste input for the Add Fabric Connection tool.
//
// Each row is a FortiGate: serial, IP, port, name. Header optional.
// `name` (FMN-291) is optional and free-form - it becomes the connection
// label. Positionally it is the 4th column; by header it is `name` or
// `label`. Blank name is omitted, and the caller falls back to the IP.
//
// Returns:
//   {
//     devices: Array<{ serial, ip, port, lineNum, name?, flagged? }>
//     warnings: string[]
//     skipped: Array<{ lineNum, serial, ip, port, reason, severity }>
//     totalLines: number
//   }
//
// `severity` partitions skip reasons:
//   'soft'  - failed a format heuristic only (serial pattern, IPv4-vs-host).
//             Overridable via { includeFlagged: true } - the operator opts in
//             to onboarding the row anyway. This is the inflexibility FMN-265
//             relaxes.
//   'hard'  - a required field is genuinely absent / unusable (no serial, no
//             IP, non-numeric port). Cannot build a POST body; never included.
//   'dedup' - duplicate serial already accepted this run; always collapsed.
//
// Pure module - no chrome APIs, fully unit-testable.

// FortiGate serials are alphanumeric, >= 8 chars. Cloud / marketplace serials
// (FGTAWS-, FGTAZR-, FGTGCP-, ...) carry a hyphen, so it must be permitted
// (FMN-265). At least one alphanumeric char is required so a string of only
// hyphens isn't mistaken for a serial.
const SERIAL_RE = /^(?=.*[A-Za-z0-9])[A-Za-z0-9-]{8,}$/;
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

export function parseFortigateList(input, { defaultPort = 8013, includeFlagged = false } = {}) {
  const warnings = [];
  const skipped = [];
  const devices = [];
  const seenSerials = new Set();
  let totalLines = 0;

  let headerCols = null;
  const rawLines = splitLines(input);

  // Record a skipped row both as a human warning (existing UI contract) and a
  // structured entry (new, drives the flagged-device summary).
  function skip(lineNum, serial, ip, port, reason, severity, verb = 'skipped') {
    warnings.push(`Line ${lineNum}: ${reason} - ${verb}`);
    skipped.push({ lineNum, serial, ip, port, reason, severity });
  }

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
          portIdx: find('port', 'upstream_port'),
          nameIdx: find('name', 'label')
        };
        if (headerCols.serialIdx === -1) headerCols.serialIdx = 0;
        if (headerCols.ipIdx === -1) headerCols.ipIdx = 1;
        // portIdx / nameIdx allowed to remain -1 → default port / no name
        totalLines--;
        continue;
      }
      // Positional layout: serial, ip, port, name
      headerCols = { serialIdx: 0, ipIdx: 1, portIdx: 2, nameIdx: 3 };
    }

    const serial = tokens[headerCols.serialIdx] ?? '';
    const ip = tokens[headerCols.ipIdx] ?? '';
    const portRaw = headerCols.portIdx >= 0 ? (tokens[headerCols.portIdx] ?? '') : '';
    // Optional free-form connection label (FMN-291). tokens are pre-trimmed.
    const name = headerCols.nameIdx >= 0 ? (tokens[headerCols.nameIdx] ?? '') : '';
    const ln = lineNum + 1;

    // Soft format issues accumulate here; when includeFlagged is set they
    // annotate an otherwise-onboarded device instead of skipping it.
    const softIssues = [];

    // Hard: no serial at all - nothing to put in upstream_sn.
    if (!serial) {
      skip(ln, serial, ip, null, 'missing serial', 'hard');
      continue;
    }

    // Soft: serial doesn't match the expected shape (heuristic guess).
    if (!SERIAL_RE.test(serial)) {
      if (includeFlagged) {
        softIssues.push('unusual serial');
      } else {
        skip(ln, serial, ip, null, `"${serial}" doesn't look like a FortiGate serial`, 'soft');
        continue;
      }
    }

    // Hard: no host at all - nothing to put in upstream_host.
    if (!ip) {
      skip(ln, serial, ip, null, `missing IP for serial ${serial}`, 'hard');
      continue;
    }

    // Soft: not an IPv4. The API field is upstream_host, so a DNS name may be
    // intentional - let the operator opt in rather than hard-blocking.
    if (!isValidIP(ip)) {
      if (includeFlagged) {
        softIssues.push('non-IPv4 host');
      } else {
        skip(ln, serial, ip, null, `"${ip}" is not a valid IPv4 address`, 'soft');
        continue;
      }
    }

    let port;
    if (portRaw === '') {
      port = defaultPort;
    } else {
      const parsed = Number(portRaw);
      if (!isValidPort(parsed)) {
        // Hard: a present port that isn't a valid number/range. We won't guess
        // a substitute even under includeFlagged - silently rewriting the
        // operator's value is worse than a clear skip.
        skip(ln, serial, ip, null, `"${portRaw}" is not a valid port (1–65535)`, 'hard');
        continue;
      }
      port = parsed;
    }

    if (seenSerials.has(serial)) {
      skip(ln, serial, ip, port, `duplicate serial ${serial}`, 'dedup', 'deduplicated');
      continue;
    }
    seenSerials.add(serial);

    const device = { serial, ip, port, lineNum: ln };
    if (name) device.name = name;
    if (softIssues.length) {
      device.flagged = softIssues.join(', ');
      warnings.push(`Line ${ln}: included flagged device ${serial} (${device.flagged})`);
    }
    devices.push(device);
  }

  return { devices, warnings, skipped, totalLines };
}
