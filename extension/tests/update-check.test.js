// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// FMN-157: unit tests for the update-check background module.
//
// fetch is mocked at the call boundary (no real network). storage is
// the createStorageMock from chrome-mocks.js so we can inspect the
// post-call shape. Time is injected via the `now` dep so we can prove
// the hour rate limit without actually waiting.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  checkForUpdate,
  compareSemver,
  isRemoteNewer,
  UPDATE_CHECK_RESULT_KEY,
  REMOTE_MANIFEST_URL,
  MIN_INTERVAL_MS
} from '../src/background/update-check.js';
import { UPDATE_CHECK_ENABLED_KEY } from '../src/lib/settings.js';
import { createStorageMock } from './fixtures/chrome-mocks.js';

function makeFetchMock(responder) {
  const calls = [];
  async function fn(url, init) {
    calls.push({ url, init });
    return responder(url, init);
  }
  fn.calls = calls;
  return fn;
}

function jsonResponse(body, { status = 200, ok = true } = {}) {
  return {
    ok,
    status,
    async text() { return typeof body === 'string' ? body : JSON.stringify(body); }
  };
}

// ---------- compareSemver ----------

test('compareSemver: equal versions return 0', () => {
  assert.equal(compareSemver('1.0.0', '1.0.0'), 0);
  assert.equal(compareSemver('2.3.4', '2.3.4'), 0);
});

test('compareSemver: larger major wins', () => {
  assert.equal(compareSemver('2.0.0', '1.99.99'), 1);
  assert.equal(compareSemver('1.0.0', '2.0.0'), -1);
});

test('compareSemver: minor breaks tie on equal major', () => {
  assert.equal(compareSemver('1.5.0', '1.4.99'), 1);
  assert.equal(compareSemver('1.4.99', '1.5.0'), -1);
});

test('compareSemver: patch breaks tie on equal major.minor', () => {
  assert.equal(compareSemver('1.4.10', '1.4.9'), 1);
  assert.equal(compareSemver('1.4.9', '1.4.10'), -1);
});

// ---------- isRemoteNewer ----------

test('isRemoteNewer: remote ahead returns true', () => {
  assert.equal(isRemoteNewer('1.3.0', '1.4.0'), true);
  assert.equal(isRemoteNewer('1.0.0', '99.0.0'), true);
});

test('isRemoteNewer: remote equal or behind returns false', () => {
  assert.equal(isRemoteNewer('1.4.0', '1.4.0'), false);
  assert.equal(isRemoteNewer('1.4.0', '1.3.99'), false);
});

test('isRemoteNewer: rejects non-semver inputs', () => {
  assert.equal(isRemoteNewer('1.4', '1.5.0'), false);
  assert.equal(isRemoteNewer('1.4.0', 'v1.5.0'), false);
  assert.equal(isRemoteNewer('1.4.0-rc.1', '1.5.0'), false);
});

// ---------- checkForUpdate: happy path ----------

test('checkForUpdate: fresh check fetches and stores result', async () => {
  const storage = createStorageMock();
  const fetchImpl = makeFetchMock(() => jsonResponse({ version: '2.0.0' }));
  const result = await checkForUpdate({
    fetchImpl,
    storage,
    localVersion: '1.4.0',
    now: () => 1000
  });
  assert.equal(result.ran, true);
  assert.deepEqual(result.result, {
    checkedAt: 1000,
    localVersion: '1.4.0',
    remoteVersion: '2.0.0',
    isNewer: true
  });
  // Fetched exactly once, against the documented URL.
  assert.equal(fetchImpl.calls.length, 1);
  assert.equal(fetchImpl.calls[0].url, REMOTE_MANIFEST_URL);
  // Cache disabled so service workers don't serve stale JSON.
  assert.equal(fetchImpl.calls[0].init?.cache, 'no-store');
  // Storage written.
  assert.deepEqual(storage.__raw()[UPDATE_CHECK_RESULT_KEY], result.result);
});

test('checkForUpdate: older remote version sets isNewer false', async () => {
  const storage = createStorageMock();
  const fetchImpl = makeFetchMock(() => jsonResponse({ version: '1.2.0' }));
  const result = await checkForUpdate({
    fetchImpl,
    storage,
    localVersion: '1.4.0',
    now: () => 1000
  });
  assert.equal(result.ran, true);
  assert.equal(result.result.isNewer, false);
  assert.equal(result.result.remoteVersion, '1.2.0');
});

test('checkForUpdate: equal remote version sets isNewer false', async () => {
  const storage = createStorageMock();
  const fetchImpl = makeFetchMock(() => jsonResponse({ version: '1.4.0' }));
  const result = await checkForUpdate({
    fetchImpl,
    storage,
    localVersion: '1.4.0',
    now: () => 1000
  });
  assert.equal(result.ran, true);
  assert.equal(result.result.isNewer, false);
});

// ---------- checkForUpdate: rate limiting ----------

test('checkForUpdate: skips fetch when prior successful check is under one hour old', async () => {
  const prior = {
    checkedAt: 10_000,
    localVersion: '1.4.0',
    remoteVersion: '1.4.0',
    isNewer: false
  };
  const storage = createStorageMock({ [UPDATE_CHECK_RESULT_KEY]: prior });
  const fetchImpl = makeFetchMock(() => {
    throw new Error('fetch should not have been called');
  });
  // Move time forward by 30 minutes - inside the hour window.
  const result = await checkForUpdate({
    fetchImpl,
    storage,
    localVersion: '1.4.0',
    now: () => 10_000 + (30 * 60 * 1000)
  });
  assert.equal(result.ran, false);
  assert.equal(result.reason, 'rate-limited');
  assert.equal(fetchImpl.calls.length, 0);
  // Prior result preserved.
  assert.deepEqual(storage.__raw()[UPDATE_CHECK_RESULT_KEY], prior);
});

test('checkForUpdate: refetches once the hour window has passed', async () => {
  const prior = {
    checkedAt: 10_000,
    localVersion: '1.4.0',
    remoteVersion: '1.4.0',
    isNewer: false
  };
  const storage = createStorageMock({ [UPDATE_CHECK_RESULT_KEY]: prior });
  const fetchImpl = makeFetchMock(() => jsonResponse({ version: '2.0.0' }));
  // 61 minutes later.
  const later = 10_000 + (61 * 60 * 1000);
  const result = await checkForUpdate({
    fetchImpl,
    storage,
    localVersion: '1.4.0',
    now: () => later
  });
  assert.equal(result.ran, true);
  assert.equal(fetchImpl.calls.length, 1);
  assert.equal(storage.__raw()[UPDATE_CHECK_RESULT_KEY].remoteVersion, '2.0.0');
});

test('checkForUpdate: MIN_INTERVAL_MS is the documented one hour', () => {
  assert.equal(MIN_INTERVAL_MS, 60 * 60 * 1000);
});

// ---------- checkForUpdate: flag gating ----------

test('checkForUpdate: disabled flag short-circuits without fetch', async () => {
  const storage = createStorageMock({ [UPDATE_CHECK_ENABLED_KEY]: false });
  const fetchImpl = makeFetchMock(() => {
    throw new Error('fetch should not have been called');
  });
  const result = await checkForUpdate({
    fetchImpl,
    storage,
    localVersion: '1.4.0',
    now: () => 1000
  });
  assert.equal(result.ran, false);
  assert.equal(result.reason, 'disabled');
  assert.equal(fetchImpl.calls.length, 0);
});

test('checkForUpdate: default-on flag triggers the fetch on fresh storage', async () => {
  const storage = createStorageMock(); // no flag key set
  const fetchImpl = makeFetchMock(() => jsonResponse({ version: '1.4.0' }));
  const result = await checkForUpdate({
    fetchImpl,
    storage,
    localVersion: '1.4.0',
    now: () => 1000
  });
  assert.equal(result.ran, true);
});

// ---------- checkForUpdate: silent failure modes ----------

test('checkForUpdate: malformed JSON is silently ignored', async () => {
  const storage = createStorageMock();
  const fetchImpl = makeFetchMock(() => jsonResponse('{ not valid json'));
  const result = await checkForUpdate({
    fetchImpl,
    storage,
    localVersion: '1.4.0',
    now: () => 1000
  });
  assert.equal(result.ran, false);
  assert.ok(result.reason.startsWith('parse-error'));
  // No write occurred.
  assert.equal(storage.__raw()[UPDATE_CHECK_RESULT_KEY], undefined);
});

test('checkForUpdate: missing version field is silently ignored', async () => {
  const storage = createStorageMock();
  const fetchImpl = makeFetchMock(() => jsonResponse({ name: 'no version here' }));
  const result = await checkForUpdate({
    fetchImpl,
    storage,
    localVersion: '1.4.0',
    now: () => 1000
  });
  assert.equal(result.ran, false);
  assert.equal(result.reason, 'bad-remote-version');
  assert.equal(storage.__raw()[UPDATE_CHECK_RESULT_KEY], undefined);
});

test('checkForUpdate: non-semver version field is silently ignored', async () => {
  const storage = createStorageMock();
  const fetchImpl = makeFetchMock(() => jsonResponse({ version: 'latest' }));
  const result = await checkForUpdate({
    fetchImpl,
    storage,
    localVersion: '1.4.0',
    now: () => 1000
  });
  assert.equal(result.ran, false);
  assert.equal(result.reason, 'bad-remote-version');
  assert.equal(storage.__raw()[UPDATE_CHECK_RESULT_KEY], undefined);
});

test('checkForUpdate: HTTP error response is silently ignored', async () => {
  const storage = createStorageMock();
  const fetchImpl = makeFetchMock(() => jsonResponse({}, { ok: false, status: 503 }));
  const result = await checkForUpdate({
    fetchImpl,
    storage,
    localVersion: '1.4.0',
    now: () => 1000
  });
  assert.equal(result.ran, false);
  assert.ok(result.reason.startsWith('http-503'));
  assert.equal(storage.__raw()[UPDATE_CHECK_RESULT_KEY], undefined);
});

test('checkForUpdate: network/throw is silently ignored', async () => {
  const storage = createStorageMock();
  const fetchImpl = makeFetchMock(() => { throw new Error('DNS failure'); });
  const result = await checkForUpdate({
    fetchImpl,
    storage,
    localVersion: '1.4.0',
    now: () => 1000
  });
  assert.equal(result.ran, false);
  assert.ok(result.reason.startsWith('fetch-error'));
  assert.equal(storage.__raw()[UPDATE_CHECK_RESULT_KEY], undefined);
});

test('checkForUpdate: prior result preserved across silent failure', async () => {
  const prior = {
    checkedAt: 1000,
    localVersion: '1.0.0',
    remoteVersion: '1.0.0',
    isNewer: false
  };
  // Move time past the rate-limit window so we attempt the fetch.
  const storage = createStorageMock({ [UPDATE_CHECK_RESULT_KEY]: prior });
  const fetchImpl = makeFetchMock(() => { throw new Error('blew up'); });
  const result = await checkForUpdate({
    fetchImpl,
    storage,
    localVersion: '1.4.0',
    now: () => 1000 + (2 * 60 * 60 * 1000)
  });
  assert.equal(result.ran, false);
  // Prior result still intact - silent failure must NEVER overwrite
  // last-known-good state.
  assert.deepEqual(storage.__raw()[UPDATE_CHECK_RESULT_KEY], prior);
});

test('checkForUpdate: bad local version aborts without fetch', async () => {
  const storage = createStorageMock();
  const fetchImpl = makeFetchMock(() => {
    throw new Error('fetch should not have been called');
  });
  const result = await checkForUpdate({
    fetchImpl,
    storage,
    localVersion: 'not-a-version',
    now: () => 1000
  });
  assert.equal(result.ran, false);
  assert.equal(result.reason, 'bad-local-version');
  assert.equal(fetchImpl.calls.length, 0);
});
