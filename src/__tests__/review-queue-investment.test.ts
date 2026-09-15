/**
 * #185 REVIEW-001 — review-queue hygiene for newly linked US accounts.
 *
 * The noise this removes: linking Schwab puts every dividend, interest credit, sell
 * proceed and sweep on the brokerage into "is this your paycheck?". None of them is a
 * candidate for earned income, and a queue full of them buries the credits that are.
 *
 * What must NOT change (invariant 4): the brokerage credit is still `unknown_inflow` —
 * not income, not spend — and a credit that matches an approved source is still earned
 * income. The web workspace, mapping suggestions and the phone's reviewQueue callable
 * all read this one selector, so they agree by construction.
 */
import { interpretTransaction, selectInflowReviewQueue, sumExpenseCents, sumIncomeCents, POSTED_ONLY, type IncomeContext } from '@/lib/classify';
import { calculateCurrentCash, withDerivedBalances } from '@/lib/forecast';
import type { IncomeSource, PaymentAccount, Transaction } from '@/types';

const account = (id: string, type: PaymentAccount['type']): PaymentAccount =>
  ({ id, name: id, type, provider: 'other', openingBalance: 0, openingDate: '2000-01-01', color: '#000', isActive: true });
const accounts = [account('chk', 'bank_account'), account('card', 'credit_card'), account('brk', 'investment')];

const credit = (id: string, accountId: string, title: string, amount: number): Transaction =>
  ({ id, accountId, title, amount, type: 'income', category: 'other', paymentMethod: 'other', date: '2026-08-10' } as Transaction);

const DIVIDEND = credit('brk-div', 'brk', 'Cash Dividend VTI', 41.2);
const BROKERAGE_INTEREST = credit('brk-int', 'brk', 'Bank Interest', 0.87);
const SELL_PROCEEDS = credit('brk-sell', 'brk', 'Sold 10 AAPL', 2150);
const CHECKING_INTEREST = credit('chk-int', 'chk', 'INTEREST PAID', 0.44);
const MYSTERY_DEPOSIT = credit('chk-dep', 'chk', 'AB-4471 CREDIT', 88);
const CARD_PAYMENT_CREDIT = credit('card-pmt', 'card', 'ONLINE PMT RCVD REF 88213', 400);

const NONE: IncomeContext = { sources: [] };

describe('the review queue after linking a brokerage (#185)', () => {
  const rows = [DIVIDEND, BROKERAGE_INTEREST, SELL_PROCEEDS, CHECKING_INTEREST, MYSTERY_DEPOSIT, CARD_PAYMENT_CREDIT];

  it('asks only about unexplained credits on cash accounts — not dividends, interest or sells on the brokerage', () => {
    expect(selectInflowReviewQueue(rows, accounts, NONE).map((q) => q.transactionId)).toEqual(['chk-dep', 'chk-int']);
  });

  it('a card-side payment credit is never asked about (already a card payment)', () => {
    expect(interpretTransaction(CARD_PAYMENT_CREDIT, accounts, NONE).financialMeaning).toBe('card_payment');
  });

  it('scope only: a brokerage credit is still unknown — not income, not spend, not cash', () => {
    expect(interpretTransaction(DIVIDEND, accounts, NONE).financialMeaning).toBe('unknown_inflow');
    expect(sumIncomeCents([DIVIDEND, SELL_PROCEEDS], accounts, NONE)).toBe(0);
    expect(sumExpenseCents([DIVIDEND, SELL_PROCEEDS], accounts, POSTED_ONLY)).toBe(0);
    expect(calculateCurrentCash(withDerivedBalances(accounts, [DIVIDEND, SELL_PROCEEDS], NONE))).toBe(0);
  });

  it('a paycheck that matches an approved source is earned income even when it lands in the brokerage', () => {
    const employer: IncomeSource = { id: 'src', name: 'Larkspur Studio', amount: 4200, frequency: 'monthly', isActive: true, kind: 'employment' };
    const pay = credit('brk-pay', 'brk', 'Direct Deposit - Larkspur Studio', 4200);
    const policy: IncomeContext = { sources: [employer] };
    expect(sumIncomeCents([pay], accounts, policy)).toBe(420000);
    expect(selectInflowReviewQueue([pay], accounts, policy)).toEqual([]);
  });

  it('the same credit on a cash account is still asked about — the scope is the account type, not the words', () => {
    const sameWordsOnChecking = { ...DIVIDEND, id: 'chk-div', accountId: 'chk' };
    expect(selectInflowReviewQueue([sameWordsOnChecking], accounts, NONE).map((q) => q.transactionId)).toEqual(['chk-div']);
  });
});
