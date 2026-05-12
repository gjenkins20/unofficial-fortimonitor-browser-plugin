# IP / DNS Columns on Instances List (FMN-153)

Adds two sub-columns to the Instance cell on `/report/ListServers`: IP Address and DNS Name. Values come from each server's primary `fqdn` (from `/report/get_idp_data?server_id={id}`). The classifier walks the full `pageData.instance.fqdns[]` array and types each entry locally (`IPV4_RE`, `IPV6_HINT_RE`, `HOSTNAME_RE`) - FortiMonitor's `ipTypes` hint is unreliable (e.g. the literal string "server" arrives tagged `ipTypes: "v4"`).

Per-row fetches are concurrency-capped at 3 and cached in-memory for the session.

The sub-columns share the Instance cell's grid (FMN-71 pattern), so DataTables continues to see one cell and pagination + native sort keep working.

See also:

- [`docs/api-discovery/server-metadata.md`](../api-discovery/server-metadata.md)
- [FMN-153 ticket on Plane](https://app.plane.so/myrug/projects/).
