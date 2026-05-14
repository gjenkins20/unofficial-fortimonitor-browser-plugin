// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// FMN-136 - BPA PDF print-document builder tests.
//
// printReport() itself is a DOM-side trigger and is exercised by the
// Playwright harness spec; here we test buildPrintableHtml() and
// pdfFilename() in pure node.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPrintableHtml, pdfFilename } from '../src/lib/bpa-pdf.js';
import { getTabs } from '../src/ui/bpa-audit/viewer.js';

function fixtureCtx() {
  return {
    inventory: {
      servers: [{ id: 1, status: 'active' }, { id: 2, status: 'active' }],
      fabric_connections: [{}],
      contact_groups: [],
      compound_services: [],
      users: [{ id: 1, name: 'Alice', email: 'a@x', created: '2024-01-01' }]
    },
    analysis: {
      incidents: { active_details: [], top_by_instance: [], top_by_type: [], noisy_metrics: [], trending: {} },
      users: {
        details: [
          { id: 1, name: 'Alice', email: 'a@x', created: '2024-01-01',
            contact_methods: 1, last_login: '',
            active_assessment: 'Never', created_on: '' }
        ],
        issues: []
      }
    },
    customer: 'Acme'
  };
}

test('pdfFilename: pattern is {customer}_best-practice-assessment_{YYYYMMDD}.pdf', () => {
  assert.match(pdfFilename('Acme Corp'), /^acme-corp_best-practice-assessment_\d{8}\.pdf$/);
});

test('pdfFilename: blank customer falls back to generic prefix', () => {
  assert.match(pdfFilename(''), /^best-practice-assessment_best-practice-assessment_\d{8}\.pdf$/);
});

test('buildPrintableHtml: emits a complete HTML document with every tab section', () => {
  const html = buildPrintableHtml(fixtureCtx(), { customer: 'Acme', generatedAt: '2026-05-02T00:00:00Z' });
  assert.match(html, /^<!DOCTYPE html>/);
  assert.match(html, /<html lang="en">/);
  assert.match(html, /<\/html>$/);
  for (const tab of getTabs()) {
    assert.match(html, new RegExp(`id="tab-${tab.id}"`), `expected section anchor for ${tab.id}`);
  }
});

test('buildPrintableHtml: includes header block with customer + timestamp by default (no cover page)', () => {
  const html = buildPrintableHtml(fixtureCtx(), { customer: 'Acme', generatedAt: '2026-05-02T00:00:00Z' });
  assert.match(html, /<header>/);
  assert.match(html, />Acme</);
  assert.match(html, /2026-05-02T00:00:00Z/);
  // Cover and TOC are off by default.
  assert.equal(html.includes('class="cover"'), false);
  assert.equal(html.includes('class="toc"'), false);
});

test('buildPrintableHtml: coverPage:true emits cover + TOC with anchor links to every tab', () => {
  const html = buildPrintableHtml(fixtureCtx(), { customer: 'Acme', generatedAt: '2026-05-02T00:00:00Z', coverPage: true });
  assert.match(html, /class="cover"/);
  assert.match(html, /class="toc"/);
  for (const tab of getTabs()) {
    assert.match(html, new RegExp(`href="#tab-${tab.id}"`), `expected TOC link to ${tab.id}`);
  }
});

test('buildPrintableHtml: customer name is HTML-escaped to defend against injection through the field', () => {
  const html = buildPrintableHtml(fixtureCtx(), { customer: 'Acme <script>alert(1)</script> & Co' });
  assert.equal(html.includes('<script>alert(1)</script>'), false);
  assert.match(html, /Acme &lt;script&gt;alert\(1\)&lt;\/script&gt; &amp; Co/);
});

test('buildPrintableHtml: User Activity Last Login renders N/A when missing (FMN-143)', () => {
  const ctx = fixtureCtx();
  const html = buildPrintableHtml(ctx);
  // Alice has no last_login - cell value is 'N/A' (not a manual-input
  // annotation - that path was removed in FMN-143).
  assert.match(html, /<td[^>]*>N\/A<\/td>/);
});

test('buildPrintableHtml: empty section without alwaysIncludeHeader still renders its emptyText hint', () => {
  // The Incidents tab's "Active Incidents" goes empty when
  // analysis.incidents.active_details is []. Verify the empty-text hint
  // appears (so the PDF reader knows the section was checked).
  const html = buildPrintableHtml(fixtureCtx(), { customer: 'Acme' });
  assert.match(html, /No active incidents\./);
});

test('buildPrintableHtml: includes the print stylesheet inline so the iframe is self-contained', () => {
  const html = buildPrintableHtml(fixtureCtx(), { customer: 'Acme' });
  assert.match(html, /<style>[\s\S]*@page[\s\S]*<\/style>/);
  // No external stylesheet references.
  assert.equal(html.includes('<link rel="stylesheet"'), false);
});

test('buildPrintableHtml: every tab section gets an h2 heading with the tab label (HTML-escaped)', () => {
  const html = buildPrintableHtml(fixtureCtx(), { customer: 'Acme' });
  for (const tab of getTabs()) {
    // Tab labels are plain ASCII in the spec, so a literal substring match suffices.
    assert.ok(html.includes(`<h2>${tab.label}</h2>`), `expected <h2>${tab.label}</h2>`);
  }
});

test('buildPrintableHtml: tables get explicit thead/tbody for repeating headers across pages', () => {
  const html = buildPrintableHtml(fixtureCtx(), { customer: 'Acme' });
  assert.match(html, /<table><thead><tr>/);
  assert.match(html, /<\/tbody><\/table>/);
});
