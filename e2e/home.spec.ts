/**
 * UI spec Phase C acceptance on the Home fixture (the real DashboardPage).
 *
 * - Phone: the runway hero fits in the first screenful, with no filter pile.
 * - "What changed" shows at most five rows; "Next bills" at most three, linking to all bills.
 * - Desktop: the two lists sit side by side under a full-measure hero.
 */

import { test, expect, type Page } from '@playwright/test';

const LIVE_ENDPOINTS = /firestore\.googleapis\.com|identitytoolkit\.googleapis\.com|securetoken\.googleapis\.com|cloudfunctions\.net|bridge\.simplefin\.org/;

test.describe.configure({ timeout: 120_000 });

async function openHome(page: Page, size: { width: number; height: number }) {
  await page.route(LIVE_ENDPOINTS, (r) => r.abort());
  await page.setViewportSize(size);
  await page.goto('/dev/home-fixture', { waitUntil: 'load' });
  await expect(page.getByText('Runway', { exact: true })).toBeVisible({ timeout: 60_000 });
  await page.evaluate(() => Promise.all(
    document.getAnimations()
      .filter((a) => a.effect?.getComputedTiming().iterations !== Infinity)
      .map((a) => a.finished),
  ));
}

const section = (page: Page, heading: string) =>
  page.locator('section').filter({ has: page.getByRole('heading', { name: heading }) });

test('phone: runway first, then what changed and next bills, no filter pile', async ({ page }) => {
  const size = { width: 390, height: 844 };
  await openHome(page, size);

  const hero = page.locator('section').filter({ has: page.getByText('Runway', { exact: true }) });
  const heroBox = (await hero.boundingBox())!;
  expect(heroBox.y + heroBox.height, 'runway hero bottom vs first screenful').toBeLessThanOrEqual(size.height);

  await expect(page.getByRole('group', { name: 'Filter transactions' })).toHaveCount(0);

  // A long bank description once stretched the implicit grid column: 137px sideways scroll.
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow, 'page scrolls sideways by this many px').toBeLessThanOrEqual(1);

  const changed = section(page, 'What changed');
  await expect(changed).toBeVisible();
  const changedRows = await changed.getByRole('listitem').count();
  expect(changedRows).toBeGreaterThan(0);
  expect(changedRows).toBeLessThanOrEqual(5);

  const bills = section(page, 'Next bills');
  await expect(bills).toBeVisible();
  const billRows = await bills.getByRole('listitem').count();
  expect(billRows).toBeGreaterThan(0);
  expect(billRows).toBeLessThanOrEqual(3);
  await expect(bills.getByRole('link', { name: 'All bills' })).toHaveAttribute('href', '/forecast?tab=bills');

  // Order on a phone: hero, then what changed, then next bills.
  const changedBox = (await changed.boundingBox())!;
  const billsBox = (await bills.boundingBox())!;
  expect(changedBox.y).toBeGreaterThan(heroBox.y);
  expect(billsBox.y).toBeGreaterThan(changedBox.y);

  await page.screenshot({ path: 'test-results/screens/home-c-phone.png', fullPage: true, animations: 'disabled' });
});

test('desktop: what changed and next bills side by side under the hero', async ({ page }) => {
  await openHome(page, { width: 1280, height: 800 });
  const changed = (await section(page, 'What changed').boundingBox())!;
  const bills = (await section(page, 'Next bills').boundingBox())!;
  expect(Math.abs(changed.y - bills.y), 'same row').toBeLessThan(2);
  expect(bills.x).toBeGreaterThan(changed.x + changed.width - 1);
  await page.screenshot({ path: 'test-results/screens/home-c-desktop.png', fullPage: true, animations: 'disabled' });
});
