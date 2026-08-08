/**
 * UX-001 (#67) — where the app puts you after you get in.
 *
 * Every auth entry point sent you to /forecast: two control rows, three balance
 * cards and a projection chart. For a brand-new account that screen has nothing
 * in it, and a five-persona review found it was where the youngest reviewer quit
 * — "I filled in four fields, hit the button, and got dumped somewhere I didn't
 * understand."
 *
 * Home is the correct landing for both cases, and needs no new branching: it
 * already redirects to /onboarding when the profile is not onboarded, so a new
 * user is routed on and an existing one is simply home.
 *
 * These read source rather than render, which is a real limit — they pin the
 * route constant and the absence of the fake delay, not the runtime navigation.
 * That is the defect that shipped, and it is the one that can silently come back
 * in a copy-paste.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const read = (p: string) => readFileSync(join(root, p), 'utf8');

const AUTH_PAGES = ['src/app/login/page.tsx', 'src/app/signup/page.tsx'];

describe('UX-001 auth lands on Home', () => {
  test.each(AUTH_PAGES)('%s does not drop the user on Forecast', (page) => {
    expect(read(page)).not.toMatch(/router\.push\(['"]\/forecast/);
  });

  test.each(AUTH_PAGES)('%s sends the user to Home', (page) => {
    expect(read(page)).toMatch(/router\.push\(['"]\/dashboard['"]\)/);
  });

  test.each(AUTH_PAGES)('%s navigates immediately, with no invented delay', (page) => {
    // `setTimeout(() => router.push(...), 1000)` made every successful sign-in
    // wait a second for nothing.
    //
    // NOT `[^)]*` — that stops at the `)` in the arrow function's own empty
    // parameter list, so it never reaches router.push and the test passes on
    // the very code it exists to forbid.
    expect(read(page)).not.toMatch(/setTimeout\([\s\S]*?router\.push/);
  });

  test('Home still routes a new account on to onboarding', () => {
    // The whole fix depends on this guard existing; without it, landing on Home
    // strands a user with no accounts on an empty screen.
    const home = read('src/app/dashboard/page.tsx');
    expect(home).toMatch(/!isOnboarded/);
    expect(home).toMatch(/router\.push\(['"]\/onboarding['"]\)/);
  });

  test('the sign-in page does not promise sample data it never provides', () => {
    // "Create an account to get started with sample data" stopped the
    // 59-year-old reviewer dead: "I do not want sample data."
    expect(read('src/app/login/page.tsx')).not.toMatch(/sample data/i);
  });
});
