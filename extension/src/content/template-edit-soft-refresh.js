// FMN-82: suppress the full page reload that fires after the operator saves
// an edit on a template's Monitoring Config. Runs in the page's main world so
// it can read the Vue component's __vue__ instance and toggle its data.
//
// FortiMonitor's p-editmetric-drawer save() ends with:
//
//   if (this.refreshOnComplete) {
//       window.location.reload();
//   } else if (isExistingMetric) {
//       this.eventHub.$emit("paginated-metrics-table:reload");
//   }
//   this.$parent.close();
//
// On the template Monitoring Config page refreshOnComplete is `true` by
// default - the source of the user's pain (the operator loses scroll position
// after every edit). FortiMonitor already has a soft-refresh code path on the
// else branch; the template page just doesn't take it.
//
// We patch the open drawer's refreshOnComplete to false (routing into the
// soft branch) and listen on the same eventHub for "paginated-metrics-table:
// reload" so we can call getMonitoringConfigData() on the ancestor
// p-monitoring-catalog-2 to refresh the metric list in place.
//
// If any of these hooks fail (e.g. FortiMonitor renames the data prop or
// changes the event name), the patch silently no-ops and the user falls back
// to the original behavior. Fail-safe.

(() => {
  const PAGE_RE = /\/report\/Instance\/\d+\/monitoring\/template_incidents_config(?:\/|$|\?)/;
  const PATCHED_FLAG = '__fmnSoftRefreshPatched';
  const HUB_HOOKED_FLAG = '__fmnSoftRefreshHubHooked';

  let cachedCatalog = null;

  function findCatalog() {
    if (cachedCatalog && cachedCatalog.$el && document.contains(cachedCatalog.$el)) {
      return cachedCatalog;
    }
    cachedCatalog = null;
    const all = document.querySelectorAll('*');
    for (let i = 0; i < all.length; i++) {
      const v = all[i].__vue__;
      if (!v || !v.$options) continue;
      const name = v.$options.name || v.$options._componentTag;
      if (name === 'p-monitoring-catalog-2'
          && typeof v.getMonitoringConfigData === 'function') {
        cachedCatalog = v;
        return v;
      }
    }
    return null;
  }

  function softRefresh() {
    const cat = findCatalog();
    if (!cat) return;
    try {
      cat.getMonitoringConfigData();
    } catch (err) {
      console.warn('[FMN-82] getMonitoringConfigData failed', err);
    }
  }

  function tryPatchDrawer() {
    if (!PAGE_RE.test(location.pathname)) return;
    const wrapper = document.querySelector('.editmetric-drawer-wrapper');
    if (!wrapper) return;
    const v = wrapper.__vue__;
    if (!v) return;
    if (v[PATCHED_FLAG]) return;
    // Only intercept the existing-metric edit path. New-metric add and the
    // DEM zero-state flow have their own post-save behavior we don't touch.
    if (v.action !== 'edit') return;
    if (v.refreshOnComplete !== true) return;

    v.refreshOnComplete = false;
    v[PATCHED_FLAG] = true;

    const hub = v.eventHub;
    if (hub && typeof hub.$on === 'function' && !hub[HUB_HOOKED_FLAG]) {
      hub.$on('paginated-metrics-table:reload', softRefresh);
      hub[HUB_HOOKED_FLAG] = true;
    }
  }

  // The drawer mounts asynchronously after the operator clicks Edit; observe
  // the document for childList changes and try to patch on each mutation.
  // Idempotent: bails out as soon as the drawer is already patched, so loops
  // are not a concern (and we never write to the DOM ourselves).
  const observer = new MutationObserver(tryPatchDrawer);
  observer.observe(document.documentElement, { childList: true, subtree: true });

  // SPA route changes: the script may have loaded on a sibling /report/Instance/...
  // page and the operator navigated to the template Monitoring Config without a
  // full reload. Re-run on history changes too.
  const origPush = history.pushState;
  history.pushState = function () {
    const r = origPush.apply(this, arguments);
    queueMicrotask(tryPatchDrawer);
    return r;
  };
  const origReplace = history.replaceState;
  history.replaceState = function () {
    const r = origReplace.apply(this, arguments);
    queueMicrotask(tryPatchDrawer);
    return r;
  };
  window.addEventListener('popstate', () => queueMicrotask(tryPatchDrawer));

  tryPatchDrawer();
})();
