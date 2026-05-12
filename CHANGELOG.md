# Changelog

All notable changes to the Unofficial FortiMonitor Toolkit are tracked here.
Each release section maps to a `v<version>` git tag on `github/main` and to
the `version` field in `extension/manifest.json` at that tag.

Versioning follows semver with this convention:

| Bump | When |
|------|------|
| **patch** (`x.y.Z`) | Bug fix, copy change, doc-only, internal refactor with no operator-visible change |
| **minor** (`x.Y.0`) | New tool, new augmentation, new settings, new visible feature |
| **major** (`X.0.0`) | Changes that require re-Load Unpacked, new permissions, or otherwise alter install steps |

The "Unreleased" section accumulates work in flight; at merge time it is
renamed to the new version section and a fresh "Unreleased" header takes its
place.

## Unreleased

- FMN-154 (phase 1, behind flag): Deployment Snapshot &amp; Diff. New
  toolkit card on FortiMonitor's Canned Reports page
  (`/report/ListReports`), styled to match native `.pa-card` tiles and
  tagged with the FMN-86 attribution ribbon. "Take Snapshot" runs a BPA
  scan and persists a condensed result to `chrome.storage.local`
  (two-slot model: current + previous). "Open diff" launches a viewer
  that shows added / removed / modified servers between the two
  snapshots with field-level prev → next changes. The card includes a
  pre-click ETA (last run's duration as a gauge, or a 30s default for
  the first scan), a real progress bar driven by the BPA fetcher's
  endpoint-done events during the run, and an inline "safe to leave the
  page" reassurance. **Off by default** behind the new
  `fm:snapshotDiffEnabled` flag (FMN-129 per-tool gating pattern);
  toggle it on under popup &rarr; Settings &rarr; "Deployment Snapshot
  &amp; Diff (Beta)". Phase 2 (separate ticket) will add N-rotation,
  multi-tab diffs, and export.

## v1.2.0 - 2026-05-11

- FMN-160: FM TK Search now matches instances by their numeric ID. Paste an
  ID like `43859419` into the search bar and the matching instance appears
  with the `id` badge and an `#43859419` snippet. Exact-ID is the strongest
  signal (ranks just under name-exact); prefix matches also surface.

## v1.1.0 - 2026-05-11

- FMN-153: IP Address and DNS Name columns on `/report/ListServers` now
  walk the full `pageData.instance.fqdns[]` array and classify each entry
  by value (IPv4 / IPv6 / hostname), instead of reading only the scalar
  `pageData.instance.fqdn`. Surfaces real addresses that the prior code
  missed (e.g., instances whose primary fqdn is a label like "server"
  while a secondary entry carries the real IP).
- FMN-153: Universal search bar now classifies `fqdn + additional_fqdns`
  on ingest and tags results with `field: 'ip'` or `field: 'dns'`
  accurately, so the result snippet reads from the right list.

## v1.0.1 - 2026-05-11

- FMN-157: Popup version display now reads from `chrome.runtime.getManifest().version`
  instead of a hardcoded string, closing the drift seen between popup `v0.7.0`
  and manifest `1.0.0`.
- FMN-157: This `CHANGELOG.md` seeded.
- FMN-157: `v1.0.0` git tag created retroactively on `github/main` so future
  releases have a canonical predecessor reference.
- FMN-157: Persistent Dev Launcher generalized from
  `tools/dev/fmn-151-browser.mjs` to `tools/dev/launcher.mjs` (target URL via
  flag). Internal tooling; no operator-visible change.

## v1.0.0 - 2026-04-30

Inflection point. FMN-125 removed Beta flags from the shipping tool set,
marking the first non-prerelease version of the toolkit. Predecessor history
is not reconstructed in this file; see `git log` for the commits that landed
between project start (FMN-39 scaffolding) and this version.
