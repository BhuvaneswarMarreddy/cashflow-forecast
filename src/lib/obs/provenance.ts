/**
 * Sanitized provenance for the numbers the Accounts page puts on screen.
 *
 * This module EXPLAINS the calculation; it must never become the calculation. Each
 * metric re-applies the exact filter + reducer used in src/app/accounts/page.tsx and
 * reports what that filter actually did — including the parts that are unflattering
 * (accounts excluded by type, an unavailable last-sync timestamp, a cache hit).
 */

import { PaymentAccount, Transaction, AccountType } from '@/types';
import { currentOf } from '@/lib/accounts';
import { maskAccountNumber } from './redact';

export const CALCULATION_NAME = 'AccountsSummary';
export const CALCULATION_VERSION = 'v1';

export type CacheStatus = 'hit' | 'miss' | 'refill' | 'unknown';
export type Staleness = 'fresh' | 'stale' | 'unknown';

export interface MetricProvenance {
  metric: string;
  displayedValue: number;
  calculationName: string;
  calculationVersion: string;
  asOf: string;
  lastSourceSync: string | null;
  includedAccountCount: number;
  includedAccountTypes: AccountType[];
  includedAccounts: Array<{ id: string; type: AccountType; label: string }>;
  excludedAccountCount: number;
  exclusionReasons: Record<string, number>;
  pendingDataTreatment: string;
  dataSource: string;
  cacheStatus: CacheStatus;
  staleness: Staleness;
  traceId: string;
}

export interface AccountsProvenance {
  traceId: string;
  asOf: string;
  calculationName: string;
  calculationVersion: string;
  accountCount: number;
  transactionCount: number;
  dataSource: string;
  cacheStatus: CacheStatus;
  lastSourceSync: string | null;
  lastSyncSource: string;
  staleness: Staleness;
  metrics: MetricProvenance[];
  limitations: string[];
}

const CASH_TYPES: AccountType[] = ['bank_account', 'debit_card', 'cash'];
const CARD_TYPES: AccountType[] = ['credit_card'];
const DEBT_TYPES: AccountType[] = ['credit_card', 'personal_loan'];

const STALE_AFTER_HOURS = 36;

/** `Chase ****1234` — safe to show a developer, never a full number. */
function safeLabel(a: PaymentAccount): string {
  return a.lastFourDigits ? `${a.name} ${maskAccountNumber(a.lastFourDigits)}` : a.name;
}

/** Firestore Timestamp | Date | ISO string → ISO string. Unknown shapes → null. */
function toIso(value: unknown): string | null {
  if (!value) return null;
  if (typeof value === 'string') return Number.isNaN(Date.parse(value)) ? null : new Date(value).toISOString();
  if (value instanceof Date) return value.toISOString();
  const ts = value as { toDate?: () => Date; seconds?: number };
  if (typeof ts.toDate === 'function') return ts.toDate().toISOString();
  if (typeof ts.seconds === 'number') return new Date(ts.seconds * 1000).toISOString();
  return null;
}

/**
 * Best available "when did the bank feed last touch this data".
 *
 * The authoritative value lives in Firestore at `meta/monarchSync.lastSuccess`, which
 * the browser cannot read (top-level collection, no security rule grants it). So we
 * use the newest `updatedAt` written by the sync's balance re-anchor, and fall back to
 * the newest transaction that arrived from a bank feed. Reported with its own source
 * so nobody mistakes the fallback for the real thing.
 */
export function lastSourceSync(
  accounts: PaymentAccount[], transactions: Transaction[]
): { at: string | null; source: string } {
  const stamps = accounts
    .map((a) => toIso((a as unknown as { updatedAt?: unknown }).updatedAt))
    .filter((s): s is string => Boolean(s))
    .sort();
  if (stamps.length) return { at: stamps[stamps.length - 1], source: 'account.updatedAt (sync re-anchor)' };

  const feeds = transactions
    .filter((t) => t.sources?.some((s) => s !== 'manual' && s !== 'csv'))
    .map((t) => t.date)
    .sort();
  if (feeds.length) return { at: new Date(feeds[feeds.length - 1]).toISOString(), source: 'newest bank-feed transaction date' };

  return { at: null, source: 'unavailable (meta/monarchSync not client-readable)' };
}

function staleness(lastSync: string | null, now: number): Staleness {
  if (!lastSync) return 'unknown';
  return now - Date.parse(lastSync) > STALE_AFTER_HOURS * 3600_000 ? 'stale' : 'fresh';
}

function metric(
  name: string,
  value: number,
  included: PaymentAccount[],
  excluded: PaymentAccount[],
  shared: Pick<AccountsProvenance, 'traceId' | 'asOf' | 'dataSource' | 'cacheStatus' | 'lastSourceSync' | 'staleness'>
): MetricProvenance {
  const exclusionReasons: Record<string, number> = {};
  for (const a of excluded) {
    const reason = `type:${a.type}`;
    exclusionReasons[reason] = (exclusionReasons[reason] ?? 0) + 1;
  }
  return {
    metric: name,
    displayedValue: Math.round(value * 100) / 100,
    calculationName: CALCULATION_NAME,
    calculationVersion: CALCULATION_VERSION,
    asOf: shared.asOf,
    lastSourceSync: shared.lastSourceSync,
    includedAccountCount: included.length,
    includedAccountTypes: [...new Set(included.map((a) => a.type))],
    includedAccounts: included.map((a) => ({ id: a.id, type: a.type, label: safeLabel(a) })),
    excludedAccountCount: excluded.length,
    exclusionReasons,
    // #83 Fix 5: this used to assert "rows before openingDate are already inside the
    // anchor" unconditionally. An account with no openingDate has no anchor and no
    // such rows to be inside one — deriveAccountBalance's openingKey falls back to
    // '0000-00-00' (src/lib/forecast.ts) and every row on record counts. Wording now
    // true in both cases, not a claim that only held for the anchored ones.
    pendingDataTreatment:
      'Balances are openingBalance ± POSTED transactions dated openingDate..today (an account with no openingDate has no anchor, so this is net movement across every row on record); provider-pending rows (pending: true) are excluded because the anchor is the provider posted balance, rows dated after today are excluded as forecast, and — only for an account that has an anchor — rows before openingDate are already inside it.',
    dataSource: shared.dataSource,
    cacheStatus: shared.cacheStatus,
    staleness: shared.staleness,
    traceId: shared.traceId,
  };
}

/**
 * Build the provenance for one Accounts render.
 *
 * `accounts` must be the DERIVED list (post `withDerivedBalances`) the page renders,
 * so the displayed values here are the values on screen — not a second opinion.
 */
export function accountsSummaryProvenance(
  accounts: PaymentAccount[],
  transactions: Transaction[],
  ctx: { traceId: string; dataSource: string; cacheStatus: CacheStatus; now?: number }
): AccountsProvenance {
  const now = ctx.now ?? Date.now();
  const asOf = new Date(now).toISOString();
  const sync = lastSourceSync(accounts, transactions);
  const shared = {
    traceId: ctx.traceId,
    asOf,
    dataSource: ctx.dataSource,
    cacheStatus: ctx.cacheStatus,
    lastSourceSync: sync.at,
    staleness: staleness(sync.at, now),
  };

  const by = (types: AccountType[]) => accounts.filter((a) => types.includes(a.type));
  const not = (types: AccountType[]) => accounts.filter((a) => !types.includes(a.type));
  const sum = (list: PaymentAccount[]) => list.reduce((s, a) => s + currentOf(a), 0);

  const cash = by(CASH_TYPES);
  const cards = by(CARD_TYPES);
  const debts = by(DEBT_TYPES);

  const bankBalance = sum(cash);
  const creditUsed = sum(cards);
  const totalDebt = sum(debts);
  const creditLimit = cards.reduce((s, a) => s + (a.creditLimit || 0), 0);

  const metrics: MetricProvenance[] = [
    metric('BankBalance', bankBalance, cash, not(CASH_TYPES), shared),
    metric('CreditUsed', creditUsed, cards, not(CARD_TYPES), shared),
    metric('TotalDebt', totalDebt, debts, not(DEBT_TYPES), shared),
    metric('NetWorth', bankBalance - totalDebt, [...cash, ...debts], accounts.filter((a) => ![...CASH_TYPES, ...DEBT_TYPES].includes(a.type)), shared),
    metric('AvailableCredit', creditLimit - creditUsed, cards.filter((a) => a.creditLimit != null), cards.filter((a) => a.creditLimit == null), shared),
    metric('AccountCount', accounts.length, accounts, [], shared),
  ];

  return {
    ...shared,
    calculationName: CALCULATION_NAME,
    calculationVersion: CALCULATION_VERSION,
    accountCount: accounts.length,
    transactionCount: transactions.length,
    lastSyncSource: sync.source,
    metrics,
    limitations: [
      'Inactive accounts never reach this calculation: firestore.getAccounts() filters isActive == true at the repository, so "excludedAccountCount" counts type exclusions only.',
      `Last-sync is derived (${sync.source}); the authoritative meta/monarchSync.lastSuccess is not readable by the browser under the current Firestore rules.`,
      'AvailableCredit excludes cards with no creditLimit set rather than treating a missing limit as zero — matching the page, which sums only the limits it has.',
      // Faithful description of current execution. FIN-INCOME-001 replaced the
      // "Paychecks"-literal rule this used to record; the remaining gap is that
      // per-metric provenance rows have not been written for the income cards yet.
      'NOT COVERED: the "Monthly Income" and "Monthly Budget" cards have no per-metric provenance row yet. Monthly Income comes from monthlyAverages() (src/lib/forecast.ts), which since FIN-INCOME-001 counts a row ONLY when interpretTransaction() resolves it to the financial meaning "earned_income" — that is, it matched an ACTIVE APPROVED source in users/{uid}/income or the owner confirmed it in users/{uid}/reviews. Every other credit is an "unknown_inflow": it moves the balance and is excluded from income, so refunds, reimbursements, Zelle credits and one-off deposits no longer inflate this figure. With no approved source configured the honest answer is 0, and the unexplained credits are listed by selectInflowReviewQueue() (src/lib/classify.ts).',
    ],
  };
}
