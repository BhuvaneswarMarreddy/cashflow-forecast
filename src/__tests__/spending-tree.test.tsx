import React from 'react';
import { render, screen } from '@testing-library/react';
import SpendingTree from '@/components/SpendingTree';
import { FlowGraph } from '@/lib/flows';
import { PaymentAccount, Transaction } from '@/types';

const txn = (o: Partial<Transaction> & { id: string }): Transaction => ({
  title: o.id, amount: 1, date: '2026-07-01', type: 'expense', category: 'other',
  accountId: 'a1', ...o,
} as Transaction);

const account = { id: 'a1', name: 'Bank', type: 'bank_account' } as PaymentAccount;

const graph = (links: FlowGraph['links'], nodeTxnIds: Record<string, string[]>): FlowGraph => ({
  nodes: [
    { id: 'acct:a1', label: 'Bank', kind: 'bank' },
    { id: 'cat:Food', label: 'Food', kind: 'category' },
    { id: 'person-out:JOHN A', label: 'John A', kind: 'person' },
  ],
  links, reconciliation: [], between: [], nodeTxnIds, nettedRefundCents: 0, personExpenseCents: 500,
});

describe('SpendingTree', () => {
  it('total = category links + person expense rows, tied to the graph', () => {
    const t1 = txn({ id: 't1', amount: 1, merchant: 'Cafe' });
    const t2 = txn({ id: 't2', amount: 2, merchant: 'Cafe' });
    const t3 = txn({ id: 't3', amount: 5, description: 'Zelle payment to John A' });
    render(
      <SpendingTree
        graph={graph(
          [{ source: 'acct:a1', target: 'cat:Food', cents: 300 }],
          { 'cat:Food': ['t1', 't2'], 'person-out:JOHN A': ['t3'] }
        )}
        transactions={[t1, t2, t3]}
        accounts={[account]}
      />
    );
    // $3.00 of category links + the $5.00 person expense = $8.00, never a cent apart
    expect(screen.getByText('$8.00')).toBeInTheDocument();
    expect(screen.getByText('Food')).toBeInTheDocument();
    // the two Cafe rows fold into one merchant group with a count
    expect(screen.getByText('2×')).toBeInTheDocument();
  });
});

/**
 * Reported from the live app: three Remitly rows rendered as three separate
 * branches, each reading "Paid to Sent to India (Remitly) · 1 transaction".
 *
 * Two defects in one loop. Category branches are grouped by node and summed;
 * the person branches pushed ONE BRANCH PER ROW, so a recurring counterparty
 * fragmented into a list of ones instead of totalling. And the label prefixes
 * "Paid to" onto displayPerson(), which for REMITLY already returns the whole
 * phrase "Sent to India (Remitly)".
 */
describe('SpendingTree — money paid to the same person groups', () => {
  const remitly = (id: string, amount: number) =>
    txn({ id, amount, description: 'RMTLY* US1234 REMITLY' });

  const remitlyGraph = (ids: string[]): FlowGraph => ({
    nodes: [
      { id: 'acct:a1', label: 'Bank', kind: 'bank' },
      { id: 'person-out:REMITLY', label: 'Sent to India (Remitly)', kind: 'person' },
    ],
    links: [], reconciliation: [], between: [],
    nodeTxnIds: { 'person-out:REMITLY': ids },
    nettedRefundCents: 0, personExpenseCents: 0,
  });

  it('sums repeat payments into ONE branch, not one per transaction', () => {
    const rows = [remitly('r1', 5880), remitly('r2', 3000), remitly('r3', 3000)];
    render(
      <SpendingTree graph={remitlyGraph(['r1', 'r2', 'r3'])} transactions={rows} accounts={[account]} />
    );
    // Twice on purpose: the period total, and the single grouped branch — which
    // is itself the proof that three rows collapsed into one branch.
    expect(screen.getAllByText('$11,880.00')).toHaveLength(2);
    expect(screen.getByText(/3 transactions/)).toBeInTheDocument();
    expect(screen.queryByText(/\b1 transaction\b/)).not.toBeInTheDocument();
  });

  it('does not say "Paid to Sent to India (Remitly)"', () => {
    render(
      <SpendingTree graph={remitlyGraph(['r1'])} transactions={[remitly('r1', 100)]} accounts={[account]} />
    );
    expect(screen.queryByText(/Paid to Sent to/)).not.toBeInTheDocument();
    expect(screen.getByText('Sent to India (Remitly)')).toBeInTheDocument();
  });

  it('still says "Paid to" for an actual person', () => {
    const t = txn({ id: 'p1', amount: 40, description: 'Zelle payment to John A' });
    render(
      <SpendingTree
        graph={graph([], { 'person-out:JOHN A': ['p1'] })}
        transactions={[t]}
        accounts={[account]}
      />
    );
    expect(screen.getByText('Paid to John A')).toBeInTheDocument();
  });
});
