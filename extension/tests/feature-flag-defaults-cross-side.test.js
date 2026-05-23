// FMN-252: cross-side feature-flag default audit.
//
// Bug class this test prevents: a boolean visibility flag whose
// popup-side helper (settings.js) and content-script loader (augment.js
// / *-bridge.js) disagree on what an empty-storage entry resolves to.
// FMN-251 was the canonical regression: FMN-239 flipped
// isOmniSearchEnabled() default-on but never touched augment.js's
// loadOmniSearchFlag(), so fresh installs saw a checked Settings toggle
// with no on-page input replacement.
//
// For each flag in the manifest below, this test:
//   1. Calls the popup-side helper with an empty storage mock and
//      asserts the result matches expectedDefault.
//   2. Extracts the content-script loader function body, runs it with
//      an empty chrome.storage.local mock, and asserts the resulting
//      flag value matches expectedDefault.
// Plus a third orphan-flag test that scans every content-script source
// file for fm: storage keys and fails if any are read without being
// listed either in the manifest or in the known-non-flag allowlist
// (catches FMN-250-style "popup toggle retired, content script still
// gates on the dead flag" regressions).

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStorageMock } from './fixtures/chrome-mocks.js';
import * as settings from '../src/lib/settings.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(__dirname, '..', 'src');

// loader.kind:
//   'mutator'  - the function writes to a module-scoped variable named
//                stateVar; the test captures that variable after the
//                body runs.
//   'returner' - the function returns a boolean directly; the test
//                captures the return value.
//   'inline'   - the flag is read inside a larger function (no named
//                loader); the test asserts the source contains an
//                expected default-handling snippet. Use sparingly;
//                prefer mutator/returner for new flags.
const CROSS_SIDE_FLAGS = [
  {
    key: 'fm:omniSearchEnabled',
    expectedDefault: true,
    popupHelper: 'isOmniSearchEnabled',
    contentScript: 'content/augment.js',
    loader: { kind: 'mutator', name: 'loadOmniSearchFlag', stateVar: 'omniSearchEnabled' },
  },
  {
    key: 'fm:sidebarLauncherEnabled',
    expectedDefault: false,
    popupHelper: 'isSidebarLauncherEnabled',
    contentScript: 'content/augment.js',
    loader: { kind: 'mutator', name: 'loadSidebarLauncherFlag', stateVar: 'sidebarLauncherEnabled' },
  },
  {
    key: 'fm:showFeatureBadges',
    expectedDefault: true,
    popupHelper: 'isShowFeatureBadgesEnabled',
    contentScript: 'content/augment.js',
    loader: { kind: 'mutator', name: 'loadShowFeatureBadgesFlag', stateVar: 'showFeatureBadgesEnabled' },
  },
  {
    key: 'fm:snapshotDiffEnabled',
    expectedDefault: false,
    popupHelper: 'isSnapshotDiffEnabled',
    contentScript: 'content/augment.js',
    loader: { kind: 'mutator', name: 'loadSnapshotDiffFlag', stateVar: 'snapshotDiffEnabled' },
  },
  {
    key: 'fm:reportNotificationsEnabled',
    expectedDefault: false,
    popupHelper: 'isReportNotificationsEnabled',
    contentScript: 'content/augment.js',
    loader: { kind: 'mutator', name: 'loadReportBellState', stateVar: 'reportNotifEnabled' },
  },
  {
    key: 'fm:showInfoBubbles',
    expectedDefault: true,
    popupHelper: 'isShowInfoBubblesEnabled',
    contentScript: 'content/augment.js',
    loader: { kind: 'inline', snippet: 'infoBubblesEnabled = flag === undefined ? true : Boolean(flag)' },
  },
  {
    key: 'fm:customMetricsTourEnabled',
    expectedDefault: false,
    popupHelper: 'isCustomMetricsTourEnabled',
    contentScript: 'content/custom-metrics-tour-bridge.js',
    loader: { kind: 'returner', name: 'isEnabled' },
  },
];

// Content-script storage keys that are NOT boolean visibility flags
// (lists, maps, counters). The orphan-detection test allowlists these.
const NON_FLAG_CONTENT_SCRIPT_KEYS = new Set([
  'fm:webguiColumns',
  'fm:dismissedInfoBubbles',
  'fm:reportNotificationBadge',
  'fm:reportNotificationHistory',
]);

for (const flag of CROSS_SIDE_FLAGS) {
  test(`${flag.key}: popup ${flag.popupHelper}() returns ${flag.expectedDefault} on empty storage`, async () => {
    const fn = settings[flag.popupHelper];
    assert.equal(
      typeof fn, 'function',
      `${flag.popupHelper} is not exported from settings.js (manifest stale?)`
    );
    const storage = createStorageMock();
    const result = await fn(storage);
    assert.equal(
      result, flag.expectedDefault,
      `${flag.popupHelper} on empty storage returned ${result}, manifest expects ${flag.expectedDefault}. Update either the manifest or the helper - both sides must agree.`
    );
  });

  test(`${flag.key}: content-script ${flag.contentScript}:${describeLoader(flag.loader)} agrees with popup default ${flag.expectedDefault}`, async () => {
    const sourcePath = path.join(SRC, flag.contentScript);
    const source = fs.readFileSync(sourcePath, 'utf8');

    if (flag.loader.kind === 'inline') {
      assert.ok(
        source.includes(flag.loader.snippet),
        `${flag.contentScript} no longer contains the expected default-handling snippet for ${flag.key}:\n  ${flag.loader.snippet}\nIf the snippet was refactored, update the manifest entry; if the default-handling changed, verify the popup helper ${flag.popupHelper} still agrees with the new shape.`
      );
      return;
    }

    const result = await runContentScriptLoader(source, flag);
    assert.equal(
      result, flag.expectedDefault,
      `${flag.loader.name} in ${flag.contentScript} resolved empty storage to ${result}, but popup helper ${flag.popupHelper} resolves it to ${flag.expectedDefault}. This is the FMN-251 bug class - the operator sees a "visible" toggle but the on-page surface never mounts (or vice versa).`
    );
  });
}

// Orphan-flag detection. Scans every content-script source file for
// quoted 'fm:*' storage keys and asserts each one is either in the
// CROSS_SIDE_FLAGS manifest or the NON_FLAG_CONTENT_SCRIPT_KEYS
// allowlist. Catches FMN-250-style regressions where a popup toggle is
// retired but a content-script bridge still reads the dead key.
test('no orphan fm: storage keys read by content scripts', () => {
  const knownKeys = new Set([
    ...CROSS_SIDE_FLAGS.map((f) => f.key),
    ...NON_FLAG_CONTENT_SCRIPT_KEYS,
  ]);

  const contentDir = path.join(SRC, 'content');
  const contentFiles = fs.readdirSync(contentDir).filter((f) => f.endsWith('.js'));
  const orphans = [];

  // Match fm: strings that are declared as const-bound storage keys
  // (the convention for chrome.storage.local entries). Inline strings
  // used as chrome.runtime.sendMessage type literals are NOT keyed via
  // a const, so they fall out of scope here automatically.
  const KEY_DECL = /const\s+\w+\s*=\s*['"](fm:[a-zA-Z0-9_-]+)['"]/g;

  for (const file of contentFiles) {
    const source = fs.readFileSync(path.join(contentDir, file), 'utf8');
    const matches = source.matchAll(KEY_DECL);
    const seen = new Set();
    for (const m of matches) {
      const key = m[1];
      if (seen.has(key)) continue;
      seen.add(key);
      if (!knownKeys.has(key)) {
        orphans.push({ file, key });
      }
    }
  }

  assert.deepEqual(
    orphans, [],
    `Content scripts read storage keys not declared in the cross-side manifest:\n${JSON.stringify(orphans, null, 2)}\nEither add the key to CROSS_SIDE_FLAGS (with a popup helper) or to NON_FLAG_CONTENT_SCRIPT_KEYS (if it's not a boolean visibility flag). Orphan reads silently break features when the popup side is later retired (FMN-250-class regression).`
  );
});

function describeLoader(loader) {
  if (loader.kind === 'inline') return `inline assignment (${truncate(loader.snippet, 40)})`;
  return `${loader.kind} ${loader.name}`;
}

function truncate(s, n) {
  return s.length <= n ? s : s.slice(0, n - 1) + '…';
}

// Run a named content-script loader function against an empty
// chrome.storage.local. Returns the resulting flag value (mutator: the
// captured stateVar; returner: the return value).
async function runContentScriptLoader(source, flag) {
  const body = extractFunctionBody(source, flag.loader.name);
  assert.ok(body !== null, `loader function ${flag.loader.name} not found in ${flag.contentScript}`);

  // Find the const that holds the flag key so we can substitute the
  // literal key string into the body (the const itself isn't visible
  // outside the file's IIFE scope, so we rewrite references).
  const keyConstName = findKeyConstName(source, flag.key);
  assert.ok(keyConstName, `flag key '${flag.key}' is not declared as a const in ${flag.contentScript}`);

  const rewritten = body.replace(new RegExp(`\\b${keyConstName}\\b`, 'g'), `'${flag.key}'`);

  const fakeChrome = {
    storage: {
      local: {
        async get() { return {}; },
        async set() {},
        async remove() {},
      },
      onChanged: { addListener() {} },
    },
  };

  if (flag.loader.kind === 'returner') {
    const fn = new Function('chrome', `return (async () => { ${rewritten} })();`);
    return await fn(fakeChrome);
  }

  // mutator: declare the state var so the body can write to it; run the
  // body; return the state var. Other module-scoped variables the body
  // touches (e.g. <stateVar>Loaded) leak into the Function's sloppy-mode
  // scope as implicit globals - acceptable for the duration of this test
  // call.
  const fn = new Function('chrome', `
    let ${flag.loader.stateVar};
    return (async () => {
      ${rewritten}
      return ${flag.loader.stateVar};
    })();
  `);
  return await fn(fakeChrome);
}

function extractFunctionBody(source, name) {
  const re = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\([^)]*\\)\\s*\\{`, 'm');
  const m = source.match(re);
  if (!m) return null;
  const start = m.index + m[0].length;
  let depth = 1;
  let i = start;
  while (i < source.length && depth > 0) {
    const c = source[i];
    if (c === '{') depth++;
    else if (c === '}') depth--;
    i++;
  }
  return source.slice(start, i - 1);
}

function findKeyConstName(source, key) {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`const\\s+(\\w+)\\s*=\\s*['"]${escaped}['"]`);
  const m = source.match(re);
  return m ? m[1] : null;
}
