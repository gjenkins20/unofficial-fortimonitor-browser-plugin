# Omni-Search (FMN-152, FMN-160)

The toolkit replaces FortiMonitor's narrow "Search Instances" input in the top bar with an omni-search box that matches across every server field exposed by the v2 API: name, FQDN, IP addresses, description, tags, attributes (Operating System, Model, custom), device type, agent version, server group, and applied template.

When the operator types a bare numeric token or `s-<id>` token, the search matches the server id directly (FMN-160 search-by-ID). The match indexer warms a tenant-wide corpus on first activation and re-uses it across the session.

The feature is opt-in via popup -> Settings ("Replace FortiMonitor's Search Instances"). Toggling off restores FortiMonitor's native search and removes the toolkit DOM. Requires a configured RW API key.

See also:

- [FMN-152 ticket on Plane (omni-search)](https://app.plane.so/myrug/projects/) for design history and operator QA notes.
- [FMN-160 ticket on Plane (search-by-ID)](https://app.plane.so/myrug/projects/).
