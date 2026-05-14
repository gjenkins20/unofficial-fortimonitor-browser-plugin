// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// FMN-167: pure step-to-DOM renderer. No engine state, no chrome.* APIs.
// Given a normalized step + a target document, builds the overlay /
// spotlight / caption card and returns a teardown handle.

import { normalizeStep } from './step-schema.js';

// Allowed tags + attributes for caption HTML. Anything else is dropped.
// Kept deliberately small for v1; expand only when a real step needs it.
const ALLOWED_TAGS = new Set([
  'P', 'STRONG', 'EM', 'CODE', 'UL', 'OL', 'LI', 'A', 'BR', 'SPAN'
]);
const ALLOWED_ATTRS_BY_TAG = {
  A: new Set(['href', 'target', 'rel']),
  SPAN: new Set(['class'])
};
// Hard cap on URL length to keep sanitized output bounded.
const MAX_HREF_LENGTH = 2048;

/**
 * Render a step against a host document. The host is typically the
 * top-level document on a FortiMonitor page (live use) or a fixture
 * document inside a harness (tests). The renderer is identical in both
 * cases - all chrome.* + storage I/O lives in the engine.
 *
 * Returns:
 *   {
 *     hostNode,  // top-level container appended to host.body
 *     cardNode,  // the caption card inside hostNode
 *     nextButton, // the Next button element (null when advance !== 'next-button')
 *     dispose()  // removes hostNode + observers
 *   }
 *
 * Options:
 *   doc      - target document (default: globalThis.document)
 *   onNext   - callback for the Next button click. No-op if not provided.
 *   onDismiss- callback for the X button click. No-op if not provided.
 *
 * Anchor resolution:
 *   - If `step.anchor` resolves at call time, the spotlight + card are
 *     positioned relative to that node.
 *   - If it does not resolve, the renderer uses `step.anchor_fallback`
 *     (default 'body') and renders the card as a floating panel without
 *     a spotlight. The engine is responsible for waiting on the anchor
 *     with a MutationObserver before calling renderStep - this renderer
 *     does one synchronous resolution attempt and commits.
 */
export function renderStep(stepInput, opts = {}) {
  const step = isAlreadyNormalized(stepInput) ? stepInput : normalizeStep(stepInput);
  const doc = opts.doc || (typeof document !== 'undefined' ? document : null);
  if (!doc) throw new Error('renderStep: no document available');
  const onNext = typeof opts.onNext === 'function' ? opts.onNext : noop;
  const onDismiss = typeof opts.onDismiss === 'function' ? opts.onDismiss : noop;

  const host = doc.createElement('div');
  host.className = 'fmn-tour-overlay';
  host.setAttribute('data-fmn-tour-step', step.id);
  host.setAttribute('role', 'dialog');
  host.setAttribute('aria-modal', 'false');
  host.setAttribute('aria-label', 'FortiMonitor tour');

  let anchorNode = null;
  try {
    anchorNode = step.anchor ? doc.querySelector(step.anchor) : null;
  } catch {
    anchorNode = null;
  }
  if (!anchorNode) {
    try {
      anchorNode = doc.querySelector(step.anchor_fallback);
    } catch {
      anchorNode = null;
    }
  }
  const usingFallback = !!anchorNode && step.anchor && !doc.querySelector(safeSelector(step.anchor));

  // Spotlight: a positioned div that visually frames the anchor. When the
  // anchor is body (fallback floating case), we skip it entirely - the
  // caption card renders as a centered floating panel.
  const isFloatingFallback = !anchorNode || anchorNode === doc.body;
  let spotlight = null;
  if (!isFloatingFallback) {
    spotlight = doc.createElement('div');
    spotlight.className = 'fmn-tour-spotlight';
    spotlight.setAttribute('aria-hidden', 'true');
    host.appendChild(spotlight);
    positionSpotlight(spotlight, anchorNode, doc);
  } else {
    host.classList.add('fmn-tour-overlay--floating');
  }

  const card = doc.createElement('div');
  card.className = 'fmn-tour-card';
  card.setAttribute('data-placement', step.placement);
  if (usingFallback) card.setAttribute('data-anchor-fallback', 'true');
  host.appendChild(card);

  const dismissBtn = doc.createElement('button');
  dismissBtn.type = 'button';
  dismissBtn.className = 'fmn-tour-dismiss';
  dismissBtn.setAttribute('aria-label', 'Dismiss tour');
  dismissBtn.textContent = '×';
  dismissBtn.addEventListener('click', () => onDismiss(step));
  card.appendChild(dismissBtn);

  const body = doc.createElement('div');
  body.className = 'fmn-tour-card-body';
  appendSanitizedCaption(body, step, doc);
  card.appendChild(body);

  const footer = doc.createElement('div');
  footer.className = 'fmn-tour-card-footer';
  let nextBtn = null;
  if (step.advance === 'next-button') {
    nextBtn = doc.createElement('button');
    nextBtn.type = 'button';
    nextBtn.className = 'fmn-tour-next';
    nextBtn.textContent = 'Next';
    nextBtn.addEventListener('click', () => onNext(step));
    footer.appendChild(nextBtn);
  } else if (step.advance === 'click') {
    const hint = doc.createElement('span');
    hint.className = 'fmn-tour-hint';
    hint.textContent = 'Click the highlighted element to continue.';
    footer.appendChild(hint);
  } else if (step.advance === 'auto') {
    const hint = doc.createElement('span');
    hint.className = 'fmn-tour-hint';
    hint.textContent = 'Continuing automatically...';
    footer.appendChild(hint);
  }
  card.appendChild(footer);

  // Position the card after appending - getBoundingClientRect needs the
  // node to be in the DOM (and the host to be appended to body).
  doc.body.appendChild(host);
  if (!isFloatingFallback) positionCard(card, anchorNode, step.placement, doc);

  return {
    hostNode: host,
    cardNode: card,
    nextButton: nextBtn,
    dispose() {
      try { host.remove(); } catch { /* noop */ }
    }
  };
}

function isAlreadyNormalized(s) {
  return s
    && typeof s === 'object'
    && Object.isFrozen(s)
    && 'caption_html' in s
    && 'anchor_fallback' in s
    && 'auto_ms' in s;
}

function appendSanitizedCaption(target, step, doc) {
  if (step.caption_html) {
    const cleaned = sanitizeHtml(step.caption_html, doc);
    target.appendChild(cleaned);
    return;
  }
  if (step.caption_markdown) {
    const html = markdownToHtml(step.caption_markdown);
    const cleaned = sanitizeHtml(html, doc);
    target.appendChild(cleaned);
    return;
  }
  // Should never happen for a validated step; render an empty placeholder
  // rather than crash.
  const placeholder = doc.createElement('p');
  placeholder.className = 'fmn-tour-caption-empty';
  placeholder.textContent = '(no caption)';
  target.appendChild(placeholder);
}

/**
 * Parse + sanitize caption HTML. Returns a DocumentFragment. Only tags
 * in ALLOWED_TAGS survive; only attributes in ALLOWED_ATTRS_BY_TAG[tag]
 * survive on those tags. event handler attrs (onclick etc.) are dropped
 * unconditionally because they're not in any allowed-attr set.
 */
function sanitizeHtml(html, doc) {
  const tpl = doc.createElement('template');
  tpl.innerHTML = String(html);
  const out = doc.createDocumentFragment();
  for (const node of Array.from(tpl.content.childNodes)) {
    const safe = sanitizeNode(node, doc);
    if (safe) out.appendChild(safe);
  }
  return out;
}

function sanitizeNode(node, doc) {
  if (node.nodeType === 3 /* TEXT_NODE */) {
    return doc.createTextNode(node.nodeValue || '');
  }
  if (node.nodeType !== 1 /* ELEMENT_NODE */) return null;
  const tag = node.tagName;
  if (!ALLOWED_TAGS.has(tag)) {
    // Drop the tag but keep its text children inline.
    const frag = doc.createDocumentFragment();
    for (const child of Array.from(node.childNodes)) {
      const safe = sanitizeNode(child, doc);
      if (safe) frag.appendChild(safe);
    }
    return frag;
  }
  const el = doc.createElement(tag.toLowerCase());
  const allowed = ALLOWED_ATTRS_BY_TAG[tag] || new Set();
  for (const attr of Array.from(node.attributes || [])) {
    if (!allowed.has(attr.name.toLowerCase())) continue;
    if (attr.name.toLowerCase() === 'href') {
      const v = String(attr.value || '').trim();
      if (v.length > MAX_HREF_LENGTH) continue;
      if (!/^https?:\/\//i.test(v) && !v.startsWith('/')) continue;
      el.setAttribute('href', v);
      el.setAttribute('target', '_blank');
      el.setAttribute('rel', 'noopener noreferrer');
      continue;
    }
    el.setAttribute(attr.name, attr.value);
  }
  for (const child of Array.from(node.childNodes)) {
    const safe = sanitizeNode(child, doc);
    if (safe) el.appendChild(safe);
  }
  return el;
}

/**
 * Tiny markdown converter. Supports: paragraphs, **bold**, *italic*,
 * `code`, links [text](url), and -/* bullet lists. Anything else passes
 * through as text (then through sanitizeHtml, which drops unsafe tags).
 */
function markdownToHtml(md) {
  const lines = String(md).split(/\r?\n/);
  const blocks = [];
  let buf = [];
  let inList = false;
  function flushParagraph() {
    if (buf.length === 0) return;
    blocks.push(`<p>${inlineMd(buf.join(' '))}</p>`);
    buf = [];
  }
  function flushList() {
    if (!inList) return;
    blocks.push('</ul>');
    inList = false;
  }
  for (const raw of lines) {
    const line = raw.trim();
    if (line === '') {
      flushParagraph();
      flushList();
      continue;
    }
    const bullet = line.match(/^[-*]\s+(.*)$/);
    if (bullet) {
      flushParagraph();
      if (!inList) {
        blocks.push('<ul>');
        inList = true;
      }
      blocks.push(`<li>${inlineMd(bullet[1])}</li>`);
      continue;
    }
    flushList();
    buf.push(line);
  }
  flushParagraph();
  flushList();
  return blocks.join('');
}

function inlineMd(s) {
  return String(s)
    .replace(/`([^`]+)`/g, (_, code) => `<code>${escapeText(code)}</code>`)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
}

function escapeText(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function positionSpotlight(spotlightEl, anchor, doc) {
  const rect = anchor.getBoundingClientRect();
  const win = doc.defaultView || globalThis;
  const scrollX = win.scrollX || win.pageXOffset || 0;
  const scrollY = win.scrollY || win.pageYOffset || 0;
  // Add a small padding so the spotlight visibly frames the anchor.
  const PAD = 6;
  spotlightEl.style.position = 'absolute';
  spotlightEl.style.top = `${rect.top + scrollY - PAD}px`;
  spotlightEl.style.left = `${rect.left + scrollX - PAD}px`;
  spotlightEl.style.width = `${rect.width + PAD * 2}px`;
  spotlightEl.style.height = `${rect.height + PAD * 2}px`;
}

function positionCard(cardEl, anchor, placement, doc) {
  const rect = anchor.getBoundingClientRect();
  const win = doc.defaultView || globalThis;
  const scrollX = win.scrollX || win.pageXOffset || 0;
  const scrollY = win.scrollY || win.pageYOffset || 0;
  const cardRect = cardEl.getBoundingClientRect();
  const cardW = cardRect.width || 320;
  const cardH = cardRect.height || 120;
  const docW = doc.documentElement.clientWidth || 1024;
  const docH = doc.documentElement.clientHeight || 768;

  // Room on each side of the anchor in the viewport. Used both by the
  // 'auto' placement chooser and (FMN-192) by the oversized-anchor
  // fallback that switches to a viewport-centered floating card when no
  // edge has room. The Control Panel step anchors on div.pa-main which
  // covers nearly the full viewport, so none of the edge placements fit.
  const rightRoom = docW - rect.right;
  const leftRoom = rect.left;
  const topRoom = rect.top;
  const bottomRoom = docH - rect.bottom;

  let resolved = placement;
  if (placement === 'auto') {
    resolved = rightRoom >= cardW + 20 ? 'right'
      : leftRoom >= cardW + 20 ? 'left'
      : bottomRoom >= cardH + 20 ? 'bottom'
      : topRoom >= cardH + 20 ? 'top'
      : 'center';
  }

  const GAP = 12;

  if (resolved === 'center') {
    // Anchor too large for any edge placement (typical for whole-workspace
    // anchors like div.pa-main). Float the card centered in the viewport
    // using fixed positioning so scroll doesn't drag it off.
    cardEl.style.position = 'fixed';
    cardEl.style.top = `${Math.max(20, (docH - cardH) / 2)}px`;
    cardEl.style.left = `${Math.max(20, (docW - cardW) / 2)}px`;
    cardEl.setAttribute('data-placement-resolved', 'center');
    return;
  }

  let top, left;
  switch (resolved) {
    case 'right':
      top = rect.top + scrollY;
      left = rect.right + scrollX + GAP;
      break;
    case 'left':
      top = rect.top + scrollY;
      left = rect.left + scrollX - cardW - GAP;
      break;
    case 'top':
      top = rect.top + scrollY - cardH - GAP;
      left = rect.left + scrollX;
      break;
    case 'bottom':
    default:
      top = rect.bottom + scrollY + GAP;
      left = rect.left + scrollX;
      break;
  }
  cardEl.style.position = 'absolute';
  cardEl.style.top = `${Math.max(0, top)}px`;
  cardEl.style.left = `${Math.max(0, left)}px`;
  cardEl.setAttribute('data-placement-resolved', resolved);
}

function safeSelector(sel) {
  // querySelector throws on invalid syntax. Wrap so the engine's "did
  // this resolve" check doesn't throw a second time after the first try.
  return String(sel);
}

function noop() { /* intentionally empty */ }
