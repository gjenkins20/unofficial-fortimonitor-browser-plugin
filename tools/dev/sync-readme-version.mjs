#!/usr/bin/env node
// FMN-242: keep README.md's "Current version" line in sync with the version
// in extension/manifest.json. Run from the repo root:
//
//   node tools/dev/sync-readme-version.mjs           # rewrite README
//   node tools/dev/sync-readme-version.mjs --check   # fail with non-zero
//                                                    # if README would change
//
// --check is intended for a pre-commit / CI gate. The script exits with code
// 1 (and prints a diff line) when the README version line is stale.

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..');
const MANIFEST_PATH = resolve(REPO_ROOT, 'extension', 'manifest.json');
const README_PATH = resolve(REPO_ROOT, 'README.md');

const REPO_RELEASES_URL =
  'https://github.com/gjenkins20/unofficial-fortimonitor-browser-plugin/releases';

// Regex matches the whole version line in README. Anchored to end-of-line so
// the replacement rewrites the line in one shot (the prior commit had a
// shorter prefix-only match that duplicated the tail). The script refuses to
// run if the marker is missing so the README cannot silently drift.
const VERSION_LINE_RE =
  /\*\*Current version: \[v[^\]]+\]\([^)]+\)\*\*[^\n]*/m;

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function buildVersionLine(version) {
  return (
    `**Current version: [v${version}](${REPO_RELEASES_URL})** — ` +
    `compare against your installed copy in \`chrome://extensions\` to ` +
    `see how far behind you are. Run \`git pull\` in your clone and ` +
    `reload the extension to upgrade.`
  );
}

function main() {
  const args = process.argv.slice(2);
  const checkOnly = args.includes('--check');

  const manifest = readJson(MANIFEST_PATH);
  const version = manifest.version;
  if (!version || typeof version !== 'string') {
    console.error('[sync-readme-version] no version in extension/manifest.json');
    process.exit(2);
  }

  const readme = readFileSync(README_PATH, 'utf8');
  if (!VERSION_LINE_RE.test(readme)) {
    console.error(
      '[sync-readme-version] README.md is missing the version marker line. ' +
        'Add `**Current version: [vX.Y.Z](...)** — compare against...` near the top.'
    );
    process.exit(2);
  }

  const expectedLine = buildVersionLine(version);
  const nextReadme = readme.replace(VERSION_LINE_RE, expectedLine);

  if (nextReadme === readme) {
    console.log(`[sync-readme-version] README already at v${version}`);
    process.exit(0);
  }

  if (checkOnly) {
    console.error(
      `[sync-readme-version] README version line is stale ` +
        `(expected v${version}). Run \`node tools/dev/sync-readme-version.mjs\` ` +
        `to fix.`
    );
    process.exit(1);
  }

  writeFileSync(README_PATH, nextReadme, 'utf8');
  console.log(`[sync-readme-version] README updated to v${version}`);
}

main();
