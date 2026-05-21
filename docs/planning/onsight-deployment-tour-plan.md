# OnSight deployment guided walk-through — design

FMN-168 planning ticket. Sibling of FMN-167 (Introduction to FortiMonitor); same framework, different content. Re-uses the tour engine, step renderer, and step schema shipped under `extension/src/ui/intro-tour/`.

Operator request: a guided walk-through that takes an operator through OnSight deployment from "I need to set up an OnSight" to "the OnSight is online and monitoring instances." Captioned narration per step. Initiated from the toolkit popup. Persists across days because hardware shipping and firewall changes don't happen in one sitting.

This ticket is **planning + small PoC**. Deliverables are this doc plus one demonstration step (rendered as a docs/harnesses fixture so the off-FortiMonitor branch of the step schema is visible without depending on a live tenant). The full content authoring, popup trigger, and framework extension to support off-FortiMonitor steps land as follow-up tickets.

> Terminology note (per memory rule `no_best_practice_terminology.md`): the ticket title in Plane uses the phrase "Best-practice walk-through" because it predates the rule. Throughout this doc, in code, and in the popup we use the neutral phrasing **"OnSight Deployment Guide"** (or "OnSight tour" in shorthand). When the work fans out into follow-up tickets, use the neutral phrasing there too.

---

## 1. Reuse vs. fork

The intro-tour framework's reusable surface is documented at `docs/planning/intro-tour-plan.md` section "Reusable surface for sibling tour tickets." Bind to these exact paths and exports:

| Symbol | Used by OnSight tour |
|---|---|
| `extension/src/ui/intro-tour/tour-engine.js` (`runTour(steps, opts)`) | Yes. Pass `storageKey: 'fm:onsightTourState'`. |
| `extension/src/ui/intro-tour/step-renderer.js` (`renderStep`) | Yes — but see §3 for the off-FortiMonitor step gap. |
| `extension/src/ui/intro-tour/step-schema.js` (`validateStep` + `normalizeStep`) | Yes for DOM-anchored steps. Requires a small extension for checklist steps. |
| `extension/src/ui/intro-tour/styles.css` | Yes. |
| `extension/src/content/intro-tour-bridge.js` | Mostly. The bridge listens for `fm:intro-tour:start`; for OnSight we add a sibling listener `fm:onsight-tour:start`. |

**Do not fork the renderer or the schema.** If a new field is needed (`step_type` to distinguish DOM-anchored vs checklist), extend the existing schema with a backward-compatible default rather than creating a parallel tour module.

---

## 2. Trigger surface

Toolkit popup gets a dedicated tile, distinct from the Introduction-to-FortiMonitor entry:

```
[OnSight Deployment Guide]
A step-by-step walkthrough for putting a new OnSight on the network
and getting it into FortiMonitor. Resumes across days.
```

Tile is gated behind `fm:onsightTourEnabled` (Settings toggle, default off until the full content lands), matching the per-tool visibility flag convention (memory: `per_tool_visibility_flag.md`).

Clicking the tile posts `fm:onsight-tour:start` to whichever content script picks it up. Inside FortiMonitor the existing `intro-tour-bridge.js` pattern lights up; outside FortiMonitor (e.g. operator on their hypervisor console) the popup itself hosts the first checklist step.

---

## 3. Step model — and the off-FortiMonitor gap

The current `step-schema.js` requires `anchor: <CSS selector>` on every step. For the introduction tour that's correct: every step highlights a FortiMonitor UI element.

OnSight deployment has steps that live **outside** FortiMonitor entirely:
- "Confirm outbound network access to FortiMonitor from the OnSight's planned subnet."
- "Get the OnSight image from the FortiMonitor admin UI" (this one IS FortiMonitor-anchored).
- "First-boot the OnSight, paste in the registration token, wait for heartbeat" (back outside; the OnSight's own UI, not FortiMonitor's).

For these the existing schema is wrong: there's no DOM node on the current page to highlight, and degrading to `anchor: 'body'` produces a viewport-centered card that doesn't read as "a step in the process," it reads as a stuck modal.

**Proposed schema extension** (followup FMN ticket; out of scope for this planning ticket):

```diff
  {
    id: 'network-access-check',
+   step_type: 'checklist',          // 'anchor' (default, existing) | 'checklist'
    caption_html: '<p>Before powering on the OnSight, confirm the following:</p>',
+   checklist: [
+     { id: 'outbound-443', label: 'Outbound TCP/443 from the OnSight subnet to <code>api.panopta.com</code>', help: 'Required for heartbeat and metric upload.' },
+     { id: 'dns-resolve',  label: 'DNS resolves <code>api.panopta.com</code> from the OnSight subnet', help: null },
+     { id: 'time-sync',    label: 'NTP/Chrony reachable for the OnSight (cert validation depends on clock)', help: null }
+   ],
    advance: 'all-checked'           // new mode: enable Next once every checklist item is checked
  }
```

- `step_type` defaults to `'anchor'`, so every existing intro-tour step stays valid (zero migration cost).
- `anchor` is required only when `step_type === 'anchor'`.
- `'all-checked'` joins the existing `ADVANCE_MODES` array.

The renderer dispatches on `step_type`: anchor steps run the existing spotlight + caption path; checklist steps render a centered card with the checklist + caption + Next (disabled until all-checked). Persistence (per-item checked state) lives under the same `chrome.storage.session` slot the engine already uses for step-index, with a small extension to store per-step checked-items so the operator can leave and come back.

---

## 4. Content outline (rough; final wording belongs to the operator)

Suggested seven sections. Each section yields one or more steps; counts in parentheses are conservative estimates.

| Section | Step count | Mix |
|---|---|---|
| **A. Pre-deployment** | 2 | Both checklist (form-factor decision, capacity sizing matrix). |
| **B. Network access** | 1 | Checklist. Outbound flows, FW exceptions, subnet placement. Used as the PoC step in this ticket. |
| **C. Initial provisioning** | 2 | Mixed. "Get the OnSight image from FortiMonitor → OnSights → Add" is anchor (FortiMonitor UI). "Run first-boot config" is checklist. |
| **D. Registration with FortiMonitor** | 2 | One anchor step (navigate to OnSights, click Add, paste token). One checklist step (verify the heartbeat is green within 60s). |
| **E. Instance attachment** | 2 | Anchor steps: pick instances to put behind this OnSight; configure monitoring-policy workflows to route them. |
| **F. Validation** | 2 | Anchor: check first metrics arrive. Checklist: smoke-test alerts (cause a known outage condition, verify the platform pages oncall correctly). |
| **G. Post-deployment** | 2 | Anchor: monitor the OnSight itself (heartbeat, version, queue depth). Checklist: maintenance windows, scaling indicators. |

Total: ~13 steps. Comparable to FMN-167's final 12-step intro tour.

---

## 5. Persistence and resume

The tour engine already persists step index to `chrome.storage.session` (active step) and to `chrome.storage.local` (dismiss + resume). For OnSight specifically:

- The default `chrome.storage.session` lifetime is the browser session — fine for resumption during one work day, not fine for the multi-day case operator described (hardware shipping window).
- **Switch the OnSight tour to `chrome.storage.local` for active step state**, not just dismiss/resume. The active step + checklist checked items survive browser restarts that way.
- The popup shows "Resume OnSight Deployment Guide (step 4 of 13)" when local state exists, alongside the "Start" tile. Clicking Resume re-opens at the saved step.

This single per-tour storage-tier decision is the only behavior split between the intro tour and the OnSight tour. Encode it in the `runTour` opts:

```js
runTour(STEPS, {
  storageKey: 'fm:onsightTourState',
  storageTier: 'local'        // new opt; intro tour stays default 'session'
});
```

---

## 6. Per-step content rules

Authoring the actual `caption_html` is operator-driven. A few rules so authoring goes smoothly when content arrives:

- **No marketing language.** No "Best Practice," no "industry-leading," no "powerful." Per memory `no_best_practice_terminology.md`.
- **Mirror FortiMonitor's UI vocabulary verbatim.** If FortiMonitor calls the page "OnSights," the caption says "OnSights." If FortiMonitor calls a feature a "Monitoring Policy Workflow," that's what we call it (memory `fortimonitor_term_monitoring_policy_workflow.md`).
- **Externally-imposed steps spell out why.** "Outbound 443 to api.panopta.com" is followed by "(required for heartbeat and metric upload)." Operators routing this through firewall change-tickets need the rationale to paste in.
- **Each step has exactly one ask.** If a step has two unrelated actions, it's two steps.

---

## 7. Demonstration step (this ticket's PoC)

`docs/harnesses/fmn-168-onsight-checklist-demo.html` renders Section B ("Network access") as a checklist step using the schema extension described in §3. The harness:

- Is a standalone HTML file (no extension load required).
- Imports the existing `extension/src/ui/intro-tour/styles.css` to confirm the visual vocabulary matches the intro tour.
- Inlines a small JS shim that mimics the step-renderer's API for `step_type === 'checklist'` so the visual can be validated before the schema extension lands.

The PoC is **not wired through the live engine** — that hookup is the follow-up ticket's job. It's there so the operator can review what the checklist step looks like before the framework code lands.

---

## 8. Follow-up tickets (filed at the end of this ticket)

1. **Framework extension**: add `step_type` to `step-schema.js`, add `'all-checked'` advance mode, extend the renderer to dispatch on `step_type`, add `storageTier` option to `runTour`. Acceptance: every existing intro-tour step still passes validation and renders identically; the new checklist branch round-trips through engine + renderer with persistence.
2. **OnSight tour content authoring**: write the 13 step captions + checklist items. Operator-driven; lands as a `STEPS` array under `extension/src/ui/onsight-tour/`.
3. **Popup trigger**: tile + Settings toggle (`fm:onsightTourEnabled`). Hook the Resume entry too.
4. **Live validation hooks**: at least one step ("Verify FortiMonitor sees the OnSight heartbeat") calls v2 `/onsight` before allowing advance, instead of relying on the operator to self-confirm.

---

## 9. Acceptance for this ticket

- This doc exists. ✓
- The demonstration step (`docs/harnesses/fmn-168-onsight-checklist-demo.html`) renders a checklist step and visually matches the intro-tour palette.
- Follow-up tickets above are filed in Plane with the labels `browser-plugin` and acceptance criteria.

Out of scope (covered by follow-ups):
- Authoring the full step content.
- Wiring the engine to render the checklist branch.
- The Resume UI in the popup.
- The Live validation hooks.
