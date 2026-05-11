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

- FMN-157: Popup version display now reads from `chrome.runtime.getManifest().version`
  instead of a hardcoded string, closing the drift seen between popup `v0.7.0`
  and manifest `1.0.0`.
- FMN-157: This `CHANGELOG.md` seeded.
- FMN-157: `v1.0.0` git tag created retroactively on `github/main` so future
  releases have a canonical predecessor reference.
- FMN-157 (planned): Persistent Dev Launcher generalized from
  `tools/dev/fmn-151-browser.mjs` to `tools/dev/launcher.mjs` (target URL via
  flag). Internal tooling; no operator-visible change.

## v1.0.0 - 2026-04-30

Inflection point. FMN-125 removed Beta flags from the shipping tool set,
marking the first non-prerelease version of the toolkit. Predecessor history
is not reconstructed in this file; see `git log` for the commits that landed
between project start (FMN-39 scaffolding) and this version.
