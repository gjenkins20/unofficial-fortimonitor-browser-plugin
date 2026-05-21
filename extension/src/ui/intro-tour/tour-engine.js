// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// FMN-167: tour engine. State machine over a step list. Drives the
// step-renderer and wires advance / dismiss events.
//
// Designed so the same engine drives:
//   - Live FortiMonitor (content-script context, real chrome.* APIs).
//   - The synthetic harness (file:// page, no chrome APIs - opts.storage
//     stub is provided).
//   - Unit tests (jsdom-free node:test environment, doc is constructed
//     by the test, opts.storage is in-memory).
//
// All side-effects (storage, DOM injection of the scoped CSS link) are
// opt-in via the opts object. No top-level imports of chrome.* anything.

import { normalizeStep, validateStep, stepMatchesPath } from './step-schema.js';
import { renderStep } from './step-renderer.js';

const DEFAULT_STORAGE_KEY = 'fm:intro-tour:state';

/**
 * Drive a tour over the supplied step list.
 *
 * Required:
 *   - steps: array of step inputs (validated here; invalid steps throw).
 *
 * Options (all optional):
 *   - tour_id: string identifier persisted in session storage.
 *     Default: 'intro-fortimonitor'.
 *   - doc: target document. Default: globalThis.document.
 *   - storage: a thenable storage adapter with get/set/remove.
 *     Default: a no-op in-memory storage. The content-script bridge
 *     passes chrome.storage.session.
 *   - storageKey: session-storage key for engine state.
 *     Default: 'fm:intro-tour:state'.
 *   - onComplete: invoked when the operator reaches past the final step.
 *   - onDismiss: invoked when the operator clicks the X on a step card.
 *   - onAdvance: invoked on every successful advance with (fromStep, toStep).
 *   - initialStepId: start from a specific step id (resume support).
 *     Defaults to the first step.
 *
 * Returns an IntroTour instance with .start(), .advance(), .dismiss(),
 * .currentStep, .isActive, .renderNow().
 */
export function runTour(steps, opts = {}) {
  const tour = new IntroTour(steps, opts);
  tour.start();
  return tour;
}

export class IntroTour {
  constructor(steps, opts = {}) {
    if (!Array.isArray(steps) || steps.length === 0) {
      throw new Error('IntroTour: steps must be a non-empty array');
    }
    const normalized = [];
    for (const [i, s] of steps.entries()) {
      const res = validateStep(s);
      if (!res.ok) {
        throw new Error(`IntroTour: step[${i}] (id=${s?.id ?? '?'}) invalid: ${res.errors.join('; ')}`);
      }
      normalized.push(res.step);
    }
    this.steps = Object.freeze(normalized);
    this.tour_id = String(opts.tour_id || 'intro-fortimonitor');
    this.doc = opts.doc || (typeof document !== 'undefined' ? document : null);
    this.storage = opts.storage || createNoopStorage();
    this.storageKey = String(opts.storageKey || DEFAULT_STORAGE_KEY);
    // FMN-229: storageTier metadata. The bridge picks chrome.storage.session
    // (default) or chrome.storage.local based on whether the tour content
    // is expected to outlive the browser session (OnSight deployment can
    // span days, so it uses 'local'). The engine itself just records the
    // value for inspection; storage I/O still goes through this.storage.
    this.storageTier = opts.storageTier === 'local' ? 'local' : 'session';
    this.onComplete = typeof opts.onComplete === 'function' ? opts.onComplete : noop;
    this.onDismiss = typeof opts.onDismiss === 'function' ? opts.onDismiss : noop;
    this.onAdvance = typeof opts.onAdvance === 'function' ? opts.onAdvance : noop;
    // FMN-229: per-step checklist state. Mirrors storage on writes.
    // start() hydrates this from storage; activate / commit / dismiss
    // touch it as needed.
    this._checklistState = null;
    this._startedAt = null;

    const initialId = opts.initialStepId || normalized[0].id;
    const initialIdx = normalized.findIndex((s) => s.id === initialId);
    this.activeIndex = initialIdx >= 0 ? initialIdx : 0;
    this.isActive = false;
    this._mount = null; // { hostNode, cardNode, nextButton, dispose }
    this._anchorWaitObserver = null;
  }

  get currentStep() {
    return this.steps[this.activeIndex] || null;
  }

  /**
   * Mount the current step into the document. Returns a promise so
   * callers can await render completion when they need a deterministic
   * post-mount checkpoint (the synthetic harness + Playwright spec rely
   * on this).
   */
  async start() {
    if (this.isActive) return;
    this.isActive = true;
    // FMN-229: hydrate persisted checklist state (if any) so a re-entry
    // restores per-step checks. active_step_id is honored too when
    // initialStepId wasn't supplied at construction.
    try {
      const data = await this.storage.get(this.storageKey);
      const prior = data && data[this.storageKey];
      if (prior && typeof prior === 'object') {
        if (prior.checklist && typeof prior.checklist === 'object') {
          this._checklistState = { ...prior.checklist };
        }
        if (this._startedAt == null && typeof prior.started_at === 'number') {
          this._startedAt = prior.started_at;
        }
      }
    } catch { /* noop */ }
    await this._writeState();
    await this.renderNow();
  }

  /**
   * Render the current step against the current DOM. Use this after a
   * route change to re-paint after a navigation. The engine itself does
   * not subscribe to route changes - the bridge does, then calls
   * renderNow().
   */
  async renderNow() {
    if (!this.isActive) return;
    const step = this.currentStep;
    if (!step) return;
    // If the step's `when` predicate doesn't match the current path,
    // do not render - this is normal when persistence resumes a tour
    // and the operator navigates away from the expected page.
    const pathname = this.doc?.location?.pathname ?? '';
    if (!stepMatchesPath(step, pathname)) return;

    await this._waitForAnchor(step);

    if (this._mount) this._mount.dispose();
    // FMN-229: pass per-step checklist state to the renderer when the
    // step is a checklist. Persisted under state.checklist[stepId].
    const initialChecked = step.step_type === 'checklist'
      ? (this._checklistState?.[step.id] ?? null)
      : null;
    this._mount = renderStep(step, {
      doc: this.doc,
      onNext: () => { this.advance(); },
      onDismiss: () => { this.dismiss(); },
      initialChecked,
      onChecklistChange: (stepId, checkedIds) => {
        if (!this._checklistState) this._checklistState = {};
        this._checklistState[stepId] = checkedIds.slice();
        // Fire-and-forget; state is best-effort.
        this._writeState();
      }
    });
    this._dispatchEvent(step.on_enter);
  }

  async advance() {
    if (!this.isActive) return;
    const fromStep = this.currentStep;
    if (fromStep && fromStep.on_exit) this._dispatchEvent(fromStep.on_exit);
    if (this.activeIndex >= this.steps.length - 1) {
      await this._teardown();
      this.onComplete(fromStep);
      return;
    }
    this.activeIndex += 1;
    const toStep = this.currentStep;
    await this._writeState();
    await this.renderNow();
    this.onAdvance(fromStep, toStep);
  }

  async dismiss() {
    const step = this.currentStep;
    if (step && step.on_exit) this._dispatchEvent(step.on_exit);
    await this._teardown();
    this.onDismiss(step);
  }

  async _teardown() {
    this.isActive = false;
    if (this._mount) {
      this._mount.dispose();
      this._mount = null;
    }
    if (this._anchorWaitObserver) {
      this._anchorWaitObserver.disconnect();
      this._anchorWaitObserver = null;
    }
    try { await this.storage.remove(this.storageKey); } catch { /* noop */ }
  }

  async _writeState() {
    const payload = {
      tour_id: this.tour_id,
      active_step_id: this.currentStep?.id ?? null,
      started_at: this._startedAt ?? (this._startedAt = Date.now()),
      // FMN-229: persist per-step checklist state so an operator who
      // leaves mid-step and returns (possibly after a browser restart
      // when storageTier === 'local') resumes with their checks intact.
      checklist: this._checklistState ?? {}
    };
    try {
      await this.storage.set({ [this.storageKey]: payload });
    } catch { /* noop - state is best-effort */ }
  }

  async _waitForAnchor(step) {
    const doc = this.doc;
    if (!doc) return;
    // FMN-229: checklist steps don't have a DOM anchor.
    if (step.step_type === 'checklist' || !step.anchor) return;
    if (safeQuery(doc, step.anchor)) return;
    // Wait up to step.anchor_timeout_ms for the anchor to show up. The
    // engine bails (renders against the fallback) if the anchor never
    // arrives - this keeps tours from hanging on a route that doesn't
    // exist in the live tenant.
    await new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        if (this._anchorWaitObserver) {
          this._anchorWaitObserver.disconnect();
          this._anchorWaitObserver = null;
        }
        resolve();
      };
      const MO = doc.defaultView?.MutationObserver || globalThis.MutationObserver;
      if (!MO) { finish(); return; }
      this._anchorWaitObserver = new MO(() => {
        if (safeQuery(doc, step.anchor)) finish();
      });
      this._anchorWaitObserver.observe(doc.documentElement, {
        subtree: true, childList: true, attributes: false
      });
      const setTimeoutFn = doc.defaultView?.setTimeout || globalThis.setTimeout;
      setTimeoutFn(finish, step.anchor_timeout_ms);
    });
  }

  _dispatchEvent(eventName) {
    if (!eventName || !this.doc) return;
    try {
      const evt = new (this.doc.defaultView?.CustomEvent || globalThis.CustomEvent)(
        `fm:intro-tour:${eventName}`,
        { bubbles: true, cancelable: false, detail: { step_id: this.currentStep?.id ?? null } }
      );
      this.doc.dispatchEvent(evt);
    } catch { /* noop */ }
  }
}

function safeQuery(doc, sel) {
  try { return doc.querySelector(sel); } catch { return null; }
}

function createNoopStorage() {
  const data = new Map();
  return {
    async get(key) {
      if (typeof key === 'string') return { [key]: data.get(key) };
      return Object.fromEntries(data);
    },
    async set(obj) { for (const [k, v] of Object.entries(obj)) data.set(k, v); },
    async remove(key) { data.delete(key); }
  };
}

function noop() { /* intentionally empty */ }

// Re-export validators for sibling tours that build their own step lists.
export { validateStep, normalizeStep };
