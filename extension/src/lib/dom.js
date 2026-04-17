// Unofficial FortiMonitor Toolkit — Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// Minimal DOM helpers. No framework — vanilla JS keeps the MV3 bundle at
// zero runtime dependencies (matches the testing story in the service
// worker modules).

export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class' || k === 'className') el.setAttribute('class', v);
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k === 'dataset' && typeof v === 'object') Object.assign(el.dataset, v);
    else if (k === 'checked' && v) el.checked = true;
    else if (k === 'disabled' && v) el.disabled = true;
    else if (k === 'html') el.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') {
      el.addEventListener(k.slice(2).toLowerCase(), v);
    } else {
      el.setAttribute(k, String(v));
    }
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    if (child instanceof Node) el.appendChild(child);
    else el.appendChild(document.createTextNode(String(child)));
  }
  return el;
}

export function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
}

export function breadcrumbs(active) {
  const steps = [
    { id: 'start', label: '1. Load devices' },
    { id: 'review', label: '2. Review groups' },
    { id: 'queue', label: '3. Audit queue' },
    { id: 'execute', label: '4. Execute' }
  ];
  const order = steps.findIndex((s) => s.id === active);
  return h('div', { class: 'step-breadcrumbs' },
    steps.flatMap((s, i) => {
      const cls = i < order ? 'step done' : i === order ? 'step active' : 'step';
      const label = i < order ? `${s.label} ✓` : s.label;
      const item = h('span', { class: cls }, label);
      return i === 0 ? [item] : [h('span', { class: 'arrow' }, '›'), item];
    })
  );
}

export function titleBar(subtitle, { runningDot = false, toolName = 'Remove from Port Scope (Fabric)' } = {}) {
  return h('div', { class: 'title-bar' },
    h('h1', {},
      h('span', { class: 'icon' }, 'F'),
      toolName,
      subtitle ? h('span', { class: 'subtitle' }, `— ${subtitle}`) : null,
      runningDot ? h('span', { class: 'running-dot' }) : null
    )
  );
}

export function downloadBlob(filename, mime, text) {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Revoke on next tick so Chrome has time to start the download.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
