'use client';

import React, { useMemo, useState } from 'react';
import { Transaction } from '@/types';
import { ReviewCandidate } from '@/lib/candidates';
import { toCents } from '@/lib/flows';
import { formatMoneyCents } from '@/lib/money';
import { purchaseEconomics, refundConfidence, refundEconomics } from '@/lib/refunds';
import { LinkDraft, TxRef, toTxRef, validateLink } from '@/lib/relations';
import {
  ACTION_BTN,
  ConfirmationPreview,
  QueueAllocation,
  QueueContext,
  RecoveryDecision,
  confirmationPreview,
  creditLine,
  netCostSentence,
  reasonSentence,
  remainderSentence,
  rowLabel,
  unrefundedSentence,
} from '@/lib/review-queue';

const money = formatMoneyCents;

/**
 * "Did that $1,100.00 purchase come back?" — one card, everything text and numbers.
 *
 * Two rules the whole card exists to keep:
 *  1. NOTHING APPLIES BEFORE CONFIRMATION. `onDecide` fires from a button press and from
 *     nowhere else; a high score preselects an allocation but never applies one.
 *  2. NOTHING IS SILENTLY CLAMPED. An over-allocation disables Confirm with a sentence
 *     that states the overage. A number quietly corrected behind the owner's back is a lie.
 */
export default function RefundCandidateCard({
  candidate,
  alternatives,
  ctx,
  onDecide,
  onAllocationEdited,
}: {
  candidate: ReviewCandidate;
  /** Other candidates for the SAME credit, when §4.4 flagged the match ambiguous. */
  alternatives?: readonly ReviewCandidate[];
  ctx: QueueContext;
  onDecide: (decision: RecoveryDecision, candidate: ReviewCandidate) => void;
  onAllocationEdited?: (info: { allocationCount: number; validationRejected: boolean }) => void;
}) {
  const ambiguous = (alternatives?.length ?? 0) > 0;
  // No pre-selection when the evidence is ambiguous (§4.4 / test C4). When it is not,
  // the single candidate IS the selection — that is preselection, not auto-application.
  const [chosenId, setChosenId] = useState<string | null>(ambiguous ? null : candidate.id);
  const [editing, setEditing] = useState(false);
  const [draftDollars, setDraftDollars] = useState<Record<string, string>>({});

  const chosen = useMemo(() => {
    if (!chosenId) return null;
    return [candidate, ...(alternatives ?? [])].find((c) => c.id === chosenId) ?? null;
  }, [chosenId, candidate, alternatives]);

  const index = useMemo(() => new Map(ctx.transactions.map((t) => [t.id, t])), [ctx.transactions]);
  const credit = index.get(candidate.proposedLinks[0]?.sourceTransactionId ?? candidate.transactionIds[0]);

  const allocations: QueueAllocation[] = useMemo(() => {
    if (!chosen) return [];
    return chosen.proposedLinks.map((l) => {
      const typed = draftDollars[l.targetTransactionId];
      return {
        targetTransactionId: l.targetTransactionId,
        allocatedAmountCents: typed === undefined ? l.allocatedAmountCents : toCents(Number(typed)),
      };
    });
  }, [chosen, draftDollars]);

  // §7.2 — validated live through the ONE validator the store and the parser use, so
  // "integer cents, Σ ≤ the credit, each ≤ its purchase" has a single definition.
  const rejection = useMemo(() => {
    if (!credit || !chosen) return null;
    const refs: TxRef[] = ctx.transactions.map(toTxRef);
    const accumulated = [...ctx.links];
    for (const a of allocations) {
      if (!Number.isInteger(a.allocatedAmountCents) || a.allocatedAmountCents <= 0) {
        return 'Enter a dollar amount greater than zero.';
      }
      const draft: LinkDraft = {
        linkType: 'refund_of',
        sourceTransactionId: credit.id,
        targetTransactionId: a.targetTransactionId,
        allocatedAmountCents: a.allocatedAmountCents,
        status: 'confirmed',
        confirmedAt: new Date().toISOString(),
        confirmedBy: 'user',
        algorithmVersion: chosen.algorithmVersion,
      };
      const result = validateLink(draft, { transactions: refs, links: accumulated });
      if (!result.ok) {
        const purchase = index.get(a.targetTransactionId);
        if (result.ruleId === 'V4') {
          const over = allocations.reduce((s, x) => s + x.allocatedAmountCents, 0) - toCents(credit.amount);
          return `That is ${money(over)} more than the credit.`;
        }
        if (result.ruleId === 'V5' && purchase) {
          return `That is ${money(a.allocatedAmountCents - toCents(purchase.amount))} more than that purchase.`;
        }
        return `That allocation was refused (rule ${result.ruleId}).`;
      }
      accumulated.push({
        ...draft,
        id: `draft~${a.targetTransactionId}`,
        createdAt: draft.confirmedAt!,
        updatedAt: draft.confirmedAt!,
      });
    }
    return null;
  }, [credit, chosen, allocations, ctx.transactions, ctx.links, index]);

  const preview: ConfirmationPreview | null = useMemo(
    () => (chosen ? confirmationPreview(chosen, allocations, ctx) : null),
    [chosen, allocations, ctx]
  );

  if (!credit) return null;

  const creditEconomics = refundEconomics(
    credit,
    allocations.map((a) => ({
      id: `pending~${a.targetTransactionId}`,
      linkType: 'refund_of' as const,
      sourceTransactionId: credit.id,
      targetTransactionId: a.targetTransactionId,
      allocatedAmountCents: a.allocatedAmountCents,
      status: 'confirmed' as const,
      algorithmVersion: candidate.algorithmVersion,
      confirmedAt: candidate.generatedAt,
      createdAt: candidate.generatedAt,
      updatedAt: candidate.generatedAt,
    }))
  );

  const setDollars = (id: string, value: string) => {
    setDraftDollars((prev) => ({ ...prev, [id]: value }));
    onAllocationEdited?.({ allocationCount: allocations.length, validationRejected: Boolean(rejection) });
  };

  const decide = (decision: RecoveryDecision) => onDecide(decision, chosen ?? candidate);

  return (
    <article className="rounded-xl border border-[var(--border-color)] bg-[var(--background-secondary)] p-4 space-y-3">
      <header>
        <p className="font-medium text-[var(--foreground)]">{creditLine(credit, ctx.accounts)}</p>
        <p className="text-sm text-[var(--foreground-secondary)]">
          {credit.merchant || credit.title} · confidence {refundConfidence(candidate.score)}
        </p>
      </header>

      {ambiguous && (
        <fieldset className="rounded-lg border border-[var(--border-color)] p-3">
          <legend className="px-1 text-sm font-medium">
            {(alternatives?.length ?? 0) + 1} purchases could match this credit
          </legend>
          <p className="text-xs text-[var(--foreground-muted)] mb-2">
            Pick the one you meant. We have not chosen for you.
          </p>
          {[candidate, ...(alternatives ?? [])].map((c) => (
            <label key={c.id} className="flex items-center gap-2 min-h-[44px] cursor-pointer text-sm">
              <input
                type="radio"
                name={`alt-${candidate.id}`}
                value={c.id}
                checked={chosenId === c.id}
                onChange={() => setChosenId(c.id)}
              />
              {c.proposedLinks
                .map((l) => `${rowLabel(index.get(l.targetTransactionId))} ${money(l.allocatedAmountCents)}`)
                .join(' + ')}
            </label>
          ))}
        </fieldset>
      )}

      {/* Every proposed purchase, with ITS amount and the amount allocated to it —
          both, always, because "allocated $100.00 of $100.00" is the thing being confirmed. */}
      <ul className="space-y-1 text-sm">
        {allocations.map((a) => {
          const purchase = index.get(a.targetTransactionId) as Transaction | undefined;
          const gross = purchase ? toCents(purchase.amount) : 0;
          return (
            <li key={a.targetTransactionId} className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <span className="text-[var(--foreground)]">{rowLabel(purchase)}</span>
              <span className="text-[var(--foreground-muted)]">{purchase ? purchase.date.slice(0, 10) : ''}</span>
              <span className="tabular-nums">{money(gross)}</span>
              {editing ? (
                <span className="inline-flex items-center gap-2">
                  <label htmlFor={`alloc-${a.targetTransactionId}`} className="text-xs text-[var(--foreground-secondary)]">
                    Amount allocated to {rowLabel(purchase)}
                  </label>
                  <input
                    id={`alloc-${a.targetTransactionId}`}
                    type="number"
                    inputMode="decimal"
                    step="0.01"
                    min="0"
                    className="min-h-[44px] w-28 rounded-lg border border-[var(--border-color)] bg-[var(--background)] px-2"
                    value={draftDollars[a.targetTransactionId] ?? (a.allocatedAmountCents / 100).toFixed(2)}
                    onChange={(e) => setDollars(a.targetTransactionId, e.target.value)}
                  />
                </span>
              ) : (
                <span className="tabular-nums text-[var(--accent-success)]">
                  allocated {money(a.allocatedAmountCents)} of {money(gross)}
                </span>
              )}
              {purchase && a.allocatedAmountCents < gross && (
                <span className="text-xs text-[var(--foreground-muted)]">
                  {netCostSentence(gross, a.allocatedAmountCents)}
                </span>
              )}
            </li>
          );
        })}
      </ul>

      <p className="text-sm text-[var(--foreground-secondary)]">
        Allocated {money(creditEconomics.allocatedRefundCents)} of {money(creditEconomics.refundAmountCents)} ·{' '}
        {remainderSentence(creditEconomics)}
      </p>
      {allocations.length === 1 && (() => {
        const purchase = index.get(allocations[0].targetTransactionId);
        if (!purchase) return null;
        const economics = purchaseEconomics(purchase, ctx.links);
        return economics.netEconomicCostCents > 0 ? (
          <p className="text-sm text-[var(--foreground-muted)]">{unrefundedSentence(economics)}</p>
        ) : null;
      })()}

      <details className="text-sm">
        <summary className="min-h-[44px] flex items-center cursor-pointer text-[var(--foreground-secondary)]">Why?</summary>
        <p className="text-[var(--foreground-muted)]">{reasonSentence(candidate.evidence.reasonCodes ?? [])}</p>
        <p className="text-xs text-[var(--foreground-muted)] mt-1">
          Evidence: {(candidate.evidence.reasonCodes ?? []).join(', ') || 'none recorded'} ·{' '}
          {candidate.algorithmVersion}
        </p>
      </details>

      {/* The gate. Everything below is what the owner is agreeing to, shown BEFORE the
          Confirm button is reachable — not after it, and not in a tooltip. */}
      {preview && (
        <section aria-label="What confirming will do" className="rounded-lg bg-[var(--background-tertiary)] p-3 text-sm space-y-1">
          <p className="font-medium">If you confirm:</p>
          <ul className="list-disc pl-5">
            {preview.whatChanges.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
          <p>{preview.affectedCount} transactions affected · {preview.dateRange}</p>
          <p>{preview.moneyEffect}</p>
          <p>{preview.budgetEffect}</p>
          <p>{preview.forecastEffect}</p>
          <p>{preview.flowEffect}</p>
          <p className="text-[var(--foreground-muted)]">{preview.whatDoesNotChange}</p>
          <p className="text-[var(--foreground-muted)]">{preview.scope}</p>
        </section>
      )}

      {rejection && (
        <p role="alert" className="text-sm text-[var(--accent-danger)]">
          {rejection}
        </p>
      )}

      <div className="flex flex-wrap gap-2">
        <button
          className={ACTION_BTN}
          disabled={!chosen || Boolean(rejection)}
          onClick={() => decide({ status: 'confirmed', allocations })}
        >
          Confirm links
        </button>
        <button className={ACTION_BTN} onClick={() => setEditing((e) => !e)}>
          {editing ? 'Done adjusting' : 'Adjust allocation'}
        </button>
        {ambiguous && (
          <button className={ACTION_BTN} onClick={() => setChosenId(null)}>
            Choose different purchase
          </button>
        )}
        <button className={ACTION_BTN} onClick={() => decide({ status: 'dismissed', cardCreditKind: 'cashback_reward', reasonCode: 'reward' })}>
          Mark as reward
        </button>
        <button className={ACTION_BTN} onClick={() => decide({ status: 'dismissed', cardCreditKind: 'card_payment', reasonCode: 'card_payment' })}>
          Mark as card payment
        </button>
        <button
          className={ACTION_BTN}
          disabled={!allocations.length}
          onClick={() =>
            decide({
              status: 'dismissed',
              cardCreditKind: 'chargeback_credit',
              reasonCode: 'chargeback',
              chargebackTargetId: allocations[0]?.targetTransactionId,
            })
          }
        >
          Mark as chargeback
        </button>
        <button className={ACTION_BTN} onClick={() => decide({ status: 'needs_more_information', reasonCode: 'keep_unclassified' })}>
          Keep unclassified
        </button>
      </div>
    </article>
  );
}
