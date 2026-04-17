// Minimal fakes for the Chrome APIs used by the extension modules.
// Matches the Promise-based MV3 API surface (not the legacy callback one).

export function createStorageMock(initialData = {}) {
  let data = { ...initialData };
  return {
    async get(key) {
      if (key === null || key === undefined) return { ...data };
      if (typeof key === 'string') return { [key]: data[key] };
      if (Array.isArray(key)) {
        const out = {};
        for (const k of key) out[k] = data[k];
        return out;
      }
      if (typeof key === 'object') {
        const out = {};
        for (const [k, defaultValue] of Object.entries(key)) {
          out[k] = Object.prototype.hasOwnProperty.call(data, k) ? data[k] : defaultValue;
        }
        return out;
      }
      return {};
    },
    async set(obj) {
      Object.assign(data, obj);
    },
    async remove(keys) {
      const list = Array.isArray(keys) ? keys : [keys];
      for (const k of list) delete data[k];
    },
    async clear() {
      data = {};
    },
    // test-only inspection
    __raw() { return { ...data }; }
  };
}

export function createCookieMock(cookies = {}) {
  // cookies is an object like { "https://host/:NAME": "value" }
  const store = { ...cookies };
  return {
    async get({ url, name }) {
      const v = store[`${url}:${name}`];
      return v == null ? null : { value: v, name };
    },
    __set(url, name, value) { store[`${url}:${name}`] = value; }
  };
}

export function createFetchMock(handler) {
  const calls = [];
  async function fn(url, init = {}) {
    calls.push({ url, init });
    const res = await handler(url, init);
    return res;
  }
  fn.calls = calls;
  return fn;
}

export function jsonResponse(body, { status = 200, headers = {} } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Map(Object.entries({ 'content-type': 'application/json', ...headers })),
    async json() { return body; },
    async text() { return JSON.stringify(body); }
  };
}

export function errorResponse(status, body = null) {
  return {
    ok: false,
    status,
    headers: new Map(),
    async json() { return body; },
    async text() { return typeof body === 'string' ? body : JSON.stringify(body); }
  };
}
