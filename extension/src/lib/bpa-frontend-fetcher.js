// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// BPA frontend (session-auth) data layer (FMN-135).
//
// Companion to BpaFetcher. Walks the FortiMonitor UI's per-user EditUser
// page to harvest fields the v2 API does not expose - currently
// `last_login` and `created_on`. Designed to be invoked AFTER BpaFetcher
// has populated inventory.users; the result is merged into inventory
// under `frontend_user_data` so the user analyzer can pick it up.
//
// Why session auth: /users/users/EditUser is an HTML page rendered by the
// FortiMonitor UI server, not a JSON API. There is no v2 surface for
// last_login. From a service-worker context with `cookies` +
// host_permissions + credentials:'include', the session cookie is
// attached automatically (per FMN-70 and memory
// extension_page_cross_origin_cookies.md).
//
// Why regex (not DOMParser): MV3 service workers have no `document` or
// DOMParser. The targets are labelled <p> elements with a well-defined
// class string ("pa-txt_secondary pa-mb-6 pa-txt_xs" containing the
// label text); each value follows in the next element. A targeted regex
// is sufficient and keeps this module SW-pure.
//
// Auth-failure detection: FortiMonitor redirects unauthenticated session
// requests to a login page. fetch() follows redirects, so we sniff the
// final response body for a login-form marker; absent the marker, we
// assume the page is the EditUser content.

import { createBpaFetch } from './bpa-fetcher.js';

export const FORTIMONITOR_ORIGIN = 'https://fortimonitor.forticloud.com';
export const EDIT_USER_PATH = '/users/users/EditUser';

// =============================================================================
// HTML parsing
// =============================================================================

/**
 * Extract the value following a labelled <p> on an EditUser HTML page.
 *
 * Marker shape (per FMN-135 capture, 2026-05-01):
 *   <p class="pa-txt_secondary pa-mb-6 pa-txt_xs">{label}</p>
 *   <next-element>{value}</next-element>
 *
 * Returns the trimmed text content of the value that follows, or null if
 * the label is missing or the value is empty.
 *
 * @param {string} html
 * @param {string} label  exact label text (whitespace-tolerant), e.g. "Last Login"
 * @returns {string|null}
 */
export function parseLabelledField(html, label) {
  if (typeof html !== 'string' || html.length === 0) return null;
  if (typeof label !== 'string' || label.length === 0) return null;
  const labelEsc = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const labelRe = new RegExp(
    `<p\\s+class="pa-txt_secondary\\s+pa-mb-6\\s+pa-txt_xs"\\s*>\\s*${labelEsc}\\s*<\\/p>`,
    'i'
  );
  const match = labelRe.exec(html);
  if (!match) return null;
  const tailStart = match.index + match[0].length;
  const tail = html.slice(tailStart);
  // First preference: a single sibling element directly following the
  // label, e.g. <p>2026-04-30</p>. Grab its inner text only - this avoids
  // bleeding into the NEXT labelled section (which sits later in the
  // document and has the same class structure).
  const elemMatch = /^\s*<(\w+)[^>]*>([\s\S]*?)<\/\1>/.exec(tail);
  if (elemMatch) {
    const inner = elemMatch[2].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    if (inner) return inner.slice(0, 80).trim() || null;
  }
  // Fallback: plain text node sitting between the label's </p> and the
  // next tag. Useful if FortiMonitor's markup ever drops the wrapping
  // element around the value.
  const textMatch = /^\s*([^<]+)/.exec(tail);
  if (textMatch) {
    const t = textMatch[1].trim();
    if (t) return t.slice(0, 80).trim() || null;
  }
  return null;
}

/** Convenience wrapper - keeps the call site readable. */
export function parseLastLogin(html) {
  return parseLabelledField(html, 'Last Login');
}

/** Convenience wrapper - keeps the call site readable. */
export function parseCreatedOn(html) {
  return parseLabelledField(html, 'Created On');
}

/**
 * Heuristic: detect that the response is a FortiMonitor login page rather
 * than the EditUser content. Used to surface a clear auth-failure error
 * instead of returning null for every user.
 *
 * @param {string} html
 * @returns {boolean}
 */
export function looksLikeLoginPage(html) {
  if (typeof html !== 'string' || html.length === 0) return false;
  return /<form[^>]*(?:id|name)="?login/i.test(html)
    || /name="password"/i.test(html)
    || /<input[^>]*type="password"/i.test(html);
}

// =============================================================================
// BpaFrontendFetcher
// =============================================================================

/**
 * @typedef {Object} FrontendUserDatum
 * @property {string|null} last_login
 *   The text shown next to the "Last Login" label on the EditUser page,
 *   verbatim. Null if the label is present but no value, or if the page
 *   could not be fetched / parsed for that user.
 * @property {string|null} created_on
 *   The text shown next to the "Created On" label on the EditUser page,
 *   verbatim. Null on the same conditions as last_login.
 */

/**
 * @typedef {Object} BpaFrontendResult
 * @property {Object<string, FrontendUserDatum>} users  Keyed by user id (string)
 * @property {string[]} errors  Per-user error strings ("user 581047: reason")
 * @property {{requests:number, durationMs:number, total:number}} stats
 */

export class BpaFrontendFetcher {
  /**
   * @param {object} options
   * @param {typeof fetch} options.fetch
   *   Wrapped fetch (rate-limited + retry). Production callers pass
   *   createBpaFetch(globalThis.fetch). Tests inject a stub.
   * @param {string} [options.origin]  defaults to FortiMonitor production origin
   * @param {AbortSignal} [options.signal]
   * @param {(event:object) => void} [options.onProgress]
   *   Same event shape vocabulary as BpaFetcher:
   *     { type: 'frontend-user-start' | 'frontend-user-done' | 'frontend-user-error',
   *       index?: number, total?: number, id?: string, error?: string }
   */
  constructor({ fetch, origin = FORTIMONITOR_ORIGIN, signal, onProgress } = {}) {
    if (typeof fetch !== 'function') {
      throw new TypeError('BpaFrontendFetcher requires a fetch function');
    }
    this.fetch = fetch;
    this.origin = origin;
    this.signal = signal;
    this.onProgress = onProgress ?? null;
    this._requestCount = 0;
  }

  /**
   * Walk inventory.users, fetching each user's EditUser page and parsing
   * last_login. Returns a BpaFrontendResult; never throws on per-user
   * failures (those are recorded in errors[]). Aborts cleanly if the
   * caller's AbortSignal fires.
   *
   * Auth failure on the FIRST user is treated as fatal - if the operator
   * isn't logged in, every subsequent fetch will redirect to login, and
   * we'd rather surface the problem once than spam the errors[] list.
   *
   * @param {Object[]} users  inventory.users from BpaFetcher
   * @returns {Promise<BpaFrontendResult>}
   */
  async collect(users) {
    const started = Date.now();
    /** @type {BpaFrontendResult} */
    const result = {
      users: {},
      errors: [],
      stats: { requests: 0, durationMs: 0, total: 0 }
    };
    const list = Array.isArray(users) ? users : [];
    result.stats.total = list.length;

    for (let idx = 0; idx < list.length; idx++) {
      this._abortIfNeeded();
      const u = list[idx];
      const id = idLikeOf(u);
      if (id == null) continue;
      const idStr = String(id);
      this._emit({ type: 'frontend-user-start', index: idx + 1, total: list.length, id: idStr });

      try {
        const datum = await this._fetchOne(idStr);
        result.users[idStr] = datum;
        this._emit({ type: 'frontend-user-done', index: idx + 1, total: list.length, id: idStr });
      } catch (err) {
        if (err?.name === 'AbortError') throw err;
        const reason = err?.message ?? String(err);
        result.errors.push(`user ${idStr}: ${reason}`);
        this._emit({ type: 'frontend-user-error', index: idx + 1, total: list.length, id: idStr, error: reason });
        // Fatal-on-first-failure: if this is the first user and the cause
        // is auth, abort the whole walk rather than producing N
        // unhelpful "login page" errors.
        if (idx === 0 && /not logged in|login page|auth/i.test(reason)) {
          throw new Error(
            'FortiMonitor session not detected. Open https://fortimonitor.forticloud.com '
            + 'in another tab and log in, then retry the assessment.'
          );
        }
      }
    }

    result.stats.requests = this._requestCount;
    result.stats.durationMs = Date.now() - started;
    return result;
  }

  // ---- Internal -----------------------------------------------------------

  async _fetchOne(idStr) {
    this._requestCount++;
    const url = `${this.origin}${EDIT_USER_PATH}?contact_id=${encodeURIComponent(idStr)}`;
    const res = await this.fetch(url, {
      method: 'GET',
      credentials: 'include',
      headers: { 'Accept': 'text/html' },
      signal: this.signal
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    const html = await res.text();
    if (looksLikeLoginPage(html)) {
      throw new Error('Not logged into FortiMonitor (got a login page)');
    }
    return {
      last_login: parseLastLogin(html),
      created_on: parseCreatedOn(html)
    };
  }

  _emit(event) {
    try { this.onProgress?.(event); } catch { /* ignore listener errors */ }
  }

  _abortIfNeeded() {
    if (this.signal?.aborted) {
      const err = new Error('aborted');
      err.name = 'AbortError';
      throw err;
    }
  }
}

/**
 * Pull a usable id off an inventory.users entry. Mirrors the
 * extractTrailingId helper in bpa-fetcher.js for the resource_url case.
 */
function idLikeOf(user) {
  if (!user) return null;
  if (user.id != null && user.id !== '') return user.id;
  const url = user.resource_url ?? user.url;
  if (typeof url === 'string') {
    const parts = url.replace(/\/+$/, '').split('/');
    for (let i = parts.length - 1; i >= 0; i--) {
      if (/^\d+$/.test(parts[i])) return Number(parts[i]);
    }
  }
  return null;
}

/**
 * Production factory. Builds a paced + retrying fetch (same wrapper
 * BpaFetcher uses) and returns a BpaFrontendFetcher ready to collect().
 *
 * @param {object} [overrides]
 * @param {typeof fetch} [overrides.fetch]
 * @param {AbortSignal} [overrides.signal]
 * @param {(event:object)=>void} [overrides.onProgress]
 */
export function createProductionBpaFrontendFetcher(overrides = {}) {
  const baseFetch = overrides.fetch ?? globalThis.fetch.bind(globalThis);
  const fetch = createBpaFetch(baseFetch);
  return new BpaFrontendFetcher({
    fetch,
    signal: overrides.signal,
    onProgress: overrides.onProgress
  });
}
