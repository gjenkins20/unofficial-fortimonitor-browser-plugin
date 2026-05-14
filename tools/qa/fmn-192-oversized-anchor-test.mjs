#!/usr/bin/env node
// FMN-192: verify the positionCard fix for oversized anchors.
//
// Simulates div.pa-main on the FortiMonitor /users page (top:53, left:220,
// w:1052, h:903 on a 1272x958 viewport) and asserts the rendered caption
// card lands inside the viewport — previously it fell off-screen below
// because none of the auto-placement directions had room.
//
// Headless Playwright. No extension fixture, no operator session.

import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';

const RENDERER_PATH = new URL('../../extension/src/ui/intro-tour/step-renderer.js', import.meta.url).pathname;
const SCHEMA_PATH = new URL('../../extension/src/ui/intro-tour/step-schema.js', import.meta.url).pathname;
const rendererSrc = readFileSync(RENDERER_PATH, 'utf8');
const schemaSrc = readFileSync(SCHEMA_PATH, 'utf8');

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1272, height: 958 } });

// Inject both modules as <script type="module"> bundles via blob URLs, then
// expose renderStep on window. Keeps this probe dependency-free.
await page.setContent(`
<!doctype html>
<html><head><meta charset="utf-8">
<style>
  body { margin: 0; }
  .fake-pa-main {
    position: absolute; top: 53px; left: 220px;
    width: 1052px; height: 903px;
    background: #eef; outline: 1px dashed #99c;
  }
  .fmn-tour-card { background: #fff; border: 1px solid #ccc; padding: 12px; max-width: 320px; }
</style>
</head>
<body>
  <div id="huge-anchor" class="fake-pa-main">div.pa-main mock</div>
</body></html>
`);

const result = await page.evaluate(async ({ rendererSrc, schemaSrc }) => {
  // Wire schema as a blob URL, then renderer (which imports schema by
  // relative path). To keep imports working, replace the renderer's
  // relative schema import with a blob URL.
  const schemaBlob = new Blob([schemaSrc], { type: 'text/javascript' });
  const schemaUrl = URL.createObjectURL(schemaBlob);
  const patchedRenderer = rendererSrc.replace(
    /from\s+['"]\.\/step-schema\.js['"]/,
    `from '${schemaUrl}'`
  );
  const rendererBlob = new Blob([patchedRenderer], { type: 'text/javascript' });
  const rendererUrl = URL.createObjectURL(rendererBlob);
  const { renderStep } = await import(rendererUrl);

  const step = {
    id: 'control-panel-test',
    anchor: '#huge-anchor',
    anchor_fallback: 'body',
    caption_html: '<p>Control Panel caption mock.</p>',
    advance: 'next-button',
    placement: 'auto'
  };
  const handle = renderStep(step);
  const card = document.querySelector('.fmn-tour-card');
  if (!card) return { error: 'no card rendered' };
  const r = card.getBoundingClientRect();
  return {
    placementResolved: card.getAttribute('data-placement-resolved'),
    cardRect: { top: r.top, left: r.left, right: r.right, bottom: r.bottom, w: r.width, h: r.height },
    viewport: { w: window.innerWidth, h: window.innerHeight },
    inViewport: r.top >= 0 && r.bottom <= window.innerHeight && r.left >= 0 && r.right <= window.innerWidth,
    cardPosition: card.style.position,
  };
}, { rendererSrc, schemaSrc });

console.log(JSON.stringify(result, null, 2));

// Assertions
const ok = result.placementResolved === 'center' && result.inViewport && result.cardPosition === 'fixed';
console.log(ok ? '\nPASS: oversized anchor falls back to viewport-centered fixed card.' : '\nFAIL.');

await browser.close();
process.exit(ok ? 0 : 1);
