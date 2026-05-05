// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// Best-Practice Assessment PDF export (FMN-136).
//
// Print-to-PDF via a hidden iframe loaded with a self-contained
// printable HTML document. The browser's print dialog handles the
// "Save as PDF" output - no JS PDF library, zero new runtime
// dependencies. Matches the no-vendor ethos of zip.js.
//
// Usage:
//   import { printReport } from '../../lib/bpa-pdf.js';
//   printReport(ctx, { customer, coverPage: false });
//
// The PDF mirrors the CSV exactly: same TABS model, same cell-value
// resolution, same "skip empty section unless alwaysIncludeHeader"
// rule. The only difference is that CSV is per-tab and PDF is the
// combined report.

import { getTabs, csvCellValue } from '../ui/bpa-audit/viewer.js';

// ---------------------------------------------------------------------------
// Filename helper - mirrors combinedZipFilename's pattern with .pdf ext.
// ---------------------------------------------------------------------------

function timestampPart(d = new Date()) {
  return d.toISOString().slice(0, 10).replace(/-/g, '');
}

function safeFilenamePart(s) {
  return String(s ?? '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

export function pdfFilename(customer) {
  const slug = safeFilenamePart(customer);
  const prefix = slug || 'best-practice-assessment';
  return `${prefix}_best-practice-assessment_${timestampPart()}.pdf`;
}

// ---------------------------------------------------------------------------
// HTML escaping - everything that flows from data into the printable
// document MUST go through here. Customer names, table cells, tab
// labels - all of it.
// ---------------------------------------------------------------------------

const ESCAPE_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
function esc(v) {
  if (v == null) return '';
  return String(v).replace(/[&<>"']/g, (c) => ESCAPE_MAP[c]);
}

// ---------------------------------------------------------------------------
// Print stylesheet - inlined so the iframe is self-contained.
// ---------------------------------------------------------------------------

const PRINT_STYLES = `
  @page { size: letter; margin: 0.6in; }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
    color: #111;
    font-size: 10pt;
    line-height: 1.35;
  }
  h1 { font-size: 16pt; margin: 0 0 0.3rem; }
  h2 { font-size: 13pt; margin: 1.1rem 0 0.4rem; border-bottom: 1px solid #999; padding-bottom: 0.1rem; }
  h3 { font-size: 11pt; margin: 0.8rem 0 0.3rem; color: #333; }
  p { margin: 0.3rem 0; }
  .muted { color: #666; font-size: 9pt; }
  .meta { color: #555; font-size: 9pt; margin-bottom: 0.8rem; }
  .cover {
    page-break-after: always;
    text-align: center;
    padding-top: 2.5in;
  }
  .cover h1 { font-size: 28pt; margin-bottom: 0.4rem; }
  .cover .sub { font-size: 14pt; color: #444; margin-bottom: 2rem; }
  .cover .meta { font-size: 11pt; color: #333; margin-top: 1.5rem; }
  .toc { page-break-after: always; }
  .toc ol { padding-left: 1.4rem; }
  .toc a { color: #1f4e79; text-decoration: none; }
  .tab-section { page-break-before: always; }
  .tab-section:first-of-type { page-break-before: auto; }
  .section-block { margin-bottom: 0.8rem; }
  table {
    width: 100%;
    border-collapse: collapse;
    font-size: 9pt;
    margin-top: 0.2rem;
  }
  thead { display: table-header-group; }
  tr { page-break-inside: avoid; }
  th, td {
    border: 1px solid #bbb;
    padding: 0.18rem 0.35rem;
    text-align: left;
    vertical-align: top;
    word-wrap: break-word;
    overflow-wrap: anywhere;
  }
  th { background: #eef1f5; font-weight: 600; }
  td.cell-empty { color: #888; }
  .footer {
    position: running(footer);
    text-align: center;
    color: #888;
    font-size: 8pt;
  }
`;

// ---------------------------------------------------------------------------
// Document composition
// ---------------------------------------------------------------------------

/**
 * Build a self-contained printable HTML document for the BPA report.
 *
 * @param {object} ctx - viewer context: { inventory, analysis, customer }
 * @param {object} [options]
 * @param {boolean} [options.coverPage=false] - emit a cover page + TOC before the sections
 * @param {string}  [options.customer='']     - customer name (escaped before insertion)
 * @param {string}  [options.generatedAt]     - ISO timestamp string
 * @returns {string} full <!DOCTYPE html> document
 */
export function buildPrintableHtml(ctx, { coverPage = false, customer = '', generatedAt = new Date().toISOString() } = {}) {
  const tabs = getTabs();
  const parts = [];
  parts.push('<!DOCTYPE html>');
  parts.push('<html lang="en"><head><meta charset="UTF-8">');
  parts.push(`<title>Best-Practice Assessment${customer ? ` - ${esc(customer)}` : ''}</title>`);
  parts.push(`<style>${PRINT_STYLES}</style>`);
  parts.push('</head><body>');

  if (coverPage) {
    parts.push(renderCover(customer, generatedAt));
    parts.push(renderToc(tabs));
  } else {
    parts.push(renderHeaderBlock(customer, generatedAt));
  }

  for (const tab of tabs) {
    parts.push(renderTabSection(tab, ctx, { coverPage }));
  }

  parts.push('</body></html>');
  return parts.join('');
}

function renderCover(customer, generatedAt) {
  return [
    '<section class="cover">',
    '<h1>Best-Practice Assessment</h1>',
    '<div class="sub">Unofficial FortiMonitor Toolkit</div>',
    customer ? `<div class="meta"><strong>Customer:</strong> ${esc(customer)}</div>` : '',
    `<div class="meta"><strong>Generated:</strong> ${esc(generatedAt)}</div>`,
    '<div class="meta">Built by Gregori Jenkins - https://www.linkedin.com/in/gregorijenkins</div>',
    '</section>'
  ].join('');
}

function renderToc(tabs) {
  const items = tabs.map((t, i) => `<li><a href="#tab-${esc(t.id)}">${i + 1}. ${esc(t.label)}</a></li>`).join('');
  return `<section class="toc"><h2>Contents</h2><ol>${items}</ol></section>`;
}

function renderHeaderBlock(customer, generatedAt) {
  return [
    '<header>',
    '<h1>Best-Practice Assessment</h1>',
    '<div class="meta">',
    customer ? `<strong>Customer:</strong> ${esc(customer)} &middot; ` : '',
    `<strong>Generated:</strong> ${esc(generatedAt)}`,
    '</div>',
    '</header>'
  ].join('');
}

function renderTabSection(tab, ctx, { coverPage }) {
  const out = [`<section class="tab-section" id="tab-${esc(tab.id)}">`];
  // When there's no cover, the FIRST tab's page-break-before is suppressed
  // by .tab-section:first-of-type so the document doesn't open with a
  // blank page. With a cover, the first tab still gets its own page.
  out.push(`<h2>${esc(tab.label)}</h2>`);
  if (coverPage === false) {
    // no-op; included for clarity that header-mode does not get an extra meta block per tab
  }

  for (const section of tab.sections) {
    const rows = section.rows(ctx) ?? [];
    if (rows.length === 0 && !section.alwaysIncludeHeader) {
      // Skip parity with CSV. But render the empty-text hint so the
      // PDF reader knows the section was checked, not omitted.
      if (section.label) out.push(`<div class="section-block"><h3>${esc(section.label)}</h3><p class="muted">${esc(section.emptyText ?? 'No rows.')}</p></div>`);
      continue;
    }
    out.push('<div class="section-block">');
    if (section.label) out.push(`<h3>${esc(section.label)}</h3>`);
    if (rows.length === 0) {
      out.push(`<p class="muted">${esc(section.emptyText ?? 'No rows.')}</p>`);
    } else {
      out.push(renderTable(section, rows, ctx));
    }
    out.push('</div>');
  }
  out.push('</section>');
  return out.join('');
}

function renderTable(section, rows, ctx) {
  const head = section.columns.map((c) => `<th>${esc(c.header)}</th>`).join('');
  const body = rows.map((row) => {
    const cells = section.columns.map((col) => {
      const value = csvCellValue(col, row);
      const isEmpty = value === '' || value == null;
      const cls = isEmpty ? ' class="cell-empty"' : '';
      return `<td${cls}>${isEmpty ? '-' : esc(value)}</td>`;
    }).join('');
    return `<tr>${cells}</tr>`;
  }).join('');
  return `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

// ---------------------------------------------------------------------------
// Trigger - mount a hidden iframe and invoke its print dialog.
// ---------------------------------------------------------------------------

/**
 * Build the printable document, mount it in a hidden iframe, and call
 * window.print() against the iframe so the user gets Chrome's print
 * dialog with "Save as PDF" pre-selectable.
 *
 * The iframe is positioned off-screen rather than display:none because
 * print engines skip non-rendered subtrees.
 *
 * @param {object} ctx     - viewer context
 * @param {object} options - same shape as buildPrintableHtml
 * @returns {Promise<void>} resolves once print() has been invoked
 */
export function printReport(ctx, options = {}) {
  return new Promise((resolve) => {
    const html = buildPrintableHtml(ctx, options);
    const iframe = document.createElement('iframe');
    iframe.setAttribute('aria-hidden', 'true');
    iframe.setAttribute('data-test', 'bpa-pdf-iframe');
    iframe.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden;';
    iframe.srcdoc = html;

    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      // Defer remove so the print dialog has finished referencing the doc.
      setTimeout(() => {
        if (iframe.parentNode) iframe.parentNode.removeChild(iframe);
      }, 0);
    };

    iframe.addEventListener('load', () => {
      const win = iframe.contentWindow;
      if (!win) { cleanup(); resolve(); return; }
      try {
        win.addEventListener('afterprint', cleanup);
      } catch { /* afterprint not supported in this context */ }
      try {
        win.focus();
        win.print();
      } catch { /* print was rejected; cleanup happens via fallback below */ }
      // Fallback cleanup: some browsers don't fire afterprint reliably
      // when the user dismisses the dialog quickly.
      setTimeout(cleanup, 60_000);
      resolve();
    });

    document.body.appendChild(iframe);
  });
}
