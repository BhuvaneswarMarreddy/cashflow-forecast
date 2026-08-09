/**
 * #79 — a remittance is not "money moving between accounts you own".
 *
 * The transfer branch of `interpretTransaction` was a binary: card payment, or internal.
 * `namesExternalCounterparty` was imported in that file and never consulted, so a
 * Remitly row typed `transfer` came out as `internal_transfer` — a claim that the money
 * never left the owner's net worth. The repo's own integration test measures
 * $120,562.36 of real outflow through Remitly.
 *
 * THE LINE THIS FIX WALKS. FIN-SETTLEMENT-003 says only a confirmation moves a number.
 * A previous attempt at this issue changed the TREATMENT and was correctly reverted.
 * This changes only the LABEL, so every unconfirmed total is byte-identical; the tests
 * below assert both halves of that, because the label being honest is worthless if the
 * numbers moved to buy it.
 */
import { interpretTransaction, personalCostSign, sumExpenseCents, POSTED_ONLY } from '@/lib/classify';
import { namesExternalCounterparty } from '@/lib/counterparty';
import { roleOf } from '@/lib/money-roles';
import { OUTFLOW_GROUP_MEANINGS } from '@/lib/mapping-suggestions';
import type { PaymentAccount, Transaction, InflowReview } from '@/types';

const ACCOUNTS = [
  { id: 'chk', name: 'Checking', type: 'bank_account', openingBalance: 0, provider: 'other', color: '#000', isActive: true },
] as PaymentAccount[];

/** One remittance row, in whichever shape the importer happened to produce. */
const remitly = (type: 'expense' | 'transfer'): Transaction => ({
  id: `r-${type}`,
  title: 'Remitly',
  merchant: 'Remitly',
  description: 'RMTLY* US1234 REMITLY',
  sourceCategory: type === 'transfer' ? 'Transfer' : 'Other',
  amount: 500,
  type,
  ...(type === 'transfer' ? { transferDirection: 'out' as const } : {}),
  category: 'other',
  paymentMethod: 'other',
  date: '2026-03-01',
  accountId: 'chk',
} as Transaction);

const confirmedAs = (t: Transaction, meaning: string) => ({
  reviews: {
    [t.id]: { transactionId: t.id, state: 'confirmed', meaning, source: 'user', updatedAt: '' } as InflowReview,
  },
});

describe('the app already knew, and did not use it', () => {
  it('recognises both shapes as naming someone outside the owner', () => {
    expect(namesExternalCounterparty(remitly('transfer'))).toBe(true);
    expect(namesExternalCounterparty(remitly('expense'))).toBe(true);
  });
});

describe('a remittance is never called internal', () => {
  it('stops claiming the money moved between the owner\'s own accounts', () => {
    const i = interpretTransaction(remitly('transfer'), ACCOUNTS);
    expect(i.financialMeaning).not.toBe('internal_transfer');
    expect(i.financialMeaning).toBe('gift_or_personal_transfer');
  });

  it('says WHY, so the reason does not contradict the label', () => {
    expect(interpretTransaction(remitly('transfer'), ACCOUNTS).reason)
      .toMatch(/names someone who is not you/);
  });

  it('still calls a genuine self-transfer internal', () => {
    const own = { ...remitly('transfer'), title: 'Transfer to Savings', merchant: 'Transfer', description: 'Online Transfer to SAV 1234' };
    expect(interpretTransaction(own, ACCOUNTS).financialMeaning).toBe('internal_transfer');
  });
});

describe('no number moves without a confirmation', () => {
  it('leaves spending exactly where it was for BOTH import shapes', () => {
    // The stored type still decides the treatment while nothing is confirmed. This is
    // the assertion that would have caught the reverted attempt.
    expect(interpretTransaction(remitly('transfer'), ACCOUNTS).expense).toBe('excluded');
    expect(interpretTransaction(remitly('expense'), ACCOUNTS).expense).toBe('counted');
    expect(sumExpenseCents([remitly('transfer')], ACCOUNTS, POSTED_ONLY)).toBe(0);
    expect(sumExpenseCents([remitly('expense')], ACCOUNTS, POSTED_ONLY)).toBe(50_000);
  });

  it('keeps an unconfirmed transfer leg nettable, because netting is a number', () => {
    expect(interpretTransaction(remitly('transfer'), ACCOUNTS).transfer).toBe('internal_leg');
  });

  it('the honest label costs nothing — that is why it is allowed to be honest', () => {
    expect(personalCostSign('gift_or_personal_transfer')).toBe(0);
  });
});

describe('once the owner confirms, it behaves like money that left', () => {
  const row = remitly('transfer');

  it('is excluded from spending — sent, not consumed', () => {
    const i = interpretTransaction(row, ACCOUNTS, confirmedAs(row, 'gift_or_personal_transfer'));
    expect(i.expense).toBe('excluded');
  });

  it('stops being an internal leg, so nothing nets it away', () => {
    const i = interpretTransaction(row, ACCOUNTS, confirmedAs(row, 'gift_or_personal_transfer'));
    expect(i.transfer).toBe('none');
  });

  it('still counts as spending if the owner says it was', () => {
    const i = interpretTransaction(row, ACCOUNTS, confirmedAs(row, 'personal_expense'));
    expect(i.expense).toBe('counted');
  });
});

describe('the vocabulary #45 already shipped', () => {
  it('files it under Transferred — not Spent, not internal', () => {
    expect(roleOf('gift_or_personal_transfer')).toBe('transferred');
  });

  it('is already an answer the owner can pick for an outflow', () => {
    expect(OUTFLOW_GROUP_MEANINGS.map((m) => m.value)).toContain('gift_or_personal_transfer');
  });
});
