/**
 * #199 acceptance on the Flow fixture (the real FlowPage). Live endpoints are blocked:
 * this fixture still reads links/candidates directly (#176).
 */

import { test, expect, type Page } from '@playwright/test';

const LIVE_ENDPOINTS = /firestore\.googleapis\.com|identitytoolkit\.googleapis\.com|securetoken\.googleapis\.com|cloudfunctions\.net|bridge\.simplefin\.org/;

test.describe.configure({ timeout: 120_000 });

async function openFlow(page: Page, size: { width: number; height: number }) {
  await page.route(LIVE_ENDPOINTS, (r) => r.abort());
  await page.addInitScript(() => localStorage.setItem('flow-chart-view', 'detailed')); // desktop habit
  await page.setViewportSize(size);
  await page.goto('/dev/flow-fixture', { waitUntil: 'load' });
  await expect(page.getByRole('heading', { name: 'Money flow' })).toBeVisible({ timeout: 60_000 });
  await page.evaluate(() => Promise.all(
    document.getAnimations()
      .filter((a) => a.effect?.getComputedTiming().iterations !== Infinity)
      .map((a) => a.finished),
  ));
}

test('phone: the diagram is the hero, Simple only, one chart switch, no sideways scroll', async ({ page }) => {
  await openFlow(page, { width: 390, height: 844 });

  await expect(page.getByText('same cents as Activity')).toBeVisible();
  await expect(page.getByText(/1 account don’t|1 account don't/)).toHaveCount(0); // grammar: "doesn’t" for one
  await expect(page.getByRole('link', { name: /View as list/ })).toHaveAttribute('href', '/history');

  await expect(page.getByRole('button', { name: /Show the diagram/ })).toHaveCount(0);
  const diagram = page.getByRole('img', { name: /chart tracing/ });
  await expect(diagram).toBeVisible();
  // The picture leads: it starts inside the first screenful, above the story tiles.
  const diagramBox = (await diagram.boundingBox())!;
  expect(diagramBox.y, 'diagram top vs first screenful').toBeLessThan(844);
  const tile = (await page.getByText('Money came in').boundingBox())!;
  expect(tile.y).toBeGreaterThan(diagramBox.y);

  await expect(page.getByRole('group', { name: 'Detail level' })).toBeHidden(); // Full detail is md+
  const kinds = page.getByRole('group', { name: 'Chart type' }).getByRole('button');
  await expect(kinds).toHaveText(['Flow', 'Spending tree', 'Where it went', 'Step by step', 'Pace']);
  await expect(kinds.first()).toHaveAttribute('aria-pressed', 'true');

  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow, 'page scrolls sideways by this many px').toBeLessThanOrEqual(1);

  const topLevel = await page.evaluate(() =>
    [...document.querySelectorAll('details')].filter((d) => !d.parentElement?.closest('details')).map((d) => ({ open: d.open, summary: d.querySelector('summary')?.textContent ?? '' })),
  );
  const more = topLevel.find((d) => d.summary.startsWith('Reconciliation and more'));
  expect(more?.open).toBe(false);

  await page.screenshot({ path: 'test-results/screens/flow-phone.png', animations: 'disabled' });
});

test('phone: Pace shows spending pace in place of the diagram', async ({ page }) => {
  await openFlow(page, { width: 390, height: 844 });
  await page.getByRole('group', { name: 'Chart type' }).getByRole('button', { name: 'Pace' }).click();
  await expect(page.getByRole('heading', { name: 'Spending pace' })).toBeVisible();
  await expect(page.getByRole('img', { name: /chart tracing/ })).toHaveCount(0);
});

test('desktop: Full detail is offered', async ({ page }) => {
  await openFlow(page, { width: 1280, height: 800 });
  await expect(page.getByRole('group', { name: 'Detail level' })).toBeVisible();
  await expect(page.getByRole('group', { name: 'Detail level' }).getByRole('button', { name: 'Full detail' })).toBeVisible();
  await page.screenshot({ path: 'test-results/screens/flow-desktop.png', animations: 'disabled' });
});
