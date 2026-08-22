/**
 * homeSnapshot — the owner's numbers, derived once, server-side.
 *
 * WHY THIS EXISTS
 *
 * Firestore does not store balances. `PaymentAccount.currentBalance` is
 * annotated *"DERIVED in memory by withDerivedBalances; never stored"*, so a
 * second client that reads the raw documents cannot show a balance without
 * re-deriving one — and a second derivation is a second opinion. This callable
 * runs the SAME functions the browser runs (`src/lib/**`, compiled into this
 * bundle by `functions/tsconfig.json`) and hands back the finished figures.
 *
 * Every consumer therefore quotes one computation. Nothing here re-implements
 * money maths; this file is a reader, a mapper and nothing else.
 *
 * UNITS: the web model is DOLLARS (floats). The mobile client is INTEGER CENTS.
 * That conversion happens once, at the very bottom of this file, in `cents()`.
 */

import { getFirestore, Timestamp } from 'firebase-admin/firestore';
import { HttpsError, onCall } from 'firebase-functions/v2/https';

import { currentOf, isUnanchored, sortAccounts } from '@/lib/accounts';
import { nonNegotiableMonthly, type Bill } from '@/lib/bills';
import { isPositive, type IncomeContext } from '@/lib/classify';
import {
  calculateCurrentCash,
  generateForecast,
  monthlyAverages,
  withDerivedBalances,
} from '@/lib/forecast';
import { RESERVE_TARGET_MONTHS, homeSummary, runwayLabel } from '@/lib/home';
import { interpretLedgerRows, type MappingRule } from '@/lib/mapping-rules';
import type {
  ForecastEvent,
  InflowReview,
  IncomeSource,
  PaymentAccount,
  SavingsGoal,
  Transaction,
} from '@/types';

/** How far ahead "upcoming" reaches. A bill past this is not actionable today. */
const UPCOMING_DAYS = 45;
/** Recent activity sent to the client. The full ledger is not a phone payload. */
const ACTIVITY_LIMIT = 200;
/** The web dashboard's own averaging window. Keep them the same or they diverge. */
const AVERAGE_MONTHS = 6;
const DEFAULT_SAFETY_THRESHOLD = 500;

const cents = (dollars: number): number => Math.round(dollars * 100);

const toIso = (value: unknown): string | null => {
  if (value instanceof Timestamp) return value.toDate().toISOString();
  return typeof value === 'string' ? value : null;
};

// ── Reads ───────────────────────────────────────────────────────────────────

export interface Ledger {
  accounts: PaymentAccount[];
  transactions: Transaction[];
  incomeSources: IncomeSource[];
  reviews: Record<string, InflowReview>;
  bills: Bill[];
  goals: SavingsGoal[];
  safetyThreshold: number;
  includePending: boolean;
  /** `meta/plaid.lastSuccess` — when the banks were last actually reached. */
  lastBankSyncAt: string | null;
  /** The owner's mapping rules, newest first — same precedence order as
   *  TransactionContext. Exposed on the ledger (not just applied and dropped)
   *  so a later derivation can explain WHY a row looks the way it does. */
  rules: MappingRule[];
}

// `interpretLedgerRows` moved to `@/lib/mapping-rules` — one derivation, one
// home, shared with `TransactionContext.tsx`'s useMemo instead of two copies
// that could drift. Re-exported here so every existing `readLedger` caller in
// this file, and `../__tests__/snapshot.test.ts`, keep working unchanged.
export { interpretLedgerRows };

/**
 * Everything one derivation needs, in one round of parallel reads.
 *
 * The mappings mirror `src/lib/firestore.ts` exactly — `{ id, ...data }` with
 * Timestamps flattened to ISO. They are re-stated rather than imported because
 * that module is built on the *client* SDK.
 */
export async function readLedger(uid: string): Promise<Ledger> {
  const user = getFirestore().collection('users').doc(uid);

  const [userDoc, plaidMeta, accounts, rawTransactions, income, reviews, bills, goals, rulesDocs] =
    await Promise.all([
    user.get(),
    // The ONLY real sync timestamp in the system. Written by `_guarded` /
    // plaid_ingest on every successful run; there is no per-account stamp, so
    // this is a property of the sync, not of any one account.
    getFirestore().collection('meta').doc('plaid').get(),
    user.collection('accounts').where('isActive', '==', true).get(),
    user.collection('transactions').get(),
    user.collection('income').get(),
    user.collection('reviews').get(),
    user.collection('bills').get(),
    user.collection('goals').get(),
    // Own subcollection, same as TransactionContext — never `settings`, which
    // is rebuilt from a hardcoded whitelist and would silently drop these.
    user.collection('rules').get(),
  ]);

  const settings = (userDoc.data()?.settings ?? {}) as {
    safetyThreshold?: number;
    includePendingInCalculations?: boolean;
  };

  const rules = rulesDocs.docs
    .map((d) => ({ ...(d.data() as Omit<MappingRule, 'id'>), id: d.id }))
    // Newest first = highest precedence — a later correction beats an older
    // rule without deleting it. Mirrors TransactionContext's `rules` load.
    .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));

  const transactions = interpretLedgerRows(
    rawTransactions.docs.map((d) => {
      const data = d.data();
      return { ...data, id: d.id, date: toIso(data.date) ?? data.date } as Transaction;
    }),
    rules,
  );

  return {
    lastBankSyncAt: toIso(plaidMeta.data()?.lastSuccess),
    accounts: sortAccounts(
      accounts.docs.map((d) => ({ id: d.id, ...d.data() }) as PaymentAccount),
    ),
    transactions,
    incomeSources: income.docs.map((d) => ({ id: d.id, ...d.data() }) as IncomeSource),
    reviews: Object.fromEntries(
      reviews.docs.map((d) => [d.id, { ...(d.data() as InflowReview), transactionId: d.id }]),
    ),
    bills: bills.docs.map((d) => {
      const data = d.data();
      return {
        ...data,
        id: d.id,
        createdAt: toIso(data.createdAt) ?? '',
        updatedAt: toIso(data.updatedAt) ?? '',
      } as Bill;
    }),
    goals: goals.docs.map((d) => ({ id: d.id, ...d.data() }) as SavingsGoal),
    safetyThreshold: settings.safetyThreshold ?? DEFAULT_SAFETY_THRESHOLD,
    includePending: settings.includePendingInCalculations ?? false,
    rules,
  };
}

// ── Mapping to the mobile domain ────────────────────────────────────────────

const ACCOUNT_KIND = {
  credit_card: 'credit-card',
  debit_card: 'checking',
  bank_account: 'checking',
  cash: 'cash',
  personal_loan: 'loan',
} as const;

const INSTITUTION: Record<string, string> = {
  amex: 'American Express',
  chase: 'Chase',
  discover: 'Discover',
  apple: 'Apple Card',
  visa: 'Visa',
  mastercard: 'Mastercard',
  cash: 'Cash',
  'bank-transfer': 'Bank Account',
  other: 'Other',
};

export function mapAccount(account: PaymentAccount) {
  const owed = currentOf(account);
  const isCard = account.type === 'credit_card';
  return {
    id: account.id,
    name: account.name,
    institution: INSTITUTION[account.provider] ?? 'Other',
    kind: ACCOUNT_KIND[account.type] ?? 'checking',
    mask: account.lastFourDigits ?? '',
    balanceCents: cents(owed),
    availableCents:
      isCard && account.creditLimit !== undefined ? cents(account.creditLimit - owed) : null,
    creditLimitCents: account.creditLimit !== undefined ? cents(account.creditLimit) : null,
    currency: 'USD' as const,
    // No per-account sync stamp is stored. Inventing "just now" would be worse
    // than admitting it is unknown.
    lastSyncedAt: null,
    // An account with no opening anchor has an unmeasured balance (#83) — the
    // client is required to say so rather than quote the figure flatly.
    status: isUnanchored(account) ? ('stale' as const) : ('ok' as const),
  };
}

export function mapTransaction(transaction: Transaction, accounts: PaymentAccount[]) {
  // The SAME sign resolver `deriveAccountBalance` uses, so a row's displayed
  // direction can never contradict its effect on the balance.
  const inflow = isPositive(transaction, accounts);
  return {
    id: transaction.id,
    accountId: transaction.accountId ?? '',
    date: transaction.date.slice(0, 10),
    description: transaction.title,
    merchant: transaction.merchant ?? null,
    amountCents: cents(inflow ? transaction.amount : -transaction.amount),
    // The provider's own label, verbatim, falling back to the coarse bucket.
    category: transaction.sourceCategory ?? transaction.category,
    pending: transaction.pending ?? false,
    kind:
      transaction.type === 'income'
        ? ('income' as const)
        : transaction.type === 'transfer'
          ? ('transfer' as const)
          : ('purchase' as const),
  };
}

const UPCOMING_KIND: Partial<Record<ForecastEvent['type'], 'bill' | 'card-payment'>> = {
  bill: 'bill',
  credit_card_payment: 'card-payment',
};

// ── The callable ────────────────────────────────────────────────────────────

export const homeSnapshot = onCall({ cors: true }, async (request) => {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'Sign in to load your figures.');
  }

  const ledger = await readLedger(request.auth.uid);

  // The app's financial policy, assembled exactly as UserProfileContext does.
  const policy: IncomeContext = {
    sources: ledger.incomeSources,
    reviews: ledger.reviews,
    includePending: ledger.includePending,
  };

  const accounts = withDerivedBalances(ledger.accounts, ledger.transactions, policy);
  const cash = calculateCurrentCash(accounts);
  const cardsOwed = accounts
    .filter((a) => a.type === 'credit_card')
    .reduce((sum, a) => sum + currentOf(a), 0);
  const averages = monthlyAverages(ledger.transactions, accounts, AVERAGE_MONTHS, policy);

  const home = homeSummary({
    currentCash: cash,
    avgMonthlyExpense: averages.spending,
    cardsOwed,
    lockedMonthly: nonNegotiableMonthly(ledger.bills),
    today: new Date(),
  });

  const forecast = generateForecast(
    cash,
    accounts,
    ledger.incomeSources,
    ledger.transactions,
    policy,
    ledger.safetyThreshold,
    UPCOMING_DAYS,
  );

  const upcoming = forecast.events
    .filter((e) => UPCOMING_KIND[e.type])
    .map((e, index) => ({
      id: `${e.type}-${e.date}-${index}`,
      name: e.description,
      dueDate: e.date.slice(0, 10),
      amountCents: cents(Math.abs(e.amount)),
      accountId: e.accountId ?? null,
      kind: UPCOMING_KIND[e.type]!,
      // Every event the forecast projects is one it expects to happen without
      // being asked, which is what autopay means to the person reading it.
      autopay: e.source === 'recurring',
    }));

  const paycheck = forecast.events.find((e) => e.type === 'income');

  const activity = ledger.transactions
    .slice()
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, ACTIVITY_LIMIT)
    .map((t) => mapTransaction(t, accounts));

  return {
    generatedAt: new Date().toISOString(),

    snapshot: {
      cashCents: cents(cash),
      creditCardBalanceCents: cents(cardsOwed),
      upcomingTotalCents: upcoming.reduce((sum, u) => sum + u.amountCents, 0),
      // Null until a Plaid run has succeeded. The client must render its absence
      // as "not known", never as "never synced" — those are different claims.
      lastBankSyncAt: ledger.lastBankSyncAt,
      // The web model has no savings ACCOUNT type, so there is no figure to
      // quote. `null`, never 0 — a zero here reads as "you have saved nothing".
      savingsCents: null,
      nextPaycheck: paycheck
        ? {
            expectedDate: paycheck.date.slice(0, 10),
            amountCents: cents(paycheck.amount),
            source: paycheck.description,
            // Projected from the source's cadence; nobody confirmed the date.
            confidence: 'estimated' as const,
          }
        : null,
      // Runway is the hero (UI-102): cash over measured burn. `hasBurn` false
      // means no spending has been measured, and the client must render nothing
      // rather than divide by zero and call the result a deadline.
      runway: {
        hasBurn: home.hasBurn,
        label: runwayLabel(home),
        days: home.runwayDays,
        months: home.runwayMonths,
        date: home.runwayDate.toISOString().slice(0, 10),
        reserveProgress: home.reserveProgress,
        reserveTargetMonths: RESERVE_TARGET_MONTHS,
        nextMonthTarget: home.nextMonthTarget,
        amountToNextMonthCents: cents(home.amountToNextMonth),
      },
      lockedMonthlyCents: cents(home.lockedMonthly),
      avgMonthlySpendCents: cents(averages.spending),
      avgMonthlyIncomeCents: cents(averages.income),
      // FIN-PENDING-001. Returned so the client can show the policy that
      // produced these figures — every number above honours it, so a screen
      // offering the toggle must read the same value the maths used.
      includePending: ledger.includePending,
    },

    accounts: accounts.map(mapAccount),
    upcoming,
    goals: ledger.goals
      .filter((g) => g.isActive)
      .map((g) => ({
        id: g.id,
        name: g.name,
        targetCents: cents(g.targetAmount),
        savedCents: cents(g.currentAmount),
        targetDate: g.targetDate ?? null,
      })),
    activity,
  };
});
