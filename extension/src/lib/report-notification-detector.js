// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// FMN-191: pure state machine for detecting when a FortiMonitor canned
// report finishes generating.
//
// Detection signal: GET /report/get_canned_history_report_requests_data
// returns a DataTables JSON blob whose `recordsTotal` field is a count
// of completed runs. The page itself never polls; it loads once and
// shows whatever the count was at load. We poll the same endpoint
// periodically and notify on every increase.
//
// The state lives in chrome.storage.local under STORAGE_KEY so the SW
// can be evicted mid-cycle without losing the baseline.

export const STORAGE_KEY = 'fm:reportNotificationDetector';
// FMN-191 task 9: ring buffer of recent completion notifications. Used by
// the popup's "Recent reports" card. Each entry is one notification event
// (one delta), most-recent first, capped to MAX_HISTORY_ENTRIES.
export const HISTORY_STORAGE_KEY = 'fm:reportNotificationHistory';
export const MAX_HISTORY_ENTRIES = 10;

export function initialState() {
  return {
    baseline: null,           // last-seen recordsTotal; null = "first poll, set baseline"
    lastPollAt: null,         // ISO timestamp of last successful poll
    notifiedCount: 0,         // total notifications fired since enable
  };
}

// Decide what to do given the current poll result.
//   currentCount: number returned by the FortiMonitor endpoint
//   prevState: prior state from storage (or null on first run)
//   now: Date.now() at the call site (injected for testability)
//
// Returns { nextState, notify } where notify is either null or
//   { delta: number, baseline: number, newTotal: number }
export function classifyPoll(prevState, currentCount, now = Date.now()) {
  if (!Number.isFinite(currentCount) || currentCount < 0) {
    // Sentinel: treat as transient endpoint glitch. Keep state unchanged.
    return { nextState: prevState ?? initialState(), notify: null };
  }
  const state = prevState && typeof prevState === 'object' ? { ...prevState } : initialState();
  const nowIso = new Date(now).toISOString();

  if (state.baseline == null) {
    // First poll - calibrate, don't notify.
    return {
      nextState: { ...state, baseline: currentCount, lastPollAt: nowIso },
      notify: null,
    };
  }
  if (currentCount > state.baseline) {
    const delta = currentCount - state.baseline;
    return {
      nextState: {
        ...state,
        baseline: currentCount,
        lastPollAt: nowIso,
        notifiedCount: (state.notifiedCount || 0) + 1,
      },
      notify: { delta, baseline: state.baseline, newTotal: currentCount },
    };
  }
  // Count unchanged or (improbably) regressed. Refresh lastPollAt; never
  // lower the baseline so a transient backend hiccup that returns a
  // smaller count can't make us re-fire on the next bump.
  return {
    nextState: { ...state, lastPollAt: nowIso },
    notify: null,
  };
}

// Append a completion event to the history ring buffer. Pure: takes
// the prior history array (or null/undefined) and returns the next one.
// Most-recent first; capped to MAX_HISTORY_ENTRIES.
//
// `notify` may optionally carry a `reports` array of parsed row objects
// (see extractCompletedReports). When present, each report becomes its
// own ring-buffer entry so the bell can show one row per finished
// report rather than collapsing them into "N reports finished".
export function appendHistory(priorHistory, notify, now = Date.now()) {
  if (!notify || !Number.isFinite(notify.delta) || notify.delta < 1) {
    return Array.isArray(priorHistory) ? priorHistory : [];
  }
  const prior = Array.isArray(priorHistory) ? priorHistory : [];
  const reports = Array.isArray(notify.reports) && notify.reports.length > 0 ? notify.reports : null;
  const baseTs = now;
  let entries;
  if (reports) {
    // One ring-buffer entry per actual completed report, most-recent first.
    const safeIso = (s) => {
      if (!s) return new Date(baseTs).toISOString();
      const d = new Date(s);
      return Number.isFinite(d.getTime()) ? d.toISOString() : new Date(baseTs).toISOString();
    };
    entries = reports.map((report, i) => ({
      id: `hist-${baseTs}-${i}`,
      takenAt: safeIso(report.lastSent),
      reportTypeId: report.reportTypeId ?? null,
      reportTypeName: report.reportTypeName ?? null,
      reportName: report.reportName ?? report.reportTypeName ?? null,
      downloadLink: report.downloadLink ?? null,
      historyId: report.historyId ?? null,
    }));
  } else {
    // Fallback: no row data attached, just record the delta count.
    entries = [{
      id: `hist-${baseTs}`,
      takenAt: new Date(baseTs).toISOString(),
      delta: notify.delta,
      baseline: notify.baseline,
      newTotal: notify.newTotal,
    }];
  }
  return [...entries, ...prior].slice(0, MAX_HISTORY_ENTRIES);
}

// Extract clean report objects from FortiMonitor's
// get_canned_history_report_requests_data response. The wire shape is
// an array of arrays; columns we care about are positional. Returns up
// to `limit` entries, most-recent first (the wire data is already
// ordered newest-first).
//
// Wire row shape (positional):
//   [0] [report_type_id, report_type_name]
//   [1] HTML report-name cell with badges
//   [2] "Created By" text
//   [3] "Last Sent" formatted timestamp string
//   [4] Recipient (collapsed)
//   [5] Recipient (full)
//   [6] { title: "Download", link: "/report/downloadCannedReport?report_history_id=N" }
//   [7] sort-key (negative epoch)
export function extractCompletedReports(rawData, limit) {
  if (!Array.isArray(rawData) || !Number.isFinite(limit) || limit < 1) return [];
  const out = [];
  for (const row of rawData) {
    if (out.length >= limit) break;
    if (!Array.isArray(row)) continue;
    const typeTuple = Array.isArray(row[0]) ? row[0] : [null, null];
    const nameHtml = typeof row[1] === 'string' ? row[1] : '';
    // Strip FortiMonitor's pa-badge spans (e.g. "Me" / "You receive this
    // report") FIRST so their text content doesn't leak into reportName,
    // then drop remaining tags + normalize whitespace.
    const reportName = nameHtml
      ? nameHtml
          .replace(/<span[^>]*pa-badge[^>]*>[\s\S]*?<\/span>/gi, '')
          .replace(/<[^>]*>/g, '')
          .replace(/&nbsp;/g, ' ')
          .replace(/\s+/g, ' ')
          .trim()
      : (typeTuple[1] || '');
    const downloadCell = row[6] && typeof row[6] === 'object' ? row[6] : null;
    const link = downloadCell?.link || null;
    const historyId = link ? Number((link.match(/report_history_id=(\d+)/) || [])[1]) || null : null;
    out.push({
      reportTypeId: typeTuple[0] ?? null,
      reportTypeName: typeTuple[1] ?? null,
      reportName,
      createdBy: typeof row[2] === 'string' ? row[2] : null,
      lastSent: typeof row[3] === 'string' ? row[3] : null,
      downloadLink: link,
      historyId,
    });
  }
  return out;
}

// Compose the notification text. Single-report and multi-report variants.
export function notificationText({ delta }) {
  const reportWord = delta === 1 ? 'report' : 'reports';
  return {
    title: 'FortiMonitor report ready',
    message: delta === 1
      ? 'A canned report finished generating.'
      : `${delta} canned ${reportWord} finished generating.`,
  };
}
