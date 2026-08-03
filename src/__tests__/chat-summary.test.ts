/**
 * The chat used to answer "no groceries last month" from a 20-row sample, and to say
 * what Instacart "typically" is with no data on Instacart at all. These tests pin the
 * fix: totals cover every row, transfers are excluded, and every cap reports what it
 * dropped so the model can say "I don't have that" instead of inventing it.
 */
import { PaymentAccount, Transaction } from '@/types';
import { buildLedgerSummary } from '@/lib/chat-summary';

const ACCOUNTS: PaymentAccount[] = [
  { id: 'bank', name: 'Checking', type: 'bank_account', isActive: true } as PaymentAccount,
  { id: 'card', name: 'Card', type: 'credit_card', isActive: true } as PaymentAccount,
];

const tx = (o: Partial<Transaction>): Transaction => ({
  id: Math.random().toString(36).slice(2),
  title: 'Thing',
  amount: 10,
  type: 'expense',
  category: 'other',
  paymentMethod: 'other',
  date: '2026-03-05',
  accountId: 'bank',
  ...o,
} as Transaction);

const TODAY = '2026-08-02';

describe('buildLedgerSummary', () => {
  it('reports an empty ledger without inventing a span', () => {
    const s = buildLedgerSummary([], ACCOUNTS, TODAY);
    expect(s.span).toEqual({ from: '', to: '', transactions: 0 });
    expect(s.byYear).toEqual([]);
    expect(s.topMerchants).toEqual([]);
  });

  it('counts every row, not a recent window — the original bug', () => {
    // 400 rows across two years. A 20-row sample would see only 2026.
    const rows = [
      ...Array.from({ length: 200 }, (_, i) =>
        tx({ amount: 5, date: `2025-${String((i % 12) + 1).padStart(2, '0')}-10` })),
      ...Array.from({ length: 200 }, (_, i) =>
        tx({ amount: 3, date: `2026-${String((i % 7) + 1).padStart(2, '0')}-10` })),
    ];
    const s = buildLedgerSummary(rows, ACCOUNTS, TODAY);

    expect(s.span.transactions).toBe(400);
    expect(s.byYear.find((y) => y.period === '2025')!.spending).toBe(1000);
    expect(s.byYear.find((y) => y.period === '2026')!.spending).toBe(600);
  });

  it('excludes transfers from income and spending', () => {
    // A card payment is debt settlement: $0 income, $0 spending. FIN-LEDGER-001.
    const s = buildLedgerSummary([
      tx({ amount: 100, type: 'expense', date: '2026-03-01' }),
      tx({ amount: 500, type: 'transfer', transferDirection: 'out', date: '2026-03-02' }),
      tx({ amount: 500, type: 'transfer', transferDirection: 'in', date: '2026-03-02', accountId: 'card' }),
      tx({ amount: 250, type: 'income', date: '2026-03-03' }),
    ], ACCOUNTS, TODAY);

    const y = s.byYear.find((p) => p.period === '2026')!;
    expect({ income: y.income, spending: y.spending, net: y.net }).toEqual({
      income: 250, spending: 100, net: 150,
    });
    // The transfer legs are still real rows — they count toward the span, not the totals.
    expect(s.span.transactions).toBe(4);
  });

  it('records what was SENT through a merchant, not just what it cost', () => {
    // The Remitly bug: 3 spending rows and 75 transfer rows reported as "$5,208.25
    // spent" when $120,562.36 had actually been sent. Both numbers were true; the
    // one shown answered a question nobody asked.
    const s = buildLedgerSummary([
      tx({ merchant: 'WIRE SVC', amount: 100, type: 'expense', date: '2026-01-05' }),
      tx({ merchant: 'WIRE SVC', amount: 5000, type: 'transfer', transferDirection: 'out', date: '2026-02-05' }),
      tx({ merchant: 'WIRE SVC', amount: 3000, type: 'transfer', transferDirection: 'out', date: '2026-03-05' }),
    ], ACCOUNTS, TODAY);

    const m = s.topMerchants.find((x) => x.name === 'WIRE SVC')!;
    expect({ spending: m.spending, transferred: m.transferred, count: m.count })
      .toEqual({ spending: 100, transferred: 8000, count: 3 });

    // ...and the transfers still stay out of the period totals.
    expect(s.byYear.find((y) => y.period === '2026')!.spending).toBe(100);
  });

  it('ranks a transfer-heavy merchant by everything that moved', () => {
    // Ranked on spending alone, a six-figure remittance service falls off the list
    // below a coffee shop and the owner can never ask about it.
    const rows = [
      tx({ merchant: 'WIRE SVC', amount: 90_000, type: 'transfer', transferDirection: 'out', date: '2026-01-05' }),
      ...Array.from({ length: 60 }, (_, i) =>
        tx({ merchant: `SHOP${i}`, amount: i + 1, date: '2026-04-01' })),
    ];
    const s = buildLedgerSummary(rows, ACCOUNTS, TODAY);
    expect(s.topMerchants[0].name).toBe('WIRE SVC');
  });

  it('gives a merchant its real total and the categories it actually carries', () => {
    // The Instacart question: the answer must come from rows, not world knowledge.
    const s = buildLedgerSummary([
      tx({ merchant: 'INSTACART', amount: 40, category: 'other', date: '2026-01-04' }),
      tx({ merchant: 'INSTACART', amount: 60, category: 'other', date: '2026-02-04' }),
      tx({ merchant: 'INSTACART', amount: 20, category: 'food', date: '2026-03-04' }),
    ], ACCOUNTS, TODAY);

    const m = s.topMerchants.find((x) => x.name === 'INSTACART')!;
    expect(m.spending).toBe(120);
    expect(m.count).toBe(3);
    expect(m.categories[0]).toBe('Other');      // most-used first
    expect(m.firstDate).toBe('2026-01-04');
    expect(m.lastDate).toBe('2026-03-04');
  });

  it('breaks the current year down by category', () => {
    const s = buildLedgerSummary([
      tx({ amount: 30, category: 'food', date: '2026-02-01' }),
      tx({ amount: 70, category: 'food', date: '2026-03-01' }),
      tx({ amount: 25, category: 'transportation', date: '2026-03-02' }),
      tx({ amount: 999, category: 'food', date: '2025-03-01' }), // prior year, excluded
    ], ACCOUNTS, TODAY);

    expect(s.byCategoryThisYear[0]).toEqual({ category: 'Food & Dining', spending: 100, count: 2 });
    expect(s.byCategoryThisYear.map((c) => c.spending)).toEqual([100, 25]);
  });

  it('reports what each cap dropped instead of truncating silently', () => {
    // 60 distinct merchants against a cap of 40.
    const rows = Array.from({ length: 60 }, (_, i) =>
      tx({ merchant: `M${i}`, amount: i + 1, date: '2026-04-01' }));
    const s = buildLedgerSummary(rows, ACCOUNTS, TODAY);

    expect(s.topMerchants).toHaveLength(40);
    expect(s.merchantsOmitted).toBe(20);
    // Ranked by money moved, so the largest survives the cap.
    expect(s.topMerchants[0].name).toBe('M59');
  });

  it('orders months newest-first and caps at two years', () => {
    const rows = Array.from({ length: 40 }, (_, i) => {
      const d = new Date(Date.UTC(2023, i, 15)).toISOString().slice(0, 10);
      return tx({ amount: 10, date: d });
    });
    const s = buildLedgerSummary(rows, ACCOUNTS, TODAY);

    expect(s.byMonth).toHaveLength(24);
    expect(s.monthsOmitted).toBe(16);
    expect(s.byMonth[0].period > s.byMonth[1].period).toBe(true);
  });
});
