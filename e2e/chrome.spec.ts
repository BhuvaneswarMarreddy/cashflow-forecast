/**
 * UI spec Phase B acceptance in a real browser, on the fixture screens.
 *
 * - Phone: four tabs, one Add (in the header), nothing covering the Accounts tab.
 * - Activity links to Flow. (Activity staying lit on /flow is pinned in Jest,
 *   chrome-four-tabs.test.tsx: the fixture lives at /dev/flow-fixture, and the real /flow
 *   needs a signed-in session this spec never has.)
 * - Desktop: no tab bar; the one Add is the corner FAB.
 *
 * Live endpoints are blocked; this spec asserts chrome only.
 */

import { test, expect, type Page } from '@playwright/test';

const LIVE_ENDPOINTS = /firestore\.googleapis\.com|identitytoolkit\.googleapis\.com|securetoken\.googleapis\.com|cloudfunctions\.net|bridge\.simplefin\.org/;
const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1280, height: 800 };

test.describe.configure({ timeout: 120_000 });

async function open(page: Page, path: string, size: { width: number; height: number }) {
  await page.route(LIVE_ENDPOINTS, (r) => r.abort());
  await page.setViewportSize(size);
  await page.goto(path, { waitUntil: 'load' });
  await expect(page.getByRole('heading').first()).toBeVisible({ timeout: 60_000 });
  await page.evaluate(() => Promise.all(
    document.getAnimations()
      .filter((a) => a.effect?.getComputedTiming().iterations !== Infinity)
      .map((a) => a.finished),
  ));
}

test('phone: four tabs, one Add in the header, Accounts tab uncovered', async ({ page }) => {
  await open(page, '/dev/home-fixture', PHONE);

  const tabs = page.locator('nav[aria-label="Primary"]').getByRole('link');
  await expect(tabs).toHaveText(['Home', 'Forecast', 'Activity', 'Accounts']);

  const add = page.getByRole('button', { name: 'Add transaction' });
  await expect(add).toHaveCount(1); // the corner FAB is display:none on phones
  const addBox = (await add.boundingBox())!;
  expect(addBox.y + addBox.height, 'Add sits in the 64px header').toBeLessThanOrEqual(64);
  expect(addBox.width).toBeGreaterThanOrEqual(44);
  expect(addBox.height).toBeGreaterThanOrEqual(44);

  // Nothing is drawn over the Accounts tab: the topmost element at its centre is the tab.
  const accounts = page.locator('nav[aria-label="Primary"]').getByRole('link', { name: 'Accounts' });
  const box = (await accounts.boundingBox())!;
  const hit = await page.evaluate(([x, y]) => {
    const el = document.elementFromPoint(x, y);
    return el?.closest('a')?.textContent ?? null;
  }, [box.x + box.width / 2, box.y + box.height / 2]);
  expect(hit).toBe('Accounts');

  await add.click();
  await expect(page.getByRole('dialog', { name: 'Add transaction' })).toBeVisible();
  await page.keyboard.press('Escape');

  await page.screenshot({ path: 'test-results/screens/chrome-home-phone.png' });
});

test('phone: Activity offers "View as flow"', async ({ page }) => {
  await open(page, '/dev/activity-fixture', PHONE);
  await expect(page.getByRole('link', { name: /view as flow/i })).toHaveAttribute('href', '/flow');
  await page.screenshot({ path: 'test-results/screens/chrome-activity-phone.png' });
});

test('desktop: no tab bar, one Add as the corner FAB', async ({ page }) => {
  await open(page, '/dev/home-fixture', DESKTOP);
  await expect(page.locator('nav[aria-label="Primary"]')).toBeHidden();
  const add = page.getByRole('button', { name: 'Add transaction' });
  await expect(add).toHaveCount(1); // the header Add is display:none from md up
  const box = (await add.boundingBox())!;
  expect(box.x + box.width).toBeGreaterThan(DESKTOP.width - 100);
  expect(box.y + box.height).toBeGreaterThan(DESKTOP.height - 100);
  await page.screenshot({ path: 'test-results/screens/chrome-home-desktop.png' });
});
