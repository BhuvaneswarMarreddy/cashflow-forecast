/**
 * #198 acceptance on the Forecast fixture (the real ForecastPage).
 * Live endpoints are blocked (this fixture still reads savings goals directly, #176).
 */

import { test, expect, type Page } from '@playwright/test';

const LIVE_ENDPOINTS = /firestore\.googleapis\.com|identitytoolkit\.googleapis\.com|securetoken\.googleapis\.com|cloudfunctions\.net|bridge\.simplefin\.org/;

test.describe.configure({ timeout: 120_000 });

async function openForecast(page: Page, size: { width: number; height: number }, query = '') {
  await page.route(LIVE_ENDPOINTS, (r) => r.abort());
  await page.setViewportSize(size);
  await page.goto(`/dev/forecast-fixture${query}`, { waitUntil: 'load' });
  await expect(page.getByRole('heading', { name: 'Forecast', exact: true })).toBeVisible({ timeout: 60_000 });
  await page.evaluate(() => Promise.all(
    document.getAnimations()
      .filter((a) => a.effect?.getComputedTiming().iterations !== Infinity)
      .map((a) => a.finished),
  ));
}

test('phone: two tabs, 3M default, chart then "Can I afford this?", Outflows, collapsed Assumptions', async ({ page }) => {
  const size = { width: 390, height: 844 };
  await openForecast(page, size);

  const tabs = page.getByRole('tablist', { name: 'Forecast views' }).getByRole('tab');
  await expect(tabs).toHaveText(['Plan', 'Month']);
  await expect(tabs.first()).toHaveAttribute('aria-selected', 'true');

  const chips = page.getByRole('group', { name: 'Forecast period' }).getByRole('button');
  await expect(chips).toHaveText(['1M', '3M', '6M', '1Y']);
  await expect(chips.nth(1)).toHaveAttribute('aria-pressed', 'true');
  const tops = await chips.evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().top)));
  expect(new Set(tops).size, 'chips on one row').toBe(1);

  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow, 'page scrolls sideways by this many px').toBeLessThanOrEqual(1);

  const chartBox = (await page.getByRole('img', { name: /Area chart projecting cash balance/ }).boundingBox())!;
  expect(chartBox.height, 'phone chart height').toBeLessThanOrEqual(220);

  const decision = (await page.getByRole('heading', { name: 'Can I Afford This?' }).boundingBox())!;
  const outflows = (await page.getByRole('heading', { name: 'Outflows' }).boundingBox())!;
  expect(decision.y).toBeGreaterThan(chartBox.y + chartBox.height);
  expect(outflows.y).toBeGreaterThan(decision.y);

  // One top-level disclosure (the panels inside it carry their own nested ones).
  const topLevel = await page.evaluate(() =>
    [...document.querySelectorAll('details')]
      .filter((d) => !d.parentElement?.closest('details'))
      .map((d) => ({ open: d.open, summary: d.querySelector('summary')?.textContent ?? '' })),
  );
  expect(topLevel).toHaveLength(1);
  expect(topLevel[0].summary).toMatch(/^Assumptions/);
  expect(topLevel[0].open).toBe(false);

  await page.screenshot({ path: 'test-results/screens/forecast-plan-phone.png', fullPage: true, animations: 'disabled' });
});

test('Month tab and ?tab=cashflow land on the same view', async ({ page }) => {
  await openForecast(page, { width: 390, height: 844 }, '?tab=cashflow');
  const tabs = page.getByRole('tablist', { name: 'Forecast views' }).getByRole('tab');
  await expect(tabs.nth(1)).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('heading', { name: 'Income vs Spending, by month' })).toBeVisible();
  await tabs.first().click();
  await expect(page).toHaveURL(/\/dev\/forecast-fixture$|\/forecast$/);
});

test('"Edit bills" opens the bills editor without a third tab, and comes back', async ({ page }) => {
  await openForecast(page, { width: 390, height: 844 });
  await page.getByRole('button', { name: 'Edit bills' }).click();
  await expect(page).toHaveURL(/\?tab=bills$/);
  await expect(page.getByRole('tablist', { name: 'Forecast views' })).toHaveCount(0);
  await page.getByRole('button', { name: '← Back to plan' }).click();
  await expect(page.getByRole('tablist', { name: 'Forecast views' })).toBeVisible();
});

test('desktop: content on the 896px measure', async ({ page }) => {
  await openForecast(page, { width: 1280, height: 800 });
  const main = (await page.locator('main').boundingBox())!;
  expect(main.width).toBeLessThanOrEqual(896);
  await page.screenshot({ path: 'test-results/screens/forecast-plan-desktop.png', fullPage: true, animations: 'disabled' });
});
