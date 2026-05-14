import { chromium } from 'playwright';
const browser = await chromium.connectOverCDP('http://localhost:9222');
const fmPage = browser.contexts().flatMap(c => c.pages()).find(p => p.url().includes('fortimonitor.forticloud.com'));
const result = await fmPage.evaluate(() => {
  const tests = {
    'section.fn1-header': document.querySelector('section.fn1-header')?.outerHTML?.slice(0, 80) || null,
    'div.fn1-header': document.querySelector('div.fn1-header')?.outerHTML?.slice(0, 80) || null,
    '.fn1-header': document.querySelector('.fn1-header')?.outerHTML?.slice(0, 80) || null,
    'section.pa-page-header': document.querySelector('section.pa-page-header')?.outerHTML?.slice(0, 80) || null,
    'svg:has(use[*|href="#leftnav_collapse_24dp"])': (() => { try { return document.querySelector('svg:has(use[*|href="#leftnav_collapse_24dp"])')?.outerHTML?.slice(0, 80) || null; } catch(e) { return 'SELECTOR-ERROR: ' + e.message; } })(),
    'use[*|href="#leftnav_collapse_24dp"]': (() => { try { return document.querySelector('use[*|href="#leftnav_collapse_24dp"]')?.outerHTML?.slice(0, 80) || null; } catch(e) { return 'SELECTOR-ERROR: ' + e.message; } })(),
  };
  return tests;
});
console.log(JSON.stringify(result, null, 2));
await browser.close();
