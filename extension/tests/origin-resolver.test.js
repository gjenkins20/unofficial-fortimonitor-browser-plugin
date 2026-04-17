import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveFortimonitorOrigin,
  FEDERATION_ORIGIN,
  ORIGIN_OVERRIDE_KEY
} from '../src/lib/origin-resolver.js';
import { createStorageMock } from './fixtures/chrome-mocks.js';

function makeQueryTabs(urlByPattern) {
  return async ({ url }) => {
    const pattern = Array.isArray(url) ? url[0] : url;
    const match = urlByPattern[pattern] ?? [];
    return match.map((u) => ({ url: u }));
  };
}

test('resolves to regional tenant origin when a matching tab is open', async () => {
  const queryTabs = makeQueryTabs({
    'https://*.fortimonitor.com/*': ['https://my.us01.fortimonitor.com/dashboard']
  });
  const origin = await resolveFortimonitorOrigin({ queryTabs });
  assert.equal(origin, 'https://my.us01.fortimonitor.com');
});

test('falls back to federation origin when no regional tab is open', async () => {
  const queryTabs = makeQueryTabs({
    'https://*.fortimonitor.com/*': [],
    'https://fortimonitor.forticloud.com/*': [{ url: 'https://fortimonitor.forticloud.com/login' }]
  });
  // makeQueryTabs returns {url} objects but we stored an object — flatten
  const tabs = { 'https://fortimonitor.forticloud.com/*': ['https://fortimonitor.forticloud.com/login'] };
  const origin = await resolveFortimonitorOrigin({
    queryTabs: makeQueryTabs({ 'https://*.fortimonitor.com/*': [], ...tabs })
  });
  assert.equal(origin, FEDERATION_ORIGIN);
});

test('defaults to federation origin with no tabs anywhere', async () => {
  const queryTabs = async () => [];
  const origin = await resolveFortimonitorOrigin({ queryTabs });
  assert.equal(origin, FEDERATION_ORIGIN);
});

test('respects an explicit storage override over any open tab', async () => {
  const storage = createStorageMock({ [ORIGIN_OVERRIDE_KEY]: 'https://my.eu01.fortimonitor.com' });
  const queryTabs = makeQueryTabs({
    'https://*.fortimonitor.com/*': ['https://my.us01.fortimonitor.com/dashboard']
  });
  const origin = await resolveFortimonitorOrigin({ queryTabs, storage });
  assert.equal(origin, 'https://my.eu01.fortimonitor.com');
});

test('prefers regional tenant over federation when both are open', async () => {
  const queryTabs = makeQueryTabs({
    'https://*.fortimonitor.com/*': ['https://my.us02.fortimonitor.com/servers'],
    'https://fortimonitor.forticloud.com/*': ['https://fortimonitor.forticloud.com/login']
  });
  const origin = await resolveFortimonitorOrigin({ queryTabs });
  assert.equal(origin, 'https://my.us02.fortimonitor.com');
});

test('ignores tabs whose URLs do not match the regional shape even if returned', async () => {
  const queryTabs = async () => [{ url: 'https://phishing.fortimonitor.com.attacker.example/' }];
  const origin = await resolveFortimonitorOrigin({ queryTabs });
  assert.equal(origin, FEDERATION_ORIGIN);
});

test('requires a queryTabs dependency', async () => {
  await assert.rejects(resolveFortimonitorOrigin({}), TypeError);
});

test('survives queryTabs throwing', async () => {
  const queryTabs = async () => { throw new Error('no permission'); };
  const origin = await resolveFortimonitorOrigin({ queryTabs });
  assert.equal(origin, FEDERATION_ORIGIN);
});
