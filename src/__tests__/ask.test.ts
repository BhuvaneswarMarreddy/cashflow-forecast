/**
 * The seeded question is the whole feature: click a node, and the app asks on your
 * behalf. If it drops the facts, the model answers from its merchant list — which is
 * keyed differently — and quietly answers about a DIFFERENT set of rows than the ones
 * on screen. These pin the facts into the sentence.
 */
import { askAboutNode, askAboutTransaction } from '@/lib/ask';

const row = (o: Partial<Parameters<typeof askAboutNode>[1][number]>) => ({
  date: '2026-03-01', amount: 100, ...o,
});

describe('askAboutNode', () => {
  it('states count, total and date span from the rows on screen', () => {
    const q = askAboutNode('REMITLY', [
      row({ date: '2025-01-05', amount: 1000 }),
      row({ date: '2026-07-08', amount: 250.5 }),
    ]);
    expect(q).toContain('"REMITLY"');
    expect(q).toContain('2 transactions');
    expect(q).toContain('$1250.50');
    expect(q).toContain('between 2025-01-05 and 2026-07-08');
  });

  it('names the categories the rows actually carry, most-used first', () => {
    const q = askAboutNode('X', [
      row({ sourceCategory: 'Transfer' }),
      row({ sourceCategory: 'Transfer' }),
      row({ sourceCategory: 'Send to India' }),
    ]);
    expect(q).toContain('filed under Transfer, Send to India');
  });

  it('invites one question rather than a guess', () => {
    // Was "ask me one question"; now it names WHICH one, because the question carries
    // the numbered rows and "the first one" is a thing it can point at.
    expect(askAboutNode('X', [row({})])).toContain('ask me about the first one only');
  });

  it('says "1 transaction", not "1 transactions"', () => {
    expect(askAboutNode('X', [row({})])).toContain('1 transaction totalling');
  });

  it('survives a row with no date and a non-finite amount', () => {
    // Real feeds carry both; a seeded question containing "NaN" is worse than none.
    const q = askAboutNode('X', [row({ date: '', amount: Number.NaN }), row({ amount: 5 })]);
    expect(q).not.toMatch(/NaN/);
    expect(q).toContain('$5.00');
  });
});

describe('askAboutNode carries the rows, not just the total', () => {
  const rows = [
    row({ date: '2025-11-12T06:00:00.000Z', amount: 750, merchant: 'Turo', sourceCategory: 'Other Income' }),
    row({ date: '2026-05-05T05:00:00.000Z', amount: 130.79, merchant: 'Apple', sourceCategory: 'Other Income' }),
  ];

  it('lists every row so the model can go one at a time', () => {
    const q = askAboutNode('Card credits not yet explained', rows);
    // The owner asked the chat to work through 15 rows and it replied that it had no
    // details — because the question carried a count and a total and no rows.
    expect(q).toContain('1. 2025-11-12 · Turo · $750.00');
    expect(q).toContain('2. 2026-05-05 · Apple · $130.79');
    expect(q).toMatch(/ONE AT A TIME/);
  });

  it('never shows a raw timestamp to a person', () => {
    const q = askAboutNode('X', rows);
    expect(q).not.toMatch(/T\d{2}:\d{2}:\d{2}/);
    expect(q).toContain('between 2025-11-12 and 2026-05-05');
  });

  it('says how many it left out rather than silently truncating', () => {
    const many = Array.from({ length: 40 }, (_, i) =>
      row({ date: `2026-01-${String((i % 28) + 1).padStart(2, '0')}`, amount: 10, merchant: `M${i}` })
    );
    const q = askAboutNode('X', many);
    expect(q).toContain('first 25 of 40');
  });
});

describe('askAboutTransaction — one row, plus the neighbours that make follow-ups work', () => {
  const acct = [{ id: 'chk', name: 'CHASE SAVINGS' }];
  const t = (id: string, date: string, amount: number, over: object = {}) =>
    ({ id, date, amount, merchant: `M-${id}`, accountId: 'chk', type: 'expense', ...over });
  const ALL = [t('a', '2026-07-28', 12.34), t('b', '2026-08-01', 500, { type: 'transfer', transferDirection: 'out', merchant: 'Zelle' }), t('c', '2026-08-03', 5)];

  it('says from/to for a transfer and names the account', () => {
    const q = askAboutTransaction(ALL[1] as never, acct, ALL as never);
    expect(q).toContain('a transfer OUT of CHASE SAVINGS');
    expect(q).toContain('2026-08-01 · Zelle · $500.00');
  });

  it('ships the neighbours and marks the clicked row, so "the next one" means something', () => {
    const q = askAboutTransaction(ALL[1] as never, acct, ALL as never);
    expect(q).toContain('  2026-07-28 · M-a · $12.34');
    expect(q).toContain('<- this one');
    expect(q).toContain('  2026-08-03 · M-c · $5.00');
    expect(q).toContain('use the neighbours listed above');
  });

  it('neighbours come from the SAME account only', () => {
    const other = t('x', '2026-08-02', 99, { accountId: 'other' });
    const q = askAboutTransaction(ALL[1] as never, acct, [...ALL, other] as never);
    expect(q).not.toContain('M-x');
  });
});
