'use client';

/**
 * FIN-FLOW-003 — the SPENDING TREE: top-to-bottom, category → merchant → receipt.
 *
 * The owner's ask, verbatim: "not this Sankey — some tree structure, top down,
 * so eventually the user can see how much he's spending". Every figure here is
 * read off the SAME graph the Sankey draws — the category totals are the sums of
 * the links into each `cat:` node and the rows are that node's own transaction
 * ids — so this view can never disagree with the tiles or the chart by a cent.
 *
 * Native <details>/<summary> does the expanding: no state, keyboard-accessible,
 * and closed branches cost nothing to render.
 */
import React from 'react';
import { FlowGraph, day, normalizeMerchant, toCents } from '@/lib/flows';
import { askAbout, askAboutTransaction } from '@/lib/ask';
import { formatMoneyCents } from '@/lib/money';
import { classifyTransaction } from '@/lib/classify';
import { displayPerson, personFrom } from '@/lib/counterparty';
import { PaymentAccount, Transaction } from '@/types';
import { Sparkles } from 'lucide-react';

const money = (cents: number) => formatMoneyCents(cents);

interface Branch {
  label: string;
  cents: number;
  txns: Transaction[];
}

/** Group a branch's rows by merchant, biggest first; label = the raw text of its first row. */
function merchantGroups(txns: Transaction[]): Branch[] {
  const by = new Map<string, Branch>();
  for (const t of txns) {
    const key = normalizeMerchant(t.merchant || t.title) || '(no merchant)';
    const b = by.get(key) ?? { label: (t.merchant || t.title).trim() || '(no merchant)', cents: 0, txns: [] };
    b.cents += toCents(t.amount);
    b.txns.push(t);
    by.set(key, b);
  }
  return [...by.values()].sort((a, b) => b.cents - a.cents)
    .map((b) => ({ ...b, txns: [...b.txns].sort((x, y) => day(y.date).localeCompare(day(x.date))) }));
}

export default function SpendingTree(props: {
  graph: FlowGraph; // the DETAILED graph: the tree wants every category, never the folded view
  transactions: Transaction[];
  accounts: PaymentAccount[];
}) {
  const { graph, transactions, accounts } = props;
  const txnById = new Map(transactions.map((t) => [t.id, t]));
  const rowsOf = (nodeId: string) =>
    (graph.nodeTxnIds[nodeId] ?? []).map((id) => txnById.get(id)).filter((t): t is Transaction => !!t);

  // Categories: total = the links into the node (already netted), rows = the node's own ids.
  const catTotal = new Map<string, number>();
  for (const l of graph.links) {
    if (l.target.startsWith('cat:')) catTotal.set(l.target, (catTotal.get(l.target) ?? 0) + l.cents);
  }
  const branches: Branch[] = graph.nodes
    .filter((n) => n.id.startsWith('cat:'))
    .map((n) => ({ label: n.label, cents: catTotal.get(n.id) ?? 0, txns: rowsOf(n.id) }))
    .filter((b) => b.cents > 0);

  // Money paid to named people that the classifier calls a COST — the same rows
  // personExpenseCents counts, shown under the person's name.
  const personRows = graph.nodes
    .filter((n) => n.id.startsWith('person-out:'))
    .flatMap((n) => rowsOf(n.id))
    .filter((t) => classifyTransaction(t, accounts) === 'expense');
  if (personRows.length) {
    const seen = new Set<string>();
    const unique = personRows.filter((t) => (seen.has(t.id) ? false : (seen.add(t.id), true)));
    for (const t of unique) {
      const who = personFrom(t.description ?? t.title);
      branches.push({
        label: `Paid to ${who ? displayPerson(who) : 'a person'}`,
        cents: toCents(t.amount),
        txns: [t],
      });
    }
  }
  branches.sort((a, b) => b.cents - a.cents);

  const total = branches.reduce((s, b) => s + b.cents, 0);
  const max = branches[0]?.cents ?? 1;

  const txnRow = (t: Transaction) => (
    <div key={t.id} className="flex items-baseline gap-3 py-1.5 pl-2 border-b border-[var(--border-color)]/50 last:border-0">
      <span className="text-xs text-[var(--foreground-muted)] tabular-nums shrink-0">{day(t.date)}</span>
      <span className="text-sm text-[var(--foreground-secondary)] truncate flex-1 min-w-0">{(t.merchant || t.title).trim()}</span>
      <span className="text-sm font-medium tabular-nums">{money(toCents(t.amount))}</span>
      <button
        onClick={() => askAbout(askAboutTransaction(t, accounts, transactions))}
        aria-label={`Ask about ${(t.merchant || t.title).trim()} on ${day(t.date)}`}
        className="w-8 h-8 flex items-center justify-center rounded-lg text-[var(--accent-primary)] hover:bg-[var(--background-tertiary)] shrink-0"
      >
        <Sparkles className="w-4 h-4" aria-hidden="true" />
      </button>
    </div>
  );

  return (
    <div className="space-y-1">
      <p className="text-sm text-[var(--foreground-secondary)] pb-2">
        Spent <span className="font-semibold text-[var(--foreground)] tabular-nums">{money(total)}</span> in
        this period, top to bottom. Open a category, then a merchant, down to the receipt — the ✨ asks
        about that exact transaction.
      </p>
      {branches.map((b) => (
        <details key={b.label} className="rounded-xl border border-[var(--border-color)] bg-[var(--background-secondary)] open:bg-[var(--background-tertiary)]/40">
          <summary className="flex items-center gap-3 px-3 py-2.5 cursor-pointer list-none [&::-webkit-details-marker]:hidden rounded-xl hover:bg-[var(--background-tertiary)]">
            <span className="text-[var(--foreground-muted)] text-xs select-none">▸</span>
            <span className="flex-1 min-w-0">
              <span className="flex items-baseline justify-between gap-3">
                <span className="text-sm font-medium truncate">{b.label}</span>
                <span className="text-sm font-semibold tabular-nums shrink-0">{money(b.cents)}</span>
              </span>
              <span className="block mt-1 h-1 rounded-full bg-[var(--background-tertiary)] overflow-hidden">
                <span
                  className="block h-full rounded-full bg-[var(--accent-primary)]"
                  style={{ width: `${Math.max(1.5, (100 * b.cents) / max)}%` }}
                />
              </span>
              <span className="text-xs text-[var(--foreground-muted)]">
                {b.txns.length} transaction{b.txns.length === 1 ? '' : 's'}
                {total > 0 ? ` · ${Math.round((1000 * b.cents) / total) / 10}% of spending` : ''}
              </span>
            </span>
          </summary>
          <div className="px-3 pb-2">
            {merchantGroups(b.txns).map((m) =>
              m.txns.length === 1 ? (
                txnRow(m.txns[0])
              ) : (
                <details key={m.label} className="ml-1">
                  <summary className="flex items-baseline gap-3 py-1.5 cursor-pointer list-none [&::-webkit-details-marker]:hidden hover:bg-[var(--background-tertiary)] rounded-lg px-2">
                    <span className="text-[var(--foreground-muted)] text-xs select-none">▸</span>
                    <span className="text-sm truncate flex-1 min-w-0">{m.label}</span>
                    <span className="text-xs text-[var(--foreground-muted)]">{m.txns.length}×</span>
                    <span className="text-sm font-medium tabular-nums">{money(m.cents)}</span>
                  </summary>
                  <div className="ml-5">{m.txns.map(txnRow)}</div>
                </details>
              )
            )}
          </div>
        </details>
      ))}
    </div>
  );
}
