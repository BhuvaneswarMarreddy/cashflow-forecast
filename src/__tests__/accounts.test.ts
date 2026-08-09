import fs from 'fs';
import { PaymentAccount } from '@/types';
import { sortAccounts, reindex, isUnanchored, accountsBehindFigure, balanceCaption } from '@/lib/accounts';

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

  // #83 round 4a Defect 1: the zero-drift early return is correct for an ANCHORED
  // account (UI-106 — an unchanged balance must not move openingDate) but wrong for
  // an UNANCHORED one. There is no earlier anchor for that guarantee to protect, and
  // the owner's most likely path — open ReconcileSheet, see the prefilled derived
  // figure, agree it's right, confirm — is exactly entered === derived. Applying the
  // same short-circuit there left the account unanchored forever while the caller
  // reported success.
  it('no drift on an UNANCHORED account still re-anchors — the confirm IS the first assertion', () => {
    const unanchored = a({ id: 'u', openingDate: undefined });
    const r = reconcile(unanchored, 1150, 1150, '2026-03-01', CTX);
    expect(r.driftCents).toBe(0);
    expect(r.reanchor).toEqual({ openingBalance: 1150, openingDate: '2026-03-01' });
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

  // Round 4b: Dashboard's "Cards owed" chip and Accounts' "Credit Used" card are both
  // fed by totalCreditUsed — credit_card accounts ONLY, never personal_loan. A caller
  // must be able to ask for that scope explicitly; 'cash' stays the DEFAULT so every
  // pre-existing caller (untouched call sites) keeps agreeing with calculateCurrentCash
  // exactly as before this fix.
  it("'all' with scope 'debt' means credit_card accounts only — matching totalCreditUsed, never isDebtAccount's broader personal_loan", () => {
    const cashAcct = a({ id: 'checking', type: 'bank_account', openingDate: '2026-01-01' });
    const anchoredCard = a({ id: 'card', type: 'credit_card', openingDate: '2026-01-01' });
    const unanchoredCard = a({ id: 'unanchored_cc', type: 'credit_card', openingDate: undefined });
    const unanchoredLoan = a({ id: 'unanchored_loan', type: 'personal_loan', openingDate: undefined });
    const roster = [cashAcct, anchoredCard, unanchoredCard, unanchoredLoan];

    const debtScope = accountsBehindFigure('all', roster, 'debt');
    expect(debtScope).toEqual([anchoredCard, unanchoredCard]);
    // An unanchored personal LOAN must never be named as the reason a credit-CARD
    // total looks off — totalCreditUsed never sums personal loans in the first place.
    expect(debtScope).not.toContain(unanchoredLoan);
    expect(debtScope).not.toContain(cashAcct);

    // Omitting the scope (or passing 'cash') is unchanged.
    const cashScope = accountsBehindFigure('all', roster, 'cash');
    expect(cashScope).toEqual([cashAcct]);
    expect(accountsBehindFigure('all', roster)).toEqual(cashScope);
  });

  it("a single selection ignores scope — one account named by id is the whole answer regardless of 'cash'/'debt'", () => {
    const unanchoredCard = a({ id: 'unanchored_cc', type: 'credit_card', openingDate: undefined });
    expect(accountsBehindFigure('unanchored_cc', [unanchoredCard], 'cash')).toEqual([unanchoredCard]);
  });
});

// #83 Finding 2/3: the single-account caption AccountDetailModal, History's per-account
// tile, and the XLSX export all now call — pure so each of the three can be trusted
// without mounting a component or building a workbook to check the wording agrees.
describe('balanceCaption', () => {
  const txns = [
    { accountId: 'x', date: '2026-03-14' },
    { accountId: 'x', date: '2026-04-01' },
    { accountId: 'other', date: '2026-01-01' },
  ];

  it('anchored → "as of" the stated opening date, no row lookup needed', () => {
    expect(balanceCaption({ id: 'x', openingDate: '2026-01-01' }, [])).toBe('as of 2026-01-01');
  });

  it('unanchored with rows → net since the account\'s own earliest row', () => {
    expect(balanceCaption({ id: 'x', openingDate: undefined }, txns)).toBe('net since 2026-03-14 · no starting balance set');
  });

  it('unanchored with no rows on this account → still discloses, never a blank claim', () => {
    expect(balanceCaption({ id: 'x', openingDate: undefined }, [])).toBe('no starting balance set');
    // A row belonging to a DIFFERENT account must not leak in as this one's "earliest".
    expect(balanceCaption({ id: 'zzz', openingDate: undefined }, txns)).toBe('no starting balance set');
  });
});

// #83 Finding 1, round 2: the dashboard hero's cash figure is calculateCurrentCash
// (cash-type accounts only) — NOT the full account list. A tag-presence grep (see
// cross-surface-consistency.test.ts) cannot see which accounts are actually passed to
// UnanchoredNote, so this pins the specific, scoped call and fails if it regresses
// back to the full roster (the exact bug this fix corrected).
describe('dashboard scopes UnanchoredNote to the figure it actually shows (#83 Finding 1)', () => {
  const src = fs.readFileSync('src/app/dashboard/page.tsx', 'utf8');

  it("calls accountsBehindFigure('all', derivedAccounts), matching calculateCurrentCash's filter", () => {
    expect(src).toContain("<UnanchoredNote accounts={accountsBehindFigure('all', derivedAccounts)} />");
  });

  it('never passes the unfiltered account list to UnanchoredNote', () => {
    expect(src).not.toMatch(/<UnanchoredNote accounts=\{derivedAccounts\}/);
  });

  // Round 4b Fix 1: "Cards owed" (totalCreditUsed, credit_card accounts only — see
  // dashboard/page.tsx's own definition) had NO disclosure at all. Production's one
  // unanchored account (Amazon Store Card, a credit card) is IN this figure, not the
  // cash one above — the prior fix covered the figure it isn't even in.
  it("also discloses \"Cards owed\" via accountsBehindFigure('all', derivedAccounts, 'debt'), matching totalCreditUsed's filter", () => {
    expect(src).toContain("<UnanchoredNote accounts={accountsBehindFigure('all', derivedAccounts, 'debt')} />");
  });
});

// #83 Finding 3: History's per-account tile must call the shared caption, not
// silently drop it — a regression here would be a "Balance owed" tile with no
// disclosure at all, the exact gap this fix closed.
describe('history wires the per-account balance caption (#83 Finding 3)', () => {
  it('calls balanceCaption(acct, transactions) and threads it into the tile', () => {
    const src = fs.readFileSync('src/app/history/page.tsx', 'utf8');
    expect(src).toContain('balanceCaption(acct, transactions)');
  });
});
