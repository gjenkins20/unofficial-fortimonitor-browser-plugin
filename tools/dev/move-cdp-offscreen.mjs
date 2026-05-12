// Move the running :9222 Chromium window offscreen and minimize, without
// restarting it. Uses a Playwright CDPSession to call Browser.setWindowBounds.
import { chromium } from 'playwright';

const browser = await chromium.connectOverCDP('http://localhost:9222');
const context = browser.contexts()[0];
if (!context) { console.error('no context'); process.exit(1); }

// CDPSession at the browser-target level (not page) so we can call Browser.* commands.
const page = context.pages()[0];
const cdp = await context.newCDPSession(page);
const { windowId } = await cdp.send('Browser.getWindowForTarget', {});
console.log('windowId:', windowId);

await cdp.send('Browser.setWindowBounds', {
  windowId,
  bounds: { left: -32000, top: -32000, width: 1200, height: 800, windowState: 'normal' },
});
await cdp.send('Browser.setWindowBounds', {
  windowId,
  bounds: { windowState: 'minimized' },
});
console.log('Window moved offscreen and minimized');

await browser.close();
