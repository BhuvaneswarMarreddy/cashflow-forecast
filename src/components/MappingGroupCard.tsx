'use client';

import React, { useMemo, useState } from 'react';
import { PaymentAccount, Transaction } from '@/types';
import { formatMoneyCents } from '@/lib/money';
import {
  GroupDecision,
  GroupScope,
  MappingGroup,
  SCOPE_LABEL,
  buildGroupRule,
  groupMeanings,
  groupPreview,
  groupScopes,
  ruleSetForMeaning,
} from '@/lib/mapping-suggestions';
import { ACTION_BTN, maskedAccount } from '@/lib/review-queue';

const money = formatMoneyCents;

/**
 * ONE question that answers a whole pattern.
 *
 * Every number on this card comes from the group or from `groupPreview()`, which is
 * computed from the RULE the chosen scope would create — so "changes 37 rows" is the
 * same 37 rows the rule will change. Confirm stays disabled until an answer exists, and
 * a broad rule (FIN-REVIEW-002 §7.3) needs a second, explicit acknowledgement.
 *
 * Nothing here writes. The card hands a `GroupDecision` upwards on a button press.
 */
export default function MappingGroupCard({
  group,
  transactions,
  accounts,
  todayISO,
  onDecide,
}: {
  group: MappingGroup;
  transactions: readonly Transaction[];
  accounts: readonly PaymentAccount[];
  todayISO: string;
  onDecide: (decision: GroupDecision) => void;
}) {
  const [meaning, setMeaning] = useState<string>('');
  const [scope, setScope] = useState<GroupScope>('only_this_group');
  const [acknowledged, setAcknowledged] = useState(false);
  // MAP-002 — OFF by default. A derived income source is a proposal until the owner ticks
  // it, and an unticked box is the difference between suggesting and applying.
  const [createSource, setCreateSource] = useState(false);

  const scopes = useMemo(() => groupScopes(group), [group]);
  const set = meaning ? ruleSetForMeaning(meaning as never) : null;
  // A scope the answer cannot express is not offered as a real choice: the review record
  // still carries the meaning for these rows, and we say that in words rather than
  // silently creating a rule that means something else.
  const rule = useMemo(
    () => (set && scope !== 'only_this_group' ? buildGroupRule(group, scope, set, todayISO) : null),
    [group, scope, set, todayISO]
  );
  const preview = useMemo(
    () => (rule ? groupPreview(group, rule, { transactions, accounts }) : null),
    [group, rule, transactions, accounts]
  );

  const offer = group.suggestion?.incomeSourceOffer;
  const blocked = !meaning || (!!preview?.needsExtraConfirmation && !acknowledged);
  const spanLabel = group.firstDate === group.lastDate ? group.firstDate : `${group.firstDate} to ${group.lastDate}`;

  return (
    <article className="rounded-xl border border-[var(--border-color)] bg-[var(--background-secondary)] p-4 space-y-3">
      <header className="space-y-1">
        <h3 className="font-medium text-[var(--foreground)]">{group.label}</h3>
        <p className="text-sm text-[var(--foreground-secondary)]">
          {group.rowCount} {group.rowCount === 1 ? 'row' : 'rows'} · {money(group.totalCents)} total ·{' '}
          {group.direction === 'inflow' ? 'money in' : 'money out'}
        </p>
        <p className="text-sm text-[var(--foreground-muted)]">
          {spanLabel}
          {group.minCents !== group.maxCents ? ` · ${money(group.minCents)}–${money(group.maxCents)} each` : ''}
          {group.cadence ? ` · ${group.cadence}` : ''}
        </p>
        <p className="text-sm text-[var(--foreground-muted)]">
          {group.accountIds.map((id) => maskedAccount(accounts, id)).join(', ') || 'no account on these rows'}
          {group.sourceCategories.length ? ` · your export calls this ${group.sourceCategories.join(', ')}` : ''}
        </p>
      </header>

      {group.suggestion && (
        <section aria-label="What your data suggests" className="rounded-lg bg-[var(--background-tertiary)] p-3 text-sm space-y-1">
          <p className="font-medium">From your own data:</p>
          <p>{group.suggestion.why}.</p>
          {group.suggestion.meaning && (
            <button
              className={ACTION_BTN}
              onClick={() => setMeaning(group.suggestion!.meaning!)}
              aria-label="Use this suggestion"
            >
              Use this
            </button>
          )}
        </section>
      )}

      {/* MAP-002 — what the ledger says ABOUT these rows. There is nothing to confirm
          here, so there is no button: it is a fact, not a question. */}
      {group.findings.length > 0 && (
        <section aria-label="What your data also shows" className="rounded-lg bg-[var(--background-tertiary)] p-3 text-sm space-y-1">
          {group.findings.map((f) => (
            <p key={f} className="text-[var(--foreground-secondary)]">{f}.</p>
          ))}
        </section>
      )}

      {/* The pre-filled income source, offered only once the owner has chosen the meaning
          it belongs to. Every field below is read off these rows. */}
      {offer && meaning === group.suggestion?.meaning && (
        <section aria-label="Create an income source from these rows" className="rounded-lg bg-[var(--background-tertiary)] p-3 text-sm space-y-1">
          <label className="flex items-start gap-2 min-h-[44px] cursor-pointer">
            <input type="checkbox" checked={createSource} onChange={(e) => setCreateSource(e.target.checked)} />
            <span>
              Also save &ldquo;{offer.name}&rdquo; as an income source — {money(Math.round(offer.amount * 100))}{' '}
              {offer.frequency}
              {offer.endDate
                ? `, ending ${offer.endDate}, because nothing has arrived from this payer since then`
                : ', still running'}
              .
            </span>
          </label>
        </section>
      )}

      <fieldset className="space-y-1">
        <legend className="text-sm text-[var(--foreground-secondary)]">
          What are these {group.rowCount === 1 ? 'row' : 'rows'}?
        </legend>
        {/* One list per direction: every answer above is a credit, and this queue now
            also holds debits. Offering "someone paying me back" for money going OUT is
            a lie the UI should not be able to tell. */}
        {groupMeanings(group.direction).map((m) => (
          <label key={m.value} className="flex items-center gap-2 min-h-[44px] text-sm cursor-pointer">
            <input
              type="radio"
              name={`meaning-${group.key}`}
              value={m.value}
              checked={meaning === m.value}
              onChange={() => { setMeaning(m.value); setAcknowledged(false); setCreateSource(false); }}
            />
            {m.label}
          </label>
        ))}
      </fieldset>

      {meaning && (
        <fieldset className="space-y-1">
          <legend className="text-sm text-[var(--foreground-secondary)]">How far should this go?</legend>
          {scopes.map((s) => (
            <label key={s} className="flex items-center gap-2 min-h-[44px] text-sm cursor-pointer">
              <input
                type="radio"
                name={`scope-${group.key}`}
                value={s}
                disabled={s !== 'only_this_group' && !set}
                checked={scope === s}
                onChange={() => { setScope(s); setAcknowledged(false); }}
              />
              {SCOPE_LABEL[s]}
            </label>
          ))}
          {!set && (
            <p className="text-sm text-[var(--foreground-muted)]">
              A saved rule can only change a row&apos;s category or mark it a transfer, so this answer is
              recorded on these {group.rowCount} {group.rowCount === 1 ? 'row' : 'rows'} and no rule is created.
            </p>
          )}
        </fieldset>
      )}

      <section aria-label="What confirming will do" className="rounded-lg bg-[var(--background-tertiary)] p-3 text-sm space-y-1">
        <p className="font-medium">If you confirm:</p>
        {preview ? (
          <>
            <p>{preview.whatChanges}</p>
            <p>
              {preview.affectedCount} {preview.affectedCount === 1 ? 'transaction' : 'transactions'} affected ·{' '}
              {preview.dateRange}
            </p>
            <p>{preview.futureEffect}</p>
            <p>{preview.budgetEffect}</p>
            <p>{preview.forecastEffect}</p>
            <p>{preview.flowEffect}</p>
            <p>{preview.scopeSentence}</p>
          </>
        ) : (
          <>
            <p>
              {group.rowCount} {group.rowCount === 1 ? 'transaction' : 'transactions'} affected · {spanLabel}
            </p>
            <p>Future rows are not included. No rule is created.</p>
            <p>No category changes, so no budget total moves.</p>
            <p>Your forecast gains no income from this. Naming money does not create any.</p>
            <p>The Flow diagram keeps the same boxes, ribbons and totals.</p>
          </>
        )}
        <p>Every row stays in your history at its full amount. Nothing is deleted.</p>
      </section>

      {preview?.needsExtraConfirmation && (
        <label className="flex items-start gap-2 min-h-[44px] text-sm cursor-pointer text-[var(--foreground)]">
          <input type="checkbox" checked={acknowledged} onChange={(e) => setAcknowledged(e.target.checked)} />
          This is a broad rule. I have read that it changes {preview.affectedCount} transactions.
        </label>
      )}

      <div className="flex flex-wrap gap-2">
        <button
          className={ACTION_BTN}
          disabled={blocked}
          onClick={() =>
            onDecide({
              action: 'confirm',
              meaning: meaning as never,
              incomeSourceId:
                meaning === group.suggestion?.meaning ? group.suggestion?.incomeSourceId : undefined,
              scope: rule ? scope : 'only_this_group',
              ...(rule ? { rule } : {}),
              // Only when the box is ticked AND the answer is the one the offer was
              // derived for. Deriving a source and creating one are two different events.
              ...(offer && createSource && meaning === group.suggestion?.meaning
                ? { incomeSourceOffer: offer }
                : {}),
            })
          }
        >
          Confirm for {group.rowCount} {group.rowCount === 1 ? 'row' : 'rows'}
        </button>
        {/* The terminal answer. Persisted, and the pattern never asks again. */}
        <button
          className={ACTION_BTN}
          onClick={() => onDecide({ action: 'unknown', scope: 'only_this_group' })}
        >
          I can&apos;t classify these — stop asking
        </button>
      </div>
    </article>
  );
}
