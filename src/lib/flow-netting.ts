/**
 * FIN-FLOW-001 — the LINK-aware half of the flow lanes.
 *
 * WHY THIS IS A SEPARATE FILE FROM flow-lanes.ts. `relations.ts` imports `toCents` from
 * `flows.ts`, so `flows.ts` may not reach `relations.ts`, `card-credit.ts` or
 * `refunds.ts` through a static import: when `relations.ts` is the module that enters
 * the cycle, `card-credit.ts` evaluates `CARD_CREDIT_KINDS` while `relations.ts` is
 * still initialising and the app dies with a temporal-dead-zone error at import time
 * (nine suites proved it). So the layering is:
 *
 *     flows.ts  ->  flow-lanes.ts            (leaf: classify.ts + types only)
 *     page.tsx  ->  flow-netting.ts -> refunds.ts / card-credit.ts / relations.ts
 *
 * The caller that owns the links resolves them ONCE here and hands `buildFlowGraph`
 * plain data. Nothing is re-implemented: the allocations are the confirmed links
 * themselves, the card kinds come from `classifyCardCredit()`, and a test asserts the
 * allocation totals equal `purchaseEconomics()`/`refundEconomics()` to the cent.
 *
 * PURE module: no React, no I/O.
 */

import { PaymentAccount, Transaction } from '@/types';
import { IncomeContext, classifyTransaction, isPosted, isRefund } from '@/lib/classify';
import { CARD_CREDIT_TO_INFLOW_MEANING, cardPaymentPairedIds, classifyCardCredit } from '@/lib/card-credit';
import { REFUND_SOURCE_TYPES, TransactionLink } from '@/lib/relations';
import { FlowNetting, Lane, MONEY_BACK, REWARDS, RefundAllocation } from '@/lib/flow-lanes';

const isDebt = (a?: PaymentAccount) => a?.type === 'credit_card' || a?.type === 'personal_loan';

/**
 * Every CONFIRMED refund allocation, plus the ladder's answer for each card credit.
 *
 * `suggested` and `provisional` are deliberately absent: an unproven match nets nothing,
 * and a dispute credit the bank can still claw back reduces no spending. That is the
 * same rule `purchaseEconomics()` keeps, stated once more where it is enforced.
 */
export function flowNetting(
  transactions: readonly Transaction[],
  accounts: PaymentAccount[],
  links: readonly TransactionLink[],
  income?: IncomeContext
): FlowNetting {
  const allocations: RefundAllocation[] = [];
  for (const l of links) {
    if (l.status !== 'confirmed') continue;
    if (!REFUND_SOURCE_TYPES.includes(l.linkType)) continue;
    allocations.push({
      creditId: l.sourceTransactionId,
      purchaseId: l.targetTransactionId,
      cents: l.allocatedAmountCents,
    });
  }

  // matchTransfers() is O(outs x ins); the paired set is computed ONCE for the run, as
  // card-credit.ts's own doc requires, never per credit.
  const posted = transactions.filter(isPosted);
  const pairedTransactionIds = cardPaymentPairedIds([...posted], accounts);
  const byId = new Map(accounts.map((a) => [a.id, a]));

  const laneOf = new Map<string, Lane>();
  for (const t of posted) {
    // Only rows the graph actually routes through an inflow lane — a card PURCHASE is
    // spending and has no business being run through a credit ladder.
    if (classifyTransaction(t, accounts) !== 'income') continue;
    if (!isDebt(t.accountId ? byId.get(t.accountId) : undefined)) continue;
    const { kind } = classifyCardCredit(t, {
      accounts, links, pairedTransactionIds, income,
    });
    const meaning = CARD_CREDIT_TO_INFLOW_MEANING[kind];
    // `card_payment` is a settlement and never reaches an inflow lane at all.
    if (kind === 'card_payment') continue;
    if (meaning === 'refund') { laneOf.set(t.id, MONEY_BACK); continue; }
    if (kind === 'cashback_reward' || kind === 'statement_credit' || kind === 'promotional_credit') {
      laneOf.set(t.id, REWARDS);
      continue;
    }
    // Rungs 6-7 determined NOTHING — that is the ladder's honest default, and saying so
    // by leaving the row out is what lets flow-lanes.ts apply the evidence this layer
    // cannot see (refund wording, and whether the credit's category is one the owner
    // actually spends in). Overwriting it here made 104 obvious refunds "unexplained".
    if (isRefund(t)) laneOf.set(t.id, MONEY_BACK);
  }

  return { allocations, laneOf };
}
