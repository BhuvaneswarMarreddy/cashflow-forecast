/**
 * Bills register (BILLS-001) — manually curated recurring obligations.
 *
 * The register is the owner-validated source of truth for the autopay
 * migration (credit cards → BofA debit). Nothing here is inferred from
 * transactions; the only derived numbers are frequency-normalized monthly
 * costs and the migration roll-ups.
 *
 * Rounding rule: display rounds per bill; aggregates sum RAW values and
 * round once, so per-row rounding can never drift a header total.
 */

import { addDays, differenceInCalendarDays, format, getDaysInMonth, isAfter, isBefore, parseISO } from 'date-fns';

import type { Transaction } from '@/types';

export type BillFrequency =
  | 'weekly'
  | 'biweekly'
  | 'monthly'
  | 'quarterly'
  | 'semiannual'
  | 'annual';

export type MigrationStatus =
  | 'to-review'
  | 'to-switch'
  | 'switched'
  | 'exception'
  | 'no-change-needed';

export type LifecycleStatus = 'active' | 'cancel-planned' | 'cancelled';

/**
 * Links a bill row (typically a budget-target "(average)" row) to the live
 * transactions behind it, so tapping the row shows actual merchants and a
 * target-vs-actual comparison. All rules AND together.
 */
export interface BillMatcher {
  /** Matches Transaction.sourceCategory (the Monarch label). */
  categories?: string[];
  /** Matches Transaction.merchant exactly. */
  merchants?: string[];
  excludeMerchants?: string[];
  /** Ignore single rows larger than this — one-off purchases, not run rate. */
  excludeOver?: number;
}

export interface Bill {
  id: string;
  vendor: string;
  url?: string;
  amount: number;
  frequency: BillFrequency;
  /** Day of month for monthly+ cadences; undefined = varies. */
  autopayDay?: number;
  /** ISO date (YYYY-MM-DD) anchoring weekly/biweekly (and multi-month) cadences. */
  anchorDate?: string;
  category?: string;
  paymentMethodId: string;
  migrationStatus: MigrationStatus;
  lifecycleStatus: LifecycleStatus;
  /**
   * Owner-declared untouchable (BILLS-003). Contract: every planning /
   * safe-to-spend consumer subtracts locked bills FIRST and never proposes
   * them as cuts — the chat brain (BRAIN-002+) must honor this.
   */
  nonNegotiable?: boolean;
  matcher?: BillMatcher;
  remarks?: string;
  source?: 'manual' | 'starter-audit';
  seedVersion?: number;
  /**
   * ISO date (YYYY-MM-DD). Set when the bill has a known end — e.g. an
   * installment plan's final payment. `isCharging()` stops counting a bill
   * the day AFTER this date; `billUpcomingEvents()` projects no due date
   * past it either. Same precedent as `FirestoreIncome.endDate` (firestore.ts).
   */
  endDate?: string;
  /**
   * Payments left as of when this was recorded — caps how many future due
   * dates `billUpcomingEvents()` projects (mirrors `FirestoreIncome.remainingPayments`
   * / forecast.ts's `maxPayments`). Does NOT auto-decrement with time; re-record
   * to update it.
   */
  installmentsRemaining?: number;
  createdAt: string;
  updatedAt: string;
}

export interface PaymentMethod {
  label: string;
  type: 'debit' | 'bank-ach' | 'credit-card' | 'zelle' | 'manual';
  institution: string;
  /** false = the owner is retiring this method; live bills on it get flagged. */
  active: boolean;
}

// Bundled registry, not a Firestore collection — one owner, a handful of
// methods. Promote to users/{uid}/paymentMethods if that ever changes.
export const PAYMENT_METHODS: Record<string, PaymentMethod> = {
  'bofa-debit': { label: 'BofA Debit', type: 'debit', institution: 'Bank of America', active: true },
  'bofa-checking-ach': { label: 'BofA Checking (ACH)', type: 'bank-ach', institution: 'Bank of America', active: true },
  'apple-card': { label: 'Apple Card', type: 'credit-card', institution: 'Apple', active: false },
  'amex-bcp': { label: 'Amex Blue Cash Preferred', type: 'credit-card', institution: 'American Express', active: false },
  'discover': { label: 'Discover it', type: 'credit-card', institution: 'Discover', active: false },
  'customized-cash': { label: 'BofA Customized Cash', type: 'credit-card', institution: 'Bank of America', active: false },
  'amazon-store': { label: 'Amazon Store Card', type: 'credit-card', institution: 'Synchrony', active: false },
  'zelle': { label: 'Zelle', type: 'zelle', institution: '—', active: true },
  'manual': { label: 'Manual / other', type: 'manual', institution: '—', active: true },
};

/** Periods per month for each cadence. */
const MONTHLY_FACTOR: Record<BillFrequency, number> = {
  weekly: 52 / 12,
  biweekly: 26 / 12,
  monthly: 1,
  quarterly: 1 / 3,
  semiannual: 1 / 6,
  annual: 1 / 12,
};

const roundCurrency = (n: number): number => Math.round(n * 100) / 100;

/** yyyy-MM-dd for "today" — a plain-string comparison against Bill.endDate (same format). */
const TODAY = (): string => new Date().toISOString().slice(0, 10);

/**
 * Cancelled bills never charge; neither does a bill whose end has passed.
 * `today` is a REQUIRED param (not defaulted here) so this can never be handed
 * bare to `Array.prototype.filter` — filter's own (element, INDEX, array) call
 * would otherwise pass the row index as `today` and compare a number to a date
 * string. Every call site below wraps it in an arrow for exactly that reason.
 */
const isCharging = (b: Bill, today: string): boolean =>
  b.lifecycleStatus !== 'cancelled' && !(b.endDate !== undefined && b.endDate < today);

export function monthlyCostRaw(bill: Bill): number {
  return bill.amount * MONTHLY_FACTOR[bill.frequency];
}

export function monthlyCost(bill: Bill): number {
  return roundCurrency(monthlyCostRaw(bill));
}

/** Sum raw, round once. Cancelled (or ended) bills charge nothing; cancel-planned still does. */
export function totalMonthlyCost(bills: Bill[], today: string = TODAY()): number {
  return roundCurrency(
    bills.filter((b) => isCharging(b, today)).reduce((sum, b) => sum + monthlyCostRaw(b), 0)
  );
}

/** $/mo the owner has declared untouchable — reserved first in any plan. */
export function nonNegotiableMonthly(bills: Bill[], today: string = TODAY()): number {
  return roundCurrency(
    bills
      .filter((b) => isCharging(b, today) && b.nonNegotiable)
      .reduce((s, b) => s + monthlyCostRaw(b), 0)
  );
}

export interface MigrationSummary {
  /** $/mo already moved to the target method (active lifecycles only). */
  switchedMonthly: number;
  /** $/mo still flowing to methods awaiting a switch (active, to-switch). */
  onCardsMonthly: number;
  /** $/mo deliberately staying on a card (active, exception). */
  exceptionMonthly: number;
  /** Rows still needing owner attention: to-switch + to-review, any lifecycle. */
  remaining: number;
  /** Rows done: switched + no-change-needed. */
  completed: number;
  exceptions: number;
  total: number;
}

export function migrationSummary(bills: Bill[]): MigrationSummary {
  const today = TODAY();
  const money = (status: MigrationStatus) =>
    roundCurrency(
      bills
        .filter(b => isCharging(b, today) && b.migrationStatus === status)
        .reduce((s, b) => s + monthlyCostRaw(b), 0)
    );
  const count = (...statuses: MigrationStatus[]) =>
    bills.filter(b => statuses.includes(b.migrationStatus)).length;
  return {
    switchedMonthly: money('switched'),
    onCardsMonthly: money('to-switch'),
    exceptionMonthly: money('exception'),
    remaining: count('to-switch', 'to-review'),
    completed: count('switched', 'no-change-needed'),
    exceptions: count('exception'),
    total: bills.length,
  };
}

// ---------------------------------------------------------------------------
// Merchant drill-down (v1.1)
// ---------------------------------------------------------------------------

/**
 * Does this settled income/expense row belong to the bill's spending bucket?
 *
 * Transfers and pending holds never count, in BOTH modes. FIN-PENDING-001 deliberately
 * does not reach here: "is this bill paid this month" is a question about a settlement
 * the biller has actually received, and a hold routinely posts at a different amount.
 * Marking a bill paid off an authorisation that later posts $8 higher is worse than
 * marking it paid a day late.
 */
export function matcherApplies(m: BillMatcher, t: Transaction): boolean {
  if (t.type === 'transfer' || t.pending) return false;
  if (m.categories && !m.categories.includes(t.sourceCategory ?? '')) return false;
  if (m.merchants && !m.merchants.includes(t.merchant ?? '')) return false;
  if (m.excludeMerchants && m.excludeMerchants.includes(t.merchant ?? '')) return false;
  if (m.excludeOver && Math.abs(t.amount) > m.excludeOver) return false;
  return true;
}

export interface SpendBreakdown {
  /** Net spend per month for the last 3 FULL months, oldest first. */
  months: Array<{ month: string; total: number }>;
  /** 3-full-month average — the "actual" against the row's target amount. */
  actualMonthly: number;
  /** The in-progress month, reported separately ("Aug so far"). */
  currentMonth: { month: string; total: number };
  /** Net monthly spend per merchant over the window, descending. */
  merchants: Array<{ merchant: string; monthly: number }>;
}

/**
 * Actual spending behind a matcher: expenses add, refunds (income rows)
 * subtract. Store-card payment credits arrive as income titled "No Details
 * Available" and are debt settlement, not refunds — they never subtract.
 */
export function spendBreakdown(
  m: BillMatcher,
  transactions: Transaction[],
  today: Date
): SpendBreakdown {
  const ym = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  const windowMonths: string[] = [];
  for (let i = 3; i >= 1; i--) {
    windowMonths.push(ym(new Date(today.getFullYear(), today.getMonth() - i, 1)));
  }
  const current = ym(today);

  const monthTotals = new Map<string, number>(windowMonths.map(mm => [mm, 0]));
  let currentTotal = 0;
  const perMerchant = new Map<string, number>();

  for (const t of transactions) {
    if (!matcherApplies(m, t)) continue;
    const isRefund = t.type === 'income';
    if (isRefund && /no details/i.test(t.title)) continue;
    const signed = isRefund ? -t.amount : t.amount;
    const month = t.date.slice(0, 7);
    if (month === current) {
      currentTotal = roundCurrency(currentTotal + signed);
      continue;
    }
    if (!monthTotals.has(month)) continue;
    monthTotals.set(month, roundCurrency(monthTotals.get(month)! + signed));
    const name = t.merchant || t.title;
    perMerchant.set(name, (perMerchant.get(name) ?? 0) + signed);
  }

  const months = windowMonths.map(mm => ({ month: mm, total: monthTotals.get(mm)! }));
  return {
    months,
    actualMonthly: roundCurrency(months.reduce((s, x) => s + x.total, 0) / months.length),
    currentMonth: { month: current, total: currentTotal },
    merchants: [...perMerchant.entries()]
      .map(([merchant, total]) => ({ merchant, monthly: roundCurrency(total / months.length) }))
      .sort((a, b) => b.monthly - a.monthly),
  };
}

/**
 * Live bills whose payment method the owner is retiring and that still need
 * switching. Exceptions are deliberate; cancelled rows are dead — neither is
 * actionable here.
 */
export function billsOnRetiredMethods(bills: Bill[]): Bill[] {
  const today = TODAY();
  return bills.filter(
    b =>
      isCharging(b, today) &&
      (b.migrationStatus === 'to-switch' || b.migrationStatus === 'to-review') &&
      PAYMENT_METHODS[b.paymentMethodId]?.active === false
  );
}

// ---------------------------------------------------------------------------
// Bills → Upcoming (record-bill epic, #10/#14)
// ---------------------------------------------------------------------------

/** How many months a cadence steps by. weekly/biweekly step in DAYS, not months — absent here. */
const MONTH_STEP: Partial<Record<BillFrequency, number>> = {
  monthly: 1,
  quarterly: 3,
  semiannual: 6,
  annual: 12,
};

export interface BillUpcomingEvent {
  billId: string;
  vendor: string;
  /** ISO date (YYYY-MM-DD). */
  dueDate: string;
  /** Dollars, the amount charged on THIS occurrence — Bill.amount verbatim. */
  amount: number;
}

/** monthly+ cadences: day-of-month from autopayDay. Quarterly/semiannual/annual
 *  additionally need anchorDate to pin WHICH months in the cycle qualify — plain
 *  monthly needs no anchor, every month qualifies. Missing the anchor its cadence
 *  needs means the bill "varies" (see Bill.autopayDay) and projects nothing, same
 *  as generateBillEvents (forecast.ts) skips a loan missing dueDate. */
function projectMonthlyish(bill: Bill, periodMonths: number, today: Date, horizonEnd: Date): Date[] {
  const day = bill.autopayDay;
  if (day === undefined) return [];

  let originMonth = today.getFullYear() * 12 + today.getMonth();
  if (periodMonths > 1) {
    if (!bill.anchorDate) return [];
    const anchor = parseISO(bill.anchorDate);
    originMonth = anchor.getFullYear() * 12 + anchor.getMonth();
  }

  const startMonth = today.getFullYear() * 12 + today.getMonth();
  const endMonth = horizonEnd.getFullYear() * 12 + horizonEnd.getMonth();

  const dates: Date[] = [];
  for (let m = startMonth; m <= endMonth; m++) {
    if (((m - originMonth) % periodMonths + periodMonths) % periodMonths !== 0) continue;
    const y = Math.floor(m / 12);
    const mo = ((m % 12) + 12) % 12;
    // Clamp, don't let JS Date roll a day-31 bill into next month for a shorter one
    // (Feb, or any 30-day month) — `new Date(y, mo, 31)` silently normalizes into mo+1.
    const clampedDay = Math.min(day, getDaysInMonth(new Date(y, mo, 1)));
    const candidate = new Date(y, mo, clampedDay);
    if (!isBefore(candidate, today) && !isAfter(candidate, horizonEnd)) dates.push(candidate);
  }
  return dates;
}

/** weekly/biweekly: step from anchorDate. No anchor, no projection — same "varies" rule. */
function projectWeeklyish(bill: Bill, stepDays: number, today: Date, horizonEnd: Date): Date[] {
  if (!bill.anchorDate) return [];
  let candidate = parseISO(bill.anchorDate);
  if (isBefore(candidate, today)) {
    const missed = differenceInCalendarDays(today, candidate);
    candidate = addDays(candidate, Math.ceil(missed / stepDays) * stepDays);
  }
  const dates: Date[] = [];
  while (!isAfter(candidate, horizonEnd)) {
    dates.push(candidate);
    candidate = addDays(candidate, stepDays);
  }
  return dates;
}

/**
 * Projects each charging bill's due dates inside [todayISO, todayISO + horizonDays]
 * (both ends inclusive) from its frequency + autopayDay/anchorDate, stopping at
 * endDate/installmentsRemaining.
 *
 * DISPLAY TRUTH ONLY. These events are for the "Upcoming" list and nothing else —
 * they must NEVER be folded into generateForecast/monthlyAverages or anything else
 * that drives runway. `avgMonthlyExpense` is derived from real transaction history,
 * which already contains every bill's real charge once it posts; adding the bill
 * register's PROJECTED amount on top would charge the same obligation twice — once
 * as history, once as a bill event. See the snapshot.ts merge site for the same
 * warning at the call site.
 */
export function billUpcomingEvents(
  bills: Bill[],
  todayISO: string,
  horizonDays: number
): BillUpcomingEvent[] {
  const today = parseISO(todayISO);
  const horizonEnd = addDays(today, horizonDays);
  const events: BillUpcomingEvent[] = [];

  for (const bill of bills) {
    if (!isCharging(bill, todayISO)) continue;

    const isWeeklyish = bill.frequency === 'weekly' || bill.frequency === 'biweekly';
    let dueDates = isWeeklyish
      ? projectWeeklyish(bill, bill.frequency === 'weekly' ? 7 : 14, today, horizonEnd)
      : projectMonthlyish(bill, MONTH_STEP[bill.frequency]!, today, horizonEnd);

    if (bill.endDate) {
      const end = parseISO(bill.endDate);
      dueDates = dueDates.filter((d) => !isAfter(d, end));
    }
    if (bill.installmentsRemaining !== undefined) {
      dueDates = dueDates.slice(0, bill.installmentsRemaining);
    }

    for (const d of dueDates) {
      events.push({ billId: bill.id, vendor: bill.vendor, dueDate: format(d, 'yyyy-MM-dd'), amount: bill.amount });
    }
  }

  return events.sort((a, b) => a.dueDate.localeCompare(b.dueDate));
}
