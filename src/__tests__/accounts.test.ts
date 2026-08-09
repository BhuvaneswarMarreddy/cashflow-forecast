import { PaymentAccount } from '@/types';
import { sortAccounts, reindex, isUnanchored, accountsBehindFigure } from '@/lib/accounts';

const a = (o: Partial<PaymentAccount> & { id: string }): PaymentAccount => ({
  name: o.id, type: 'bank_account', provider: 'chase', openingBalance: 0,
  openingDate: '2026-01-01', balance: 0, color: '#000', isActive: true, ...o,
} as PaymentAccount);

describe('sortAccounts', () => {
  it('orders by sortIndex, undefined to the end tie-broken by name', () => {
    const out = sortAccounts([
      a({ id: 'z', sortIndex: 2 }), a({ id: 'a' }), a({ id: 'm', sortIndex: 0 }), a({ id: 'b' }),
    ]);
    expect(out.map((x) => x.id)).toEqual(['m', 'z', 'a', 'b']);
  });
});

describe('reindex', () => {
  it('assigns contiguous indices in the given id order, skipping unknown ids', () => {
    const accts = [a({ id: 'a' }), a({ id: 'b' }), a({ id: 'c' })];
    expect(reindex(['c', 'a', 'b'], accts)).toEqual([
      { id: 'c', sortIndex: 0 }, { id: 'a', sortIndex: 1 }, { id: 'b', sortIndex: 2 },
    ]);
    expect(reindex(['c', 'ghost', 'a'], accts).map((x) => x.id)).toEqual(['c', 'a']);
  });
});

import { reconcile } from '@/lib/accounts';
describe('reconcile', () => {
  const bank = a({ id: 'b', type: 'bank_account', openingBalance: 1000, openingDate: '2026-02-01' });
  const CTX = { includePending: false, source: 'user' as const };
  it('no drift → no re-anchor', () => {
    const r = reconcile(bank, 1150, 1150, '2026-03-01', CTX);
    expect(r.driftCents).toBe(0);
    expect(r.reanchor).toBeUndefined();
  });
  it('drift → re-anchor to the entered balance at today', () => {
    const r = reconcile(bank, 1200, 1150, '2026-03-01', CTX);
    expect(r.driftCents).toBe(5000);
    expect(r.reanchor).toEqual({ openingBalance: 1200, openingDate: '2026-03-01' });
  });
});

describe('isUnanchored', () => {
  const base = { id: 'a', name: 'A', type: 'bank_account', provider: 'chase', color: '#000', isActive: true, openingBalance: 0 } as PaymentAccount;

  it('is true when nobody ever asserted a starting balance', () => {
    expect(isUnanchored(base)).toBe(true);
  });

  it('is false once an anchor date exists', () => {
    expect(isUnanchored({ ...base, openingDate: '2026-01-01' })).toBe(false);
  });

  it('is true for an empty-string date, which asserts nothing', () => {
    expect(isUnanchored({ ...base, openingDate: '' })).toBe(true);
  });
});

// #83 Finding 1: Forecast's headline card is either the combined total or one
// account's balance; UnanchoredNote must count only the account(s) that figure
// actually contains, never the whole roster regardless of selection.
describe('accountsBehindFigure', () => {
  const anchored = a({ id: 'anchored', openingDate: '2026-01-01' });
  const unanchored = a({ id: 'unanchored', openingDate: undefined });

  it("'all' behind the cash total means all cash accounts (both anchored and unanchored)", () => {
    expect(accountsBehindFigure('all', [anchored, unanchored])).toEqual([anchored, unanchored]);
  });

  it('a single selection means just that account — an anchored pick must not drag in an unrelated unanchored one', () => {
    const out = accountsBehindFigure('anchored', [anchored, unanchored]);
    expect(out).toEqual([anchored]);
    expect(out.some(isUnanchored)).toBe(false);
  });

  it('a selection that matches nothing yields no accounts, not a false positive', () => {
    expect(accountsBehindFigure('ghost', [anchored, unanchored])).toEqual([]);
  });

  it("'all' when cash-only total excludes unanchored debt accounts: unanchored credit card and personal loan must not appear", () => {
    const anchoredCash = a({ id: 'checking', type: 'bank_account', openingDate: '2026-01-01' });
    const unanchoredCard = a({ id: 'unanchored_cc', type: 'credit_card', openingDate: undefined });
    const unanchoredLoan = a({ id: 'unanchored_loan', type: 'personal_loan', openingDate: undefined });
    const out = accountsBehindFigure('all', [anchoredCash, unanchoredCard, unanchoredLoan]);
    expect(out).toEqual([anchoredCash]);
    expect(out).not.toContain(unanchoredCard);
    expect(out).not.toContain(unanchoredLoan);
  });
});
