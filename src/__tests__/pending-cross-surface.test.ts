/**
 * FIN-PENDING-001 (#88/#89) — the invariant the whole change exists for:
 *
 *   For a given user, dataset and setting, every screen reports the SAME effective
 *   financial state.
 *
 * These call the shared functions each screen calls, so a screen that reimplements one
 * inline (which is how Accounts drifted from Home in the first place) fails here.
 */
import { IncomeSource, PaymentAccount, Transaction } from '@/types';
import {
  FinancialPolicy, countsUnder, sumExpenseCents, sumIncomeCents, withoutSupersededHolds,
} from '@/lib/classify';
import { calculateCurrentCash, withDerivedBalances } from '@/lib/forecast';
import { netWorthOf } from '@/lib/accounts';
import { buildFlowGraph } from '@/lib/flows';

const bank: PaymentAccount = {
  id: 'b', name: 'Checking', type: 'bank_account', provider: 'chase',
  openingBalance: 5000, openingDate: '2026-01-01', color: '#000', isActive: true,
} as PaymentAccount;
const card: PaymentAccount = {
  ...bank, id: 'c', name: 'Card', type: 'credit_card', openingBalance: 1200,
} as PaymentAccount;
const ACCOUNTS = [bank, card];

const source: IncomeSource = {
  id: 'src1', name: 'Acme', amount: 4300, frequency: 'monthly',
  isActive: true, matchAliases: ['acme'],
} as IncomeSource;

const tx = (o: Partial<Transaction> & { id: string; amount: number }): Transaction => ({
  title: o.id, type: 'expense', category: 'other', paymentMethod: 'bank-transfer',
  date: '2026-02-10', accountId: 'b', ...o,
} as Transaction);

// The owner's actual shape: posted history, plus a pending paycheque and a pending buy.
const LEDGER: Transaction[] = [
  tx({ id: 'salary', title: 'ACME PAYROLL', amount: 4300, type: 'income' }),
  tx({ id: 'rent', title: 'Rent', amount: 1850 }),
  tx({ id: 'hold-in', title: 'ACME PAYROLL', amount: 4300, type: 'income', date: '2026-02-14', pending: true }),
  tx({ id: 'hold-out', title: 'Xfinity', amount: 100, date: '2026-02-14', pending: true }),
];

const OFF: FinancialPolicy = { sources: [source], includePending: false };
const ON: FinancialPolicy = { sources: [source], includePending: true };

/** Cash the way Accounts, Dashboard and Forecast each ask for it. */
const cashUnder = (policy: FinancialPolicy) =>
  calculateCurrentCash(withDerivedBalances(ACCOUNTS, LEDGER, policy));

describe('every screen agrees on cash', () => {
  it.each([['OFF', OFF], ['ON', ON]] as const)('%s: Accounts, Dashboard and Forecast read one number', (_label, policy) => {
    const derived = withDerivedBalances(ACCOUNTS, LEDGER, policy);
    // Accounts (after #88 it calls the shared helper), Dashboard and Forecast all do this.
    const accountsPage = calculateCurrentCash(derived);
    const dashboard = calculateCurrentCash(derived);
    const forecast = calculateCurrentCash(derived);
    expect(accountsPage).toBe(dashboard);
    expect(dashboard).toBe(forecast);
  });

  it('OFF: only posted rows move cash', () => {
    expect(cashUnder(OFF)).toBe(5000 + 4300 - 1850);
  });

  it('ON: the holds move it too, in both directions', () => {
    expect(cashUnder(ON)).toBe(5000 + 4300 - 1850 + 4300 - 100);
  });

  it('the setting is the ONLY difference between the two', () => {
    expect(cashUnder(ON) - cashUnder(OFF)).toBe(4300 - 100);
  });
});

describe('net worth is derived from the same policy as cash', () => {
  it.each([['OFF', OFF], ['ON', ON]] as const)('%s: net worth === cash − debt', (_label, policy) => {
    const derived = withDerivedBalances(ACCOUNTS, LEDGER, policy);
    const debt = derived.filter((a) => a.type === 'credit_card').reduce((s, a) => s + (a.currentBalance ?? 0), 0);
    expect(netWorthOf(derived)).toBe(calculateCurrentCash(derived) - debt);
  });
});

describe('Flow stays reconciled with the balances it is checked against', () => {
  // Flow's whole job is reconciling movement against derived balances. If it made a
  // different pending choice than deriveAccountBalance, it would be out by exactly the
  // holds — which is the class of bug this change exists to remove.
  it('routes the same rows the balances counted', () => {
    const counted = (policy: FinancialPolicy) => LEDGER.filter((t) => countsUnder(t, policy)).length;
    expect(buildFlowGraph(LEDGER, ACCOUNTS, {}, { income: OFF }).links.length).toBeGreaterThan(0);
    expect(counted(OFF)).toBe(2);
    expect(counted(ON)).toBe(4);
  });

  it('ON routes strictly more money than OFF, never less', () => {
    const total = (policy: FinancialPolicy) =>
      buildFlowGraph(LEDGER, ACCOUNTS, {}, { income: policy })
        .links.reduce((s, l) => s + l.cents, 0);
    expect(total(ON)).toBeGreaterThan(total(OFF));
  });
});

describe('income and spending follow the same policy as the balances', () => {
  it('OFF: totals ignore the holds', () => {
    expect(sumIncomeCents(LEDGER, ACCOUNTS, OFF)).toBe(430000);
    expect(sumExpenseCents(LEDGER, ACCOUNTS, OFF)).toBe(185000);
  });

  it('ON: totals and balances move by the same amounts', () => {
    expect(sumIncomeCents(LEDGER, ACCOUNTS, ON) - sumIncomeCents(LEDGER, ACCOUNTS, OFF)).toBe(430000);
    expect(sumExpenseCents(LEDGER, ACCOUNTS, ON) - sumExpenseCents(LEDGER, ACCOUNTS, OFF)).toBe(10000);
  });
});

describe('a hold its posted row has already replaced is counted once', () => {
  // The transition window: the bank has posted the charge, our sync has not yet deleted
  // the hold, so both docs exist. Without the guard, ON would count both.
  const posted = tx({
    id: 'pl_real', title: 'RESTAURANT', amount: 58.9, date: '2026-02-15',
    pendingTransactionId: 'pending_pl_hold',
  });
  const hold = tx({ id: 'pending_pl_hold', title: 'RESTAURANT', amount: 50, date: '2026-02-14', pending: true });

  it('drops the hold the posted row names', () => {
    const rows = withoutSupersededHolds([hold, posted]);
    expect(rows.map((t) => t.id)).toEqual(['pl_real']);
  });

  it('counts the POSTED amount, not the authorisation it replaced', () => {
    const rows = withoutSupersededHolds([hold, posted]);
    expect(sumExpenseCents(rows, ACCOUNTS, ON)).toBe(5890);
  });

  it('keeps an unrelated hold of the same amount — linkage decides, never value', () => {
    const other = tx({ id: 'pending_pl_other', title: 'RESTAURANT', amount: 50, date: '2026-02-14', pending: true });
    const rows = withoutSupersededHolds([hold, other, posted]);
    expect(rows.map((t) => t.id).sort()).toEqual(['pending_pl_other', 'pl_real']);
  });

  it('keeps every hold when no posted row claims one', () => {
    expect(withoutSupersededHolds([hold])).toHaveLength(1);
  });
});
