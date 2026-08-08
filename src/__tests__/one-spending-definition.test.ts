/**
 * STATE-002 (#104) — one definition of spending.
 *
 * The app had two, and they disagreed by $138,350.88 on the owner's real ledger:
 *
 *   classifyTransaction(t, accounts) === 'expense'                  1744 rows
 *   interpretTransaction(t, accounts, policy).expense === 'counted'  1843 rows
 *   99 rows apart — 73 Remitly, 21 Upstart loan payments, 5 Zelle
 *
 * All 99 are rows the owner opened and personally marked as spending in
 * users/{uid}/reviews. `interpretTransaction` honours that. `classifyTransaction`
 * cannot see reviews at all — by design, because it answers a DIFFERENT question:
 * what KIND of row is this, for pairing legs and choosing a +/- sign.
 *
 * Both functions are correct. The bug was using the row-KIND answer to compute a
 * money figure. These tests pin the distinction so neither half drifts back.
 */
import { InflowReview, PaymentAccount, Transaction } from '@/types';
import {
  FinancialPolicy, classifyTransaction, interpretTransaction, sumExpenseCents,
} from '@/lib/classify';

const bank: PaymentAccount = {
  id: 'b', name: 'Checking', type: 'bank_account', provider: 'chase',
  openingBalance: 0, openingDate: '2026-01-01', color: '#000', isActive: true,
} as PaymentAccount;
const ACCOUNTS = [bank];

/** The real shape: a remittance the provider typed `transfer`, naming an external party. */
const remittance: Transaction = {
  id: 'rmtly-1', title: 'Sent Rmtly', amount: 1217.14, type: 'transfer',
  category: 'other', paymentMethod: 'bank-transfer', accountId: 'b', date: '2026-02-10',
} as Transaction;

/** The owner opened it and said: this was me spending money. */
const confirmed: Record<string, InflowReview> = {
  'rmtly-1': { transactionId: 'rmtly-1', state: 'confirmed', meaning: 'personal_expense' } as InflowReview,
};

const WITH: FinancialPolicy = { reviews: confirmed, includePending: false };
const WITHOUT: FinancialPolicy = { reviews: {}, includePending: false };

describe('STATE-002: a confirmed remittance is spending', () => {
  it('the owner confirmation is what makes it count', () => {
    expect(sumExpenseCents([remittance], ACCOUNTS, WITHOUT)).toBe(0);
    expect(sumExpenseCents([remittance], ACCOUNTS, WITH)).toBe(121714);
  });

  it('and classifyTransaction still calls it a transfer — that is CORRECT, not a bug', () => {
    // The row genuinely IS a transfer at the ledger level. Pairing and sign rendering
    // depend on that. Only the TOTAL should change.
    expect(classifyTransaction(remittance, ACCOUNTS)).toBe('transfer');
    expect(interpretTransaction(remittance, ACCOUNTS, WITH).expense).toBe('counted');
  });

  it('this exact gap is what the two definitions disagreed about', () => {
    // The regression, in miniature: the row-kind answer says $0 spent, the
    // interpretation says $1,217.14. Scaled to the real ledger that was $138,350.88.
    const byKind = classifyTransaction(remittance, ACCOUNTS) === 'expense' ? remittance.amount : 0;
    const byInterpretation = sumExpenseCents([remittance], ACCOUNTS, WITH) / 100;
    expect(byKind).toBe(0);
    expect(byInterpretation).toBe(1217.14);
  });
});

describe('STATE-002: an UNCONFIRMED transfer is still not spending', () => {
  it('nothing is counted on a guess — only the owner can promote a transfer', () => {
    const unreviewed = { ...remittance, id: 'rmtly-2' };
    expect(sumExpenseCents([unreviewed], ACCOUNTS, WITH)).toBe(0);
  });
});

describe('STATE-002: the row-KIND question must keep its own answer', () => {
  // These are the call sites the adversarial review REFUSED to change. If someone
  // "finishes the job" by switching them, this fails and explains why.
  it('a reward is an inflow but never earned income', () => {
    const reward: Transaction = {
      id: 'cb', title: 'Cashback Reward', amount: 44.51, type: 'income',
      category: 'other', paymentMethod: 'amex', accountId: 'card', date: '2026-02-11',
    } as Transaction;
    // The rewards panel asks "is it an inflow" via classifyTransaction. Asking
    // ".income === 'counted'" instead would render $0.00 for every card, because a
    // reward resolves to other_non_income_credit and never to earned_income.
    expect(classifyTransaction(reward, ACCOUNTS)).toBe('income');
    expect(interpretTransaction(reward, ACCOUNTS, WITH).income).toBe('excluded');
  });
});
