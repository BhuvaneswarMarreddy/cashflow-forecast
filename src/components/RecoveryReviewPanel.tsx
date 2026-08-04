'use client';

import React, { useMemo, useState } from 'react';
import Sheet from '@/components/Sheet';
import CardCreditCard from '@/components/CardCreditCard';
import DuplicateCandidateCard from '@/components/DuplicateCandidateCard';
import MappingGroupCard from '@/components/MappingGroupCard';
import RefundCandidateCard from '@/components/RefundCandidateCard';
import { ReviewCandidate } from '@/lib/candidates';
import { GroupDecision, decisionsToCover } from '@/lib/mapping-suggestions';
import { DuplicateCostEstimate } from '@/lib/duplicates';
import { formatMoneyCents } from '@/lib/money';
import {
  ACTION_BTN,
  QueueContext,
  RecoveryDecision,
  REVIEW_SECTIONS,
  ReviewQueueItem,
  SectionId,
  askAboutItem,
  recoveryTotals,
} from '@/lib/review-queue';
import { askAbout } from '@/lib/ask';
import { Sparkles } from 'lucide-react';

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
  /** MAP-001 — one answer for a whole pattern. Absent hides the group cards. */
  onGroupDecide?: (item: ReviewQueueItem, decision: GroupDecision) => void;
  /**
   * Batch-confirm for EXACT refund matches — the owner's 118-row pile. Only items whose
   * candidate is a single-purchase exact match and not flagged ambiguous are offered;
   * partial matches and ambiguous credits genuinely need eyes and stay one-at-a-time.
   */
  onBatchConfirm?: (items: ReviewQueueItem[]) => void;
  todayISO?: string;
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
  onGroupDecide,
  onBatchConfirm,
  todayISO,
  onUndo,
  onAllocationEdited,
  onClose,
}: RecoveryReviewPanelProps) {
  // Batch scope: EXACT matches only. An ambiguous credit has alternatives and a partial
  // match changes a purchase's net — both need a person. Unticking excludes an item.
  const exactMatches = useMemo(
    () => items.filter(
      (i) => i.candidate?.candidateType === 'refund_match'
        && !(i.candidate.evidence.reasonCodes ?? []).includes('ambiguous_match')
    ),
    [items]
  );
  const [unticked, setUnticked] = useState<Set<string>>(new Set());
  const batchSelection = exactMatches.filter((i) => !unticked.has(i.key));
  const batchCents = batchSelection.reduce(
    (s, i) => s + (i.candidate?.proposedLinks ?? []).reduce((a, l) => a + l.allocatedAmountCents, 0), 0
  );
  const visible = useMemo(
    () => (sectionFilter ? items.filter((i) => i.sectionId === sectionFilter) : items),
    [items, sectionFilter]
  );
  const selected = visible.find((i) => i.key === selectedKey) ?? null;
  const position = selected ? visible.findIndex((i) => i.key === selected.key) : -1;
  const totals = useMemo(() => recoveryTotals({ ...ctx, estimates }), [ctx, estimates]);
  // The number MAP-001 exists to produce: how little of this the owner actually has to
  // answer. Shown, not buried in a log.
  const groups = ctx.groups ?? [];
  const groupRows = groups.reduce((s, g) => s + g.rowCount, 0);
  const eighty = groups.length ? decisionsToCover(groups, 0.8) : 0;

  const byId = useMemo(() => new Map(ctx.transactions.map((t) => [t.id, t])), [ctx.transactions]);
  const estimateOf = (key: string) => estimates.find((e) => e.identityKey === key);

  /**
   * The section whose explanation is on screen: what the owner has SELECTED, else what
   * they have FILTERED to, else the first section that has anything in it — which, since
   * `REVIEW_SECTIONS` is money-ordered, is also the one they should start with.
   */
  const activeSectionId =
    selected?.sectionId
    ?? sectionFilter
    ?? REVIEW_SECTIONS.find((s) => items.some((i) => i.sectionId === s.id))?.id;
  const activeSection = REVIEW_SECTIONS.find((s) => s.id === activeSectionId);

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
          {groups.length > 0 && (
            <p className="text-sm text-[var(--foreground-secondary)]">
              {groupRows} unmapped {groupRows === 1 ? 'row' : 'rows'} in {groups.length}{' '}
              {groups.length === 1 ? 'pattern' : 'patterns'} · answer {eighty} to clear 80%
            </p>
          )}
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
          {/* The owner opened this panel and could not tell what it wanted from them.
              Three facts fix that: these are questions, they are ordered by what the
              answer is worth, and nothing happens until a button is pressed. */}
          <p className="text-sm text-[var(--foreground-secondary)]">
            These are the questions the app cannot answer on its own. They are ordered by how
            much money the answer is worth, so <strong>start at the top and work down</strong> —
            you do not have to finish. Nothing changes until you press a button, and nothing here
            deletes a transaction.
          </p>

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

          {/* The one-press path out of the refund pile. Every unticked box is an item
              the press will NOT touch; nothing here bypasses the validator. */}
          {onBatchConfirm && exactMatches.length >= 2 && (sectionFilter === null || sectionFilter === 'refund_matches') && (
            <section
              aria-label="Confirm exact refund matches together"
              className="rounded-lg border border-[var(--accent-primary)]/40 bg-[var(--background-tertiary)] p-3 text-sm space-y-2"
            >
              <p className="font-medium text-[var(--foreground)]">
                {exactMatches.length} refunds match a purchase exactly — {money(batchCents)} in one press.
              </p>
              <p className="text-[var(--foreground-secondary)]">
                Confirming folds each refund back into the category it came from, so your spending
                shows what things actually cost. Income does not change. Nothing is deleted.
              </p>
              <details>
                <summary className="cursor-pointer min-h-[44px] flex items-center select-none text-[var(--foreground-secondary)]">
                  Review the list — untick anything you are not sure about
                </summary>
                <ul className="mt-1 space-y-1 max-h-48 overflow-y-auto">
                  {exactMatches.map((i) => (
                    <li key={i.key}>
                      <label className="flex items-start gap-2 min-h-[44px] cursor-pointer text-[var(--foreground-secondary)]">
                        <input
                          type="checkbox"
                          checked={!unticked.has(i.key)}
                          onChange={(e) => setUnticked((prev) => {
                            const next = new Set(prev);
                            if (e.target.checked) next.delete(i.key); else next.add(i.key);
                            return next;
                          })}
                        />
                        <span>{i.headline}</span>
                      </label>
                    </li>
                  ))}
                </ul>
              </details>
              <button
                className={ACTION_BTN}
                disabled={batchSelection.length === 0}
                onClick={() => onBatchConfirm(batchSelection)}
              >
                Confirm {batchSelection.length} refund{batchSelection.length === 1 ? '' : 's'}
              </button>
            </section>
          )}

          {/* What this kind of item IS and what answering it does — both before the
              decision. The owner should never have to click Confirm to find out. */}
          {activeSection && (
            <section
              aria-label={`About ${activeSection.label}`}
              className="rounded-lg bg-[var(--background-tertiary)] p-3 text-sm space-y-1"
            >
              <p className="font-medium text-[var(--foreground)]">{activeSection.label}</p>
              <p className="text-[var(--foreground-secondary)]">{activeSection.what}</p>
              <p className="text-[var(--foreground-muted)]">
                <strong>After you answer:</strong> {activeSection.after}
              </p>
            </section>
          )}

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

              {/* The way out when none of the above helps. One button for all four card
                  types: it carries the rows, the cadence, the app's own evidence, the
                  exact options and what each one does, so the chat can talk the owner
                  through a decision instead of being handed a headline. */}
              <button
                type="button"
                onClick={() => askAbout(askAboutItem(selected, ctx))}
                className={`${ACTION_BTN} flex items-center gap-1.5`}
              >
                <Sparkles className="w-4 h-4" aria-hidden="true" />
                I don&apos;t understand this — explain it
              </button>

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

    if (selected.source === 'group' && selected.group && onGroupDecide) {
      return (
        <MappingGroupCard
          group={selected.group}
          transactions={ctx.transactions}
          accounts={ctx.accounts}
          todayISO={todayISO ?? new Date().toISOString()}
          onDecide={(decision) => onGroupDecide(selected!, decision)}
        />
      );
    }

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
