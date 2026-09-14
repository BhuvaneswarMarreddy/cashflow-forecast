/**
 * Every fixture screen opens, at phone and desktop width, without crashing,
 * overflowing sideways, or touching live data.
 *
 * The fixture routes supply their React contexts from fixtures and have no code
 * path to Firebase (see accounts-observability.spec.ts), so this is safe in CI.
 * Screenshots land in test-results/screens/ and are uploaded with the run: they
 * are the PR's visual preview.
 */

import { test, expect } from '@playwright/test';

const ROUTES = ['home', 'accounts', 'activity', 'bills', 'flow', 'forecast'];
const WIDTHS = [
  { name: 'phone', width: 390, height: 844 },
  { name: 'desktop', width: 1280, height: 800 },
];

/** Same tripwire as the observability spec: the run must never reach the real project. */
const LIVE_ENDPOINTS = /firestore\.googleapis\.com|identitytoolkit\.googleapis\.com|securetoken\.googleapis\.com|cloudfunctions\.net|bridge\.simplefin\.org/;

/**
 * Known defects this spec found on day one. `test.fail` means the test must
 * still fail: fix the issue and the run goes red until its line is deleted.
 */
const KNOWN: Record<string, string> = {
  'flow@phone': '#176 reads Firestore directly', 'flow@desktop': '#176 reads Firestore directly',
  'forecast@phone': '#176 reads Firestore directly', 'forecast@desktop': '#176 reads Firestore directly',
  'activity@phone': '#177 scrolls sideways 4px',
  'accounts@phone': '#178 hydration mismatch', 'accounts@desktop': '#178 hydration mismatch',
};

test.describe.configure({ timeout: 120_000 });

for (const size of WIDTHS) {
  for (const route of ROUTES) {
    test(`${route} at ${size.name} width`, async ({ page }) => {
      const known = KNOWN[`${route}@${size.name}`];
      test.fail(!!known, known);

      const crashes: string[] = [];
      const liveHits: string[] = [];
      page.on('pageerror', (e) => crashes.push(e.message));
      // Record AND block: a regression here must never actually reach production.
      await page.route(LIVE_ENDPOINTS, (r) => { liveHits.push(r.request().url()); return r.abort(); });

      await page.setViewportSize(size);
      // Not 'networkidle': a page holding a Firestore listen channel never goes idle,
      // and the tripwire below is what should report that, not a timeout.
      const response = await page.goto(`/dev/${route}-fixture`, { waitUntil: 'load' });
      expect(response?.status()).toBe(200);

      // Something real rendered: a heading, not a blank shell or an error boundary.
      // Generous: `next dev` compiles each route on its first visit, slowly on a CI runner.
      await expect(page.getByRole('heading').first()).toBeVisible({ timeout: 60_000 });
      // ponytail: fixed settle for mount-time effects (listeners, late layout); swap for a
      // per-screen ready marker if this ever flakes.
      await page.waitForTimeout(1500);
      // Before any assertion, so a failing screen still leaves its picture.
      await page.screenshot({ path: `test-results/screens/${route}-${size.name}.png`, fullPage: true });

      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(overflow, 'page scrolls sideways by this many px').toBeLessThanOrEqual(1);

      expect(crashes, 'uncaught errors in the page').toEqual([]);
      expect(liveHits, 'requests to live Firebase/SimpleFIN endpoints').toEqual([]);
    });
  }
}
