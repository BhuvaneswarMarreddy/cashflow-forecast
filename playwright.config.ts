import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright for OBS-001 — observability validation only, not a general E2E suite.
 *
 * SAFETY: this configuration deliberately never signs in. Production is also the
 * development environment (one Firebase project, `next dev` talks to live Firestore),
 * so the automated test drives /dev/accounts-fixture, which supplies the React
 * contexts directly and therefore has no code path to the live project at all.
 * See docs/observability/README.md → "Production/Test isolation".
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: [['list'], ['html', { outputFolder: 'playwright-report', open: 'never' }]],
  outputDir: 'test-results',

  use: {
    baseURL: process.env.PW_BASE_URL || 'http://127.0.0.1:3000',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off', // the repository has no video convention; artifacts stay small
  },

  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],

  webServer: {
    command: 'npm run dev -- --port 3000',
    url: 'http://127.0.0.1:3000/dev/accounts-fixture',
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
    env: {
      // Force the diagnostics surface on and pin the environment name so the
      // fixture route and the diagnostics endpoint are both reachable.
      NEXT_PUBLIC_OBS_ENV: 'development',
      NEXT_PUBLIC_OBS_LEVEL: 'debug',
    },
  },
});
