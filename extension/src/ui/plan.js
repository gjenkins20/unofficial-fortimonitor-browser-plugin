// Convert operator decisions (one per fingerprint group) into the list of
// queue entries the executor will consume.
//
// Input:
//   groups:   scan-devices output's groups[] — each has { fingerprint, portsData, devices: [{ serverId }] }
//   decisions: Map<fingerprint, { skipped: boolean, removePortNames: string[] }>
//   nameById: Record<serverId, string> (optional display names)
//   batchId:  string
//
// Output: Array<QueueEntry> matching extension/src/background/queue.js's
// JSDoc shape.
//
// The FortiMonitor save_port_selection endpoint expects selectedIndices to
// list every port we want KEPT in scope. So we invert the operator's
// "remove these names" selection into "keep everyone else's indices".

/**
 * @param {object} params
 * @param {Array} params.groups
 * @param {Map<string, {skipped: boolean, removePortNames: string[]}>} params.decisions
 * @param {Record<string, string>} [params.nameById]
 * @param {string} params.batchId
 * @returns {Array<object>}
 */
export function buildQueueEntries({ groups, decisions, nameById = {}, batchId }) {
  if (!Array.isArray(groups)) throw new TypeError('buildQueueEntries: groups must be an array');
  if (!(decisions instanceof Map)) throw new TypeError('buildQueueEntries: decisions must be a Map');
  if (!batchId) throw new TypeError('buildQueueEntries: batchId is required');

  const entries = [];
  for (const group of groups) {
    const decision = decisions.get(group.fingerprint);
    if (!decision || decision.skipped) continue;
    const removeSet = new Set(decision.removePortNames || []);
    if (removeSet.size === 0) continue; // no-op decision; skip

    const ports = group.portsData?.ports ?? [];
    const keptIndices = ports
      .filter((p) => !removeSet.has(p.name))
      .map((p) => String(p.index));
    const searchTerm = group.portsData?.portFilters?.searchTerm ?? '';
    const filters = group.portsData?.portFilters?.filters ?? [];
    const totalPortCount = ports.length;

    for (const device of group.devices) {
      const serverId = device.serverId;
      const deviceName = nameById[String(serverId)] ?? String(serverId);
      entries.push({
        id: `${batchId}:${serverId}`,
        batchId,
        groupId: group.fingerprint,
        serverId,
        deviceName,
        removedPortNames: [...removeSet],
        intendedAction: {
          portSelectionType: 'manual',
          selectedIndices: keptIndices,
          totalPortCount,
          searchTerm,
          filters
        },
        status: 'pending',
        attempts: []
      });
    }
  }
  return entries;
}

/**
 * Summarize a queue-entry list for the queue-overview screen.
 */
export function summarizePlan(entries) {
  const byGroup = new Map();
  let totalPortsToRemove = 0;
  for (const e of entries) {
    if (!byGroup.has(e.groupId)) {
      byGroup.set(e.groupId, {
        groupId: e.groupId,
        removedPortNames: e.removedPortNames,
        devices: []
      });
    }
    byGroup.get(e.groupId).devices.push({ serverId: e.serverId, deviceName: e.deviceName });
    totalPortsToRemove += (e.removedPortNames?.length ?? 0);
  }
  return {
    totalDevices: entries.length,
    totalGroups: byGroup.size,
    totalPortsToRemove,
    groups: [...byGroup.values()]
  };
}
