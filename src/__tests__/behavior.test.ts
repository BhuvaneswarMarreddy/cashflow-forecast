/**
 * Behavior engine tests — classification 8-way, assumption medians, overrides, dedup.
 * classifyBehaviors/buildAssumptions anchor "today" internally, so fixtures are
 * relative-dated (same style as monthly-averages.test.ts).
 */
import { Transaction, PaymentAccount } from '@/types';
import { classifyBehaviors, buildAssumptions, behaviorEvents } from '@/lib/behavior';

const tx = (o: Partial<Transaction> & { id: string; amount: number; date: string }): Transaction => ({
  title: o.id, type: 'expense', category: 'other', paymentMethod: 'bank-transfer', ...o,
} as Transaction);

const acct = (o: Partial<PaymentAccount> & { id: string }): PaymentAccount => ({
  name: o.id, type: 'bank_account', provider: 'chase', color: '#000', isActive: true,
  openingBalance: 0, openingDate: '2000-01-01', ...o,
} as PaymentAccount);

const now = new Date();
/** Day `dayN` of the month `back` full months ago (UTC, matching the engine's window). */
const m = (back: number, dayN = 15) =>
  new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - back, dayN)).toISOString().slice(0, 10);
/** `days` days ago. */
const dAgo = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
const todayStr = dAgo(0);

const bank = acct({ id: 'bankA' });
const bankB = acct({ id: 'bankB' });
const card = acct({ id: 'cardC', type: 'credit_card', provider: 'amex' });
const accounts = [bank, bankB, card];

// Realistic ledger covering every class.
const ledger: Transaction[] = [
  // paired bank->bank transfer ($500 both legs)
  tx({ id: 'xfer-out', amount: 500, type: 'transfer', transferDirection: 'out', accountId: 'bankA', date: m(1, 10) }),
  tx({ id: 'xfer-in', amount: 500, type: 'transfer', transferDirection: 'in', accountId: 'bankB', date: m(1, 10) }),
  // card-payment pair ($200, receiving side is a credit card)
  tx({ id: 'cardpay-out', amount: 200, type: 'transfer', transferDirection: 'out', accountId: 'bankA', date: m(1, 20) }),
  tx({ id: 'cardpay-in', amount: 200, type: 'transfer', transferDirection: 'in', accountId: 'cardC', date: m(1, 20) }),
  // refund on the bank side
  tx({ id: 'refund1', amount: 45, type: 'income', accountId: 'bankA', title: 'Amazon Refund', sourceCategory: 'Shopping', date: m(2, 8) }),
  // paychecks: biweekly, median $2,500
  ...[70, 56, 42, 28, 14].map((d, i) => tx({
    id: `pay${i}`, amount: i === 1 ? 2600 : 2500, type: 'income', accountId: 'bankA',
    title: 'Payroll Deposit', sourceCategory: 'Paychecks', date: dAgo(d),
  })),
  // fixed bill: VERIZON monthly $49.99 across 6 months
  ...[1, 2, 3, 4, 5, 6].map((b) => tx({
    id: `vz${b}`, amount: 49.99, merchant: 'VERIZON', accountId: 'bankA', date: m(b, 14),
  })),
  // Shopping: a $1,400 one-time TV vs $60 ordinary buys in the SAME category
  tx({ id: 'tv', amount: 1400, merchant: 'BEST BUY', sourceCategory: 'Shopping', accountId: 'cardC', date: m(1, 22) }),
  ...[1, 2, 3, 4, 5].map((b) => tx({
    id: `shop${b}`, amount: 60, merchant: `STORE ${b}X`, sourceCategory: 'Shopping', accountId: 'cardC', date: m(b, 5),
  })),
  // groceries in 5 of the last 6 months -> variable-recurring
  ...[1, 2, 3, 4, 5].map((b) => tx({
    id: `groc${b}`, amount: 80 + b * 5, merchant: `MARKET ${b}Q`, sourceCategory: 'Groceries', accountId: 'bankA', date: m(b, 9),
  })),
  // lifestyle: one dining row
  tx({ id: 'dine1', amount: 45, merchant: 'CHIPOTLE', sourceCategory: 'Dining & Drinks', accountId: 'cardC', date: m(2, 18) }),
];

describe('classifyBehaviors — all 8 classes', () => {
  const cls = classifyBehaviors(ledger, accounts);

  it('tags both legs of a bank->bank pair as transfer', () => {
    expect(cls.get('xfer-out')).toBe('transfer');
    expect(cls.get('xfer-in')).toBe('transfer');
  });

  it('tags both legs of a bank->card pair as card-payment', () => {
    expect(cls.get('cardpay-out')).toBe('card-payment');
    expect(cls.get('cardpay-in')).toBe('card-payment');
  });

  it('tags a refund-titled positive as refund, not income', () => {
    expect(cls.get('refund1')).toBe('refund');
  });

  it('tags paychecks as income', () => {
    expect(cls.get('pay0')).toBe('income');
  });

  it('tags an active recurring merchant expense as fixed-bill', () => {
    expect(cls.get('vz3')).toBe('fixed-bill');
  });

  it('splits the $1,400 TV (one-time) from the $60 buy (same category)', () => {
    expect(cls.get('tv')).toBe('one-time');
    expect(cls.get('shop2')).not.toBe('one-time');
  });

  it('tags a category present in >=4 of 6 months as variable-recurring', () => {
    expect(cls.get('groc1')).toBe('variable-recurring');
  });

  it('tags a sporadic category as lifestyle', () => {
    expect(cls.get('dine1')).toBe('lifestyle');
  });
});

describe('buildAssumptions', () => {
  const a = buildAssumptions(ledger, accounts);

  it('detects biweekly paychecks: cadence, median amount, nextDate', () => {
    expect(a.income).toMatchObject({
      cadence: 'biweekly', medianAmount: 2500, nextDate: todayStr, confidence: 1,
    });
  });

  it('lists VERIZON as a fixed bill with amount and confidence', () => {
    const vz = a.fixedBills.find((b) => b.merchant === 'VERIZON')!;
    expect(vz).toMatchObject({ amount: 49.99, cadence: 'monthly', accountId: 'bankA' });
    expect(vz.confidence).toBeGreaterThanOrEqual(0.6);
  });

  it('surfaces exclusions with counts and the one-time list', () => {
    expect(a.exclusions.transfers).toBe(2);
    expect(a.exclusions.cardPayments).toBe(2);
    expect(a.exclusions.refunds).toBe(1);
    expect(a.exclusions.oneTimes).toEqual([
      { id: 'tv', title: 'tv', amount: 1400, date: m(1, 22) },
    ]);
  });

  it('baselines EXCLUDE one-times/refunds/transfers/fixed-bills', () => {
    // Groceries: monthly sums 85..105 over 5 observed months -> median 95
    expect(a.categoryBaselines.find((b) => b.category === 'Groceries')).toEqual({
      category: 'Groceries', monthlyMedian: 95, monthsObserved: 5,
    });
    // Shopping baseline is the $60 habit only — the $1,400 TV must not move it
    const shopping = a.categoryBaselines.find((b) => b.category === 'Shopping')!;
    expect(shopping.monthlyMedian).toBe(60);
    const without = buildAssumptions(ledger.filter((t) => t.id !== 'tv'), accounts);
    expect(without.categoryBaselines.find((b) => b.category === 'Shopping')!.monthlyMedian).toBe(60);
    // no baseline row for excluded classes
    expect(a.categoryBaselines.some((b) => b.category === 'Paychecks')).toBe(false);
  });

  it('applies overrides last: bill amount patch, baseline removal, income patch', () => {
    const o = buildAssumptions(ledger, accounts, {
      income: { amount: 3000 },
      bills: { VERIZON: { amount: 55 } },
      baselines: { Groceries: null, 'Pet Care': 40 },
    });
    expect(o.income!.medianAmount).toBe(3000);
    expect(o.fixedBills.find((b) => b.merchant === 'VERIZON')!.amount).toBe(55);
    expect(o.categoryBaselines.some((b) => b.category === 'Groceries')).toBe(false);
    expect(o.categoryBaselines.find((b) => b.category === 'Pet Care')).toEqual({
      category: 'Pet Care', monthlyMedian: 40, monthsObserved: 0,
    });
  });
});

describe('behaviorEvents', () => {
  it('projects income at the pay cadence and bills at nextDue', () => {
    const a = buildAssumptions(ledger, accounts);
    const evts = behaviorEvents(a, accounts, todayStr, 60);
    const pay = evts.filter((e) => e.type === 'income');
    expect(pay.length).toBeGreaterThanOrEqual(3); // biweekly over 60 days
    expect(pay[0].amount).toBe(2500);
    expect(pay[0].source).toBe('projected');
    const vz = evts.filter((e) => e.description === 'VERIZON');
    expect(vz.length).toBeGreaterThanOrEqual(1);
    expect(vz[0]).toMatchObject({ amount: -49.99, contributors: ['VERIZON'] });
  });

  it('emits daily living costs with breakdown, confidence and contributors', () => {
    const a = buildAssumptions(ledger, accounts);
    const evts = behaviorEvents(a, accounts, todayStr, 30);
    const living = evts.filter((e) => e.description === 'Projected living costs');
    expect(living.length).toBeGreaterThanOrEqual(28);
    const total = a.categoryBaselines.reduce((s, b) => s + b.monthlyMedian, 0);
    expect(living[0].amount).toBeCloseTo(-Math.round((total * 12 / 365) * 100) / 100, 2);
    expect(living[0].breakdown!.map((b) => b.label)).toContain('Groceries');
    expect(living[0].contributors!.length).toBeLessThanOrEqual(3);
    expect(living[0].confidence).toBeCloseTo(5 / 6, 5);
  });

  it('override: disabled bill produces no events; null income produces no income events', () => {
    const disabled = buildAssumptions(ledger, accounts, {
      income: null, bills: { VERIZON: { disabled: true } },
    });
    expect(disabled.income).toBeNull();
    const evts = behaviorEvents(disabled, accounts, todayStr, 60);
    expect(evts.some((e) => e.type === 'income')).toBe(false);
    expect(evts.some((e) => e.description === 'VERIZON')).toBe(false);
  });

  it('dedups a detected bill against its loan-account twin (loan wins)', () => {
    const loan = acct({ id: 'loan1', type: 'personal_loan', provider: 'other', monthlyPayment: 250, dueDate: 5 });
    // day 25: always within detectRecurring's active window (day 5 can drift to 57 days ago)
    const upstart = [1, 2, 3, 4, 5, 6].map((b) => tx({
      id: `up${b}`, amount: 250, merchant: 'UPSTART', accountId: 'bankA', date: m(b, 25),
    }));
    const a = buildAssumptions(upstart, [bank, loan]);
    // the detection itself stands...
    expect(a.fixedBills.find((b) => b.merchant === 'UPSTART')).toBeDefined();
    // ...but with the loan present its events are skipped (generateBillEvents' twin wins)
    expect(behaviorEvents(a, [bank, loan], todayStr, 90).some((e) => e.description === 'UPSTART')).toBe(false);
    // without the loan, the detected bill projects normally
    expect(behaviorEvents(a, [bank], todayStr, 90).some((e) => e.description === 'UPSTART')).toBe(true);
    // fixed-bill history never leaks into living costs
    expect(behaviorEvents(a, [bank, loan], todayStr, 90).some((e) => e.description === 'Projected living costs')).toBe(false);
  });
});
