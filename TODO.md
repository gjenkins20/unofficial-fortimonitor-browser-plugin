# TODO

Unofficial FortiMonitor Browser Plugin — task tracking.

---

## High Priority

- [ ] **Multi-tool launcher + suite rebrand + Add to Port Scope tool** <!-- PLANE:FMN-40 -->
  - Rebrand to "Unofficial FortiMonitor Toolkit" / short_name "FM Toolkit"
  - Native Chrome popup launcher (`action.default_popup`), card-style tool list
  - New tool: Add to Port Scope (inverse of the existing Remove tool)
  - Prerequisite refactor: extract shared infra into `extension/src/lib/`
  - Mockup-first: `docs/mockups/launcher-popup.html` + `tool-add-port-scope_*.html` before any code

## Backlog

- [ ] **Add author attribution + push repo to GitHub (private first)** <!-- PLANE:FMN-41 -->
  - Blocked on FMN-40
  - Add "About the Developer" section to README(s) per global CLAUDE.md standard
  - Set `package.json` author field
  - Run Pre-Push Security Checklist
  - Create private GitHub repo via `gh repo create --private`; do not make public without explicit approval

## Completed

- [x] **Capture FortiCloud UI API contract for port scope modification** <!-- PLANE:FMN-36 -->
- [x] **Determine data source for port operational status** <!-- PLANE:FMN-37 -->
- [x] **Design UX mockups for port scope cleanup extension** <!-- PLANE:FMN-38 -->
- [x] **Implement MV3 extension for port scope cleanup** <!-- PLANE:FMN-39 -->
- [x] **Build Chrome extension for automated WAN interface port scope cleanup** <!-- PLANE:FMN-35 -->

---

*Last updated: 2026-04-17*
