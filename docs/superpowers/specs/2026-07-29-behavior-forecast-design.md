# Behavior-Based Forecasting + AI Assumptions Panel

**Date:** 2026-07-29 · **Owner decisions:** hybrid classifier (deterministic behavioral engine + AI assist for the ambiguous residual, cached); V1 ships everything: engine + Assumptions panel + per-day explanation.

## Why
"Typical daily spending $214.29" every day is an averaging artifact: it blends one-time purchases, transfers, refunds and irregular events into a flat drain. Forecasts must model *behavior*: pay cycles, bills on their real due dates, category baselines — and show their assumptions.

## Architecture

### 1. `src/lib/behavior.ts` (pure, deterministic, cents-exact)
**8-way behavior classification** built ON TOP of the proven engines (classifyTransaction, matchTransfers, detectRecurring, isRefund/isReward, personFrom):
- `transfer` — a matched pair leg (matchTransfers) or classifier transfer
- `card-payment` — bank→card pair leg
- `refund` — isRefund/isReward positives (both card- and bank-side)
- `income` — classifier income (paychecks flagged separately by sourceCategory)
- `fixed-bill` — expense whose normalized merchant is in detectRecurring's active set
- `one-time` — expense outlier: amount ≥ max($300, 3× its category's monthly median) and merchant NOT recurring
- `variable-recurring` — remaining expense in habitual categories (groceries/fuel/pharmacy/transport…): category seen in ≥4 of last 6 months
- `lifestyle` — everything else (dining, entertainment, shopping)

**`buildAssumptions(transactions, accounts, overrides)`** → the contract the whole feature rides on:
```ts
interface Assumptions {
  income: { label; medianAmount; cadence; nextDate; confidence } | null;  // from Paychecks rows' gap/amount medians
  fixedBills: Array<{ merchant; amount; cadence; nextDue; accountId; confidence }>; // detectRecurring active
  categoryBaselines: Array<{ category; monthlyMedian; monthsObserved }>;  // ONLY variable-recurring + lifestyle rows, monthly medians over last 6 full months
  exclusions: { transfers; cardPayments; refunds; oneTimes: Array<{ id; title; amount; date }> };
  overrides: AssumptionOverrides; // user corrections, applied last
}
```
Confidence = in-band gap ratio (recurring) / cadence regularity (income). Overrides V1 in localStorage (`ponytail:` note — moves to the Phase-8 rules subcollection later; same shape).

**`generateBehaviorForecast(...)`** replaces the flat drain inside `generateForecast`:
- income events at pay cadence (assumption-driven, replaces incomeSources events when a paycheck assumption exists)
- fixed bills evented at nextDue + cadence repeats — deduped against loan billEvents (amount ±5% + same cadence ⇒ skip the detected twin)
- living costs: per-day event whose amount = Σ category baselines minus evented-recurring coverage, carrying `breakdown` (per-category cents), `confidence`, `contributors` (which merchants/months produced it) — additive optional fields on ForecastEvent
- one-times/transfers/refunds NEVER enter projections

### 2. AI assist (existing rails, no new infra)
Ambiguous merchants (unclassifiable category, enough volume to matter) go through the existing `aiDecision` callable (`question` type) in ONE batched call from the Assumptions panel's "Improve with AI" action; results cached in localStorage V1 and correctable. No per-forecast LLM calls; forecasts stay deterministic.

### 3. UI
- **AssumptionsPanel** (`src/components/AssumptionsPanel.tsx`) on /forecast above the chart: "What this forecast believes" — salary line, fixed bills list, top category baselines, excluded counts (transfers/card-payments/refunds/one-times with drill-open list), each row correctable (edit amount / cadence / exclude), corrections persist as overrides and regenerate the forecast live.
- **Per-day explanation**: Transaction Timeline rows for projected events get an expandable drawer — expected events that day, each with confidence + "based on" contributors; living-cost rows show the category breakdown; a footer line lists what was excluded and why.

## Testing
Unit: classification 8-way (each class with a real-shaped fixture), assumption medians (income cadence, baselines exclude one-times/refunds/transfers), forecast dedup (loan vs detected bill), override application. The existing 262 stay green; forecast tests updated where the drain shape changed.

## Non-goals (V1)
Seasonality, weekday patterns, cross-device override sync (rules subcollection later), AI classification of the full ledger.
