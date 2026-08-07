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

const isCharging = (b: Bill): boolean => b.lifecycleStatus !== 'cancelled';

export function monthlyCostRaw(bill: Bill): number {
  return bill.amount * MONTHLY_FACTOR[bill.frequency];
}

export function monthlyCost(bill: Bill): number {
  return roundCurrency(monthlyCostRaw(bill));
}

/** Sum raw, round once. Cancelled bills charge nothing; cancel-planned still does. */
export function totalMonthlyCost(bills: Bill[]): number {
  return roundCurrency(
    bills.filter(isCharging).reduce((sum, b) => sum + monthlyCostRaw(b), 0)
  );
}

/** $/mo the owner has declared untouchable — reserved first in any plan. */
export function nonNegotiableMonthly(bills: Bill[]): number {
  return roundCurrency(
    bills
      .filter(b => isCharging(b) && b.nonNegotiable)
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
  const money = (status: MigrationStatus) =>
    roundCurrency(
      bills
        .filter(b => isCharging(b) && b.migrationStatus === status)
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
 * Transfers and pending holds never count — a hold is not posted truth
 * (see interpretTransaction in classify.ts for the app-wide policy).
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
  return bills.filter(
    b =>
      isCharging(b) &&
      (b.migrationStatus === 'to-switch' || b.migrationStatus === 'to-review') &&
      PAYMENT_METHODS[b.paymentMethodId]?.active === false
  );
}
