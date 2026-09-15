/**
 * Transfer pairing — the feature Monarch doesn't have.
 *
 * Each internal move is two legs: money leaving one account and arriving in another.
 * classifyTransaction already tags both as 'transfer' (out of income/expense), but this
 * MATCHES the two legs so a move is recognised as ONE net-zero movement between your
 * accounts. Legs that can't be paired are the signal: the other side is in an account
 * you didn't import (external savings, a Zelle to a person, a loan servicer) — i.e. real
 * money leaving/arriving, or a mislabel — so they get surfaced, not hidden.
 *
 * Live match: computed from the current transaction set, so it self-updates on re-import.
 */

import { differenceInDays, parseISO } from 'date-fns';
import { Transaction, PaymentAccount } from '@/types';
import { classifyTransaction, isPositive } from '@/lib/classify';

export interface TransferPair {
  out: Transaction;      // the leg that reduced its account
  inbound: Transaction;  // the leg that increased its account
  amount: number;
  date: string;          // the out leg's date
  fromAccountId?: string;
  toAccountId?: string;
}

export interface TransferMatch {
  pairs: TransferPair[];
  unmatchedOut: Transaction[]; // left a tracked account; counterpart not imported
  unmatchedIn: Transaction[];  // arrived in a tracked account; counterpart not imported
  matchedTotal: number;        // sum of paired amounts (nets to zero across accounts)
}

// Direction of a transfer leg for its own account: the stored transferDirection when
// present (authoritative), else inferred from isPositive (title/deposit/card-payment).
function legDirection(t: Transaction, accounts: PaymentAccount[]): 'in' | 'out' {
  if (t.transferDirection) return t.transferDirection;
  return isPositive(t, accounts) ? 'in' : 'out';
}

/**
 * If `txId` is one leg of a matched internal transfer, return the other leg's id.
 * Used to warn on deletion: removing only one leg desyncs the two derived balances.
 */
export function pairedLegId(
  txId: string, transactions: Transaction[], accounts: PaymentAccount[]
): string | null {
  const { pairs } = matchTransfers(transactions, accounts);
  for (const p of pairs) {
    if (p.out.id === txId) return p.inbound.id;
    if (p.inbound.id === txId) return p.out.id;
  }
  return null;
}

export function matchTransfers(
  transactions: Transaction[],
  accounts: PaymentAccount[],
  windowDays = 4
): TransferMatch {
  const legs = transactions.filter(t => classifyTransaction(t, accounts) === 'transfer');
  // #168: BOTH lists in a total order (date, then id). The result must never depend on
  // the order Firestore returned rows in: pairedLegId feeds the paired DELETE, so a
  // different pairing offers — and removes — an unrelated transaction.
  const byDateThenId = (a: Transaction, b: Transaction) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id);
  const outs = legs.filter(t => legDirection(t, accounts) === 'out').sort(byDateThenId);
  const ins = legs.filter(t => legDirection(t, accounts) === 'in').sort(byDateThenId);

  const usedIn = new Set<number>();
  const pairs: TransferPair[] = [];

  for (const out of outs) {
    // #168: integer cents, not a float gap — `< 0.01` paired legs a cent apart at $2,000
    // but not at $2,500. And the NEAREST date wins (findTwin's rule), not the first hit:
    // first-fit made one $2,000 ledger match $2,000 or $4,000 depending on array order.
    const outCents = Math.round(out.amount * 100);
    let match = -1;
    let bestDistance = Infinity;
    for (let j = 0; j < ins.length; j++) {
      if (usedIn.has(j)) continue;
      const inbound = ins[j];
      if (Math.round(inbound.amount * 100) !== outCents) continue;
      if (out.accountId === inbound.accountId) continue; // never pair a leg with itself / same account
      const distance = Math.abs(differenceInDays(parseISO(out.date), parseISO(inbound.date)));
      // Strictly nearer only: `ins` is sorted, so a tie keeps the earlier (then lower-id) leg.
      if (distance <= windowDays && distance < bestDistance) {
        match = j;
        bestDistance = distance;
      }
    }
    if (match >= 0) {
      usedIn.add(match);
      pairs.push({
        out,
        inbound: ins[match],
        amount: out.amount,
        date: out.date,
        fromAccountId: out.accountId,
        toAccountId: ins[match].accountId,
      });
    }
  }

  const matchedOut = new Set(pairs.map(p => p.out));
  const matchedIn = new Set(pairs.map(p => p.inbound));
  return {
    pairs,
    unmatchedOut: outs.filter(o => !matchedOut.has(o)),
    unmatchedIn: ins.filter(i => !matchedIn.has(i)),
    matchedTotal: pairs.reduce((s, p) => s + p.amount, 0),
  };
}
