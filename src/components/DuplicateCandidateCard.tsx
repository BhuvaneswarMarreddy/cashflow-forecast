'use client';

import React, { useMemo, useState } from 'react';
import { ReviewCandidate } from '@/lib/candidates';
import { DuplicateCostEstimate } from '@/lib/duplicates';
import { day, toCents } from '@/lib/flows';
import { formatMoneyCents } from '@/lib/money';
import {
  ACTION_BTN,
  QueueContext,
  RecoveryDecision,
  confirmationPreview,
  maskedAccount,
  reasonSentence,
  subscriptionSeries,
} from '@/lib/review-queue';

const money = formatMoneyCents;

/**
 * "Am I being charged twice?"
 *
 * BOTH series, per account, never one collapsed row (§4.3.1). All five decisions visible,
 * never behind an overflow menu (§4.3.4) — "Different person" and "For business" are the
 * honest answers for a shared or a business card, and burying them makes "yes, cancel one"
 * the path of least resistance.
 *
 * The avoidable-cost figure is rendered from FIN-DUPLICATE-001's own `label` field, with
 * the disclaimer ADJACENT to the number rather than in a tooltip. The words "savings",
 * "you will save" and "guaranteed" appear nowhere, because none of them is true.
 */
export default function DuplicateCandidateCard({
  candidate,
  estimate,
  ctx,
  onDecide,
}: {
  candidate: ReviewCandidate;
  estimate?: DuplicateCostEstimate;
  ctx: QueueContext;
  onDecide: (decision: RecoveryDecision, candidate: ReviewCandidate) => void;
}) {
  const [cancelledOn, setCancelledOn] = useState('');
  const index = useMemo(() => new Map(ctx.transactions.map((t) => [t.id, t])), [ctx.transactions]);
  const rows = candidate.transactionIds.map((id) => index.get(id)).filter(Boolean);
  const isCharge = candidate.candidateType === 'immediate_duplicate_charge';
  const series = useMemo(() => (isCharge ? [] : subscriptionSeries(candidate, ctx)), [isCharge, candidate, ctx]);
  const preview = useMemo(() => confirmationPreview(candidate, [], ctx), [candidate, ctx]);
  const merchant = rows[0]?.merchant || rows[0]?.title || 'this service';

  return (
    <article className="rounded-xl border border-[var(--border-color)] bg-[var(--background-secondary)] p-4 space-y-3">
      <header>
        <p className="font-medium text-[var(--foreground)]">
          {isCharge
            ? 'Possible duplicate charge'
            : candidate.candidateType === 'continued_charge_after_cancellation'
              ? 'Charged after you cancelled'
              : 'Possible duplicate subscription'}
        </p>
        <p className="text-sm text-[var(--foreground-secondary)]">
          {merchant} · {(isCharge ? rows : series).map((r) =>
            isCharge ? maskedAccount(ctx.accounts, (r as { accountId?: string }).accountId) : (r as { accountLabel: string }).accountLabel
          ).join(' and ')}
        </p>
      </header>

      {isCharge ? (
        <>
          <ul className="text-sm space-y-1">
            {rows.map((r) => (
              <li key={r!.id} className="flex gap-3">
                <span className="text-[var(--foreground-muted)]">{day(r!.date)}</span>
                <span className="tabular-nums">{money(toCents(r!.amount))}</span>
                <span>{maskedAccount(ctx.accounts, r!.accountId)}</span>
              </li>
            ))}
          </ul>
          <p className="text-sm text-[var(--foreground-secondary)]">
            {candidate.evidence.dayGaps[0] === 0
              ? 'Both landed on the same day.'
              : `${candidate.evidence.dayGaps[0]} day${candidate.evidence.dayGaps[0] === 1 ? '' : 's'} apart.`}
          </p>
          <p className="text-sm text-[var(--foreground-muted)]">
            Both charges are still counted in your spending. Confirming this does not change any total — it is a
            note to yourself to check with the merchant.
          </p>
        </>
      ) : (
        <ul className="text-sm space-y-1">
          {series.map((s) => (
            <li key={s.accountId ?? s.accountLabel} className="flex flex-wrap gap-x-3">
              <span>{s.accountLabel}</span>
              <span className="tabular-nums">
                {money(s.amountCents)}/{candidate.evidence.cadence ?? 'period'}
              </span>
              <span className="text-[var(--foreground-muted)]">since {s.firstSeen}</span>
              <span className="text-[var(--foreground-muted)]">last charge {s.lastSeen}</span>
              <span className="text-[var(--foreground-muted)]">{s.chargeCount} charges</span>
            </li>
          ))}
        </ul>
      )}

      {!isCharge && candidate.evidence.overlappingPeriods !== undefined && (
        <p className="text-sm text-[var(--foreground-secondary)]">
          Both charged in {candidate.evidence.overlappingPeriods} of the same periods.
        </p>
      )}

      {estimate && (
        <div className="rounded-lg bg-[var(--background-tertiary)] p-3">
          <p className="font-medium capitalize">
            {estimate.label}: {money(estimate.potentialAnnualDuplicateCostCents)}
          </p>
          {/* Adjacent, not a tooltip (§4.3.3). */}
          <p className="text-xs text-[var(--foreground-muted)]">
            This is what a second subscription costs in a year, not money coming back — you may be paying for both
            on purpose.
          </p>
        </div>
      )}

      <details className="text-sm">
        <summary className="min-h-[44px] flex items-center cursor-pointer text-[var(--foreground-secondary)]">Why?</summary>
        <p className="text-[var(--foreground-muted)]">{reasonSentence(candidate.evidence.reasonCodes ?? [])}</p>
      </details>

      <section aria-label="What confirming will do" className="rounded-lg bg-[var(--background-tertiary)] p-3 text-sm space-y-1">
        <p className="font-medium">If you confirm:</p>
        <p>{preview.affectedCount} transactions affected · {preview.dateRange}</p>
        <p>{preview.moneyEffect}</p>
        <p>{preview.budgetEffect}</p>
        <p>{preview.forecastEffect}</p>
        <p>{preview.flowEffect}</p>
        <p className="text-[var(--foreground-muted)]">{preview.whatDoesNotChange}</p>
        <p className="text-[var(--foreground-muted)]">{preview.scope}</p>
      </section>

      <div className="flex flex-wrap gap-2">
        <button className={ACTION_BTN} onClick={() => onDecide({ status: 'confirmed', reasonCode: 'accidental_duplicate' }, candidate)}>
          {isCharge ? 'Yes, a duplicate' : 'Accidental duplicate'}
        </button>
        <button className={ACTION_BTN} onClick={() => onDecide({ status: 'intentional', reasonCode: 'intentional' }, candidate)}>
          Both intentional
        </button>
        <button className={ACTION_BTN} onClick={() => onDecide({ status: 'intentional', reasonCode: 'different_owner' }, candidate)}>
          Different owners
        </button>
        <button className={ACTION_BTN} onClick={() => onDecide({ status: 'intentional', reasonCode: 'business' }, candidate)}>
          Business vs personal
        </button>
        <button
          className={ACTION_BTN}
          disabled={!cancelledOn}
          onClick={() => onDecide({ status: 'intentional', reasonCode: 'already_cancelled', effectiveDate: cancelledOn }, candidate)}
        >
          Already cancelled
        </button>
        <button className={ACTION_BTN} onClick={() => onDecide({ status: 'dismissed', reasonCode: 'not_a_duplicate' }, candidate)}>
          Dismiss
        </button>
      </div>

      {/* The cancellation date has to be a real date, or `continued_charge_after_cancellation`
          can never arm. Native control, visible label, no picker library. */}
      <label className="flex items-center gap-2 text-sm">
        <span>Cancelled on</span>
        <input
          type="date"
          className="min-h-[44px] rounded-lg border border-[var(--border-color)] bg-[var(--background)] px-2"
          value={cancelledOn}
          onChange={(e) => setCancelledOn(e.target.value)}
        />
      </label>
    </article>
  );
}
