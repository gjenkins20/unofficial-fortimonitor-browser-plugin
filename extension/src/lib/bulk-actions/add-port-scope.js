// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// FMN-162: Bulk action - Add to Port Scope.
//
// params: { portNames: string[] }  (port names, case-insensitive match)
// target: { id, name, ports?: [{ name, index, isActive }], totalPortCount? }
//
// describe() reads pre-fetched target.ports populated by the Configure
// step (bulk-composer:list-device-ports-batch). commit() recomputes the
// "kept" selectedIndices (existing-active + names we're adding) and
// fires FortimonitorClient.savePortSelection.
//
// Idempotence: ports already in scope are skipped (no change to the
// computed selectedIndices). If none of the named ports exist on this
// device or all are already active, commit returns noop=true.

export const id = 'add-port-scope';
export const label = 'Add to Port Scope';
export const description = 'Add one or more named ports to the monitored port scope on each selected instance. Ports already in scope are skipped.';
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
      next: `+ ${v.value.portNames.join(', ')}`,
      willChange: true,
      note: 'Port list not yet fetched; commit will pre-flight.'
    };
  }
  const wanted = new Set(v.value.portNames.map((n) => n.toLowerCase()));
  const activeNames = ports.filter((p) => p.isActive).map((p) => p.name);
  const willAdd = ports.filter((p) => !p.isActive && wanted.has(String(p.name).toLowerCase()));
  if (willAdd.length === 0) {
    const presentButActive = ports.filter((p) => p.isActive && wanted.has(String(p.name).toLowerCase()));
    const note = presentButActive.length > 0
      ? `All named ports already in scope: ${presentButActive.map((p) => p.name).join(', ')}.`
      : `No matching ports on this instance.`;
    return {
      prev: activeNames.length ? activeNames.join(', ') : '(none)',
      next: activeNames.length ? activeNames.join(', ') : '(none)',
      willChange: false,
      skip: true,
      note
    };
  }
  const addedNames = willAdd.map((p) => p.name);
  return {
    prev: activeNames.length ? activeNames.join(', ') : '(none)',
    next: activeNames.concat(addedNames).join(', '),
    willChange: true,
    note: `Will add ${addedNames.length} port${addedNames.length === 1 ? '' : 's'}: ${addedNames.join(', ')}.`
  };
}

export async function commit(target, params, ctx = {}) {
  const v = validate(params);
  if (!v.ok) throw new Error(v.error);
  const { fortimonitorClient } = ctx;
  if (!fortimonitorClient) throw new Error('FortimonitorClient required for save_port_selection.');

  // Always fetch the latest port list at commit time so we don't write
  // a stale "kept" set after another operator edits scope between
  // Configure and Apply. Cheap: one GET per device.
  const parsed = await fortimonitorClient.getDevicePorts(target.id);
  const ports = Array.isArray(parsed?.ports) ? parsed.ports : [];
  if (ports.length === 0) {
    return { status: 0, noop: true, reason: 'no-ports' };
  }
  const wanted = new Set(v.value.portNames.map((n) => n.toLowerCase()));
  const addCount = ports.filter((p) => !p.isActive && wanted.has(String(p.name).toLowerCase())).length;
  if (addCount === 0) {
    return { status: 0, noop: true, reason: 'already-in-scope' };
  }
  const keptIndices = ports
    .filter((p) => p.isActive || wanted.has(String(p.name).toLowerCase()))
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
    addedCount: addCount,
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
