// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// FMN-299: session-template-collector tests (mock fetch; no network).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectTemplateSlice } from '../src/lib/session-template-collector.js';

// Fast test seam: no pacing, no retry (individual tests override for retry).
const FAST = { rateLimit: 0, backoffSchedule: [], timeoutMs: 5_000 };

function treeWith(templateIds, { stockId } = {}) {
  const mk = (id) => ({ id: `s-${id}`, 'node-type': 'template', text: `T${id}` });
  const groups = [{ id: 'grp-20', 'node-type': 'group', text: 'Acme', children: templateIds.filter((id) => id !== stockId).map(mk) }];
  if (stockId != null) groups.unshift({ id: 'grp-10', 'node-type': 'group', text: 'Default Monitoring Templates', children: [mk(stockId)] });
  return { nodes: [{ id: 'grp-0', 'node-type': 'group', text: 'All', children: groups }] };
}

function res(body, { ok = true, status = 200, contentType = 'application/json', text } = {}) {
  return {
    ok, status,
    headers: { get: (h) => (String(h).toLowerCase() === 'content-type' ? contentType : null) },
    json: async () => body,
    text: async () => (text !== undefined ? text : JSON.stringify(body))
  };
}
const cfg = (names) => ({ success: true, categories: { added: [{ metrics: names.map((n) => ({ name: n, alert_items: [] })) }] } });

// Route by URL. `perId` maps template id -> { kind: 'json'|'html'|'500', names? }.
function mockFetch(tree, perId = {}) {
  return async (url) => {
    if (url.includes('/util/monitoring_tree')) return res(tree);
    const id = (url.match(/server_id=(\d+)/) || [])[1];
    const spec = perId[id] || { kind: 'json', names: ['A'] };
    if (spec.kind === 'html') return res(null, { contentType: 'text/html', text: '<!DOCTYPE html><html>login</html>' });
    if (spec.kind === '500') return res({ error: 'x' }, { ok: false, status: 500 });
    return res(cfg(spec.names || ['A']));
  };
}

test('builds the full slice from session-auth endpoints', async () => {
  const slice = await collectTemplateSlice({
    fetch: mockFetch(treeWith(['1', '2'], { stockId: '1' }), { 1: { kind: 'json', names: ['A', 'B'] }, 2: { kind: 'json', names: ['A', 'B', 'C'] } }),
    origin: 'https://fm.example', fetchOptions: FAST
  });
  assert.deepEqual(slice.server_templates.map((t) => t.id).sort(), ['1', '2']);
  assert.equal(slice.template_monitoring_configs['1'].total_metrics, 2);
  assert.equal(slice.template_monitoring_configs['2'].total_metrics, 3);
  assert.deepEqual(slice.errors, []);
});

test('POOL: more templates than workers - each processed exactly once', async () => {
  const ids = Array.from({ length: 15 }, (_, i) => String(i + 1));   // > CONFIG_CONCURRENCY (4)
  const slice = await collectTemplateSlice({ fetch: mockFetch(treeWith(ids)), origin: 'https://fm.example', fetchOptions: FAST });
  assert.equal(slice.server_templates.length, 15);
  assert.equal(Object.keys(slice.template_monitoring_configs).length, 15, 'every template fetched');
  // No duplicates, no misses.
  assert.deepEqual(Object.keys(slice.template_monitoring_configs).sort((a, b) => a - b), ids);
  assert.deepEqual(slice.errors, []);
});

test('ISOLATION: a mid-list HTML response is a per-template error, NOT a whole-run abort', async () => {
  // template 3 returns the SPA shell (bad input / rate-limited); the crawl must
  // complete with the other 4, recording template 3 in errors[] - it must NOT
  // throw a false "session not detected" (FMN-299 review Finding 1).
  const ids = ['1', '2', '3', '4', '5'];
  const slice = await collectTemplateSlice({
    fetch: mockFetch(treeWith(ids), { 3: { kind: 'html' } }),
    origin: 'https://fm.example', fetchOptions: FAST
  });
  assert.equal(Object.keys(slice.template_monitoring_configs).length, 4, 'the 4 good templates still collected');
  assert.equal('3' in slice.template_monitoring_configs, false);
  assert.equal(slice.errors.length, 1);
  assert.match(slice.errors[0], /template 3:/);
});

test('ISOLATION: an HTTP 500 is RETRIED (2 attempts) then recorded per-template', async () => {
  let attempts2 = 0;   // prove the retry wrapper actually retried, not just that it errored
  const f = async (url) => {
    if (url.includes('/util/monitoring_tree')) return res(treeWith(['1', '2']));
    const id = (url.match(/server_id=(\d+)/) || [])[1];
    if (id === '2') { attempts2 += 1; return res({ error: 'x' }, { ok: false, status: 500 }); }
    return res(cfg(['A']));
  };
  const slice = await collectTemplateSlice({
    fetch: f, origin: 'https://fm.example',
    fetchOptions: { rateLimit: 0, backoffSchedule: [5], timeoutMs: 5_000 }   // 1 fast retry
  });
  assert.equal(attempts2, 2, 'initial attempt + one retry');
  assert.equal(Object.keys(slice.template_monitoring_configs).length, 1);
  assert.equal(slice.errors.length, 1);
  assert.match(slice.errors[0], /template 2: HTTP 500/);
});

test('ABORT (pre-run): an already-aborted signal propagates at the tree fetch', async () => {
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(
    () => collectTemplateSlice({ fetch: mockFetch(treeWith(['1', '2'])), origin: 'https://fm.example', signal: ac.signal, fetchOptions: FAST }),
    (e) => e?.name === 'AbortError'
  );
});

test('ABORT (mid-crawl): cancelling during the config phase propagates AbortError, not a per-template error', async () => {
  // Tree succeeds; the run is cancelled once the config crawl is underway. The
  // worker-pool classification (`if (signal?.aborted) throw e`) - the heart of
  // the F1 fix - must propagate AbortError, not swallow it into errors[].
  const ac = new AbortController();
  let configCalls = 0;
  const f = async (url) => {
    if (url.includes('/util/monitoring_tree')) return res(treeWith(['1', '2', '3', '4']));
    configCalls += 1;
    if (configCalls === 1) ac.abort();   // cancel the run mid-crawl
    return res(cfg(['A']));
  };
  await assert.rejects(
    () => collectTemplateSlice({ fetch: f, origin: 'https://fm.example', signal: ac.signal, fetchOptions: FAST }),
    (e) => e?.name === 'AbortError'
  );
});

test('throws a clear session error on a non-JSON tree (SPA shell)', async () => {
  const f = async (url) => (url.includes('/util/monitoring_tree')
    ? res(null, { contentType: 'text/html', text: '<!DOCTYPE html><html>login</html>' })
    : res(cfg(['A'])));
  await assert.rejects(() => collectTemplateSlice({ fetch: f, origin: 'https://fm.example', fetchOptions: FAST }), /session not detected/);
});

test('requires a fetch implementation', async () => {
  await assert.rejects(() => collectTemplateSlice({ origin: 'https://fm.example' }), /requires a fetch/);
});
