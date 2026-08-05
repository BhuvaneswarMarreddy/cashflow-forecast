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
