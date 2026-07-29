/**
 * Behavior-based forecasting (spec: docs/superpowers/specs/2026-07-29-behavior-forecast-design.md).
 *
 * Pure, deterministic, no React. Math runs in integer CENTS (flows.ts convention);
 * the exported Assumptions/ForecastEvent amounts are DOLLARS rounded to cents,
 * because they feed ForecastEvent.amount and the Assumptions panel directly.
 *
 * Built ON TOP of the proven engines: classifyTransaction, matchTransfers,
 * detectRecurring, isRefund/isReward — nothing here re-derives what they already know.
 */
import { PaymentAccount, Transaction, ForecastEvent, displayCategory } from '@/types';
import { classifyTransaction, isRefund, isReward } from './classify';
import { matchTransfers } from './transfers';
import { detectRecurring, normalizeMerchant, median, daysBetween, toCents, day, RecurringItem } from './flows';
import { addDays, addMonths, format, parseISO } from 'date-fns';

export type BehaviorClass =
  | 'income' | 'fixed-bill' | 'variable-recurring' | 'lifestyle'
  | 'one-time' | 'transfer' | 'card-payment' | 'refund';

export type IncomeCadence = 'weekly' | 'biweekly' | 'semimonthly' | 'monthly';

export interface Assumptions {
  /** Single paycheck line derived from sourceCategory==='Paychecks' rows; null when <3 paychecks. */
  income: {
    label: string;
    medianAmount: number; // dollars
    cadence: IncomeCadence;
    nextDate: string; // yyyy-MM-dd
    confidence: number; // in-band gap ratio 0..1
  } | null;
  /** detectRecurring's active items, dollarized. */
  fixedBills: Array<{
    merchant: string;
    amount: number; // dollars
    cadence: RecurringItem['cadence'];
    nextDue: string;
    accountId: string | null;
    confidence: number;
  }>;
  /** Monthly MEDIAN per category over the last 6 full months, variable-recurring + lifestyle rows ONLY. */
  categoryBaselines: Array<{ category: string; monthlyMedian: number; monthsObserved: number }>;
  /** What never enters projections, surfaced so the panel can explain itself. */
  exclusions: {
    transfers: number;
    cardPayments: number;
    refunds: number;
    oneTimes: Array<{ id: string; title: string; amount: number; date: string }>;
  };
  overrides: AssumptionOverrides;
}

export interface AssumptionOverrides {
  /** null = user removed the income line entirely. */
  income?: { amount?: number; cadence?: IncomeCadence } | null;
  bills?: Record<string, { amount?: number; disabled?: boolean }>; // keyed by merchant
  baselines?: Record<string, number | null>; // category -> monthly dollars; null = removed
}

const ONE_TIME_FLOOR_CENTS = 30_000; // $300
const WINDOW_MONTHS = 6;

// Income cadence from the median gap between pay dates.
// ponytail: coarse bands; semimonthly (1st/15th) alternates 13/17-day gaps so its
// median lands 15-16 — true day-of-month modeling if that ever mispays.
const INCOME_BANDS: Array<[IncomeCadence, number, number]> = [
  ['weekly', 6, 8], ['biweekly', 12, 14], ['semimonthly', 15, 18], ['monthly', 26, 35],
];
const cadenceOf = (medianGap: number): IncomeCadence =>
  medianGap <= 9 ? 'weekly' : medianGap <= 14 ? 'biweekly' : medianGap <= 18 ? 'semimonthly' : 'monthly';

/** Last N full calendar months' keys (yyyy-MM), current partial month excluded. Mirrors monthlyAverages. */
function monthWindow(todayISO: string, months = WINDOW_MONTHS): Set<string> {
  const [y, m] = day(todayISO).slice(0, 7).split('-').map(Number);
  const keys = new Set<string>();
  for (let i = 1; i <= months; i++) {
    keys.add(new Date(Date.UTC(y, m - 1 - i, 1)).toISOString().slice(0, 7));
  }
  return keys;
}

const monthOf = (t: Transaction) => day(t.date).slice(0, 7);

/** Does this detected bill duplicate a loan account's own projected payment? (±5%, monthly) */
function loanTwin(bill: { amount: number; cadence: string }, loan: PaymentAccount): boolean {
  return bill.cadence === 'monthly' && !!loan.monthlyPayment &&
    Math.abs(bill.amount - loan.monthlyPayment) <= loan.monthlyPayment * 0.05;
}
const projectableLoans = (accounts: PaymentAccount[]) =>
  accounts.filter((a) => a.type === 'personal_loan' && a.monthlyPayment && a.dueDate);

// ------------------------------------------------------------------
// Shared classification context — one pass, used by both exports.
// ------------------------------------------------------------------
interface Ctx {
  classes: Map<string, BehaviorClass>;
  recurring: RecurringItem[]; // active only
  window: Set<string>;
  /** category -> monthKey -> cents, variable-recurring + lifestyle rows only (baseline feed). */
  baselineByCat: Map<string, Map<string, number>>;
}

function buildContext(transactions: Transaction[], accounts: PaymentAccount[], todayISO: string): Ctx {
  const classes = new Map<string, BehaviorClass>();
  const window = monthWindow(todayISO);
  const byId = new Map(accounts.map((a) => [a.id, a]));

  // 1. Transfer pairs: both legs transfer, or card-payment when the receiving side is a card.
  const { pairs } = matchTransfers(transactions, accounts);
  for (const p of pairs) {
    const cls: BehaviorClass =
      (p.toAccountId && byId.get(p.toAccountId)?.type === 'credit_card') ? 'card-payment' : 'transfer';
    classes.set(p.out.id, cls);
    classes.set(p.inbound.id, cls);
  }

  // 2. Recurring merchants (active set) = fixed bills.
  const recurring = detectRecurring(transactions, accounts, todayISO).filter((r) => r.active);
  const activeMerchants = new Set(recurring.map((r) => r.merchant));

  // 3. Raw per-category monthly totals (ALL expense rows in window) — the one-time
  // threshold's "3x the category's monthly median" reference. Plus month presence.
  const rawByCat = new Map<string, Map<string, number>>();
  const expenseRows: Transaction[] = [];
  for (const t of transactions) {
    if (classes.has(t.id)) continue; // pair legs are settled
    if (classifyTransaction(t, accounts) !== 'expense') continue;
    expenseRows.push(t);
    const mo = monthOf(t);
    if (!window.has(mo)) continue;
    const cat = displayCategory(t);
    const inner = rawByCat.get(cat) ?? new Map<string, number>();
    inner.set(mo, (inner.get(mo) ?? 0) + toCents(t.amount));
    rawByCat.set(cat, inner);
  }
  const rawMedian = (cat: string) => {
    const inner = rawByCat.get(cat);
    return inner && inner.size ? median([...inner.values()]) : 0;
  };

  // 4. Classify everything not already settled by pairing.
  const baselineByCat = new Map<string, Map<string, number>>();
  for (const t of transactions) {
    if (classes.has(t.id)) continue;
    const cls = classifyTransaction(t, accounts);
    if (cls === 'transfer') { classes.set(t.id, 'transfer'); continue; }
    if (cls === 'income') {
      classes.set(t.id, isRefund(t) || isReward(t) ? 'refund' : 'income');
      continue;
    }
    // expense
    const merchant = normalizeMerchant(t.merchant || t.title);
    if (activeMerchants.has(merchant)) { classes.set(t.id, 'fixed-bill'); continue; }
    const cat = displayCategory(t);
    if (toCents(t.amount) >= Math.max(ONE_TIME_FLOOR_CENTS, 3 * rawMedian(cat))) {
      classes.set(t.id, 'one-time');
      continue;
    }
    const monthsPresent = rawByCat.get(cat)?.size ?? 0;
    const behavior: BehaviorClass = monthsPresent >= 4 ? 'variable-recurring' : 'lifestyle';
    classes.set(t.id, behavior);
    // 5. Baseline feed: only these two classes, only window rows.
    const mo = monthOf(t);
    if (window.has(mo)) {
      const inner = baselineByCat.get(cat) ?? new Map<string, number>();
      inner.set(mo, (inner.get(mo) ?? 0) + toCents(t.amount));
      baselineByCat.set(cat, inner);
    }
  }

  return { classes, recurring, window, baselineByCat };
}

export function classifyBehaviors(
  transactions: Transaction[], accounts: PaymentAccount[]
): Map<string, BehaviorClass> {
  return buildContext(transactions, accounts, new Date().toISOString()).classes;
}

// ------------------------------------------------------------------
// buildAssumptions — the contract the whole feature rides on.
// ------------------------------------------------------------------
export function buildAssumptions(
  transactions: Transaction[], accounts: PaymentAccount[], overrides: AssumptionOverrides = {}
): Assumptions {
  const todayISO = new Date().toISOString();
  const ctx = buildContext(transactions, accounts, todayISO);

  // Income: single paycheck line from the rows the source itself tagged as Paychecks.
  let income: Assumptions['income'] = null;
  const paychecks = transactions.filter(
    (t) => ctx.classes.get(t.id) === 'income' && t.sourceCategory === 'Paychecks'
  );
  const payDates = [...new Set(paychecks.map((t) => day(t.date)))].sort();
  if (payDates.length >= 3) {
    const gaps = payDates.slice(1).map((d, i) => daysBetween(payDates[i], d));
    const mg = median(gaps);
    const cadence = cadenceOf(mg);
    const band = INCOME_BANDS.find(([c]) => c === cadence)!;
    income = {
      label: 'Paycheck',
      medianAmount: median(paychecks.map((t) => toCents(t.amount))) / 100,
      cadence,
      nextDate: format(addDays(parseISO(payDates[payDates.length - 1]), mg), 'yyyy-MM-dd'),
      confidence: gaps.filter((g) => g >= band[1] && g <= band[2]).length / gaps.length,
    };
  }

  let fixedBills: Assumptions['fixedBills'] = ctx.recurring.map((r) => ({
    merchant: r.merchant,
    amount: r.medianCents / 100,
    cadence: r.cadence,
    nextDue: r.nextDue,
    accountId: r.accountId,
    confidence: r.confidence,
  }));

  let categoryBaselines: Assumptions['categoryBaselines'] = [...ctx.baselineByCat.entries()]
    .map(([category, byMonth]) => ({
      category,
      monthlyMedian: median([...byMonth.values()]) / 100,
      monthsObserved: byMonth.size,
    }))
    // A category seen in <3 of the last 6 months is irregular spending, not a
    // baseline — projecting it is exactly the averaging artifact this engine
    // replaces. (Big irregulars are also caught by one-time detection.)
    .filter((b) => b.monthsObserved >= 3)
    .sort((a, b) => b.monthlyMedian - a.monthlyMedian);

  const count = (cls: BehaviorClass) =>
    transactions.reduce((n, t) => n + (ctx.classes.get(t.id) === cls ? 1 : 0), 0);
  const oneTimes = transactions
    .filter((t) => ctx.classes.get(t.id) === 'one-time')
    .map((t) => ({ id: t.id, title: t.title, amount: t.amount, date: day(t.date) }))
    .sort((a, b) => b.date.localeCompare(a.date));

  // Overrides applied LAST — user corrections beat every heuristic.
  if (overrides.income === null) income = null;
  else if (overrides.income && income) {
    income = {
      ...income,
      ...(overrides.income.amount !== undefined && { medianAmount: overrides.income.amount }),
      ...(overrides.income.cadence !== undefined && { cadence: overrides.income.cadence }),
    };
  }
  if (overrides.bills) {
    fixedBills = fixedBills
      .filter((b) => !overrides.bills![b.merchant]?.disabled)
      .map((b) => {
        const amt = overrides.bills![b.merchant]?.amount;
        return amt !== undefined ? { ...b, amount: amt } : b;
      });
  }
  if (overrides.baselines) {
    categoryBaselines = categoryBaselines
      .filter((b) => overrides.baselines![b.category] !== null)
      .map((b) => {
        const v = overrides.baselines![b.category];
        return typeof v === 'number' ? { ...b, monthlyMedian: v } : b;
      });
    for (const [category, v] of Object.entries(overrides.baselines)) {
      if (typeof v === 'number' && !categoryBaselines.some((b) => b.category === category)) {
        categoryBaselines.push({ category, monthlyMedian: v, monthsObserved: 0 });
      }
    }
  }

  return {
    income,
    fixedBills,
    categoryBaselines,
    exclusions: {
      transfers: count('transfer'),
      cardPayments: count('card-payment'),
      refunds: count('refund'),
      oneTimes,
    },
    overrides,
  };
}

// ------------------------------------------------------------------
// behaviorEvents — assumption-driven events replacing the flat drain.
// ------------------------------------------------------------------
const INCOME_STEP_DAYS: Record<Exclude<IncomeCadence, 'monthly'>, number> = {
  weekly: 7, biweekly: 14, semimonthly: 15,
};
const stepBill = (d: Date, cadence: RecurringItem['cadence']): Date =>
  cadence === 'weekly' ? addDays(d, 7)
  : cadence === 'biweekly' ? addDays(d, 14)
  : cadence === 'monthly' ? addMonths(d, 1)
  : cadence === 'quarterly' ? addMonths(d, 3)
  : addMonths(d, 12);

export function behaviorEvents(
  assumptions: Assumptions, accounts: PaymentAccount[], todayISO: string, days: number
): ForecastEvent[] {
  const events: ForecastEvent[] = [];
  const today = day(todayISO);
  const end = format(addDays(parseISO(today), days), 'yyyy-MM-dd');
  const inWindow = (d: string) => d > today && d < end;
  const loans = projectableLoans(accounts);

  // Income at pay cadence.
  const inc = assumptions.income;
  if (inc) {
    let d = parseISO(inc.nextDate);
    const step = (from: Date) =>
      inc.cadence === 'monthly' ? addMonths(from, 1) : addDays(from, INCOME_STEP_DAYS[inc.cadence]);
    while (format(d, 'yyyy-MM-dd') <= today) d = step(d);
    for (; format(d, 'yyyy-MM-dd') < end; d = step(d)) {
      events.push({
        date: format(d, 'yyyy-MM-dd'), type: 'income', description: inc.label,
        amount: inc.medianAmount, balanceAfter: 0, source: 'projected',
        confidence: inc.confidence,
      });
    }
  }

  // Fixed bills at nextDue + cadence repeats — the loan twin is skipped because
  // generateBillEvents already projects the loan's own payment (that twin wins).
  for (const bill of assumptions.fixedBills) {
    if (loans.some((l) => loanTwin(bill, l))) continue;
    let d = parseISO(bill.nextDue);
    while (format(d, 'yyyy-MM-dd') <= today) d = stepBill(d, bill.cadence);
    for (; format(d, 'yyyy-MM-dd') < end; d = stepBill(d, bill.cadence)) {
      events.push({
        date: format(d, 'yyyy-MM-dd'), type: 'expense', description: bill.merchant,
        amount: -bill.amount, balanceAfter: 0, source: 'projected',
        confidence: bill.confidence, contributors: [bill.merchant],
      });
    }
  }

  // Projected living costs: Σ category baselines, divided daily. Baselines already
  // EXCLUDE fixed-bill rows (classification), so evented bills never double-count.
  // The one projected outflow whose history DOES sit inside the baselines is a loan
  // payment detectRecurring missed (no detected twin) — subtract those, same residual
  // idea as the old generateTypicalSpendEvents.
  const baselineMonthly = assumptions.categoryBaselines.reduce((s, b) => s + b.monthlyMedian, 0);
  const uncoveredLoanMonthly = loans
    .filter((l) => !assumptions.fixedBills.some((b) => loanTwin(b, l)))
    .reduce((s, l) => s + (l.monthlyPayment ?? 0), 0);
  const residualDaily = (Math.max(0, baselineMonthly - uncoveredLoanMonthly) * 12) / 365;
  if (residualDaily >= 1) {
    const top = assumptions.categoryBaselines.slice(0, 5);
    const monthsObserved = Math.max(0, ...assumptions.categoryBaselines.map((b) => b.monthsObserved));
    const amount = -Math.round(residualDaily * 100) / 100;
    for (let d = addDays(parseISO(today), 1); inWindow(format(d, 'yyyy-MM-dd')); d = addDays(d, 1)) {
      events.push({
        date: format(d, 'yyyy-MM-dd'), type: 'expense', description: 'Projected living costs',
        amount, balanceAfter: 0, source: 'projected',
        breakdown: top.map((b) => ({ label: b.category, amount: b.monthlyMedian })),
        confidence: Math.min(1, monthsObserved / WINDOW_MONTHS),
        contributors: top.slice(0, 3).map((b) => b.category),
      });
    }
  }

  return events.sort((a, b) => a.date.localeCompare(b.date));
}
