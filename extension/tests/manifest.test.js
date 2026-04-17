import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const extRoot = resolve(__dirname, '..');

async function readManifest() {
  const raw = await readFile(resolve(extRoot, 'manifest.json'), 'utf8');
  return JSON.parse(raw);
}

async function fileExists(relative) {
  try {
    await access(resolve(extRoot, relative));
    return true;
  } catch {
    return false;
  }
}

test('manifest.json is valid JSON', async () => {
  const m = await readManifest();
  assert.ok(m, 'manifest parsed');
});

test('manifest targets Manifest V3', async () => {
  const m = await readManifest();
  assert.equal(m.manifest_version, 3);
});

test('manifest has required identity fields', async () => {
  const m = await readManifest();
  assert.equal(typeof m.name, 'string');
  assert.ok(m.name.length > 0);
  assert.match(m.version, /^\d+\.\d+\.\d+$/);
  assert.equal(typeof m.description, 'string');
});

test('manifest declares the FortiMonitor host permission', async () => {
  const m = await readManifest();
  assert.ok(Array.isArray(m.host_permissions));
  assert.ok(
    m.host_permissions.some((h) => h.startsWith('https://fortimonitor.forticloud.com/')),
    'host_permissions must include fortimonitor.forticloud.com'
  );
});

test('manifest declares a host_permission covering regional FortiMonitor tenants', async () => {
  const m = await readManifest();
  // Chrome match patterns forbid mid-host wildcards, so the pattern that
  // covers my.us01.fortimonitor.com, my.eu01.fortimonitor.com, etc., is
  // the broader `*.fortimonitor.com/*`. Verify that shape.
  assert.ok(
    m.host_permissions.some((h) => h === 'https://*.fortimonitor.com/*'),
    'host_permissions must include https://*.fortimonitor.com/* so the extension can see the session cookie on regional tenants (my.us01.fortimonitor.com, etc.). A narrower mid-wildcard pattern like my.*.fortimonitor.com is rejected by Chrome as malformed.'
  );
});

test('host_permissions entries are valid Chrome match patterns (no mid-host wildcards)', async () => {
  const m = await readManifest();
  for (const pattern of m.host_permissions) {
    const m2 = pattern.match(/^https?:\/\/([^/]+)/);
    assert.ok(m2, `host_permission must start with a scheme: ${pattern}`);
    const host = m2[1];
    // Chrome allows `*` for entire host, `*.` prefix, or a literal host.
    // Anything else (mid-wildcard, trailing dot wildcard, etc.) is invalid.
    const valid = host === '*' || /^\*\.[^*]+$/.test(host) || /^[^*]+$/.test(host);
    assert.ok(valid, `invalid match pattern host (Chrome forbids mid-host wildcards): ${pattern}`);
  }
});

test('manifest declares cookies and storage permissions', async () => {
  const m = await readManifest();
  assert.ok(Array.isArray(m.permissions));
  for (const needed of ['cookies', 'storage']) {
    assert.ok(m.permissions.includes(needed), `missing permission: ${needed}`);
  }
});

test('manifest does NOT request broad browser-surveillance permissions', async () => {
  const m = await readManifest();
  const forbidden = ['tabs', 'activeTab', 'webRequest', 'webRequestBlocking'];
  for (const f of forbidden) {
    assert.equal(
      m.permissions.includes(f),
      false,
      `manifest should not include permission: ${f}`
    );
  }
});

test('service worker file exists at the path the manifest points to', async () => {
  const m = await readManifest();
  assert.ok(m.background?.service_worker, 'manifest.background.service_worker missing');
  assert.equal(await fileExists(m.background.service_worker), true,
    `service worker file not found: ${m.background.service_worker}`);
});

test('service worker is declared as ES module', async () => {
  const m = await readManifest();
  assert.equal(m.background.type, 'module');
});

test('action is configured with a default popup (launcher)', async () => {
  const m = await readManifest();
  assert.ok(m.action, 'manifest.action missing');
  assert.equal(typeof m.action.default_title, 'string');
  assert.equal(typeof m.action.default_popup, 'string', 'expected action.default_popup to point at the launcher');
});

test('launcher popup file exists at the path the manifest points to', async () => {
  const m = await readManifest();
  assert.equal(await fileExists(m.action.default_popup), true,
    `popup file not found: ${m.action.default_popup}`);
});

test('app.html exists (opened from the launcher for the Remove tool)', async () => {
  assert.equal(await fileExists('src/ui/app.html'), true);
});
