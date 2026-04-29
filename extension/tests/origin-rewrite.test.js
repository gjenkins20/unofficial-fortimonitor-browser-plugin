// FMN-120: tests for the Origin-rewrite layer that lets the extension
// reach Ollama / LM Studio without making the operator configure
// OLLAMA_ORIGINS on the host running Ollama.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  setProviderOriginRule,
  clearProviderOriginRule,
  applyAllProviderRules,
  urlFilterForBase,
  WATCHED_STORAGE_KEYS,
  SPOOFED_ORIGIN
} from '../src/lib/origin-rewrite.js';
import { createStorageMock } from './fixtures/chrome-mocks.js';

function createDnrMock() {
  let dynamicRules = [];
  const dnr = {
    async updateDynamicRules({ removeRuleIds = [], addRules = [] } = {}) {
      if (removeRuleIds.length > 0) {
        dynamicRules = dynamicRules.filter((r) => !removeRuleIds.includes(r.id));
      }
      for (const rule of addRules) dynamicRules.push(rule);
    },
    async getDynamicRules() { return dynamicRules.slice(); },
    __rules() { return dynamicRules.slice(); }
  };
  return dnr;
}

test('urlFilterForBase: produces |scheme://host:port/ for valid URLs', () => {
  assert.equal(urlFilterForBase('http://localhost:11434/v1'), '|http://localhost:11434/');
  assert.equal(urlFilterForBase('http://192.168.1.125:11434/v1'), '|http://192.168.1.125:11434/');
  assert.equal(urlFilterForBase('http://my-host.local:1234/v1'), '|http://my-host.local:1234/');
  assert.equal(urlFilterForBase('https://api.example.com/v1'), '|https://api.example.com/');
});

test('urlFilterForBase: returns null for invalid input', () => {
  assert.equal(urlFilterForBase(''), null);
  assert.equal(urlFilterForBase(null), null);
  assert.equal(urlFilterForBase(undefined), null);
  assert.equal(urlFilterForBase('not a url'), null);
});

test('setProviderOriginRule: registers a modify-Origin rule for Ollama', async () => {
  const dnr = createDnrMock();
  const result = await setProviderOriginRule({
    provider: 'ollama',
    url: 'http://192.168.1.125:11434/v1',
    dnr
  });
  assert.equal(result.ok, true);
  assert.equal(result.urlFilter, '|http://192.168.1.125:11434/');
  const rules = dnr.__rules();
  assert.equal(rules.length, 1);
  assert.equal(rules[0].id, 1001);
  assert.equal(rules[0].action.type, 'modifyHeaders');
  const header = rules[0].action.requestHeaders[0];
  assert.equal(header.header, 'origin');
  assert.equal(header.operation, 'set');
  assert.equal(header.value, SPOOFED_ORIGIN);
  assert.equal(header.value, 'http://localhost');
  assert.equal(rules[0].condition.urlFilter, '|http://192.168.1.125:11434/');
  assert.deepEqual(rules[0].condition.resourceTypes, ['xmlhttprequest']);
});

test('setProviderOriginRule: separate rule ids for Ollama and LM Studio', async () => {
  const dnr = createDnrMock();
  await setProviderOriginRule({ provider: 'ollama', url: 'http://localhost:11434/v1', dnr });
  await setProviderOriginRule({ provider: 'lmstudio', url: 'http://localhost:1234/v1', dnr });
  const rules = dnr.__rules();
  assert.equal(rules.length, 2);
  const ids = rules.map((r) => r.id).sort();
  assert.deepEqual(ids, [1001, 1002]);
});

test('setProviderOriginRule: re-registering the same provider replaces the prior rule', async () => {
  const dnr = createDnrMock();
  await setProviderOriginRule({ provider: 'ollama', url: 'http://localhost:11434/v1', dnr });
  await setProviderOriginRule({ provider: 'ollama', url: 'http://192.168.1.5:11434/v1', dnr });
  const rules = dnr.__rules();
  assert.equal(rules.length, 1);
  assert.equal(rules[0].condition.urlFilter, '|http://192.168.1.5:11434/');
});

test('setProviderOriginRule: empty URL clears the existing rule', async () => {
  const dnr = createDnrMock();
  await setProviderOriginRule({ provider: 'ollama', url: 'http://localhost:11434/v1', dnr });
  assert.equal(dnr.__rules().length, 1);
  const result = await setProviderOriginRule({ provider: 'ollama', url: '', dnr });
  assert.equal(result.ok, true);
  assert.equal(result.cleared, true);
  assert.equal(dnr.__rules().length, 0);
});

test('setProviderOriginRule: throws for unsupported provider', async () => {
  const dnr = createDnrMock();
  await assert.rejects(
    setProviderOriginRule({ provider: 'anthropic', url: 'https://api.anthropic.com/v1', dnr }),
    /unsupported provider/
  );
});

test('setProviderOriginRule: returns ok=false when DNR is unavailable (no throw)', async () => {
  const result = await setProviderOriginRule({
    provider: 'ollama',
    url: 'http://localhost:11434/v1',
    dnr: undefined
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /not available/);
});

test('setProviderOriginRule: returns ok=false when updateDynamicRules throws', async () => {
  const failingDnr = {
    async updateDynamicRules() { throw new Error('header not allowed'); }
  };
  const result = await setProviderOriginRule({
    provider: 'ollama',
    url: 'http://localhost:11434/v1',
    dnr: failingDnr
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /header not allowed/);
});

test('clearProviderOriginRule: removes the matching rule', async () => {
  const dnr = createDnrMock();
  await setProviderOriginRule({ provider: 'ollama', url: 'http://localhost:11434/v1', dnr });
  await setProviderOriginRule({ provider: 'lmstudio', url: 'http://localhost:1234/v1', dnr });
  await clearProviderOriginRule('ollama', dnr);
  const rules = dnr.__rules();
  assert.equal(rules.length, 1);
  assert.equal(rules[0].id, 1002);
});

test('clearProviderOriginRule: no-ops gracefully for unsupported provider', async () => {
  const dnr = createDnrMock();
  await clearProviderOriginRule('anthropic', dnr); // should not throw
  assert.equal(dnr.__rules().length, 0);
});

test('applyAllProviderRules: applies saved Ollama and LM Studio URLs from storage', async () => {
  const storage = createStorageMock({
    'fm:askClaudeOllamaUrl': 'http://localhost:11434/v1',
    'fm:askClaudeLmStudioUrl': 'http://localhost:1234/v1'
  });
  const dnr = createDnrMock();
  await applyAllProviderRules({ storage, dnr });
  const rules = dnr.__rules();
  assert.equal(rules.length, 2);
  const byId = Object.fromEntries(rules.map((r) => [r.id, r]));
  assert.equal(byId[1001].condition.urlFilter, '|http://localhost:11434/');
  assert.equal(byId[1002].condition.urlFilter, '|http://localhost:1234/');
});

test('applyAllProviderRules: missing URL keys clear the corresponding rules', async () => {
  const storage = createStorageMock({
    'fm:askClaudeOllamaUrl': 'http://localhost:11434/v1'
    // no LM Studio URL
  });
  const dnr = createDnrMock();
  await applyAllProviderRules({ storage, dnr });
  const rules = dnr.__rules();
  assert.equal(rules.length, 1);
  assert.equal(rules[0].id, 1001);
});

test('WATCHED_STORAGE_KEYS contains the URL keys the service worker should watch', () => {
  assert.ok(WATCHED_STORAGE_KEYS.includes('fm:askClaudeOllamaUrl'));
  assert.ok(WATCHED_STORAGE_KEYS.includes('fm:askClaudeLmStudioUrl'));
});
