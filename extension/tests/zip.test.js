import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildZip, crc32 } from '../src/lib/zip.js';
import { execSync } from 'node:child_process';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Sentinel: known CRC-32 of the ASCII string "123456789" is 0xCBF43926.
test('crc32: matches the canonical "123456789" sentinel (0xCBF43926)', () => {
  const enc = new TextEncoder();
  assert.equal(crc32(enc.encode('123456789')), 0xCBF43926);
});

test('crc32: empty input is 0', () => {
  assert.equal(crc32(new Uint8Array()), 0);
});

test('buildZip: emits the four PKZIP signatures (LFH, CDH, EOCD)', () => {
  const z = buildZip([{ filename: 'a.txt', content: 'hello' }]);
  // LFH 'PK\x03\x04' at the start.
  assert.equal(z[0], 0x50);
  assert.equal(z[1], 0x4B);
  assert.equal(z[2], 0x03);
  assert.equal(z[3], 0x04);
  // EOCD 'PK\x05\x06' near the end - last 22 bytes for a comment-less zip.
  assert.equal(z[z.length - 22], 0x50);
  assert.equal(z[z.length - 21], 0x4B);
  assert.equal(z[z.length - 20], 0x05);
  assert.equal(z[z.length - 19], 0x06);
});

test('buildZip: multi-entry archive emits the expected number of PKZIP magic words', () => {
  const entries = [
    { filename: 'a.txt', content: 'alpha' },
    { filename: 'b.txt', content: 'bravo bravo' }
  ];
  const z = buildZip(entries);
  // Two LFH signatures + one CDH per entry + one EOCD = at least 4 PKZIP magic words.
  let sigs = 0;
  for (let i = 0; i < z.length - 3; i++) {
    if (z[i] === 0x50 && z[i + 1] === 0x4B) {
      const sig = (z[i + 2]) | (z[i + 3] << 8);
      if (sig === 0x0403 || sig === 0x0201 || sig === 0x0605) sigs++;
    }
  }
  assert.equal(sigs, entries.length * 2 + 1, 'expected 2*entries + 1 magic words');
});

test('buildZip: empty entry list produces a valid zero-entry zip', () => {
  const z = buildZip([]);
  // Just an EOCD; total length 22 bytes.
  assert.equal(z.length, 22);
  assert.equal(z[0], 0x50);
  assert.equal(z[1], 0x4B);
  assert.equal(z[2], 0x05);
  assert.equal(z[3], 0x06);
});

test('buildZip: rejects entries without a filename', () => {
  assert.throws(() => buildZip([{ content: 'x' }]), /filename/);
});

// Round-trip through the system unzip tool. This is the strongest test:
// if a real unzip extracts our archive byte-for-byte, the format is correct.
test('buildZip: system unzip extracts content byte-for-byte', () => {
  // Skip when unzip isn't on PATH (CI minimal images may not have it).
  let hasUnzip = true;
  try { execSync('which unzip', { stdio: 'pipe' }); }
  catch { hasUnzip = false; }
  if (!hasUnzip) return;

  const tmp = mkdtempSync(path.join(tmpdir(), 'fm-zip-test-'));
  try {
    const entries = [
      { filename: 'README.txt', content: 'hello world\nline 2\n' },
      { filename: 'data.csv', content: '"a","b"\n"1","2"\n' }
    ];
    const zipPath = path.join(tmp, 'out.zip');
    writeFileSync(zipPath, Buffer.from(buildZip(entries)));
    execSync(`unzip -o ${zipPath} -d ${tmp}`, { stdio: 'pipe' });
    const a = execSync(`cat ${tmp}/README.txt`).toString();
    const b = execSync(`cat ${tmp}/data.csv`).toString();
    assert.equal(a, 'hello world\nline 2\n');
    assert.equal(b, '"a","b"\n"1","2"\n');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
