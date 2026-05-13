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
    } else if (store.actionId === 'apply-best-practice-fabric') {
      const recs = Array.isArray(params.recommendations) ? params.recommendations : [];
      const optedIn = recs.filter((r) => r && r.opted_in === true && r.chosen_template);
      nextBtn.disabled = optedIn.length === 0;
    } else {
      nextBtn.disabled = true;
    }
  }

  if (store.actionId === 'add-tag' || store.actionId === 'remove-tag') {
    renderTagForm({ body, store, refreshNextDisabled });
  } else if (store.actionId === 'apply-template') {
    renderTemplateForm({ body, store, refreshNextDisabled, call, stateLabel });
  } else if (store.actionId === 'apply-best-practice-fabric') {
    renderBestPracticeFabricForm({ body, store, refreshNextDisabled, call, stateLabel });
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

function renderTagForm({ body, store, refreshNextDisabled }) {
  body.appendChild(h('h3', { class: 'subhead' }, 'Tag'));

  // FMN-155 QA enhancement: for remove-tag, surface the union of tags
  // found across the selected instances as clickable chips. Operator
  // picks from the live list rather than having to remember the exact
  // string. Custom-text input remains available for tags absent from
  // the corpus cache (rare).
  const isRemove = store.actionId === 'remove-tag';
  if (isRemove) {
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
      body.appendChild(h('p', {
        class: 'muted',
        style: 'font-size:0.85rem;color:var(--text-muted);margin:0 0 0.5rem;'
      }, 'No tags found on the selected instances. Enter a tag manually below.'));
    } else {
      body.appendChild(h('h4', {
        style: 'font-size:0.9rem;margin:0.2rem 0 0.5rem;font-weight:600;'
      }, 'Tags found across selected instances'));
      const chipRow = h('div', {
        'data-test': 'configure-existing-tags',
        style: 'display:flex;flex-wrap:wrap;gap:0.35rem;margin-bottom:0.5rem;'
      });
      const chipFor = new Map();
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
      body.appendChild(chipRow);

      var highlight = () => {
        const current = (store.params?.tag ?? '').trim();
        for (const [tag, chip] of chipFor) {
          const active = tag === current;
          chip.style.background = active ? '#d0e5ff' : '#eef2f7';
          chip.style.borderColor = active ? '#1f6feb' : '#c4c8cf';
          chip.style.fontWeight = active ? '600' : '400';
        }
      };
    }
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

  if (isRemove && typeof highlight === 'function') highlight();
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
// FMN-196: Apply Best-Practice Fabric Templates
// =====================================================================
//
// Configure step UI for the Fabric Best-Practice action. Fetches three
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
  body.appendChild(h('h3', { class: 'subhead' }, 'Best-Practice Fabric Templates'));

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
