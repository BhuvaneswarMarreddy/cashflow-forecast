/**
 * Activity on a phone, from the owner's live screenshot (390px): each row stacked an
 * avatar, a Pending badge, a merchant pill and a wrapping account pill beside three
 * icons, so rows ran several hundred pixels tall, the amount split across two lines,
 * and the page scrolled sideways (#177).
 */

import { test, expect, type Page } from '@playwright/test';

const LIVE_ENDPOINTS = /firestore\.googleapis\.com|identitytoolkit\.googleapis\.com|securetoken\.googleapis\.com|cloudfunctions\.net|bridge\.simplefin\.org/;

test.describe.configure({ timeout: 120_000 });

async function openActivity(page: Page, size: { width: number; height: number }) {
  await page.route(LIVE_ENDPOINTS, (r) => r.abort());
  await page.setViewportSize(size);
  await page.goto('/dev/activity-fixture', { waitUntil: 'load' });
  await expect(page.getByRole('heading', { name: 'Activity' })).toBeVisible({ timeout: 60_000 });
  await page.evaluate(() => Promise.all(
    document.getAnimations()
      .filter((a) => a.effect?.getComputedTiming().iterations !== Infinity)
      .map((a) => a.finished),
  ));
}

test('phone: one-line rows, amount on one line, no sideways scroll', async ({ page }) => {
  await openActivity(page, { width: 390, height: 844 });

  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow, 'page scrolls sideways by this many px').toBeLessThanOrEqual(1);

  const rows = page.locator('li').filter({ has: page.getByRole('button', { name: /^More actions for / }) });
  const count = await rows.count();
  expect(count).toBeGreaterThan(0);
  for (let i = 0; i < Math.min(count, 8); i++) {
    const box = (await rows.nth(i).boundingBox())!;
    expect(box.height, `row ${i} height`).toBeLessThanOrEqual(88);
    const amount = (await rows.nth(i).locator('p.whitespace-nowrap').boundingBox())!;
    expect(amount.height, `row ${i} amount wraps`).toBeLessThan(30);
  }

  await page.screenshot({ path: 'test-results/screens/activity-rows-phone.png', animations: 'disabled' });
});

test('phone: row actions live in one sheet, and Delete still asks to confirm', async ({ page }) => {
  await openActivity(page, { width: 390, height: 844 });
  await expect(page.getByRole('button', { name: /^Edit / })).toHaveCount(0); // inline icons hidden on phones

  await page.getByRole('button', { name: /^More actions for / }).first().click();
  const sheet = page.getByRole('dialog', { name: 'Transaction actions' });
  await expect(sheet.getByRole('button')).toHaveText([/Ask about this/, /Edit/, /Delete/]);

  await sheet.getByRole('button', { name: /Delete/ }).click();
  await expect(sheet).toBeHidden();
  await expect(page.getByRole('button', { name: /^Confirm delete / })).toBeVisible();
});

test('desktop: the three row actions stay inline, no More button', async ({ page }) => {
  await openActivity(page, { width: 1280, height: 800 });
  await expect(page.getByRole('button', { name: /^More actions for / })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^Edit / }).first()).toBeVisible();
  await page.screenshot({ path: 'test-results/screens/activity-rows-desktop.png', animations: 'disabled' });
});
