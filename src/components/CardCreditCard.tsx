'use client';

import React, { useMemo, useState } from 'react';
import { Transaction } from '@/types';
import { ReviewCandidate } from '@/lib/candidates';
import { CARD_CREDIT_KINDS, CardCreditKind, classifyCardCredit } from '@/lib/card-credit';
import {
  ACTION_BTN,
  CARD_CREDIT_MEANING,
  QueueContext,
  RecoveryDecision,
  creditLine,
  reasonSentence,
} from '@/lib/review-queue';

/**
 * The smallest card: a credit, its account, and a CLOSED set of choices rendered from
 * FIN-REFUND-001's exported kind list — never a hand-written `<option>` list, so an
 * eleventh kind cannot exist in the UI and be missing from the taxonomy.
 *
 * The line above the choices is the product rule made visible.
 */
export default function CardCreditCard({
  candidate,
  transaction,
  ctx,
  onDecide,
}: {
  /** Absent for a FIN-REVIEW-002 unknown-inflow item, which has no candidate. */
  candidate?: ReviewCandidate;
  transaction: Transaction;
  ctx: QueueContext;
  onDecide: (decision: RecoveryDecision, candidate?: ReviewCandidate) => void;
}) {
  const [kind, setKind] = useState<CardCreditKind | ''>('');
  const classification = useMemo(
    () => classifyCardCredit(transaction, { accounts: ctx.accounts as never, links: ctx.links }),
    [transaction, ctx.accounts, ctx.links]
  );

  return (
    <article className="rounded-xl border border-[var(--border-color)] bg-[var(--background-secondary)] p-4 space-y-3">
      <header>
        <p className="font-medium text-[var(--foreground)]">{creditLine(transaction, ctx.accounts)}</p>
        <p className="text-sm text-[var(--foreground-secondary)]">{transaction.merchant || transaction.title}</p>
      </header>

      <p className="text-sm font-medium text-[var(--foreground)]">
        This is money that arrived on a credit card. It is not income until you say what it is.
      </p>

      <p className="text-sm text-[var(--foreground-muted)]">
        Right now we read it as: {CARD_CREDIT_MEANING[classification.kind] ?? 'not income'}.
      </p>

      <fieldset className="space-y-1">
        <legend className="text-sm text-[var(--foreground-secondary)]">What is it?</legend>
        {CARD_CREDIT_KINDS.map((k) => (
          <label key={k} className="flex items-center gap-2 min-h-[44px] text-sm cursor-pointer">
            <input type="radio" name={`kind-${transaction.id}`} value={k} checked={kind === k} onChange={() => setKind(k)} />
            {CARD_CREDIT_MEANING[k] ?? k}
          </label>
        ))}
      </fieldset>

      {candidate && (
        <details className="text-sm">
          <summary className="min-h-[44px] flex items-center cursor-pointer text-[var(--foreground-secondary)]">Why?</summary>
          <p className="text-[var(--foreground-muted)]">{reasonSentence(candidate.evidence.reasonCodes ?? [])}</p>
        </details>
      )}

      <section aria-label="What confirming will do" className="rounded-lg bg-[var(--background-tertiary)] p-3 text-sm space-y-1">
        <p className="font-medium">If you confirm:</p>
        <p>1 transaction affected · {transaction.date}</p>
        <p>This records what the credit is. It adds nothing to your income, on any screen.</p>
        <p>The row stays in your history at its full amount.</p>
        <p>This transaction only. No merchant rule is created.</p>
      </section>

      <div className="flex flex-wrap gap-2">
        <button className={ACTION_BTN} disabled={!kind} onClick={() => onDecide({ status: 'confirmed', cardCreditKind: kind || undefined }, candidate)}>
          Confirm
        </button>
        <button className={ACTION_BTN} onClick={() => onDecide({ status: 'needs_more_information', reasonCode: 'keep_unclassified' }, candidate)}>
          Keep unclassified
        </button>
      </div>
    </article>
  );
}
