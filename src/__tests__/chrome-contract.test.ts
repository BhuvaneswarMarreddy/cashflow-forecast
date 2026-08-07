/**
 * UI-101 — chrome contract (audit: dashboard/duplicatedInfo, FAB findings).
 *
 * 1. Chrome carries no money numbers: the navbar restated Net Worth and the
 *    budget from its own second computation — two reducers for one figure is
 *    how screens end up disagreeing (see #29/#30).
 * 2. The FAB is ONE action (Add), not a menu that half-duplicates the nav.
 * 3. Every nav href still resolves to a real route — the audit found a button
 *    navigating somewhere its label never promised.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');

describe('UI-101 chrome contract', () => {
  test('navbar shows no balances or budgets — numbers live on screens, not chrome', () => {
    const navbar = read('src/components/Navbar.tsx');
    expect(navbar).not.toContain('Net Balance');
    expect(navbar).not.toContain('Budget:');
    expect(navbar).not.toContain('withDerivedBalances'); // the duplicate reducer goes too
  });

  test('FAB is a single Add action — no navigation menu, no second scanner entry', () => {
    const fab = read('src/components/QuickAddFAB.tsx');
    expect(fab).not.toContain('SECONDARY_ITEMS');
    expect(fab).not.toContain('ReceiptScannerModal');
    expect(fab).not.toContain('aria-expanded'); // nothing expands — it is a button
  });

  test('secondary routes stay reachable from the navbar until their merges land', () => {
    const navbar = read('src/components/Navbar.tsx');
    expect(navbar).toContain('SECONDARY_ITEMS');
  });

  test('every nav href resolves to a real route', () => {
    const nav = read('src/lib/nav.ts');
    const hrefs = [...nav.matchAll(/href:\s*'([^']+)'/g)].map(m => m[1]);
    expect(hrefs.length).toBeGreaterThanOrEqual(5); // UI-104: the map is 5 primary destinations
    for (const href of hrefs) {
      expect(existsSync(join(process.cwd(), 'src/app', href.slice(1), 'page.tsx'))).toBe(true);
    }
  });
});
