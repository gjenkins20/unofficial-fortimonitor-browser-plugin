#!/bin/sh
# Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
#
# Custom metric data source: number of active SSH login sessions on this
# OnSight appliance, reported as a single integer on stdout.
#
# Suggested deployment path: /usr/local/bin/fmn-active-ssh-sessions.sh
# (any path FortiMonitor's custom-metric script-runner can read is fine -
# this one is conventional and outside /tmp).
#
# Permissions: chmod 755. No setuid required; `who` is world-readable on
# every distro shipped on a current OnSight appliance.
#
# Output contract: exactly one line, exactly one non-negative integer.
# FortiMonitor's script-runner parses stdout as the metric value;
# anything else (extra lines, decimal points, leading whitespace)
# either rejects the sample or skews it.

# `who` enumerates active login sessions. Counting non-empty lines yields
# the SSH session count, plus any local-console sessions if present (the
# appliance has none in steady state, so the count tracks SSH cleanly).
count=$(who | grep -c .)

# Defense in depth: if `who` returned nothing or an unexpected value,
# emit 0 rather than an empty string so FortiMonitor records a clean
# sample instead of rejecting it.
case "$count" in
  ''|*[!0-9]*) count=0 ;;
esac

printf '%s\n' "$count"
