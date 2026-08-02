'use client';

import React, { useMemo } from 'react';
import Sheet from '@/components/Sheet';
import CardCreditCard from '@/components/CardCreditCard';
import DuplicateCandidateCard from '@/components/DuplicateCandidateCard';
import RefundCandidateCard from '@/components/RefundCandidateCard';
import { ReviewCandidate } from '@/lib/candidates';
import { DuplicateCostEstimate } from '@/lib/duplicates';
import { formatMoneyCents } from '@/lib/money';
import {
  ACTION_BTN,
  QueueContext,
  RecoveryDecision,
  REVIEW_SECTIONS,
  ReviewQueueItem,
  SectionId,
  recoveryTotals,
} from '@/lib/review-queue';

const money = formatMoneyCents;

export interface RecoveryReviewPanelProps {
  items: readonly ReviewQueueItem[];
  ctx: QueueContext;
  estimates: readonly DuplicateCostEstimate[];
  selectedKey: string | null;
  sectionFilter: SectionId | null;
  announcement: string;
  /** Set while an undo is still safe — i.e. while the panel is open on that item. */
  undoLabel: string | null;
  onSelect: (key: string | null) => void;
  onSectionFilter: (section: SectionId | null) => void;
  onDecide: (item: ReviewQueueItem, decision: RecoveryDecision, candidate?: ReviewCandidate) => void;
  onUndo: () => void;
  onAllocationEdited?: (info: { allocationCount: number; validationRejected: boolean }) => void;
  onClose: () => void;
  /** `sheet` on mobile (the existing native `<dialog>`), `panel` on desktop. */
  variant: 'panel' | 'sheet';
}

/**
 * ONE review queue — the shell FIN-REVIEW-002 plugs its unknown-inflow source into.
 *
 * Desktop: a landmark `<section>` beside the Flow visualization, which STAYS OPEN while
 * the owner moves through items, so the Sankey never disappears mid-decision.
 * Mobile: the existing `Sheet` — native `<dialog>` + `showModal()`, focus trap, Escape via
 * `onCancel`, backdrop click, and the iOS body-scroll lock that is the load-bearing part.
 * The desktop sidebar is NOT ported to mobile.
 */
export default function RecoveryReviewPanel(props: RecoveryReviewPanelProps) {
  if (props.variant === 'sheet') {
    return (
      <Sheet open onClose={props.onClose} ariaLabel="Money review" maxWidth="30rem" className="p-4">
        <PanelBody {...props} />
      </Sheet>
    );
  }
  return (
    <section aria-labelledby="money-review-heading" className="rounded-xl border border-[var(--border-color)] bg-[var(--background-secondary)] p-4 lg:w-[400px] lg:shrink-0">
      <PanelBody {...props} />
    </section>
  );
}

function PanelBody({
  items,
  ctx,
  estimates,
  selectedKey,
  sectionFilter,
  announcement,
  undoLabel,
  onSelect,
  onSectionFilter,
  onDecide,
  onUndo,
  onAllocationEdited,
  onClose,
}: RecoveryReviewPanelProps) {
  const visible = useMemo(
    () => (sectionFilter ? items.filter((i) => i.sectionId === sectionFilter) : items),
    [items, sectionFilter]
  );
  const selected = visible.find((i) => i.key === selectedKey) ?? null;
  const position = selected ? visible.findIndex((i) => i.key === selected.key) : -1;
  const totals = useMemo(() => recoveryTotals({ ...ctx, estimates }), [ctx, estimates]);

  const byId = useMemo(() => new Map(ctx.transactions.map((t) => [t.id, t])), [ctx.transactions]);
  const estimateOf = (key: string) => estimates.find((e) => e.identityKey === key);

  /**
   * §4.4 — two candidates within the ambiguity band are ALTERNATIVES for the same credit.
   * The card shows them as a labelled choice with no pre-selection; here we just find them.
   */
  const alternativesFor = (item: ReviewQueueItem): ReviewCandidate[] => {
    const candidate = item.candidate;
    if (!candidate || !(candidate.evidence.reasonCodes ?? []).includes('ambiguous_match')) return [];
    const creditId = candidate.proposedLinks[0]?.sourceTransactionId;
    if (!creditId) return [];
    return items
      .filter(
        (i) =>
          i.key !== item.key &&
          i.candidate &&
          i.candidate.proposedLinks[0]?.sourceTransactionId === creditId
      )
      .map((i) => i.candidate!) as ReviewCandidate[];
  };

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-2">
        <div>
          <h2 id="money-review-heading" className="text-lg font-semibold text-[var(--foreground)]">
            Money review
          </h2>
          <p className="text-sm text-[var(--foreground-secondary)]">
            {totals.matchedCount} refund{totals.matchedCount === 1 ? '' : 's'} matched · {money(totals.returnedCents)} returned
          </p>
          {/* Reported separately and NEVER added to the figure above. */}
          {totals.potentialAnnualDuplicateCostCents > 0 && (
            <p className="text-sm text-[var(--foreground-muted)]">
              {money(totals.potentialAnnualDuplicateCostCents)} potential annual duplicate cost
            </p>
          )}
        </div>
        <button onClick={onClose} className={ACTION_BTN} aria-label="Close money review">
          Close
        </button>
      </div>

      {/* One live region for the whole surface: confirmation results and count changes,
          announced once per action, never per keystroke. */}
      <p aria-live="polite" className="text-sm text-[var(--accent-success)] min-h-[1.25rem]">
        {announcement}
      </p>
      {undoLabel && (
        <button className={ACTION_BTN} onClick={onUndo}>
          {undoLabel}
        </button>
      )}

      {items.length === 0 ? (
        <p className="text-[var(--foreground-muted)]">Nothing to review.</p>
      ) : (
        <>
          <div role="group" aria-label="Filter review by kind" className="flex flex-wrap gap-1">
            <button
              className={`${ACTION_BTN} ${sectionFilter === null ? 'bg-[var(--background-tertiary)]' : ''}`}
              aria-pressed={sectionFilter === null}
              onClick={() => onSectionFilter(null)}
            >
              All · {items.length}
            </button>
            {REVIEW_SECTIONS.map((section) => {
              const count = items.filter((i) => i.sectionId === section.id).length;
              if (!count) return null;
              return (
                <button
                  key={section.id}
                  className={`${ACTION_BTN} ${sectionFilter === section.id ? 'bg-[var(--background-tertiary)]' : ''}`}
                  aria-pressed={sectionFilter === section.id}
                  onClick={() => onSectionFilter(section.id)}
                >
                  {section.label} · {count}
                </button>
              );
            })}
          </div>

          <ul className="space-y-1 max-h-72 overflow-y-auto">
            {visible.map((item) => (
              <li key={item.key}>
                <button
                  className={`${ACTION_BTN} w-full text-left ${item.key === selectedKey ? 'bg-[var(--background-tertiary)]' : ''}`}
                  aria-pressed={item.key === selectedKey}
                  onClick={() => onSelect(item.key)}
                >
                  {item.headline}
                </button>
              </li>
            ))}
          </ul>

          {selected && (
            <>
              <div className="flex items-center gap-2">
                <button
                  className={ACTION_BTN}
                  aria-label="Previous item"
                  disabled={position <= 0}
                  onClick={() => onSelect(visible[position - 1].key)}
                >
                  Previous
                </button>
                <span className="text-sm text-[var(--foreground-muted)]">
                  {position + 1} of {visible.length}
                </span>
                <button
                  className={ACTION_BTN}
                  aria-label="Next item"
                  disabled={position < 0 || position >= visible.length - 1}
                  onClick={() => onSelect(visible[position + 1].key)}
                >
                  Next
                </button>
              </div>

              {renderCard()}
            </>
          )}
        </>
      )}
    </div>
  );

  function renderCard() {
    if (!selected) return null;
    const decide = (decision: RecoveryDecision, candidate?: ReviewCandidate) => onDecide(selected!, decision, candidate);

    if (selected.source === 'transaction' || selected.candidate?.candidateType === 'unknown_card_credit') {
      const creditId =
        selected.source === 'transaction'
          ? selected.transactionIds[0]
          : selected.candidate!.transactionIds.find((id) => {
              const t = byId.get(id);
              return t && t.type === 'income';
            }) ?? selected.transactionIds[0];
      const transaction = byId.get(creditId);
      if (!transaction) return null;
      return <CardCreditCard candidate={selected.candidate} transaction={transaction} ctx={ctx} onDecide={decide} />;
    }

    const candidate = selected.candidate!;
    if (
      candidate.candidateType === 'immediate_duplicate_charge' ||
      candidate.candidateType === 'duplicate_subscription' ||
      candidate.candidateType === 'subscription_overlap' ||
      candidate.candidateType === 'continued_charge_after_cancellation'
    ) {
      return (
        <DuplicateCandidateCard candidate={candidate} estimate={estimateOf(candidate.id)} ctx={ctx} onDecide={decide} />
      );
    }
    return (
      <RefundCandidateCard
        candidate={candidate}
        alternatives={alternativesFor(selected)}
        ctx={ctx}
        onDecide={decide}
        onAllocationEdited={onAllocationEdited}
      />
    );
  }
}
