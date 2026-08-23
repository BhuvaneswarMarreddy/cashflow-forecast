/**
 * #68 (UX-002) — the Monthly Budget stat-card on /accounts asserted "your set
 * budget" and printed $0.00 for a budget the owner never entered (whenever no
 * derived spending existed either, e.g. a brand-new account with no 6-month
 * transaction history to fall back on). Same contract as runwayLabel()'s
 * hasBurn branch in lib/home.ts: an unmeasured figure must read as unset, not
 * as a confident zero.
 */
import { resolveBudgetDisplay } from '@/app/accounts/page';

describe('resolveBudgetDisplay', () => {
  it('a budget the owner typed in renders as set, never derived', () => {
    expect(resolveBudgetDisplay(2500, 1800)).toEqual({ status: 'set', amount: 2500 });
  });

  it('no owner-set budget, but 6 months of spending exists — reads as derived, not "your set budget"', () => {
    expect(resolveBudgetDisplay(undefined, 1800)).toEqual({ status: 'derived', amount: 1800 });
    expect(resolveBudgetDisplay(0, 1800)).toEqual({ status: 'derived', amount: 1800 });
  });

  it('no owner-set budget AND nothing derivable — unset, never a fabricated $0.00', () => {
    expect(resolveBudgetDisplay(undefined, 0)).toEqual({ status: 'unset' });
    expect(resolveBudgetDisplay(0, 0)).toEqual({ status: 'unset' });
  });
});
