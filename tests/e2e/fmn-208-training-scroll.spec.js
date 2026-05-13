// FMN-208: verify the Training section now lives inside the same scroll
// container as the alphabetized tool list, and that the training tile
// moves along with the rest of the list when the container scrolls.
//
// Pre-fix: #training-section was a sibling of #tool-list and only the
// tool list had overflow:auto, so the training tile stayed visually
// pinned while tools scrolled underneath it.

import { test, expect } from './fixtures.js';

test.describe('FMN-208 - training tile scrolls with tool list', () => {
  test.beforeEach(async ({ extensionContext, extensionId }) => {
    const page = await extensionContext.newPage();
    // Constrain viewport so the popup-mode media query is the one in effect
    // (the >=500px branch removes the scroll clamp for tab-mode rendering).
    await page.setViewportSize({ width: 420, height: 640 });
    await page.goto(`chrome-extension://${extensionId}/src/popup/popup.html`);
    // Wait for the tool list to render at least one card.
    await expect(page.locator('.tool-card[data-tool="find-servers"]')).toBeAttached();
    // Reveal the Training section regardless of flag state.
    await page.evaluate(() => {
      const section = document.getElementById('training-section');
      if (section) section.hidden = false;
    });
    test.info()._page = page;
  });

  test.afterEach(async () => {
    const page = test.info()._page;
    if (page) await page.close();
  });

  test('#tool-scroll contains both #training-section and #tool-list', async () => {
    const page = test.info()._page;
    const result = await page.evaluate(() => {
      const scroll = document.getElementById('tool-scroll');
      const training = document.getElementById('training-section');
      const list = document.getElementById('tool-list');
      return {
        scrollExists: !!scroll,
        trainingIsDescendant: !!(scroll && training && scroll.contains(training)),
        listIsDescendant: !!(scroll && list && scroll.contains(list)),
      };
    });
    expect(result.scrollExists).toBe(true);
    expect(result.trainingIsDescendant).toBe(true);
    expect(result.listIsDescendant).toBe(true);
  });

  test('#tool-scroll is the overflow viewport (auto + clamped height)', async () => {
    const page = test.info()._page;
    const cs = await page.evaluate(() => {
      const el = document.getElementById('tool-scroll');
      const s = getComputedStyle(el);
      return { overflowY: s.overflowY, maxHeight: s.maxHeight };
    });
    expect(cs.overflowY).toBe('auto');
    expect(cs.maxHeight).toBe('360px');
  });

  test('#tool-list no longer owns the scroll (overflow-y is visible)', async () => {
    const page = test.info()._page;
    const cs = await page.evaluate(() => {
      const el = document.getElementById('tool-list');
      const s = getComputedStyle(el);
      return { overflowY: s.overflowY };
    });
    // After the fix the inner list should not be a scroll container itself.
    expect(cs.overflowY).toBe('visible');
  });

  test('training tile moves with the list when #tool-scroll scrolls', async () => {
    const page = test.info()._page;
    // Confirm the wrapper actually overflows (content > viewport).
    const overflowState = await page.evaluate(() => {
      const el = document.getElementById('tool-scroll');
      return { scrollHeight: el.scrollHeight, clientHeight: el.clientHeight };
    });
    expect(overflowState.scrollHeight).toBeGreaterThan(overflowState.clientHeight);

    const before = await page.evaluate(() => {
      const tile = document.getElementById('training-intro-tour-tile');
      return tile.getBoundingClientRect().top;
    });

    // Scroll the wrapper by half its overflow so the delta is unambiguous.
    await page.evaluate(() => {
      const el = document.getElementById('tool-scroll');
      el.scrollTop = Math.max(40, Math.floor((el.scrollHeight - el.clientHeight) / 2));
    });

    const after = await page.evaluate(() => {
      const tile = document.getElementById('training-intro-tour-tile');
      return tile.getBoundingClientRect().top;
    });

    // After the fix, scrolling the wrapper must move the training tile up
    // (top decreases). Pre-fix the tile sat outside the scroll viewport and
    // this delta was 0.
    expect(after).toBeLessThan(before - 20);
  });
});
