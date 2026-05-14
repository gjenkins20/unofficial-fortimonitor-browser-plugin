#!/usr/bin/env node
// FMN-192 anchor probe.
// Connects to :9222, finds the FortiMonitor tab, returns outerHTML + computed
// selector candidates for the four FMN-192 spotlight targets:
//   1. Top-most bar (FortiCloud header)
//   2. +Add button (left sidebar)
//   3. Collapse button (left sidebar)
//   4. Control Panel (operator-named; probe candidates in main content area)
// Read-only. No clicks. No bringToFront.

import { chromium } from 'playwright';

const CDP_URL = 'http://localhost:9222';

function summarize(el) {
  if (!el) return null;
  return {
    tag: el.tagName?.toLowerCase(),
    id: el.id || null,
    classes: (el.className && typeof el.className === 'string')
      ? el.className.split(/\s+/).filter(Boolean) : null,
    text: (el.textContent || '').trim().slice(0, 80),
    outerHTML: (el.outerHTML || '').slice(0, 600),
    rect: el.getBoundingClientRect && (() => {
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
    })(),
  };
}

const browser = await chromium.connectOverCDP(CDP_URL);
const contexts = browser.contexts();
const pages = contexts.flatMap(c => c.pages());
const fmPage = pages.find(p => p.url().includes('fortimonitor.forticloud.com'));
if (!fmPage) {
  console.error('No fortimonitor.forticloud.com tab found');
  process.exit(1);
}
console.log(`Probing: ${fmPage.url()}\n`);

const result = await fmPage.evaluate(() => {
  const probe = (el) => {
    if (!el) return null;
    return {
      tag: el.tagName?.toLowerCase(),
      id: el.id || null,
      classes: (typeof el.className === 'string')
        ? el.className.split(/\s+/).filter(Boolean) : null,
      role: el.getAttribute('role'),
      ariaLabel: el.getAttribute('aria-label'),
      text: (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 100),
      outerHTML: (el.outerHTML || '').slice(0, 800),
      rect: (() => {
        const r = el.getBoundingClientRect();
        return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
      })(),
    };
  };

  const out = {};

  // ---- 1. Top-most bar (FortiCloud header) -----------------------------
  // Candidates: <header>, .pa-header, anything containing "Search all fields"
  const headerCandidates = [];
  document.querySelectorAll('header, [class*="header" i], [class*="topbar" i], [class*="top-bar" i]').forEach(el => {
    const r = el.getBoundingClientRect();
    if (r.top < 100 && r.width > 600) {
      headerCandidates.push(probe(el));
    }
  });
  // Search-input upward walk
  const searchInput = document.querySelector('input[placeholder*="Search all fields" i]');
  let searchAncestor = null;
  if (searchInput) {
    let cur = searchInput;
    for (let i = 0; i < 8 && cur; i++) {
      const r = cur.getBoundingClientRect();
      if (r.width > 800 && r.top < 100) { searchAncestor = cur; break; }
      cur = cur.parentElement;
    }
  }
  out.topMostBar = {
    headerCandidates,
    searchInputAncestor: probe(searchAncestor),
    rawSearchInput: probe(searchInput),
  };

  // ---- 2. +Add button --------------------------------------------------
  // Snippet: <span>Add</span>. Find spans with text exactly "Add" near bottom of sidebar.
  const addCandidates = [];
  document.querySelectorAll('span').forEach(span => {
    if (span.textContent.trim() === 'Add') {
      const r = span.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) {
        // Find clickable ancestor (button/a) for the actual spotlight target
        let clickable = span;
        for (let i = 0; i < 5 && clickable; i++) {
          if (clickable.tagName === 'BUTTON' || clickable.tagName === 'A' ||
              clickable.getAttribute('role') === 'button' ||
              window.getComputedStyle(clickable).cursor === 'pointer') break;
          clickable = clickable.parentElement;
        }
        addCandidates.push({
          span: probe(span),
          clickableAncestor: probe(clickable),
        });
      }
    }
  });
  out.addButton = addCandidates;

  // ---- 3. Collapse button ----------------------------------------------
  // Snippet: <svg><use xlink:href="#leftnav_collapse_24dp">
  const useEls = document.querySelectorAll('use');
  const collapseUses = [];
  useEls.forEach(useEl => {
    const href = useEl.getAttribute('xlink:href') || useEl.getAttribute('href') || '';
    if (href.includes('leftnav_collapse')) {
      // Walk up to the SVG, then to a clickable parent
      let cur = useEl;
      let svg = null;
      for (let i = 0; i < 4 && cur; i++) {
        if (cur.tagName?.toLowerCase() === 'svg') { svg = cur; break; }
        cur = cur.parentElement;
      }
      let clickable = svg || useEl;
      for (let i = 0; i < 5 && clickable; i++) {
        if (clickable.tagName === 'BUTTON' || clickable.tagName === 'A' ||
            clickable.getAttribute('role') === 'button' ||
            window.getComputedStyle(clickable).cursor === 'pointer') break;
        clickable = clickable.parentElement;
      }
      collapseUses.push({
        href,
        use: probe(useEl),
        svg: probe(svg),
        clickableAncestor: probe(clickable),
      });
    }
  });
  out.collapseButton = collapseUses;

  // ---- 4. "Control Panel" — operator-named, probe by text + likely candidates
  const controlPanelMatches = [];
  document.querySelectorAll('*').forEach(el => {
    const own = Array.from(el.childNodes).filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim();
    if (own === 'Control Panel' || own.toLowerCase() === 'control panel') {
      controlPanelMatches.push(probe(el));
    }
  });
  // Also look for FortiMonitor-typical layout containers in the main content area
  const mainContentCandidates = [];
  // Tab strip
  const tabStrip = document.querySelector('[role="tablist"]');
  if (tabStrip) mainContentCandidates.push({ kind: 'role=tablist', el: probe(tabStrip) });
  // Page title bar — likely contains the H1/h2 "Canned Reports"
  document.querySelectorAll('h1, h2').forEach(h => {
    const text = h.textContent.trim();
    if (text === 'Canned Reports') {
      mainContentCandidates.push({ kind: 'h1/h2 "Canned Reports"', el: probe(h) });
      // Its containing white card
      let cur = h.parentElement;
      for (let i = 0; i < 5 && cur; i++) {
        const bg = window.getComputedStyle(cur).backgroundColor;
        const r = cur.getBoundingClientRect();
        if (bg && bg.includes('255, 255, 255') && r.width > 400) {
          mainContentCandidates.push({ kind: `white-bg container (${i} up from h)`, el: probe(cur) });
          break;
        }
        cur = cur.parentElement;
      }
    }
  });
  out.controlPanel = {
    literalTextMatches: controlPanelMatches,
    mainContentCandidates,
  };

  return out;
});

console.log(JSON.stringify(result, null, 2));
await browser.close();
