// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// FMN-162: Bulk action - Remove from Port Scope.
//
// params: { portNames: string[] }  (port names, case-insensitive match)
// target: { id, name, ports?: [{ name, index, isActive }], totalPortCount? }
//
// describe() reads pre-fetched target.ports populated by the Configure
// step (bulk-composer:list-device-ports-batch). commit() recomputes the
// "kept" selectedIndices (existing-active minus names we're removing)
// and fires FortimonitorClient.savePortSelection.
//
// Idempotence: ports already out of scope (or not present on this
// device) are skipped. If none of the named ports are currently active,
// commit returns noop=true.

export const id = 'remove-port-scope';
export const label = 'Remove from Port Scope';
export const description = 'Remove one or more named ports from the monitored port scope on each selected instance. Ports already out of scope are skipped.';
export const requires = 'session';
export const writeMethod = 'POST /config/save_port_selection';

export function validate(params = {}) {
  const names = parsePortNames(params?.portNames);
  if (names.length === 0) {
    return { ok: false, error: 'At least one port name is required.' };
  }
  return { ok: true, value: { portNames: names } };
}

export function describe(target, params) {
  const v = validate(params);
  if (!v.ok) return { prev: '-', next: '-', willChange: false, error: v.error };
  const ports = Array.isArray(target?.ports) ? target.ports : null;
  if (ports === null) {
    return {
      prev: '(ports unknown)',
      next: `− ${v.value.portNames.join(', ')}`,
      willChange: true,
      note: 'Port list not yet fetched; commit will pre-flight.'
    };
  }
  const wanted = new Set(v.value.portNames.map((n) => n.toLowerCase()));
  const activePorts = ports.filter((p) => p.isActive);
  const willRemove = activePorts.filter((p) => wanted.has(String(p.name).toLowerCase()));
  if (willRemove.length === 0) {
    return {
      prev: activePorts.length ? activePorts.map((p) => p.name).join(', ') : '(none)',
      next: activePorts.length ? activePorts.map((p) => p.name).join(', ') : '(none)',
      willChange: false,
      skip: true,
      note: 'No matching ports currently in scope.'
    };
  }
  const removedNameSet = new Set(willRemove.map((p) => p.name));
  const remaining = activePorts.filter((p) => !removedNameSet.has(p.name)).map((p) => p.name);
  return {
    prev: activePorts.map((p) => p.name).join(', '),
    next: remaining.length ? remaining.join(', ') : '(none)',
    willChange: true,
    note: `Will remove ${willRemove.length} port${willRemove.length === 1 ? '' : 's'}: ${willRemove.map((p) => p.name).join(', ')}.`
  };
}

export async function commit(target, params, ctx = {}) {
  const v = validate(params);
  if (!v.ok) throw new Error(v.error);
  const { fortimonitorClient } = ctx;
  if (!fortimonitorClient) throw new Error('FortimonitorClient required for save_port_selection.');

  const parsed = await fortimonitorClient.getDevicePorts(target.id);
  const ports = Array.isArray(parsed?.ports) ? parsed.ports : [];
  if (ports.length === 0) {
    return { status: 0, noop: true, reason: 'no-ports' };
  }
  const wanted = new Set(v.value.portNames.map((n) => n.toLowerCase()));
  const removeCount = ports.filter((p) => p.isActive && wanted.has(String(p.name).toLowerCase())).length;
  if (removeCount === 0) {
    return { status: 0, noop: true, reason: 'not-in-scope' };
  }
  const keptIndices = ports
    .filter((p) => p.isActive && !wanted.has(String(p.name).toLowerCase()))
    .map((p) => String(p.index));
  const result = await fortimonitorClient.savePortSelection({
    serverId: target.id,
    portSelectionType: 'manual',
    selectedIndices: keptIndices,
    totalPortCount: ports.length,
    searchTerm: parsed?.portFilters?.searchTerm ?? '',
    filters: parsed?.portFilters?.filters ?? []
  });
  return {
    status: 200,
    noop: false,
    removedCount: removeCount,
    portScope: {
      kept: keptIndices.length,
      total: ports.length
    },
    success: result?.success === true
  };
}

function parsePortNames(raw) {
  if (Array.isArray(raw)) {
    return raw.map((s) => String(s ?? '').trim()).filter(Boolean);
  }
  if (typeof raw === 'string') {
    return raw.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
  }
  return [];
}
