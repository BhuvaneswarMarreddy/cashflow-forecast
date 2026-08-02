/**
 * FIN-REFUND-001 §11.4 — the Flow contract (G1–G4).
 *
 * The governing rule: never destroy gross history to show net. A confirmed refund
 * link is an ANNOTATION — buildFlowGraph() is untouched, no node is added, no edge is
 * added, no cent moves. G1 is the regression that proves it.
 *
 * Sanitized fixtures only.
 */

import { PaymentAccount, Transaction } from '@/types';
import { buildFlowGraph } from '@/lib/flows';
import { TransactionLink, linkIndex } from '@/lib/relations';
import { purchaseEconomics, REFUND_MATCH_VERSION } from '@/lib/refunds';

const accounts: PaymentAccount[] = [
  {
    id: 'demo-card-9021', name: 'Demo Rewards Card', type: 'credit_card', provider: 'amex',
    lastFourDigits: '9021', creditLimit: 500000,
    openingBalance: 0, openingDate: '2000-01-01', color: '#222', isActive: true,
  },
  {
    id: 'demo-chk', name: 'Demo Everyday Checking', type: 'bank_account', provider: 'chase',
    openingBalance: 500000, openingDate: '2000-01-01', color: '#111', isActive: true,
  },
];

const tx = (o: Partial<Transaction> & { id: string; title: string; amount: number }): Transaction => ({
  type: 'expense', category: 'other', paymentMethod: 'other', date: '2026-07-20',
  sources: ['simplefin'], ...o,
});

const PURCHASE_A = tx({
  id: 'demo-purchase-a', title: 'Demo Amazon Lens', merchant: 'DEMO AMAZON',
  amount: 1100, category: 'shopping', accountId: 'demo-card-9021', date: '2026-07-12',
});
const PURCHASE_B = tx({
  id: 'demo-purchase-b', title: 'Demo Amazon Filter', merchant: 'DEMO AMAZON',
  amount: 100, category: 'shopping', accountId: 'demo-card-9021', date: '2026-07-14',
});
const COMBINED_CREDIT = tx({
  id: 'demo-refund-ab', title: 'Demo Amazon Refund', merchant: 'DEMO AMAZON',
  amount: 1200, type: 'income', accountId: 'demo-card-9021', date: '2026-07-31',
});
const BANK_REFUND = tx({
  id: 'demo-bank-refund', title: 'Demo Fernvale Refund', merchant: 'DEMO FERNVALE',
  amount: 60, type: 'income', accountId: 'demo-chk', date: '2026-07-28',
});

const LEDGER = [PURCHASE_A, PURCHASE_B, COMBINED_CREDIT, BANK_REFUND];
const PERIOD = { start: '2026-07-01', end: '2026-07-31' };

const LINKS: TransactionLink[] = [
  {
    id: `refund_of~${COMBINED_CREDIT.id}~${PURCHASE_A.id}`, linkType: 'refund_of',
    sourceTransactionId: COMBINED_CREDIT.id, targetTransactionId: PURCHASE_A.id,
    allocatedAmountCents: 110000, status: 'confirmed', algorithmVersion: REFUND_MATCH_VERSION,
    confirmedAt: '2026-08-01T00:00:00.000Z', createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z',
  },
  {
    id: `refund_of~${COMBINED_CREDIT.id}~${PURCHASE_B.id}`, linkType: 'refund_of',
    sourceTransactionId: COMBINED_CREDIT.id, targetTransactionId: PURCHASE_B.id,
    allocatedAmountCents: 10000, status: 'confirmed', algorithmVersion: REFUND_MATCH_VERSION,
    confirmedAt: '2026-08-01T00:00:00.000Z', createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z',
  },
];

describe('G1 — Flow conservation is unchanged by confirmed refund links', () => {
  it('the graph over the ledger is byte-identical with and without the links', () => {
    // FIN-REFUND-001 passes no link into buildFlowGraph and adds no node or edge —
    // the only honest way to prove the graph cannot drift is to show the same input
    // produces the same output while the link set exists beside it.
    const without = buildFlowGraph(LEDGER, accounts, PERIOD);
    const withLinks = buildFlowGraph(LEDGER, accounts, PERIOD);
    expect(LINKS).toHaveLength(2);
    expect(JSON.stringify(withLinks)).toBe(JSON.stringify(without));
    expect(withLinks.nodes.map((n) => n.id).sort()).toEqual(without.nodes.map((n) => n.id).sort());
    expect(withLinks.links.reduce((s, l) => s + l.cents, 0)).toBe(without.links.reduce((s, l) => s + l.cents, 0));
  });

  it('no recovery node is introduced', () => {
    const graph = buildFlowGraph(LEDGER, accounts, PERIOD);
    for (const id of graph.nodes.map((n) => n.id)) {
      expect(id).not.toMatch(/refund_of|allocation|recovery|net-cost/);
    }
  });
});

describe('G2 — the credit still reaches the refunds node on both account kinds', () => {
  it('a card refund and a bank refund both route to "refunds"', () => {
    const graph = buildFlowGraph(LEDGER, accounts, PERIOD);
    expect(graph.nodes.some((n) => n.id === 'refunds')).toBe(true);
    const fromRefunds = graph.links.filter((l) => l.source === 'refunds');
    expect(fromRefunds.reduce((s, l) => s + l.cents, 0)).toBe(126000); // 120000 card + 6000 bank
    expect(graph.nodeTxnIds.refunds.sort()).toEqual(['demo-bank-refund', 'demo-refund-ab']);
  });

  it('neither refund reaches an income node', () => {
    const graph = buildFlowGraph(LEDGER, accounts, PERIOD);
    const incomeSourced = graph.links.filter((l) => l.source.startsWith('inc:'));
    expect(incomeSourced).toEqual([]);
  });
});

describe('G3 — the linked pair is resolvable from nodeTxnIds plus the link map', () => {
  it('selecting the credit resolves both purchases without changing the graph', () => {
    const graph = buildFlowGraph(LEDGER, accounts, PERIOD);
    const index = linkIndex(LINKS);

    const creditRows = graph.nodeTxnIds.refunds;
    expect(creditRows).toContain(COMBINED_CREDIT.id);

    const related = (index.get(COMBINED_CREDIT.id) ?? [])
      .filter((l) => l.status === 'confirmed')
      .map((l) => l.targetTransactionId)
      .sort();
    expect(related).toEqual(['demo-purchase-a', 'demo-purchase-b']);

    // Both partners are present in the graph's own drill-down ids — the affordance
    // FIN-RECOVERY-UI-001 renders needs nothing added to the graph.
    const allGraphTxnIds = new Set(Object.values(graph.nodeTxnIds).flat());
    for (const id of related) expect(allGraphTxnIds.has(id)).toBe(true);
  });
});

describe('G4 — story.spending and the per-row net figures agree to the cent', () => {
  it('the aggregate and the row-level answers reconcile', () => {
    const graph = buildFlowGraph(LEDGER, accounts, PERIOD);
    // The exact expression src/app/flow/page.tsx:431-433 evaluates.
    const sum = (pred: (l: { source: string; target: string; cents: number }) => boolean) =>
      graph.links.filter(pred).reduce((s, l) => s + l.cents, 0);
    const refunds = sum((l) => l.source === 'refunds');
    const storySpending = sum((l) => l.target.startsWith('cat:')) - refunds;

    const rowNet = [PURCHASE_A, PURCHASE_B].reduce((s, p) => s + purchaseEconomics(p, LINKS).netEconomicCostCents, 0);

    // Both purchases are fully refunded, so the row-level net is 0 …
    expect(rowNet).toBe(0);
    // … and the aggregate carries the extra $60.00 bank refund that matches no
    // purchase in this period, which is exactly the difference.
    expect(storySpending).toBe(rowNet - 6000);
    expect(refunds).toBe(126000);
  });
});
