// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// Minimal STORE-mode (no compression) ZIP writer.
//
// Pure JS, no runtime dependencies. Sufficient for bundling a small
// number of CSV files into one .zip download (FMN-133's combined
// tenant-observations report). Files are stored uncompressed -
// CSVs are small enough that compression isn't worth the LOC.
//
// PKZIP format reference:
//   APPNOTE.TXT - .ZIP File Format Specification, version 6.3.10
//
// We emit only the subset needed for STORE files <4 GiB, no Zip64,
// no encryption, no extra fields, no folder entries.

const SIG_LFH    = 0x04034b50;       // local file header
const SIG_CDH    = 0x02014b50;       // central directory header
const SIG_EOCD   = 0x06054b50;       // end of central directory
const VERSION    = 20;               // 2.0 (default zip)
const COMPRESSION_STORE = 0;         // no compression
const FLAG_UTF8 = 0x0800;            // language encoding flag (utf-8)

// ---------------------------------------------------------------------------
// CRC-32 - polynomial 0xEDB88320, byte-wise table lookup.
// ---------------------------------------------------------------------------

let CRC32_TABLE = null;
function ensureCrcTable() {
  if (CRC32_TABLE) return CRC32_TABLE;
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  CRC32_TABLE = t;
  return t;
}

export function crc32(bytes) {
  const t = ensureCrcTable();
  let c = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) {
    c = t[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
  }
  return (c ^ 0xFFFFFFFF) >>> 0;
}

// ---------------------------------------------------------------------------
// Build a ZIP from [{ filename: string, content: string|Uint8Array }] entries.
// Returns a single Uint8Array.
// ---------------------------------------------------------------------------

const TEXT_ENCODER = new TextEncoder();

function asBytes(content) {
  if (content instanceof Uint8Array) return content;
  return TEXT_ENCODER.encode(String(content ?? ''));
}

/**
 * MS-DOS date/time encoding for the LFH/CDH timestamp fields. ZIP stores
 * times in 2-second resolution and dates in 1980-relative years. JS Date
 * is fine to use directly.
 */
function dosDateTime(d = new Date()) {
  const year = d.getFullYear();
  const dosYear = year < 1980 ? 0 : year - 1980;
  const date = ((dosYear & 0x7F) << 9) | (((d.getMonth() + 1) & 0x0F) << 5) | (d.getDate() & 0x1F);
  const time = ((d.getHours() & 0x1F) << 11) | ((d.getMinutes() & 0x3F) << 5) | ((Math.floor(d.getSeconds() / 2)) & 0x1F);
  return { date: date & 0xFFFF, time: time & 0xFFFF };
}

class ByteWriter {
  constructor() {
    // Grow geometrically; flatten on toUint8Array().
    this.chunks = [];
    this.length = 0;
  }
  push(bytes) {
    this.chunks.push(bytes);
    this.length += bytes.length;
  }
  writeUint16(v) {
    const b = new Uint8Array(2);
    b[0] = v & 0xFF;
    b[1] = (v >>> 8) & 0xFF;
    this.push(b);
  }
  writeUint32(v) {
    const b = new Uint8Array(4);
    b[0] = v & 0xFF;
    b[1] = (v >>> 8) & 0xFF;
    b[2] = (v >>> 16) & 0xFF;
    b[3] = (v >>> 24) & 0xFF;
    this.push(b);
  }
  toUint8Array() {
    const out = new Uint8Array(this.length);
    let offset = 0;
    for (const c of this.chunks) {
      out.set(c, offset);
      offset += c.length;
    }
    return out;
  }
}

/**
 * @param {{ filename: string, content: string|Uint8Array }[]} entries
 * @param {{ now?: Date }} [options]
 * @returns {Uint8Array}
 */
export function buildZip(entries, { now = new Date() } = {}) {
  if (!Array.isArray(entries)) throw new TypeError('buildZip: entries must be an array');
  const out = new ByteWriter();
  const central = new ByteWriter();
  let runningOffset = 0;
  const { date: dosDate, time: dosTime } = dosDateTime(now);

  for (const e of entries) {
    if (!e || typeof e.filename !== 'string' || !e.filename) {
      throw new TypeError('buildZip: every entry needs a non-empty filename');
    }
    const nameBytes = TEXT_ENCODER.encode(e.filename);
    const contentBytes = asBytes(e.content);
    const crc = crc32(contentBytes);
    const size = contentBytes.length;
    const lfhStart = runningOffset;

    // ---- Local File Header ----
    out.writeUint32(SIG_LFH);
    out.writeUint16(VERSION);              // version needed to extract
    out.writeUint16(FLAG_UTF8);            // general purpose bit flag
    out.writeUint16(COMPRESSION_STORE);    // compression method
    out.writeUint16(dosTime);
    out.writeUint16(dosDate);
    out.writeUint32(crc);
    out.writeUint32(size);                 // compressed size (= size for STORE)
    out.writeUint32(size);                 // uncompressed size
    out.writeUint16(nameBytes.length);
    out.writeUint16(0);                    // extra field length
    out.push(nameBytes);
    out.push(contentBytes);
    runningOffset += 30 + nameBytes.length + size;

    // ---- Central Directory Header ----
    central.writeUint32(SIG_CDH);
    central.writeUint16(VERSION);          // version made by
    central.writeUint16(VERSION);          // version needed to extract
    central.writeUint16(FLAG_UTF8);
    central.writeUint16(COMPRESSION_STORE);
    central.writeUint16(dosTime);
    central.writeUint16(dosDate);
    central.writeUint32(crc);
    central.writeUint32(size);             // compressed
    central.writeUint32(size);             // uncompressed
    central.writeUint16(nameBytes.length);
    central.writeUint16(0);                // extra field length
    central.writeUint16(0);                // comment length
    central.writeUint16(0);                // disk number start
    central.writeUint16(0);                // internal file attrs
    central.writeUint32(0);                // external file attrs
    central.writeUint32(lfhStart);         // relative offset of LFH
    central.push(nameBytes);
  }

  const cdhStart = runningOffset;
  const cdhBytes = central.toUint8Array();
  out.push(cdhBytes);

  // ---- End Of Central Directory ----
  out.writeUint32(SIG_EOCD);
  out.writeUint16(0);                       // disk number
  out.writeUint16(0);                       // disk where CD starts
  out.writeUint16(entries.length);          // entries on this disk
  out.writeUint16(entries.length);          // entries total
  out.writeUint32(cdhBytes.length);         // CD size
  out.writeUint32(cdhStart);                // CD offset
  out.writeUint16(0);                       // .zip comment length

  return out.toUint8Array();
}

/**
 * Convenience: build a ZIP and trigger a browser download.
 * @param {string} filename
 * @param {{ filename: string, content: string|Uint8Array }[]} entries
 */
export function downloadZip(filename, entries) {
  const bytes = buildZip(entries);
  const blob = new Blob([bytes], { type: 'application/zip' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
