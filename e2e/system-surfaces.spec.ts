/**
 * UI spec Phase A acceptance, in a real browser at phone and desktop width.
 *
 * - `/does-not-exist` is themed, has no FAB and no tab bar, and offers one way home.
 * - Login offers sign-up once.
 * - Signup's primary button is fully on screen at 390x844, measured AFTER a password
 *   is typed: the requirements checklist that appears is what pushed it 86px below
 *   the fold before this change.
 *
 * Live endpoints are recorded and blocked, as in screens.spec.ts. Screenshots finish the
 * auth pages' fade-in first (`animations: 'disabled'`), or the preview shows a 0-opacity header.
 */

import { test, expect } from '@playwright/test';

const LIVE_ENDPOINTS = /firestore\.googleapis\.com|identitytoolkit\.googleapis\.com|securetoken\.googleapis\.com|cloudfunctions\.net|bridge\.simplefin\.org/;
const WIDTHS = [
  { name: 'phone', width: 390, height: 844 },
  { name: 'desktop', width: 1280, height: 800 },
];

test.describe.configure({ timeout: 120_000 });

for (const size of WIDTHS) {
  test(`404 at ${size.name} width is themed, chrome-free, one CTA`, async ({ page }) => {
    const liveHits: string[] = [];
    await page.route(LIVE_ENDPOINTS, (r) => { liveHits.push(r.request().url()); return r.abort(); });
    await page.setViewportSize(size);

    const response = await page.goto('/does-not-exist', { waitUntil: 'load' });
    expect(response?.status()).toBe(404);
    await expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible({ timeout: 60_000 });
    await page.waitForTimeout(1000); // client chrome mounts after hydration; give it the chance to wrongly appear

    await expect(page.locator('nav[aria-label="Primary"]')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Add transaction' })).toHaveCount(0);
    await expect(page.getByRole('link')).toHaveCount(1);
    await expect(page.getByRole('link', { name: 'Go home' })).toHaveAttribute('href', '/dashboard');

    // Themed ground, not the stock white page.
    const ground = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    expect(ground).not.toBe('rgb(255, 255, 255)');

    await page.screenshot({ path: `test-results/screens/404-${size.name}.png`, fullPage: true, animations: 'disabled' });
    expect(liveHits).toEqual([]);
  });

  test(`signup at ${size.name} width keeps Create Account on screen with the password checklist open`, async ({ page }) => {
    await page.route(LIVE_ENDPOINTS, (r) => r.abort());
    await page.setViewportSize(size);
    await page.goto('/signup', { waitUntil: 'load' });

    const submit = page.getByRole('button', { name: /create account/i });
    await expect(submit).toBeVisible({ timeout: 60_000 });
    await page.getByLabel('Password', { exact: true }).fill('Abcdefg1!');
    await page.getByLabel(/confirm password/i).fill('Abcdefg1!');
    await page.evaluate(() => window.scrollTo(0, 0));

    const box = await submit.boundingBox();
    expect(box, 'submit button box').toBeTruthy();
    expect(box!.y + box!.height, `button bottom vs ${size.height}px viewport`).toBeLessThanOrEqual(size.height);

    await page.screenshot({ path: `test-results/screens/signup-${size.name}.png`, animations: 'disabled' });
  });

  test(`login at ${size.name} width offers sign-up once`, async ({ page }) => {
    await page.route(LIVE_ENDPOINTS, (r) => r.abort());
    await page.setViewportSize(size);
    await page.goto('/login', { waitUntil: 'load' });

    await expect(page.getByRole('link', { name: 'Sign up' })).toBeVisible({ timeout: 60_000 });
    await expect(page.getByRole('link', { name: /sign up|create an account/i })).toHaveCount(1);
    await expect(page.getByText('takes about a minute')).toHaveCount(0);
    await expect(page.getByText('See where the money went, and what the next 90 days look like.')).toBeVisible();

    await page.screenshot({ path: `test-results/screens/login-${size.name}.png`, animations: 'disabled' });
  });
}
