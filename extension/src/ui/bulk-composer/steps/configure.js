// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// FMN-155: Step 3 - action-specific configuration form.
//
// Add Tag / Remove Tag: a single tag-string text input.
// Apply Template:       a template-name dropdown (fetched once via
//                       bulk-composer:list-templates) plus a
//                       "continuous=true" toggle.

import { h, titleBar } from '../../../lib/dom.js';
import { bulkBreadcrumbs } from './breadcrumbs.js';
import { getAction } from '../../../lib/bulk-actions/index.js';
import { buildFabricProfile } from '../../../lib/fabric-profile.js';
import { buildRecommendations } from '../../../lib/recommendation-engine.js';
import { buildTemplateClusters } from '../../../lib/template-clusterer.js';

const STOCK_GROUP_NAME = 'Default Monitoring Templates';

const TOOL_NAME = 'Bulk Action Composer';

export function render({ container, store, navigate, call }) {
  const frame = h('div', { class: 'mockup-frame' });
  frame.appendChild(titleBar('Configure', { toolName: TOOL_NAME }));

  const action = getAction(store.actionId);
  frame.appendChild(h('div', { class: 'step-header' },
    bulkBreadcrumbs('configure'),
    h('h2', {}, `Configure: ${action?.label ?? '(unknown)'}`),
    h('p', {}, action?.description ?? '')
  ));

  const body = h('div', { class: 'body-section' });
  frame.appendChild(body);

  const backBtn = h('button', { class: 'btn btn-secondary', type: 'button' }, '← Back');
  const nextBtn = h('button', {
    class: 'btn btn-primary',
    'data-test': 'configure-next',
    type: 'button',
    disabled: true
  }, 'Preview & commit →');
  const stateLabel = h('span', { class: 'execute-state muted', 'data-test': 'configure-state' }, `${store.targets.length} instance${store.targets.length === 1 ? '' : 's'} selected.`);
  const actionBar = h('div', { class: 'action-bar' },
    h('div', { class: 'left' }, stateLabel),
    h('div', { class: 'right' }, backBtn, nextBtn)
  );

  function refreshNextDisabled() {
    const params = store.params || {};
    if (store.actionId === 'add-tag' || store.actionId === 'remove-tag') {
      nextBtn.disabled = !(typeof params.tag === 'string' && params.tag.trim().length > 0);
    } else if (store.actionId === 'apply-template') {
      nextBtn.disabled = !(typeof params.templateUrl === 'string' && params.templateUrl.trim().length > 0);
    } else if (store.actionId === 'apply-stock-fabric-templates') {
      const recs = Array.isArray(params.recommendations) ? params.recommendations : [];
      const optedIn = recs.filter((r) => r && r.opted_in === true && r.chosen_template);
      nextBtn.disabled = optedIn.length === 0;
    } else if (store.actionId === 'profile-and-create-templates') {
      const clusters = Array.isArray(params.clusters) ? params.clusters : [];
      const optedIn = clusters.filter((c) => c && c.opted_in === true);
      const destGroup = String(params.destination_group ?? '').trim();
      const newGroupName = String(params.destination_group_create_name ?? '').trim();
      // Exactly one must be set (matches action.validate()).
      const destOk = (destGroup !== '' && newGroupName === '')
        || (destGroup === '' && newGroupName !== '');
      nextBtn.disabled = optedIn.length === 0 || !destOk;
    } else {
      nextBtn.disabled = true;
    }
  }

  if (store.actionId === 'add-tag' || store.actionId === 'remove-tag') {
    renderTagForm({ body, store, refreshNextDisabled, call });
  } else if (store.actionId === 'apply-template') {
    renderTemplateForm({ body, store, refreshNextDisabled, call, stateLabel });
  } else if (store.actionId === 'apply-stock-fabric-templates') {
    renderBestPracticeFabricForm({ body, store, refreshNextDisabled, call, stateLabel });
  } else if (store.actionId === 'profile-and-create-templates') {
    renderProfileAndCreateTemplatesForm({ body, store, refreshNextDisabled, call, stateLabel });
  } else {
    body.appendChild(h('p', {}, 'Unknown action; pick again on the previous step.'));
  }

  frame.appendChild(actionBar);
  container.appendChild(frame);

  backBtn.addEventListener('click', () => navigate('/action'));
  nextBtn.addEventListener('click', () => {
    if (nextBtn.disabled) return;
    navigate('/commit');
  });

  refreshNextDisabled();
}

function renderTagForm({ body, store, refreshNextDisabled, call }) {
  body.appendChild(h('h3', { class: 'subhead' }, 'Tag'));

  // FMN-155 / FMN-206: for remove-tag, surface the union of tags found
  // across the selected instances as clickable chips. The chip row is
  // mounted as a placeholder and filled async after fetching tags - the
  // pick step only stamps { id, name } onto store.targets, so the tag
  // list has to be looked up here. Cache-first (omni-search), v2 GET
  // fallback for IDs the cache doesn't know about. Manual input renders
  // immediately so the form is usable while the lookup runs.
  const isRemove = store.actionId === 'remove-tag';

  // Highlight gets set when chips actually render; staying null in the
  // empty / loading paths is fine.
  let highlight = null;

  // Stable mount point for the chip block (header + row OR empty-state
  // copy). Rendered before manual input so the visual order is consistent
  // regardless of lookup outcome.
  const chipMount = isRemove
    ? h('div', { 'data-test': 'configure-chip-mount' })
    : null;
  if (isRemove) {
    chipMount.appendChild(h('p', {
      'data-test': 'configure-tags-loading',
      class: 'muted',
      style: 'font-size:0.85rem;color:var(--text-muted);margin:0 0 0.5rem;'
    }, 'Loading existing tags...'));
    body.appendChild(chipMount);
    body.appendChild(h('h4', {
      style: 'font-size:0.9rem;margin:0.6rem 0 0.3rem;font-weight:600;'
    }, 'Or enter a tag manually'));
  }

  const input = h('input', {
    type: 'text',
    class: 'paste-area',
    'data-test': 'configure-tag-input',
    placeholder: isRemove ? 'Tag to remove' : 'e.g. needs-review',
    style: 'min-height:0;height:auto;padding:0.5rem 0.7rem;font-family:inherit;'
  });
  input.value = store.params?.tag ?? '';
  body.appendChild(input);
  body.appendChild(h('p', { class: 'muted', style: 'font-size:0.85rem;margin-top:0.4rem;color:var(--text-muted);' },
    isRemove
      ? 'The tag is removed from each instance\'s existing tag list (idempotent: instances without the tag are skipped).'
      : 'The tag is added to each instance\'s existing tag list (idempotent: already-tagged instances are skipped).'
  ));
  input.addEventListener('input', () => {
    store.params = { ...store.params, tag: input.value };
    if (typeof highlight === 'function') highlight();
    refreshNextDisabled();
  });

  // FMN-207: live-fetch tags for BOTH actions, not just remove-tag. The
  // Preview step's describe() needs target.tags populated to compute
  // willChange / skip correctly - without it, Add Tag would mis-classify
  // every row as "instance not found; will skip". Chip row only renders
  // on remove-tag (chipMount === null for add-tag short-circuits the
  // chip render).
  void fetchAndRenderTagChips({
    chipMount,
    store,
    input,
    call,
    refreshNextDisabled,
    onHighlightReady: (fn) => { highlight = fn; }
  });
}

// FMN-206: enrich store.targets with tags via a live GET /server/{id}
// per picked target, then render the chip row. The earlier attempt used
// the omni-search cache as a fast path with the live batch as fallback,
// but the cache went rapidly stale between bulk operations - PREV
// columns in the Preview step showed tags that had been removed by an
// earlier run, leading to "WILL CHANGE" rows that no-op'd at commit
// time. Always-live keeps the preview honest. Cost: one GET per target
// at chip-fetch time, bounded by the SW handler's concurrency cap.
async function fetchAndRenderTagChips({ chipMount, store, input, call, refreshNextDisabled, onHighlightReady }) {
  const targets = Array.isArray(store.targets) ? store.targets : [];
  const ids = targets.map((t) => t?.id).filter((id) => Number.isFinite(id));

  let liveMap = {};
  if (ids.length > 0) {
    try {
      const res = await call('bulk-composer:list-tags-batch', { serverIds: ids });
      liveMap = (res && res.byServerId) || {};
    } catch {
      // Live fetch failed (no API key, network down). Targets stay
      // without tags and the chip row falls through to the empty state;
      // manual tag entry still works.
    }
  }

  // FMN-207: assign tags=null for IDs the live fetch could not resolve
  // (chip-fetch handler returned null for them). describe() relies on
  // this to mark the row as "instance not found; will skip" instead of
  // "(tags unknown)" / "will change". Array hits land as the tag list.
  for (const t of targets) {
    if (!t || t.id == null) continue;
    const tags = liveMap[t.id];
    if (Array.isArray(tags)) t.tags = tags.slice();
    else if (Object.prototype.hasOwnProperty.call(liveMap, t.id)) t.tags = null;
  }

  // Only the remove-tag flow has a chip row to render. add-tag still
  // benefits from the tag enrichment above (drives describe() accuracy)
  // but doesn't have anywhere to show chips.
  if (chipMount) {
    renderTagChipRow({ chipMount, store, input, refreshNextDisabled, onHighlightReady });
  }
}

// Replaces the loading-placeholder inside chipMount with either the chip
// row (when at least one tag was found) or the empty-state copy.
function renderTagChipRow({ chipMount, store, input, refreshNextDisabled, onHighlightReady }) {
  while (chipMount.firstChild) chipMount.removeChild(chipMount.firstChild);

  const tagCounts = new Map();
  for (const t of (store.targets || [])) {
    if (!Array.isArray(t.tags)) continue;
    for (const tag of t.tags) {
      if (!tag) continue;
      tagCounts.set(tag, (tagCounts.get(tag) || 0) + 1);
    }
  }
  const sortedTags = Array.from(tagCounts.entries())
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));

  if (sortedTags.length === 0) {
    chipMount.appendChild(h('p', {
      class: 'muted',
      style: 'font-size:0.85rem;color:var(--text-muted);margin:0 0 0.5rem;'
    }, 'No tags found on the selected instances. Enter a tag manually below.'));
    return;
  }

  chipMount.appendChild(h('h4', {
    style: 'font-size:0.9rem;margin:0.2rem 0 0.5rem;font-weight:600;'
  }, 'Tags found across selected instances'));

  const chipRow = h('div', {
    'data-test': 'configure-existing-tags',
    style: 'display:flex;flex-wrap:wrap;gap:0.35rem;margin-bottom:0.5rem;'
  });
  const chipFor = new Map();
  const highlight = () => {
    const current = (store.params?.tag ?? '').trim();
    for (const [tag, chip] of chipFor) {
      const active = tag === current;
      chip.style.background = active ? '#d0e5ff' : '#eef2f7';
      chip.style.borderColor = active ? '#1f6feb' : '#c4c8cf';
      chip.style.fontWeight = active ? '600' : '400';
    }
  };

  for (const [tag, count] of sortedTags) {
    const chip = h('button', {
      type: 'button',
      class: 'chip-pickable',
      'data-test': 'existing-tag-chip',
      'data-tag': tag,
      style: 'background:#eef2f7;border:1px solid #c4c8cf;border-radius:12px;padding:0.18rem 0.55rem;font-size:0.85rem;cursor:pointer;display:inline-flex;align-items:center;gap:0.3rem;'
    },
      h('span', {}, tag),
      h('span', {
        style: 'opacity:0.55;font-size:0.75rem;'
      }, `×${count}`)
    );
    chip.addEventListener('click', () => {
      store.params = { ...store.params, tag };
      input.value = tag;
      highlight();
      refreshNextDisabled();
    });
    chipRow.appendChild(chip);
    chipFor.set(tag, chip);
  }
  chipMount.appendChild(chipRow);

  if (typeof onHighlightReady === 'function') onHighlightReady(highlight);
  highlight();
}

function renderTemplateForm({ body, store, refreshNextDisabled, call, stateLabel }) {
  body.appendChild(h('h3', { class: 'subhead' }, 'Template'));
  const select = h('select', {
    class: 'select',
    'data-test': 'configure-template-select',
    style: 'width:100%;padding:0.5rem 0.7rem;font-family:inherit;border:1px solid var(--border-strong);border-radius:4px;'
  });
  select.appendChild(h('option', { value: '' }, 'Loading templates...'));
  select.disabled = true;
  body.appendChild(select);

  const continuousChk = h('input', { type: 'checkbox', 'data-test': 'configure-continuous', checked: store.params?.continuous !== false });
  body.appendChild(h('label', { style: 'display:flex;gap:0.4rem;align-items:center;margin-top:0.6rem;font-size:0.9rem;' },
    continuousChk,
    h('span', {}, 'Continuous (template keeps adding new metrics as discovery runs - matches FortiMonitor UI default)')
  ));

  body.appendChild(h('p', { class: 'muted', style: 'font-size:0.85rem;margin-top:0.4rem;color:var(--text-muted);' },
    'Instances that already have the chosen template attached are skipped at commit time (pre-flight check).'
  ));

  (async () => {
    try {
      const templates = await call('bulk-composer:list-templates', {});
      while (select.firstChild) select.removeChild(select.firstChild);
      select.appendChild(h('option', { value: '' }, `- choose template (${templates.length}) -`));
      for (const t of templates) {
        const opt = h('option', { value: t.resourceUrl }, t.name);
        opt.dataset.templateId = String(t.id ?? '');
        opt.dataset.templateName = t.name;
        select.appendChild(opt);
      }
      select.disabled = false;
      if (store.params?.templateUrl) select.value = store.params.templateUrl;
      refreshNextDisabled();
    } catch (err) {
      while (select.firstChild) select.removeChild(select.firstChild);
      select.appendChild(h('option', { value: '' }, `Error loading templates: ${err?.message ?? err}`));
      stateLabel.textContent = 'Could not load templates - check API key in Settings.';
      stateLabel.className = 'execute-state error';
    }
  })();

  select.addEventListener('change', () => {
    const opt = select.options[select.selectedIndex];
    store.params = {
      ...store.params,
      templateUrl: select.value,
      templateId: opt && opt.dataset.templateId ? Number(opt.dataset.templateId) : null,
      templateName: opt && opt.dataset.templateName ? opt.dataset.templateName : null,
      continuous: continuousChk.checked
    };
    refreshNextDisabled();
  });
  continuousChk.addEventListener('change', () => {
    store.params = { ...store.params, continuous: continuousChk.checked };
  });
}

// =====================================================================
// FMN-196: Apply Stock Fabric Templates
// =====================================================================
//
// Configure step UI for the Stock Fabric Templates action. Fetches three
// inputs from the SW in parallel:
//   - fabricSystemData for each picked device (idp_data batch)
//   - FortiMonitor's live nounOptions + existing rulesets (for clauses
//     + idempotence-by-name)
//   - tenant's templates with their server_group_name (to partition
//     stock vs customer per FMN-135 finding)
// Runs the FMN-195 modules (buildFabricProfile + buildRecommendations)
// against those inputs and renders a per-profile table the operator
// opts in/out of. Emits a commit-plan to store.params.

function renderBestPracticeFabricForm({ body, store, refreshNextDisabled, call, stateLabel }) {
  body.appendChild(h('h3', { class: 'subhead' }, 'Stock Fabric Templates'));

  // Dry-run toggle. Default off; operator opts in for preview.
  const dryRunChk = h('input', {
    type: 'checkbox',
    'data-test': 'configure-bpf-dry-run',
    checked: store.params?.dry_run === true
  });
  body.appendChild(h('label', {
    style: 'display:flex;gap:0.4rem;align-items:center;margin:0.2rem 0 0.8rem;font-size:0.9rem;'
  },
    dryRunChk,
    h('span', {}, 'Dry run (preview without writing - no policies created, no templates attached)')
  ));

  const status = h('p', {
    class: 'muted',
    style: 'font-size:0.85rem;color:var(--text-muted);margin:0.2rem 0 0.8rem;'
  }, 'Fetching device details, vocabulary, and tenant templates...');
  body.appendChild(status);

  const tableHost = h('div', { 'data-test': 'configure-bpf-table-host', style: 'margin-top:0.5rem;' });
  body.appendChild(tableHost);

  const unmatchedNote = h('p', {
    'data-test': 'configure-bpf-unmatched',
    class: 'muted',
    style: 'font-size:0.85rem;color:var(--text-muted);margin-top:0.6rem;display:none;'
  });
  body.appendChild(unmatchedNote);

  dryRunChk.addEventListener('change', () => {
    store.params = { ...(store.params || {}), dry_run: dryRunChk.checked };
  });

  (async () => {
    const targets = Array.isArray(store.targets) ? store.targets : [];
    const serverIds = targets.map((t) => t.id).filter((id) => id != null);

    let fsd, vocab, templates;
    try {
      [fsd, vocab, templates] = await Promise.all([
        call('bulk-composer:list-fabric-system-data', { serverIds }),
        call('bulk-composer:list-monitoring-policy-vocab', {}),
        call('bulk-composer:list-templates-with-groups', {})
      ]);
    } catch (err) {
      status.textContent = `Could not load data: ${err?.message ?? err}`;
      status.className = 'execute-state error';
      stateLabel.textContent = 'Configure failed - see error above.';
      stateLabel.className = 'execute-state error';
      return;
    }

    // Build profile from picked targets + fetched fabricSystemData.
    const fsdMap = (fsd && fsd.byServerId) || {};
    const profile = buildFabricProfile(targets, fsdMap);

    // Partition templates into stock vs customer by server_group_name.
    const allTemplates = Array.isArray(templates?.templates) ? templates.templates : [];
    const existingTemplates = allTemplates.filter((t) => t.server_group_name !== STOCK_GROUP_NAME);
    const stockTemplates = allTemplates.filter((t) => t.server_group_name === STOCK_GROUP_NAME);

    // Run the recommendation engine.
    const { recommendations } = buildRecommendations(profile, {
      existingTemplates,
      stockTemplates,
      nounOptions: vocab?.nounOptions ?? {}
    });

    // Cross-reference existing rulesets to mark "policy already exists"
    // per recommendation. Idempotence-by-name; sub #3 commit step uses
    // the same check on the SW side.
    const existingRulesetNames = new Set(
      (Array.isArray(vocab?.rulesets) ? vocab.rulesets : []).map((r) => r?.name).filter(Boolean)
    );

    // Decorate each recommendation with opted_in (default: true when
    // chosen_template exists and false otherwise) + policy-exists flag.
    const decorated = recommendations.map((r) => ({
      ...r,
      opted_in: !!r.chosen_template,
      policy_already_exists: existingRulesetNames.has(r.policy_proposal?.name)
    }));

    // Persist to store.params so commit step can read it.
    store.params = {
      ...(store.params || {}),
      dry_run: dryRunChk.checked,
      recommendations: decorated
    };

    // Surface unclassified count if any.
    if (profile.unclassified.length > 0) {
      unmatchedNote.style.display = 'block';
      unmatchedNote.textContent = `${profile.unclassified.length} of ${targets.length} picked instance(s) lack Fabric metadata (non-Fortinet or pre-fetch). They will not be touched.`;
    }

    if (decorated.length === 0) {
      status.textContent = 'No Fabric-onboarded instances detected in the selection. Pick at least one FortiGate / FortiSwitch / FortiAP / etc.';
      status.className = 'execute-state warning';
      refreshNextDisabled();
      return;
    }

    status.textContent = `Found ${decorated.length} distinct (Make, Model) profile${decorated.length === 1 ? '' : 's'} across the selection. Opt in/out per row, then preview & commit.`;

    renderProfileTable({
      host: tableHost,
      recommendations: decorated,
      onToggle: (idx, opted) => {
        const recs = store.params.recommendations.slice();
        recs[idx] = { ...recs[idx], opted_in: opted };
        store.params = { ...store.params, recommendations: recs };
        refreshNextDisabled();
      }
    });

    refreshNextDisabled();
  })();
}

function renderProfileTable({ host, recommendations, onToggle }) {
  while (host.firstChild) host.removeChild(host.firstChild);

  const table = h('table', {
    'data-test': 'configure-bpf-table',
    style: 'width:100%;border-collapse:collapse;margin-top:0.3rem;font-size:0.88rem;'
  });
  const thead = h('thead', {}, h('tr', {
    style: 'background:#f4f6f8;border-bottom:1px solid var(--border-strong);'
  },
    th(''), th('Make'), th('Model'), th('Devices'),
    th('Recommended template'), th('Source'),
    th('Policy'), th('Status')
  ));
  table.appendChild(thead);

  const tbody = h('tbody', {});
  for (const [idx, r] of recommendations.entries()) {
    const hasTemplate = !!r.chosen_template;
    const tr = h('tr', {
      'data-test': 'configure-bpf-row',
      'data-profile-key': r.profile_key,
      style: 'border-bottom:1px solid var(--border-weak);'
    });

    const optChk = h('input', {
      type: 'checkbox',
      'data-test': 'configure-bpf-opt-in',
      checked: r.opted_in === true,
      disabled: !hasTemplate
    });
    optChk.addEventListener('change', () => onToggle(idx, optChk.checked));
    tr.appendChild(td(optChk));

    tr.appendChild(td(r.make || '-'));
    tr.appendChild(td(r.model || '-'));
    tr.appendChild(td(String(r.applies_to_server_ids.length)));
    tr.appendChild(td(hasTemplate ? r.chosen_template.name : h('span', { class: 'muted' }, 'No matching template found')));
    tr.appendChild(td(hasTemplate ? sourceBadge(r.chosen_template.source) : h('span', { class: 'muted' }, '-')));
    tr.appendChild(td(hasTemplate
      ? h('span', {}, r.policy_proposal?.name ?? '(no policy)',
          r.policy_already_exists
            ? h('span', { class: 'pill', style: 'margin-left:0.4rem;font-size:0.75rem;background:#d4edda;color:#155724;padding:0.05rem 0.4rem;border-radius:8px;' }, 'exists')
            : null)
      : h('span', { class: 'muted' }, '-')));
    tr.appendChild(td(statusCell(r)));

    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  host.appendChild(table);
}

function th(text) {
  return h('th', {
    style: 'text-align:left;padding:0.35rem 0.5rem;font-weight:600;font-size:0.82rem;'
  }, text);
}

function td(content) {
  return h('td', {
    style: 'padding:0.35rem 0.5rem;vertical-align:middle;'
  }, content);
}

function sourceBadge(source) {
  const COPY = {
    'existing-model-specific': { label: 'existing (model)', bg: '#d4edda', fg: '#155724' },
    'existing-family': { label: 'existing (family)', bg: '#d1ecf1', fg: '#0c5460' },
    'stock-model-specific': { label: 'stock (model)', bg: '#fff3cd', fg: '#856404' },
    'stock-family': { label: 'stock (family)', bg: '#fff3cd', fg: '#856404' }
  };
  const c = COPY[source] || { label: source, bg: '#e9ecef', fg: '#495057' };
  return h('span', {
    class: 'pill',
    style: `background:${c.bg};color:${c.fg};padding:0.05rem 0.4rem;border-radius:8px;font-size:0.75rem;`
  }, c.label);
}

function statusCell(r) {
  if (!r.chosen_template) {
    return h('span', { class: 'muted', style: 'color:#856404;' }, 'skip');
  }
  if (r.policy_already_exists) {
    return h('span', {}, 'policy reused');
  }
  return h('span', {}, 'will create policy');
}

// =====================================================================
// FMN-200: Profile + Create Templates from similar devices
// =====================================================================
//
// On mount, fetches each picked device's fabricSystemData,
// monitoring_config, and (for FortiGates) port_scope. Clusters them via
// buildTemplateClusters; renders per-cluster rows with opt-in checkbox,
// editable template name, and an optional clone-from-device toggle.
// Emits the action's params shape to store.params on every change.

function renderProfileAndCreateTemplatesForm({ body, store, refreshNextDisabled, call, stateLabel }) {
  body.appendChild(h('h3', { class: 'subhead' }, 'Profile + Create Templates'));

  // Destination group: dropdown of existing groups + "+ Add new group..."
  // option that reveals a name input.
  const SENTINEL_NEW = '__new__';
  const destSelect = h('select', {
    'data-test': 'configure-pact-destination-group',
    style: 'width:100%;padding:0.4rem 0.55rem;font-family:inherit;border:1px solid var(--border-strong);border-radius:4px;'
  });
  destSelect.disabled = true;
  destSelect.appendChild(h('option', { value: '' }, 'Loading server groups...'));
  body.appendChild(h('label', {
    style: 'display:flex;flex-direction:column;gap:0.2rem;margin:0.4rem 0;font-size:0.9rem;'
  },
    h('span', {}, 'Destination server group (where new templates live)'),
    destSelect
  ));

  // Name input for the "+ Add new group..." path. Hidden until that
  // option is selected.
  const newGroupInput = h('input', {
    type: 'text',
    'data-test': 'configure-pact-new-group-name',
    placeholder: 'New group name (e.g. "FM Toolkit Templates")',
    style: 'width:100%;padding:0.4rem 0.55rem;font-family:inherit;border:1px solid var(--border-strong);border-radius:4px;margin-bottom:0.4rem;'
  });
  const newGroupWrapper = h('div', {
    'data-test': 'configure-pact-new-group-wrapper',
    style: 'display:none;margin:0.2rem 0 0.4rem;'
  },
    h('p', {
      class: 'muted',
      style: 'font-size:0.82rem;color:var(--text-muted);margin:0 0 0.25rem;'
    }, 'A new server group will be created on commit (or referenced if it already exists).'),
    newGroupInput
  );
  body.appendChild(newGroupWrapper);

  const dryRunChk = h('input', {
    type: 'checkbox',
    'data-test': 'configure-pact-dry-run',
    checked: store.params?.dry_run === true
  });
  body.appendChild(h('label', {
    style: 'display:flex;gap:0.4rem;align-items:center;margin:0.2rem 0 0.8rem;font-size:0.9rem;'
  },
    dryRunChk,
    h('span', {}, 'Dry run (preview without writing - no templates created, no metrics added, no attaches)')
  ));

  // FMN-209: similarity threshold slider. Lower threshold = more
  // devices merge into the same cluster. 1.0 = exact match (original
  // FMN-200 behavior); 0.8 (default) merges near-identical configs.
  const initialThreshold = typeof store.params?.cluster_threshold === 'number'
    ? store.params.cluster_threshold
    : 0.8;
  const thresholdSlider = h('input', {
    type: 'range',
    min: '0.5',
    max: '1.0',
    step: '0.05',
    value: String(initialThreshold),
    'data-test': 'configure-pact-threshold',
    style: 'flex:1;min-width:160px;'
  });
  const thresholdReadout = h('span', {
    'data-test': 'configure-pact-threshold-readout',
    style: 'font-variant-numeric:tabular-nums;min-width:3rem;text-align:right;font-size:0.85rem;'
  }, formatThreshold(initialThreshold));
  body.appendChild(h('label', {
    style: 'display:flex;align-items:center;gap:0.6rem;margin:0.2rem 0 0.8rem;font-size:0.9rem;'
  },
    h('span', { style: 'min-width:11rem;' }, 'Similarity threshold'),
    thresholdSlider,
    thresholdReadout
  ));
  body.appendChild(h('p', {
    class: 'muted',
    style: 'font-size:0.8rem;color:var(--text-muted);margin:-0.4rem 0 0.6rem 11.6rem;'
  },
    'Lower = group more loosely. 1.0 only merges identical configs; the default 0.8 tolerates small differences. ',
    'Each cluster\'s proposed template covers the ',
    h('strong', {}, 'union'),
    ' of resources across its devices, so a broader cluster yields a more complete template.'
  ));

  const status = h('p', {
    class: 'muted',
    style: 'font-size:0.85rem;color:var(--text-muted);margin:0.2rem 0 0.8rem;'
  }, 'Fetching device details, monitoring configs, port scopes, and server groups...');
  body.appendChild(status);

  const downloadBtn = h('button', {
    type: 'button',
    'data-test': 'configure-pact-download-report',
    style: 'margin-top:0.4rem;padding:0.35rem 0.7rem;font-size:0.85rem;border:1px solid var(--border-strong);background:#fff;border-radius:3px;cursor:pointer;'
  }, 'Download report (CSV)');
  downloadBtn.disabled = true;
  const downloadPdfBtn = h('button', {
    type: 'button',
    'data-test': 'configure-pact-download-report-pdf',
    style: 'margin-top:0.4rem;margin-left:0.4rem;padding:0.35rem 0.7rem;font-size:0.85rem;border:1px solid var(--border-strong);background:#fff;border-radius:3px;cursor:pointer;'
  }, 'Download report (PDF)');
  downloadPdfBtn.disabled = true;
  body.appendChild(h('div', {}, downloadBtn, downloadPdfBtn));

  const tableHost = h('div', { 'data-test': 'configure-pact-table-host', style: 'margin-top:0.5rem;' });
  body.appendChild(tableHost);

  const unmatchedNote = h('p', {
    'data-test': 'configure-pact-unmatched',
    class: 'muted',
    style: 'font-size:0.85rem;color:var(--text-muted);margin-top:0.6rem;display:none;'
  });
  body.appendChild(unmatchedNote);

  // Hoisted so the threshold slider and download button can read them
  // after the initial async fetch resolves.
  let lastDevices = [];
  let lastUnclassified = [];
  let lastTargets = [];

  function emit() {
    const isNew = destSelect.value === SENTINEL_NEW;
    store.params = {
      ...(store.params || {}),
      dry_run: dryRunChk.checked,
      destination_group: isNew ? '' : (destSelect.value || ''),
      destination_group_create_name: isNew ? newGroupInput.value.trim() : '',
      template_type: 'fabric_template'
    };
    refreshNextDisabled();
  }

  destSelect.addEventListener('change', () => {
    newGroupWrapper.style.display = destSelect.value === SENTINEL_NEW ? 'block' : 'none';
    emit();
  });
  newGroupInput.addEventListener('input', emit);
  dryRunChk.addEventListener('change', emit);

  (async () => {
    const targets = Array.isArray(store.targets) ? store.targets : [];
    const serverIds = targets.map((t) => t.id).filter((id) => id != null);

    let fsd, monitoringConfig, portScope, groups;
    try {
      // FMN-211 Phase A discovery (2026-05-13): /onboarding/getDevicePorts
      // returns useful port data on non-FortiGate Fabric devices too
      // (verified in FortiAP + FortiSwitch HARs - both returned populated
      // ports[] with admin_status/oper_status/template attachments per
      // port). Previous FortiGate-only gate dropped useful data. Run
      // port-scope batch for ALL ids; the SW handler already swallows
      // errors on devices that don't support the endpoint and returns
      // null per id.
      [fsd, monitoringConfig, portScope, groups] = await Promise.all([
        call('bulk-composer:list-fabric-system-data', { serverIds }),
        call('bulk-composer:list-monitoring-config-batch', { serverIds }),
        call('bulk-composer:list-port-scope-batch', { serverIds }),
        call('bulk-composer:list-server-groups', {})
      ]);
    } catch (err) {
      status.textContent = `Could not load data: ${err?.message ?? err}`;
      status.className = 'execute-state error';
      stateLabel.textContent = 'Configure failed - see error above.';
      stateLabel.className = 'execute-state error';
      return;
    }

    // Populate the server-group dropdown.
    while (destSelect.firstChild) destSelect.removeChild(destSelect.firstChild);
    const groupList = Array.isArray(groups?.groups) ? groups.groups : [];
    destSelect.appendChild(h('option', { value: '' }, `- pick a destination server group (${groupList.length} available) -`));
    destSelect.appendChild(h('option', { value: SENTINEL_NEW }, '+ Add new group...'));
    for (const g of groupList) {
      if (g?.id == null) continue;
      destSelect.appendChild(h('option', { value: `grp-${g.id}` }, g.name || `(unnamed #${g.id})`));
    }
    destSelect.disabled = false;
    // Restore prior selection if present.
    const prior = store.params?.destination_group;
    if (prior && [...destSelect.options].some((o) => o.value === prior)) {
      destSelect.value = prior;
    } else if (store.params?.destination_group_create_name) {
      destSelect.value = SENTINEL_NEW;
      newGroupWrapper.style.display = 'block';
      newGroupInput.value = store.params.destination_group_create_name;
    }

    // Assemble devices for the clusterer.
    //
    // FMN-211: fortimonitor-client's getFabricSystemData augments the
    // raw fabricSystemData block with `isFabric` and `deviceSubType`
    // pulled from the parent instance record. Hoist those to the top
    // level of the device object so the clusterer can read them
    // uniformly (it also accepts pageData.instance.{...} for synthetic
    // fixtures).
    const fsdMap = (fsd && fsd.byServerId) || {};
    const mcMap = (monitoringConfig && monitoringConfig.byServerId) || {};
    const psMap = (portScope && portScope.byServerId) || {};
    lastDevices = targets.map((t) => {
      const fsdRow = fsdMap[t.id] ?? null;
      return {
        id: t.id,
        name: t.name,
        isFabric: fsdRow?.isFabric ?? null,
        deviceSubType: fsdRow?.deviceSubType ?? null,
        fabricSystemData: fsdRow,
        monitoring_config: mcMap[t.id] ?? null,
        port_scope: psMap[t.id] ?? null
      };
    });
    lastTargets = targets;

    rebuildClusters();
    // FMN-211: per-cluster template_type. After initial clustering,
    // fire one /config/get_create_server_template_data per cluster's
    // representative device. This runs after the first rebuild so the
    // table renders immediately; defaults stitch in when they resolve.
    void resolveClusterTemplateTypes();
    downloadBtn.disabled = false;
    downloadPdfBtn.disabled = false;
  })();

  async function resolveClusterTemplateTypes() {
    const clusters = store.params?.clusters || [];
    if (clusters.length === 0) return;
    const fetches = await Promise.all(clusters.map(async (c) => {
      try {
        const resp = await call('bulk-composer:get-create-template-defaults', { serverId: c.sample_device_id });
        const opts = resp?.defaults?.template_type_options;
        if (Array.isArray(opts) && opts.length > 0 && typeof opts[0]?.value === 'string') {
          return { key: c.key, template_type: opts[0].value };
        }
        return { key: c.key, template_type: null };
      } catch {
        return { key: c.key, template_type: null };
      }
    }));
    const byKey = new Map(fetches.map((f) => [f.key, f.template_type]));
    const updated = (store.params?.clusters || []).map((c) => {
      const tt = byKey.get(c.key);
      if (!tt) return c;
      return { ...c, template_type: tt };
    });
    store.params = { ...store.params, clusters: updated };
  }

  function rebuildClusters() {
    const threshold = parseFloat(thresholdSlider.value);
    const { clusters, unclassified } = buildTemplateClusters(lastDevices, { threshold });
    lastUnclassified = unclassified;

    // Preserve operator's per-cluster opt-in / clone / template-name /
    // resource_strategy decisions across re-cluster. Match by cluster key
    // since the key is deterministic for a given (devices, threshold)
    // pair but may shift when threshold changes; fall back to defaults.
    const priorByKey = new Map();
    for (const c of (store.params?.clusters || [])) priorByKey.set(c.key, c);

    const decorated = clusters.map((c) => {
      const prior = priorByKey.get(c.key);
      const strategy = (prior?.resource_strategy === 'intersection' || prior?.resource_strategy === 'union')
        ? prior.resource_strategy
        : c.resource_strategy;
      const proposed = strategy === 'intersection'
        ? c.proposed_resources_intersection
        : c.proposed_resources_union;
      return {
        ...c,
        opted_in: prior?.opted_in !== undefined ? prior.opted_in : true,
        // FMN-200 follow-up: default clone-from-device to TRUE so the
        // commit step uses the populated-clone wire path (FMN-203
        // verified end-to-end).
        clone_from_device: prior?.clone_from_device !== undefined ? prior.clone_from_device : true,
        resource_strategy: strategy,
        proposed_resources: proposed,
        proposed_template_name: prior?.proposed_template_name ?? c.proposed_template_name
      };
    });

    const isNewSelected = destSelect.value === SENTINEL_NEW;
    store.params = {
      ...(store.params || {}),
      dry_run: dryRunChk.checked,
      destination_group: isNewSelected ? '' : (destSelect.value || ''),
      destination_group_create_name: isNewSelected ? newGroupInput.value.trim() : '',
      template_type: 'fabric_template',
      cluster_threshold: threshold,
      clusters: decorated
    };

    if (lastUnclassified.length > 0) {
      unmatchedNote.style.display = 'block';
      unmatchedNote.textContent = `${lastUnclassified.length} of ${lastTargets.length} picked instance(s) lack Fabric metadata or were missing required fields; they will not be touched.`;
    } else {
      unmatchedNote.style.display = 'none';
    }

    if (decorated.length === 0) {
      status.textContent = 'No clusterable Fabric instances in the selection. Pick at least one Fabric-onboarded device.';
      status.className = 'execute-state warning';
      refreshNextDisabled();
      return;
    }

    status.textContent = `Found ${decorated.length} cluster${decorated.length === 1 ? '' : 's'} across ${lastTargets.length} instance${lastTargets.length === 1 ? '' : 's'} at threshold ${formatThreshold(threshold)}.`;
    status.className = '';

    renderClusterTable({
      host: tableHost,
      clusters: decorated,
      onChange: (idx, patch) => {
        const updated = store.params.clusters.slice();
        let next = { ...updated[idx], ...patch };
        // If strategy changed, rebuild proposed_resources from the
        // cluster's precomputed union/intersection arrays.
        if (Object.prototype.hasOwnProperty.call(patch, 'resource_strategy')) {
          next.proposed_resources = patch.resource_strategy === 'intersection'
            ? next.proposed_resources_intersection
            : next.proposed_resources_union;
        }
        updated[idx] = next;
        store.params = { ...store.params, clusters: updated };
        refreshNextDisabled();
      }
    });

    refreshNextDisabled();
  }

  thresholdSlider.addEventListener('input', () => {
    thresholdReadout.textContent = formatThreshold(parseFloat(thresholdSlider.value));
  });
  thresholdSlider.addEventListener('change', () => {
    if (lastDevices.length > 0) rebuildClusters();
  });

  function currentReportContext() {
    return {
      clusters: store.params?.clusters || [],
      unclassified: lastUnclassified,
      targets: lastTargets,
      threshold: parseFloat(thresholdSlider.value),
      destinationGroup: store.params?.destination_group || store.params?.destination_group_create_name || '(unset)',
      dryRun: dryRunChk.checked
    };
  }

  downloadBtn.addEventListener('click', () => {
    const csv = buildSuggestionsCsv(currentReportContext());
    triggerDownload(
      `template-suggestions-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.csv`,
      csv,
      'text/csv'
    );
  });

  downloadPdfBtn.addEventListener('click', () => {
    const html = buildSuggestionsPrintableHtml(currentReportContext());
    triggerPrintToPdf(html);
  });
}

function formatThreshold(t) {
  if (typeof t !== 'number' || !Number.isFinite(t)) return '?';
  return t.toFixed(2);
}

// CSV: one row per (cluster, device). Cluster-level metadata duplicates
// across each member row so the operator can sort/filter in Excel or
// Numbers and read the rationale per device. Unclassified rows are
// appended with cluster_id blank.
function buildSuggestionsCsv({ clusters, unclassified, targets, threshold, destinationGroup, dryRun }) {
  const targetById = new Map((targets || []).map((t) => [t.id, t]));
  const headers = [
    'cluster_id',
    'proposed_template',
    'make',
    'model',
    'cluster_size',
    'opted_in',
    'clone_from_device',
    'resource_strategy',
    'similarity_threshold',
    'device_id',
    'device_name',
    'device_resource_count',
    'cluster_intersection_count',
    'cluster_union_count',
    'similarity_to_representative',
    'port_count',
    'rationale'
  ];
  const rows = [];
  for (const [idx, c] of (clusters || []).entries()) {
    const clusterId = idx + 1;
    for (const ms of (c.member_signatures || [])) {
      const memberKeys = ms.resource_keys || [];
      const target = targetById.get(ms.server_id);
      const name = ms.device_name ?? target?.name ?? '';
      rows.push([
        clusterId,
        c.proposed_template_name,
        c.make,
        c.model,
        c.applies_to_server_ids.length,
        c.opted_in === true ? 'yes' : 'no',
        c.clone_from_device === true ? 'yes' : 'no',
        c.resource_strategy,
        threshold.toFixed(2),
        ms.server_id,
        name,
        memberKeys.length,
        (c.resource_intersection || []).length,
        (c.resource_union || []).length,
        typeof ms.jaccard_to_representative === 'number' ? ms.jaccard_to_representative.toFixed(3) : '',
        Array.isArray(ms.port_keys) ? ms.port_keys.length : '',
        ms.rationale || ''
      ]);
    }
  }
  for (const u of (unclassified || [])) {
    rows.push([
      '',                                                        // cluster_id
      '(unclassified)',                                          // proposed_template
      u.device?.fabricSystemData?.model_name ?? '',              // make
      u.device?.fabricSystemData?.model_number ?? '',            // model
      '',                                                        // cluster_size
      'no',                                                      // opted_in
      '',                                                        // clone_from_device
      '',                                                        // resource_strategy
      threshold.toFixed(2),                                      // similarity_threshold
      u.device?.id ?? '',                                        // device_id
      u.device?.name ?? '',                                      // device_name
      '',                                                        // device_resource_count
      '',                                                        // cluster_intersection_count
      '',                                                        // cluster_union_count
      '',                                                        // similarity_to_representative
      '',                                                        // port_count
      `Excluded: ${u.reason}`                                    // rationale
    ]);
  }
  // Prepend a comment block summarizing the run. Comment lines start
  // with "#" and most spreadsheet tools tolerate them on import; if not,
  // the operator deletes the first few rows.
  const banner = [
    `# Template Suggestions Report`,
    `# Generated: ${new Date().toISOString()}`,
    `# Similarity threshold: ${threshold.toFixed(2)} (1.0 = identical only; 0.8 default = near-identical merge within same Make+Model)`,
    `# Destination group: ${destinationGroup}`,
    `# Dry run: ${dryRun ? 'yes' : 'no'}`,
    `# Devices: ${(targets || []).length}  Clusters: ${(clusters || []).length}  Unclassified: ${(unclassified || []).length}`,
    `# Rationale column explains why each device is grouped where it is.`,
    ``
  ].join('\n');
  return banner + [headers, ...rows].map(rowToCsv).join('\n');
}

function rowToCsv(arr) {
  return arr.map(csvFieldLocal).join(',');
}

function csvFieldLocal(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function triggerDownload(filename, content, mime) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// PDF report: builds a self-contained HTML doc with the same data the
// CSV carries, mounts it in a hidden off-screen iframe, and invokes
// window.print() so the operator gets Chrome's "Save as PDF" target.
// Same pattern observations-pdf.js uses for the Tenant Observations.
function buildSuggestionsPrintableHtml({ clusters, unclassified, targets, threshold, destinationGroup, dryRun }) {
  const targetById = new Map((targets || []).map((t) => [t.id, t]));
  const generatedAt = new Date().toISOString();
  const summary = {
    targets: (targets || []).length,
    clusters: (clusters || []).length,
    unclassified: (unclassified || []).length,
    optedIn: (clusters || []).filter((c) => c.opted_in === true).length
  };
  const head = `
<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8">
<title>Template Suggestions</title>
<style>
  body { font: 12px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, sans-serif; color: #111; margin: 24px; }
  h1 { font-size: 18px; margin: 0 0 4px; }
  h2 { font-size: 14px; margin: 16px 0 6px; border-bottom: 1px solid #ccc; padding-bottom: 2px; }
  .meta { color: #555; font-size: 11px; margin-bottom: 12px; }
  .meta strong { color: #111; }
  table { width: 100%; border-collapse: collapse; margin: 8px 0 16px; font-size: 10.5px; }
  th, td { border: 1px solid #d0d0d0; padding: 4px 6px; text-align: left; vertical-align: top; }
  th { background: #f4f6f8; font-weight: 600; }
  td.devices { max-width: 240px; word-wrap: break-word; }
  td.rationale { max-width: 320px; word-wrap: break-word; }
  .cluster-block { page-break-inside: avoid; margin-bottom: 18px; }
  .footer { color: #777; font-size: 10px; margin-top: 24px; border-top: 1px solid #ddd; padding-top: 6px; }
  @page { size: letter landscape; margin: 0.5in; }
</style>
</head><body>`;
  const headerBlock = `
<h1>Template Suggestions Report</h1>
<div class="meta">
  <strong>Generated:</strong> ${esc(generatedAt)} &middot;
  <strong>Similarity threshold:</strong> ${threshold.toFixed(2)} (1.0 = identical only; 0.8 default = near-identical merge) &middot;
  <strong>Destination group:</strong> ${esc(destinationGroup)} &middot;
  <strong>Dry run:</strong> ${dryRun ? 'yes' : 'no'}
</div>
<div class="meta">
  <strong>Devices:</strong> ${summary.targets} &middot;
  <strong>Clusters:</strong> ${summary.clusters} &middot;
  <strong>Opted in:</strong> ${summary.optedIn} &middot;
  <strong>Unclassified:</strong> ${summary.unclassified}
</div>`;

  let body = '';
  for (const [idx, c] of (clusters || []).entries()) {
    const clusterId = idx + 1;
    const memberRows = (c.member_signatures || []).map((ms) => {
      const memberKeys = ms.resource_keys || [];
      const target = targetById.get(ms.server_id);
      const name = ms.device_name ?? target?.name ?? '';
      return `<tr>
        <td>${esc(ms.server_id)}</td>
        <td class="devices">${esc(name)}</td>
        <td>${memberKeys.length}</td>
        <td>${Array.isArray(ms.port_keys) ? ms.port_keys.length : '-'}</td>
        <td class="rationale">${esc(ms.rationale || '')}</td>
      </tr>`;
    }).join('');
    body += `
<section class="cluster-block">
  <h2>Cluster ${clusterId}: ${esc(c.proposed_template_name || '')}</h2>
  <div class="meta">
    <strong>Make / Model:</strong> ${esc(c.make)} / ${esc(c.model)} &middot;
    <strong>Devices:</strong> ${c.applies_to_server_ids.length} &middot;
    <strong>Opted in:</strong> ${c.opted_in === true ? 'yes' : 'no'} &middot;
    <strong>Clone from device:</strong> ${c.clone_from_device === true ? 'yes' : 'no'} &middot;
    <strong>Resource intersection:</strong> ${(c.resource_intersection || []).length} &middot;
    <strong>Resource union:</strong> ${(c.resource_union || []).length}
  </div>
  <table>
    <thead><tr>
      <th>Device ID</th>
      <th>Device name</th>
      <th>Resource count</th>
      <th>Port count</th>
      <th>Rationale</th>
    </tr></thead>
    <tbody>${memberRows}</tbody>
  </table>
</section>`;
  }

  if ((unclassified || []).length > 0) {
    const uncRows = (unclassified || []).map((u) => `<tr>
      <td>${esc(u.device?.id ?? '')}</td>
      <td>${esc(u.device?.name ?? '')}</td>
      <td>${esc(u.reason || '')}</td>
    </tr>`).join('');
    body += `
<section class="cluster-block">
  <h2>Unclassified devices</h2>
  <table>
    <thead><tr><th>Device ID</th><th>Device name</th><th>Reason</th></tr></thead>
    <tbody>${uncRows}</tbody>
  </table>
</section>`;
  }

  const footer = `<div class="footer">Built by Gregori Jenkins - <a href="https://www.linkedin.com/in/gregorijenkins">linkedin.com/in/gregorijenkins</a></div>`;
  return head + headerBlock + body + footer + '</body></html>';
}

function esc(v) {
  if (v === null || v === undefined) return '';
  return String(v).replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[ch]));
}

function triggerPrintToPdf(html) {
  return new Promise((resolve) => {
    const iframe = document.createElement('iframe');
    iframe.setAttribute('aria-hidden', 'true');
    iframe.setAttribute('data-test', 'configure-pact-pdf-iframe');
    iframe.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden;';
    iframe.srcdoc = html;
    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      setTimeout(() => {
        if (iframe.parentNode) iframe.parentNode.removeChild(iframe);
      }, 0);
    };
    iframe.addEventListener('load', () => {
      const win = iframe.contentWindow;
      if (!win) { cleanup(); resolve(); return; }
      try { win.addEventListener('afterprint', cleanup); } catch { /* not supported */ }
      try {
        win.focus();
        win.print();
      } catch { /* print rejected */ }
      // Fallback if afterprint never fires (operator closes the dialog fast).
      setTimeout(cleanup, 60_000);
      resolve();
    });
    document.body.appendChild(iframe);
  });
}

function renderClusterTable({ host, clusters, onChange }) {
  while (host.firstChild) host.removeChild(host.firstChild);

  const table = h('table', {
    'data-test': 'configure-pact-table',
    style: 'width:100%;border-collapse:collapse;margin-top:0.3rem;font-size:0.88rem;'
  });
  table.appendChild(h('thead', {}, h('tr', {
    style: 'background:#f4f6f8;border-bottom:1px solid var(--border-strong);'
  },
    th(''), th('Make / Model'), th('Devices in scope'),
    th('Template name (editable)'),
    th('Resources'),
    th('Clone'),
    th('Port scope')
  )));

  const tbody = h('tbody', {});
  for (const [idx, c] of clusters.entries()) {
    const tr = h('tr', {
      'data-test': 'configure-pact-row',
      'data-cluster-key': c.key,
      style: 'border-bottom:1px solid var(--border-weak);'
    });

    const optChk = h('input', { type: 'checkbox', 'data-test': 'configure-pact-opt-in', checked: c.opted_in === true });
    optChk.addEventListener('change', () => onChange(idx, { opted_in: optChk.checked }));
    tr.appendChild(td(optChk));

    tr.appendChild(td(h('span', {}, `${c.make} / ${c.model}`)));
    tr.appendChild(td(renderDevicesCell(c)));

    const nameInput = h('input', {
      type: 'text',
      'data-test': 'configure-pact-template-name',
      style: 'width:100%;padding:0.25rem 0.4rem;border:1px solid var(--border-strong);border-radius:3px;font-size:0.85rem;'
    });
    nameInput.value = c.proposed_template_name;
    nameInput.addEventListener('input', () => onChange(idx, { proposed_template_name: nameInput.value }));
    tr.appendChild(td(nameInput));

    // Strategy selector removed (FMN-211 follow-up): every cluster's
    // proposed template uses the union of resources across its devices.
    // Internal `resource_strategy` field still defaults to 'union'.
    const resCount = (c.proposed_resources || []).length;
    const resCell = resCount === 0
      ? h('span', { class: 'muted', style: 'color:#856404;' }, '0 (empty shell)')
      : h('span', {
          title: (c.proposed_resources || []).map((r) => r.name || r.resource_textkey).join('\n')
        }, `${resCount} resource${resCount === 1 ? '' : 's'}`);
    tr.appendChild(td(resCell));

    const cloneChk = h('input', { type: 'checkbox', 'data-test': 'configure-pact-clone', checked: c.clone_from_device === true });
    cloneChk.addEventListener('change', () => onChange(idx, { clone_from_device: cloneChk.checked }));
    tr.appendChild(td(cloneChk));

    tr.appendChild(td(renderPortCell(c)));

    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  host.appendChild(table);
}

function renderDevicesCell(cluster) {
  const members = cluster.member_signatures || [];
  const ids = cluster.applies_to_server_ids || [];
  const names = members.map((m, i) => m.device_name || `id ${m.server_id ?? ids[i] ?? '?'}`);
  if (names.length === 0) return h('span', { class: 'muted' }, '(none)');
  const fullList = names.join(', ');
  const PREVIEW = 3;
  if (names.length <= PREVIEW) {
    return h('span', { 'data-test': 'configure-pact-devices', title: fullList }, fullList);
  }
  const visible = names.slice(0, PREVIEW).join(', ');
  const extra = names.length - PREVIEW;
  return h('span', {
    'data-test': 'configure-pact-devices',
    title: fullList,
    style: 'white-space:normal;'
  }, `${visible}, +${extra} more`);
}

function renderPortCell(cluster) {
  const memberPorts = (cluster.member_signatures || []).map((m) => Array.isArray(m.port_keys) ? m.port_keys.length : null);
  const distinct = [...new Set(memberPorts.filter((n) => n !== null))];
  if (cluster.port_signature === null && distinct.length === 0) {
    return h('span', { class: 'muted' }, '(none)');
  }
  if (distinct.length <= 1) {
    const n = distinct[0] ?? (Array.isArray(cluster.port_signature) ? cluster.port_signature.length : 0);
    return h('span', {}, n === 0 ? '0 ports' : `${n} port${n === 1 ? '' : 's'}`);
  }
  const min = Math.min(...distinct);
  const max = Math.max(...distinct);
  return h('span', { title: `Per-device port counts: ${memberPorts.join(', ')}` }, `${min}-${max} ports`);
}
