/**
 * The chat used to answer "no groceries last month" from a 20-row sample, and to say
 * what Instacart "typically" is with no data on Instacart at all. These tests pin the
 * fix: totals cover every row, transfers are excluded, and every cap reports what it
 * dropped so the model can say "I don't have that" instead of inventing it.
 */
import { ExpenseCategory, PaymentAccount, Transaction } from '@/types';
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

/**
 * cashflow-mobile#25: "what did I spend this month, and on what" needs a month-scoped
 * category breakdown — byCategoryThisYear alone is a whole year, too coarse to answer
 * it precisely. `today` is ALWAYS an injected string here, never wall time — a sibling
 * test in this suite (buildLedgerSummary's own `today` parameter, above) flaked once on
 * a real timestamp, and a month-boundary test is exactly where that would bite hardest.
 */
describe('buildLedgerSummary — byCategoryThisMonth / byCategoryLastMonth (cashflow-mobile#25)', () => {
  it('buckets expenses into THIS month and LAST month, and excludes everything else', () => {
    const s = buildLedgerSummary([
      tx({ amount: 40, category: 'food', date: '2026-08-02' }),
      tx({ amount: 60, category: 'food', date: '2026-08-15' }),
      tx({ amount: 25, category: 'transportation', date: '2026-08-20' }),
      tx({ amount: 90, category: 'shopping', date: '2026-07-10' }), // last month
      tx({ amount: 999, category: 'food', date: '2026-06-01' }),   // two months back — excluded
      tx({ amount: 999, category: 'food', date: '2025-08-01' }),   // same month, prior year — excluded
    ], ACCOUNTS, '2026-08-21');

    expect(s.byCategoryThisMonth).toEqual([
      { category: 'Food & Dining', spending: 100, count: 2 },
      { category: 'Transportation', spending: 25, count: 1 },
    ]);
    expect(s.byCategoryLastMonth).toEqual([
      { category: 'Shopping', spending: 90, count: 1 },
    ]);
  });

  it('crosses a YEAR boundary correctly: January\'s "last month" is December of the prior year', () => {
    const s = buildLedgerSummary([
      tx({ amount: 50, category: 'food', date: '2026-01-05' }),   // this month
      tx({ amount: 70, category: 'food', date: '2025-12-28' }),   // last month, prior year
      tx({ amount: 999, category: 'food', date: '2025-11-30' }),  // two months back — excluded
    ], ACCOUNTS, '2026-01-15');

    expect(s.byCategoryThisMonth).toEqual([{ category: 'Food & Dining', spending: 50, count: 1 }]);
    expect(s.byCategoryLastMonth).toEqual([{ category: 'Food & Dining', spending: 70, count: 1 }]);
  });

  it('excludes income and transfers from both month buckets — FIN-LEDGER-001, same rule as every other total here', () => {
    const s = buildLedgerSummary([
      tx({ amount: 40, category: 'food', type: 'expense', date: '2026-08-02' }),
      tx({ amount: 5000, type: 'income', date: '2026-08-03' }),
      tx({ amount: 500, type: 'transfer', transferDirection: 'out', date: '2026-08-04' }),
    ], ACCOUNTS, '2026-08-21');

    expect(s.byCategoryThisMonth).toEqual([{ category: 'Food & Dining', spending: 40, count: 1 }]);
  });

  it('reports what the 15-category cap dropped, same convention as the year breakdown', () => {
    // The 13 built-in categories plus 5 custom slugs (`as ExpenseCategory` — the same
    // idiom the rest of this codebase uses for a runtime-valid, compile-time-foreign
    // custom category value) — 18 distinct categories, comfortably over the 15-cap.
    const builtIn: ExpenseCategory[] = [
      'food', 'transportation', 'utilities', 'entertainment', 'shopping', 'healthcare',
      'education', 'travel', 'subscriptions', 'rent', 'insurance', 'investments', 'other',
    ];
    const custom = ['vacations', 'gym', 'gifts', 'pets', 'kids'].map((c) => c as ExpenseCategory);
    const categories = [...builtIn, ...custom];
    const rows = categories.map((category, i) => tx({ amount: i + 1, category, date: '2026-08-05' }));
    const s = buildLedgerSummary(rows, ACCOUNTS, '2026-08-21');

    expect(s.byCategoryThisMonth).toHaveLength(15);
    expect(s.categoriesThisMonthOmitted).toBe(categories.length - 15);
  });

  it('reports an empty ledger without inventing month buckets', () => {
    const s = buildLedgerSummary([], ACCOUNTS, TODAY);
    expect(s.byCategoryThisMonth).toEqual([]);
    expect(s.categoriesThisMonthOmitted).toBe(0);
    expect(s.byCategoryLastMonth).toEqual([]);
    expect(s.categoriesLastMonthOmitted).toBe(0);
  });
});
