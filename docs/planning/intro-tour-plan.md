# Intro tour to FortiMonitor - design

FMN-167 planning ticket (2026-05-11). Companion to FMN-168 (the OnSight deployment best-practice walk-through; same framework, different content).

Operator request: a first-time-user guided tour of FortiMonitor itself, run from this extension. The tour spotlights pieces of FortiMonitor's UI in order with captions explaining what each element is and why it matters. Operator triggers it from the popup; the tour drives them through the FortiMonitor pages they already have open via content-script overlays.

This ticket is **planning + small POC**. Deliverables are the doc, a flag-gated stub framework, and **one** working step (Dashboards). The full intro script is a follow-up ticket.

---

## Reusable surface for sibling tour tickets

FMN-168 (OnSight tour) and any future tour ticket consume the framework shipped here. Bind to these exact paths and exports; everything else is internal.

| Symbol / file | Purpose | Import path |
|---|---|---|
| `extension/src/ui/intro-tour/tour-engine.js` | `runTour(steps, opts)` - drives a step list against the live DOM. Exposes `IntroTour` class for advanced control. | `'../intro-tour/tour-engine.js'` |
| `extension/src/ui/intro-tour/step-renderer.js` | `renderStep(step, ctx) -> { hostNode, dispose }` - pure step-to-DOM function. Used by harnesses and the engine. | `'../intro-tour/step-renderer.js'` |
| `extension/src/ui/intro-tour/step-schema.js` | `normalizeStep(input)`, `validateStep(input) -> { ok, errors }`. Sole source of truth for the step model. | `'../intro-tour/step-schema.js'` |
| `extension/src/ui/intro-tour/styles.css` | Scoped `.fmn-tour-*` styles. Linked by the content-script bridge; harnesses import it inline. | n/a |
| `extension/src/content/intro-tour-bridge.js` | Content-script glue: reads `fm:introTourEnabled`, listens for `fm:intro-tour:start`, calls `runTour`. Registered in `augment.js` as an augmentation. | (loaded by `augment.js`) |

**Rule of thumb for sibling tours**: define a `STEPS` array (validated by `validateStep`), call `runTour(STEPS, { storageKey: 'fm:onsightTourState' })`, ship a unique start-trigger message. Do not fork the renderer or schema.

---

## 1. Framework choice

Three candidates evaluated against four criteria: bundle size, styling control, cross-route persistence, license.

### Shepherd.js
- **Bundle size**: ~30 KB min+gzip core, ~40 KB with default theme. Pulls Tippy.js / Floating UI for positioning (~20 KB more).
- **Styling control**: themeable but ships an opinionated stylesheet that fights the existing `.fmn-*` palette without override work. CSS variables present but the cascade order with FortiMonitor's bundled Bootstrap/Vue styles is fragile.
- **Cross-route persistence**: framework holds tour state in memory; survives only what its parent JS context survives. SPA route changes are fine; full page navigations (FortiMonitor does this between report tabs) lose state unless the consumer wraps state in `chrome.storage`. The framework does not help with this.
- **License**: MIT.

### Intro.js
- **Bundle size**: ~10 KB min+gzip, no peer deps.
- **Styling control**: smaller surface than Shepherd; still ships a default theme that clashes with FortiMonitor's chrome.
- **Cross-route persistence**: in-memory only. Same caveat.
- **License**: dual GPL-3.0 / commercial. The GPL clause makes redistribution in a Chrome extension legally awkward even if the codebase remains "unofficial."

### Hand-rolled, no runtime deps
- **Bundle size**: estimated <4 KB for the engine + renderer + schema + scoped CSS combined, written to the project's existing style (vanilla DOM, no build step).
- **Styling control**: total. We already maintain `.fmn-*` CSS primitives in `extension/src/ui/styles.css`; the tour overlay just adds scoped classes under that same vocabulary.
- **Cross-route persistence**: we implement it ourselves against `chrome.storage.session` (active step index) and `chrome.storage.local` (dismiss/resume), which the alternative frameworks would require anyway.
- **License**: ours.

### Recommendation: hand-rolled.

Justification: every cross-route piece we need (SPA + full-nav persistence) we have to author regardless of the framework. The "framework" piece we'd get is overlay + positioning + button rendering - modest work in our existing vocabulary, and the toolkit's project policy is no-runtime-deps. Shepherd's license is fine but the theme conflict is real; Intro.js's license is not fine for this repo. The hand-rolled module is the smallest total system once the cross-route requirement is included.

This decision is also reversible: the `step-renderer.js` exported surface is provider-agnostic. If the hand-rolled positioning later proves inadequate (multi-monitor scaling, RTL, weird scrollable containers), Shepherd can be slotted in behind the same `renderStep` interface without touching consumers.

---

## 2. Step model

The step JSON schema is the contract between content authors (the captioned-script ticket) and the engine. Pure data; no functions stored.

```
{
  "id": "dashboards-overview",
  "anchor": "nav .pa-side-nav__top-level-item[data-route='/dashboards']",
  "anchor_fallback": "body",
  "caption_html": "<p>The <strong>Dashboards</strong> entry is your operator-built overview...</p>",
  "when": { "path_includes": "/" },
  "advance": "next-button",
  "placement": "right",
  "on_enter": null,
  "on_exit": null
}
```

Field reference:

| Field | Type | Required | Description |
|---|---|---|---|
| `id` | string | yes | Stable across renumbering. Used for dismiss/resume bookmarking and analytics-like step counters. Lowercase kebab-case. |
| `anchor` | string (CSS selector) | yes | Highlighted node. Must be present in the DOM at step entry, or the engine waits up to `anchor_timeout_ms` (default 5000) for it via MutationObserver, then falls back to `anchor_fallback`. |
| `anchor_fallback` | string (CSS selector) | no | Used if `anchor` never resolves. Defaults to `body` (caption renders as a floating card, no spotlight). |
| `caption_html` | string | yes | HTML body of the caption. Sanitized: only `<p>, <strong>, <em>, <code>, <ul>, <ol>, <li>, <a>, <br>, <span>` survive; `<script>`, `<style>`, event attrs stripped. v1 is text + simple formatting. |
| `caption_markdown` | string | no | Optional alternative to `caption_html`. If both are present, `caption_html` wins (no double-conversion cost). Markdown is rendered by a 30-line subset converter in `step-renderer.js` - enough for headings, lists, bold/italic, code, links. |
| `when` | object | no | Step-visibility predicate. `{ path_includes: "/" }` runs the step only when `location.pathname.includes("/")`. Other forms: `{ path_regex: "/report/.*" }`, `{ always: true }`. Default `{ always: true }`. |
| `advance` | `"click" \| "auto" \| "next-button"` | yes | How the step ends. `click` waits for any click on the anchor; `auto` advances after `auto_ms` (default 3500ms); `next-button` shows a "Next" button in the caption card. |
| `auto_ms` | number | no | Used only when `advance === "auto"`. |
| `placement` | `"top" \| "right" \| "bottom" \| "left" \| "auto"` | no | Caption card position relative to anchor. Default `"auto"` (engine picks the side with most room). |
| `on_enter` | string (event name) | no | Engine dispatches `fm:intro-tour:on-enter:{value}` on `document`. Consumers can hook for side-effects (e.g., open a menu). Pure data in the step; behavior lives in `intro-tour-bridge.js`. |
| `on_exit` | string (event name) | no | Same pattern. |
| `audio_url` | string | no | Reserved for v2. Engine ignores in v1. |

The renderer is a pure function from `step -> DOM nodes`. The engine is a state machine over a `steps` array. Mutation of the step model (skip, branch, repeat) is the engine's job, not the renderer's.

---

## 3. Caption transport

**v1 is text only.** The "captioned script" is exactly the `caption_html` (or `caption_markdown`) field on each step. The engine renders inside the step card; no audio playback path is wired.

**v2 audio (deferred to a separate ticket)** would either:
- Render via the browser's `SpeechSynthesisUtterance` (TTS at render time, no asset shipping); or
- Pack pre-recorded `.mp3` files under `extension/assets/intro-tour/audio/{step_id}.mp3` and reference them via the `audio_url` field.

Both options are forward-compatible with the schema (`audio_url` is already reserved). Asset-path convention is documented for the v2 ticket: `assets/intro-tour/audio/{step_id}.mp3` if we go pre-recorded; nothing in the manifest if we go TTS.

The v1 design intentionally does not stub audio code paths - speculative scaffolding ages worse than a clean v2 patch.

---

## 4. Rough intro-tour step outline (~12-20 steps, draft)

This is a **rough draft for the operator to refine in the follow-up captioned-script ticket**. Each caption here is one or two sentences, placeholder copy. Not final.

Anchors are FortiMonitor-tenant selectors; the captioned-script ticket validates each against the live tenant.

| # | id | Path | Anchor (sketch) | Caption (draft) |
|---|---|---|---|---|
| 1 | `welcome` | `/` | `body` (floating) | Welcome to FortiMonitor. This short walkthrough shows you the pieces of the UI you will use most often. Click Next to begin. |
| 2 | `nav-dashboards` | `/` | `nav .pa-side-nav` item containing "Dashboards" | The left sidebar is your top-level navigation. Each entry maps to a workspace; Dashboards is where you build at-a-glance views. |
| 3 | `dashboards-canvas` | `/dashboards/...` | the dashboard canvas root | Dashboards are operator-built. You add cards for the servers, metrics, and alerts you care about most. |
| 4 | `nav-instances` | any | `nav` item containing "Instances" | Instances are the things FortiMonitor monitors - servers, fabric devices, OnSight appliances. Click here to see the full list. |
| 5 | `instances-list` | `/report/ListServers` | the instance table | Every monitored thing in your tenant is one row here. Search by name in the top bar; click a row to drill into details. |
| 6 | `instance-details` | `/report/Instance/{id}/...` | the instance summary header | An instance's detail page shows live metrics, configured thresholds, recent alerts, and the agent resources collecting data. |
| 7 | `instance-metrics` | (same) | the metrics card | This is where you confirm that data is flowing. A flat line for too long usually means a collection problem, not a quiet device. |
| 8 | `nav-alert-timelines` | any | `nav` item for "Alert Timelines" | Alert Timelines is FortiMonitor's incident history. Every outage, ack, and resolve is a row with a timeline. |
| 9 | `alert-timeline-row` | `/report/AlertTimelines` | first timeline row | Each row is one incident. Hover to see severity, duration, and the metric that triggered it. |
| 10 | `nav-incidents` | any | `nav` item for "Incidents" | The Incidents view is the same data, filtered to currently-open incidents - your live operations queue. |
| 11 | `nav-reports` | any | `nav` item for "Reports" | Reports is where you generate point-in-time documents for customers or audits. Includes the Canned Reports and on-demand exports. |
| 12 | `reports-canned` | `/report/CannedReports` | the canned-reports tile area | These are the pre-built report templates - pick one, scope it to a server group, render. |
| 13 | `nav-settings` | any | the gear / settings entry | Settings is where you configure users, integrations (Okta SSO, Teams, PagerDuty), notification rules, and the v2 API keys this extension uses. |
| 14 | `toolkit-handoff` | any | the FM Toolkit toolbar icon (callout) | This toolkit (the FM Toolkit Chrome extension) adds bulk operations and reports on top of what FortiMonitor ships. Click its icon in the Chrome toolbar to see the catalog. |
| 15 | `done` | any | `body` (floating) | That's the orientation. From here, your day-to-day is Dashboards for situational awareness, Instances for drill-in, and Alert Timelines when something fires. |

15 steps. The follow-up captioned-script ticket should expand or contract this list based on real walk-through testing.

---

## 5. Triggering surface - recommendation

Three options were considered:

| Option | Pros | Cons |
|---|---|---|
| Hidden behind popup ⚙ Settings | Consistent with how every other tool is exposed today | Operators who would benefit most (first-install) are least likely to dig into Settings |
| New dedicated tile in the popup | Discoverable; the popup is the toolkit's home | A tile in the launcher implies "useful tool I will rerun"; the intro tour is one-off |
| First-install empty-state banner above the popup tool list | Catches the audience that benefits most | Adds a banner the popup doesn't currently carry; needs a "completed once" flag |

### Recommendation: a popup tile titled **"Tour FortiMonitor"**.

Rationale: the popup is where extension surfaces live. A tile is discoverable, dismissible (the tile honors `fm:introTourEnabled` like every other Beta tile), and the operator can re-run the tour on demand. The empty-state banner is the second-best option but introduces a popup-shape change for one feature; the tile reuses the existing tool-list mechanism.

Behavior on click: the tile sends `chrome.runtime.sendMessage({ type: 'fm:intro-tour:start' })`. The service worker fans the message out to every FortiMonitor tab via `chrome.tabs.query` + `chrome.tabs.sendMessage`. Each tab's `intro-tour-bridge.js` picks up the message and calls `runTour(STEPS)`. If no FortiMonitor tab is open, the SW opens one to `/dashboards` first. (The bridge is gated on `fm:introTourEnabled` - if the flag is off, the message is a no-op even if it arrives.)

Settings entry: a checkbox under Experimental tools labeled **"Show Tour FortiMonitor"**, default off. Mirrors the FMN-129 / FMN-133 / FMN-155 pattern exactly.

---

## 6. Cross-route persistence

FortiMonitor is a Vue SPA for some routes (Dashboards, Instances) and a server-rendered set of pages for others (Reports tabs, some Settings). Both transitions need to survive the tour state.

**Design**: persist the tour's "currently active step index + step list id" in `chrome.storage.session` under `fm:intro-tour:state`:

```
{
  "tour_id": "intro-fortimonitor",
  "active_step_id": "instance-details",
  "started_at": 1747200000000,
  "session_id": "rand-..."
}
```

`chrome.storage.session` persists across SPA route changes (same tab, same SW), full-page navigations within the same tab (the SW outlives `window`), and Chrome `chrome.tabs.update` navigations. It does NOT persist across browser restarts - which is the desired semantic: a fresh browser session is a fresh tour attempt.

The content-script bridge subscribes to `chrome.storage.session` changes. On every step advance, it writes the new state. On every page load, `intro-tour-bridge.js` reads the state and, if a tour is active and `when` matches the current path, renders the current step. SPA route changes are picked up by the engine's existing route-change observer (the `augment.js` pushState/replaceState/popstate hooks, reused).

Full-page navigations: the engine's `on_exit` of step N writes state, page navigates, new page loads, content script reads state, finds step N's id, looks up the *next* step, and renders it if `when` matches. The "next step" logic lives in the engine, not the renderer.

---

## 7. Hide / dismiss / resume

State machine, persisted in `chrome.storage.local` under `fm:intro-tour:bookmark`:

```
{
  "status": "active" | "dismissed" | "completed",
  "tour_id": "intro-fortimonitor",
  "last_step_id": "instance-details",
  "completed_at": null | timestamp,
  "dismissed_at": null | timestamp
}
```

States:
- **active**: a tour is running this browser session. Render the current step on matching pages.
- **dismissed**: operator clicked X on a step card. Engine tears down, no further renders this session. Bookmark records `last_step_id` so a "Resume" option in the popup can pick up where they left off.
- **completed**: operator reached the final step. Same teardown as dismissed, but bookmark records `completed_at`. Tile in popup changes label from "Start tour" to "Replay tour".

Dismissed and completed states do not auto-clear; the operator can rerun from the tile (which clears `dismissed_at` / sets a new `session_id`).

A "Resume from step X" affordance is a v2 nice-to-have. v1 is "Start" and "Replay" only; resume-mid-tour is recorded but unsurfaced in the popup until the follow-up ticket implements it.

---

## 8. Per-tool visibility flag

Per `per_tool_visibility_flag.md` (project memory), this tool gets its own flag:

```
fm:introTourEnabled   // default false
```

Specific to the intro tour. **Do not** share this flag with FMN-168's OnSight tour; that tour gets its own (`fm:onsightTourEnabled`) when it lands.

Settings label, copy, and default per the memory rule:
- Settings label: **"Show Tour FortiMonitor"**
- Default: off
- Help text: "Off by default. When on, the toolkit shows a Tour FortiMonitor tile in the popup that launches a guided walk-through of FortiMonitor's UI. Beta - the framework is stable but the tour content is being authored."

The flag remains off until the framework graduates (after FMN-168 also lands and any v2 tour content is QA'd). At that point a separate ticket flips the default.

---

## 9. Authoring harness (suggested)

`tools/dev/tour-author.html` - a local preview-and-edit page. Standalone HTML; loads `step-renderer.js` and `step-schema.js` directly from the extension source tree (no build step, no extension load required). UI:

- Left pane: textarea with a step JSON document (one step at a time, or an array).
- Right pane: live-rendered step card against a placeholder anchor (`<div id="fake-anchor">Dashboards</div>` or similar). Picks up changes on textarea blur.
- Below: a step-by-step navigator with Prev/Next buttons for stepping through an array.

Out of scope for this ticket (the stub renders one hard-coded step). The authoring ticket adds it. The framework's renderer is already a pure function, so adding the harness later is purely additive.

---

## 10. Stub framework - what FMN-167 ships

1. `extension/src/ui/intro-tour/step-schema.js` - `normalizeStep`, `validateStep`, `STEP_DEFAULTS`.
2. `extension/src/ui/intro-tour/step-renderer.js` - `renderStep(step, { container }) -> { hostNode, dispose }`. Pure DOM construction, returns the inserted node + a teardown fn. Imports the scoped CSS at bridge mount time.
3. `extension/src/ui/intro-tour/tour-engine.js` - `runTour(steps, opts) -> IntroTour` instance. State machine over the steps array; integrates with `chrome.storage.session` for cross-route. v1 supports `next-button` advance only (`click` and `auto` are stubs that throw - the only step shipped uses `next-button`).
4. `extension/src/ui/intro-tour/styles.css` - `.fmn-tour-overlay`, `.fmn-tour-spotlight`, `.fmn-tour-card`, `.fmn-tour-next`, `.fmn-tour-dismiss`. Scoped, reuses CSS variables from `extension/src/ui/styles.css` where possible.
5. `extension/src/content/intro-tour-bridge.js` - content-script glue, registered as an augmentation in `augment.js`. Reads `fm:introTourEnabled`; listens for `chrome.runtime.onMessage` `fm:intro-tour:start`; calls `runTour(INTRO_TOUR_STEPS)`.
6. One step in `INTRO_TOUR_STEPS`: the Dashboards step. Anchored on `nav .pa-side-nav__top-level-item` (most stable selector visible across FortiMonitor's nav variants). Caption: a placeholder welcome line. `advance: "next-button"`. Clicking Next ends the tour (it's the only step).
7. The popup tile and the Settings toggle are **not** shipped in this ticket - they're the trigger-surface follow-up ticket. To exercise the stub during operator review: enable the flag in DevTools (`chrome.storage.local.set({ 'fm:introTourEnabled': true })`), reload the FortiMonitor tab, send the start message from DevTools (`chrome.runtime.sendMessage({ type: 'fm:intro-tour:start' })` from the popup or extension context).

The stub is real, runnable code. Operator flips the flag, sends the message, sees the caption.

---

## 11. Implementation roadmap - follow-up tickets

Filed under the `browser-plugin` label, draft state, against the FMN project. Each can land independently after FMN-167.

1. **FMN-167a - Intro tour: authoring + step content.** Operator-authored captions for the 15-step intro outline above (or whatever final count, after live-tenant walk-through validation). Updates `INTRO_TOUR_STEPS`, no framework changes expected.
2. **FMN-167b - Intro tour: popup tile + Settings toggle.** Adds the "Tour FortiMonitor" tile to `popup.html`, wires the click handler, adds the `fm:introTourEnabled` Settings checkbox under Experimental tools. Same shape as the FMN-129 / FMN-133 / FMN-155 wiring.
3. **FMN-167c - Intro tour: dismiss / resume state machine.** Implements the `fm:intro-tour:bookmark` storage shape and the "Replay tour" / "Resume tour" affordances on the popup tile.
4. **FMN-167d - Intro tour: audio transport.** Decides TTS vs. pre-recorded, wires `audio_url` rendering, ships the first audio asset.

Filed as drafts (not committed work) so they appear in Plane for the operator to size and order. Operator can promote any of them off draft when ready to schedule.

---

## What this design does not change

- `augment.js` registration model: untouched. The bridge is one more registered augmentation; the framework's mount/dismount lifecycle is the same as every other `register({...})`.
- `chrome.storage.local` settings model: one new key (`fm:introTourEnabled`); settings.js gains one getter/setter pair following the existing pattern.
- Popup HTML / `popup.js`: untouched in this ticket. The trigger surface ticket adds the tile.
- No new permissions in `manifest.json`. The framework reads/writes `chrome.storage.session` (covered by the existing `storage` permission), listens for runtime messages (no permission required), and only renders on FortiMonitor pages already covered by `content_scripts.matches`.

The whole change is a new module tree (`extension/src/ui/intro-tour/`) plus one content-script bridge file, plus a unit-test file, plus a synthetic harness, plus a Playwright spec.
