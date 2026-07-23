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

export function matchTransfers(
  transactions: Transaction[],
  accounts: PaymentAccount[],
  windowDays = 4
): TransferMatch {
  const legs = transactions.filter(t => classifyTransaction(t, accounts) === 'transfer');
  const outs = legs
    .filter(t => legDirection(t, accounts) === 'out')
    .sort((a, b) => a.date.localeCompare(b.date));
  const ins = legs.filter(t => legDirection(t, accounts) === 'in');

  const usedIn = new Set<number>();
  const pairs: TransferPair[] = [];

  for (const out of outs) {
    let match = -1;
    for (let j = 0; j < ins.length; j++) {
      if (usedIn.has(j)) continue;
      const inbound = ins[j];
      if (
        Math.abs(out.amount - inbound.amount) < 0.01 &&
        Math.abs(differenceInDays(parseISO(out.date), parseISO(inbound.date))) <= windowDays &&
        out.accountId !== inbound.accountId // never pair a leg with itself / same account
      ) {
        match = j;
        break;
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
