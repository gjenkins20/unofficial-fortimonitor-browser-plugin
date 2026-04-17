# TODO

Unofficial FortiMonitor Browser Plugin — task tracking.

---

## High Priority

- [ ] **Determine data source for port operational status** <!-- PLANE:FMN-37 -->
  - Blocks FMN-38 and FMN-39
  - Test H1 first (agent_resource live link status on existing test VMs)
  - Requires Claude session with FortiMonitor MCP connected
  - If H1 fails → lab FortiGate-VM deployment becomes necessary

- [x] **Design UX mockups for port scope cleanup extension** <!-- PLANE:FMN-38 -->
  - All five step mockups approved plus clickable flow-prototype.html

- [ ] **Implement MV3 extension for port scope cleanup** <!-- PLANE:FMN-39 -->
  - Blocked by FMN-37 and FMN-38
  - Scaffolds from `docs/api-discovery/port-scope-snippet.js`
  - Dry-run default, destructive-action warning, batch processing
  - Start as private repo per global guidelines

- [ ] **Build Chrome extension for automated WAN interface port scope cleanup** <!-- PLANE:FMN-35 -->
  - Parent/epic ticket; tracked via FMN-37/38/39 above

## Completed

- [x] **Capture FortiCloud UI API contract for port scope modification** <!-- PLANE:FMN-36 -->
- [x] **Determine data source for port operational status** <!-- PLANE:FMN-37 -->
- [x] **Design UX mockups for port scope cleanup extension** <!-- PLANE:FMN-38 -->

---

*Last updated: 2026-04-16*
