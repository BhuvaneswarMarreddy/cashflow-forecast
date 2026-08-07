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
