import { FlowGraph } from '@/lib/flows';
import { SIMPLE_TOP_CATEGORIES, simplifyFlowGraph } from '@/lib/flow-simple';

const graph = (nodes: Array<[string, string]>, links: Array<[string, string, number]>,
  nodeTxnIds: Record<string, string[]> = {}): FlowGraph => ({
  nodes: nodes.map(([id, label]) => ({ id, label, kind: 'stub' as const })),
  links: links.map(([source, target, cents]) => ({ source, target, cents })),
  reconciliation: [], between: [], nodeTxnIds, nettedRefundCents: 7, personExpenseCents: 11,
});

describe('simplifyFlowGraph', () => {
  it('groups person lanes but keeps Remitly its own channel', () => {
    const g = simplifyFlowGraph(graph(
      [['person-in:A B', 'A B'], ['person-in:others', 'Others (people)'],
       ['person-out:C D', 'C D'], ['person-out:REMITLY', 'Sent to India (Remitly)'], ['acct:1', 'Bank']],
      [['person-in:A B', 'acct:1', 100], ['person-in:others', 'acct:1', 50],
       ['acct:1', 'person-out:C D', 30], ['acct:1', 'person-out:REMITLY', 500]]
    ));
    const ids = g.nodes.map((n) => n.id).sort();
    expect(ids).toEqual(['acct:1', 'person-out:REMITLY', 'simple:people-in', 'simple:people-out']);
    // the two inbound person links merged into one, cents conserved
    expect(g.links.find((l) => l.source === 'simple:people-in')!.cents).toBe(150);
    expect(g.links.find((l) => l.target === 'person-out:REMITLY')!.cents).toBe(500);
  });

  it('folds categories beyond the top N into a residual that adds up its count', () => {
    const cats: Array<[string, string, number]> = Array.from({ length: SIMPLE_TOP_CATEGORIES + 3 },
      (_, i) => ['acct:1', `cat:c${i}`, 1000 - i]);
    const g = simplifyFlowGraph(graph(
      [['acct:1', 'Bank'], ['cat:other', '81 smaller categories'],
       ...cats.map(([, id]) => [id, id.slice(4)] as [string, string])],
      [...cats, ['acct:1', 'cat:other', 5]]
    ));
    const residual = g.nodes.find((n) => n.id === 'cat:other')!;
    expect(residual.label).toBe('84 smaller categories'); // 81 + 3 folded
    const keptCats = g.nodes.filter((n) => n.id.startsWith('cat:') && n.id !== 'cat:other');
    expect(keptCats).toHaveLength(SIMPLE_TOP_CATEGORIES);
    // the 3 folded links + the old residual link merged into one, cents conserved
    const total = (ls: FlowGraph['links']) => ls.reduce((s, l) => s + l.cents, 0);
    expect(total(g.links)).toBe(total(cats.map(([s, t, v]) => ({ source: s, target: t, cents: v }))) + 5);
  });

  it('merges nodeTxnIds under the grouped id so drill-downs keep every row', () => {
    const g = simplifyFlowGraph(graph(
      [['refunds', 'Money back (unreviewed)'], ['rewards', 'Card rewards & cashback'], ['acct:1', 'Bank']],
      [['refunds', 'acct:1', 10], ['rewards', 'acct:1', 20]],
      { refunds: ['t1', 't2'], rewards: ['t3'] }
    ));
    expect(g.nodeTxnIds['simple:money-back'].sort()).toEqual(['t1', 't2', 't3']);
    // ledger-level figures pass through untouched
    expect(g.nettedRefundCents).toBe(7);
    expect(g.personExpenseCents).toBe(11);
  });

  it('merges grouped outflow lanes and leaves account-pair links untouched', () => {
    const g = simplifyFlowGraph(graph(
      [['acct:1', 'Bank'], ['acct:2', 'Card'], ['self-ext-out', 'x'], ['cardpay-out', 'y']],
      [['acct:1', 'acct:2', 100]].concat([['acct:1', 'self-ext-out', 5], ['acct:1', 'cardpay-out', 6]]) as never
    ));
    const kept = g.links.find((l) => l.target === 'acct:2')!;
    expect(kept.cents).toBe(100); // untouched pair link
    expect(g.links.find((l) => l.target === 'simple:out-unpaired')!.cents).toBe(11);
  });
});
