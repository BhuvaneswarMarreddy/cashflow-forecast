/**
 * The seeded question is the whole feature: click a node, and the app asks on your
 * behalf. If it drops the facts, the model answers from its merchant list — which is
 * keyed differently — and quietly answers about a DIFFERENT set of rows than the ones
 * on screen. These pin the facts into the sentence.
 */
import { askAboutNode } from '@/lib/ask';

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
    expect(askAboutNode('X', [row({})])).toContain('ask me one question');
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
