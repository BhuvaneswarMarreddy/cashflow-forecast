/**
 * #200 acceptance on the Accounts fixture (the real AccountsPage).
 */

import { test, expect, type Page } from '@playwright/test';

const LIVE_ENDPOINTS = /firestore\.googleapis\.com|identitytoolkit\.googleapis\.com|securetoken\.googleapis\.com|cloudfunctions\.net|bridge\.simplefin\.org/;

test.describe.configure({ timeout: 120_000 });

async function openAccounts(page: Page, size: { width: number; height: number }) {
  await page.route(LIVE_ENDPOINTS, (r) => r.abort());
  await page.setViewportSize(size);
  await page.goto('/dev/accounts-fixture', { waitUntil: 'load' });
  await expect(page.getByRole('heading', { name: 'Accounts', exact: true })).toBeVisible({ timeout: 60_000 });
  await page.evaluate(() => Promise.all(
    document.getAnimations()
      .filter((a) => a.effect?.getComputedTiming().iterations !== Infinity)
      .map((a) => a.finished),
  ));
}

test('phone: Connect visible without scrolling, two numbers, grouped list, tools below', async ({ page }) => {
  const size = { width: 390, height: 844 };
  await openAccounts(page, size);

  const connect = page.getByRole('button', { name: 'Connect a bank through Plaid' });
  const box = (await connect.boundingBox())!;
  expect(box.y + box.height, 'Connect bank inside the first screenful').toBeLessThanOrEqual(size.height);
  await expect(page.getByRole('button', { name: /Import CSV/ })).toBeVisible();
  await expect(page.getByText(/Apple Card and Indian accounts/)).toBeVisible();

  await expect(page.getByText('Net Worth')).toHaveCount(0);
  const heroLabels = page.locator('.stat-card > span');
  await expect(heroLabels).toHaveText(['Cash', 'Debt']);

  const accountsHeading = (await page.getByRole('heading', { name: /Your accounts/ }).boundingBox())!;
  const toolsHeading = (await page.getByRole('heading', { name: 'Tools' }).boundingBox())!;
  expect(toolsHeading.y).toBeGreaterThan(accountsHeading.y);
  await expect(page.getByRole('heading', { name: 'Cash', level: 3 })).toBeVisible();

  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow, 'page scrolls sideways by this many px').toBeLessThanOrEqual(1);

  await page.screenshot({ path: 'test-results/screens/accounts-phone.png', fullPage: true, animations: 'disabled' });
});

test('desktop: content on the 896px measure', async ({ page }) => {
  await openAccounts(page, { width: 1280, height: 800 });
  const main = (await page.locator('main').boundingBox())!;
  expect(main.width).toBeLessThanOrEqual(896);
  await page.screenshot({ path: 'test-results/screens/accounts-desktop.png', fullPage: true, animations: 'disabled' });
});
