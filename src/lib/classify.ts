/**
 * The one transaction classifier. Rule order is load-bearing —
 * "Payroll Deposit Transfer from Savings" resolves differently under any
 * permutation, so do not reorder without a failing test.
 */

import {
  FinancialMeaning,
  FINANCIAL_MEANINGS,
  IncomeSource,
  InflowReview,
  InflowReviewState,
  PaymentAccount,
  PaymentMethod,
  Transaction,
  TransactionType,
} from '@/types';
import { emit } from '@/lib/obs/events';
import { newTraceId } from '@/lib/obs/trace';
import { namesExternalCounterparty } from './counterparty';

// A row only needs these fields to be classified, so partial/in-flight rows
// (e.g. a CSV preview row that has no id yet) can use the same code path.
type Classifiable = Pick<Transaction, 'type' | 'title'> &
  Partial<Pick<Transaction, 'accountId' | 'transferDirection' | 'pending'>>;

const TRANSFER = /transfer from|transfer to|online transfer/;
// pymt/epay cover real statement shapes ("CHASE CREDIT CRD EPAY", "AMZ_STORECRD_PMT"):
// bank exports rarely spell out "payment", and each missed form read as fake income.
const CARD_PAYMENT = /payment|autopay|auto pay|pymt|pmt|epay/;
const INCOME = /deposit|direct dep|payroll|salary/;

// Deliberately wider than CARD_PAYMENT: a statement credit should render as a
// positive on a card, but it is not itself a transfer between accounts.
const SIGN_PAYMENT = /payment|autopay|auto pay|pymt|pmt|epay|statement credit/;
const TRANSFER_IN = /transfer from/; // subsumes "online transfer from"
const TRANSFER_OUT = /transfer to/; // subsumes "online transfer to"
const DEPOSIT = /deposit|direct dep/;

/** Resolves the linked account, tolerating a missing list or a dangling id. */
function linkedAccount(
  t: Classifiable,
  accounts?: PaymentAccount[]
): PaymentAccount | undefined {
  return t.accountId ? accounts?.find((a) => a.id === t.accountId) : undefined;
}

// Words that identify one of the OWNER'S OWN credit cards inside a statement line.
// Deliberately not the account NAME: real card names contain "cash", "card", "store"
// and "rewards", which match half the merchants in a feed. Last four digits and the
// issuer are specific enough to be evidence.
const ISSUER_ALIASES: Partial<Record<PaymentMethod, string[]>> = {
  amex: ['amex', 'american express'],
  chase: ['chase'],
  discover: ['discover'],
  apple: ['apple card', 'goldman'], // bare "apple" matches every App Store charge
  visa: ['visa'],
  mastercard: ['mastercard', 'master card'],
};

/** Does this statement line name a credit card the owner actually holds? */
function namesOwnCard(title: string, accounts?: PaymentAccount[]): boolean {
  return !!accounts?.some((a) => {
    if (a.type !== 'credit_card') return false;
    if (a.lastFourDigits && title.includes(a.lastFourDigits)) return true;
    return (ISSUER_ALIASES[a.provider] ?? []).some((w) => title.includes(w));
  });
}

/**
 * Is this row a leg of a credit-card settlement?
 *
 * Two shapes, and BOTH have to be caught or the same money is counted twice:
 *  - the CARD leg: a credit arriving on the card (reduces debt)
 *  - the BANK leg: the debit that funded it, which SimpleFIN delivers with no
 *    category at all, so it used to read as ordinary spending
 *
 * The card leg must be a CREDIT. A purchase at a merchant with "PAYMENT" in its
 * name is a debit and stays spending — treating it as a settlement hid the spend
 * and reduced the card balance, wrong twice for one row.
 *
 * ponytail: title-token evidence only. FIN-SETTLEMENT-003's explicit link model is
 * the upgrade path when two cards from one issuer need telling apart.
 */
function isCardSettlement(t: Classifiable, accounts?: PaymentAccount[]): boolean {
  const title = t.title.toLowerCase();
  if (!CARD_PAYMENT.test(title)) return false;
  const account = linkedAccount(t, accounts);
  if (account?.type === 'credit_card') return t.type !== 'expense';
  // Funding leg: money leaving a non-card account, naming one of our cards.
  return t.type !== 'income' && namesOwnCard(title, accounts);
}

export function classifyTransaction(
  t: Classifiable,
  accounts?: PaymentAccount[]
): TransactionType {
  // A stored 'transfer' came from the source data (Monarch's own category column),
  // which beats guessing from a merchant string. Never re-derive it.
  if (t.type === 'transfer') return 'transfer';

  const title = t.title.toLowerCase();

  if (TRANSFER.test(title)) return 'transfer';

  // Either leg of a bank->card settlement. Neither is income and neither is
  // spending. ponytail: credit_card only, not personal_loan — widening this would
  // silently reclassify every loan payment out of expenses and inflate the runway.
  if (isCardSettlement(t, accounts)) return 'transfer';

  if (INCOME.test(title)) return 'income';

  // Never pass t.type through raw — that is how a fourth union member would leak.
  return t.type === 'income' ? 'income' : 'expense';
}

/**
 * Whether the amount should render as a gain (+/green) for the account it sits on.
 * Distinct from classification: a credit card payment is a *transfer*, but on the
 * card it still reduces debt and must show as a positive.
 *
 * Callers format the number themselves — this returns the sign only.
 */
// Card rewards / cashback / statement credits — a positive on a card that is earnings,
// not a refund of a purchase. Used to surface "rewards earned" per card.
const REWARD = /reward|cashback|cash back|redemption|redeem|points|statement credit|bonus/i;
export function isReward(
  t: Pick<Transaction, 'title'> & Partial<Pick<Transaction, 'merchant' | 'sourceCategory'>>
): boolean {
  return REWARD.test(`${t.title} ${t.merchant || ''} ${t.sourceCategory || ''}`);
}

// A refund / reimbursement / reversal — money coming back for something already paid.
// Owner's rule: a refund is NOT income; it nets against spending. Distinct from isReward
// (card earnings). Text-detected because the source data gives refunds no distinct type.
// ponytail: catches only rows whose text says so; a refund Monarch files under the
// original spend category with no "refund" word still reads as income — upgrade needs a
// same-merchant-prior-expense match if that proves common.
const REFUND = /refund|reimburse|reversal/i;
export function isRefund(
  t: Pick<Transaction, 'title'> & Partial<Pick<Transaction, 'merchant' | 'sourceCategory'>>
): boolean {
  return REFUND.test(`${t.title} ${t.merchant || ''} ${t.sourceCategory || ''}`);
}

export function isPositive(t: Classifiable & { amount?: number }, accounts?: PaymentAccount[]): boolean {
  // The source told us which leg this is. Authoritative — titles like
  // "USAA FUNDS TRANSFER DB"/"...CR" carry no direction word at all.
  // Gated on type because Firestore's merge writes cannot delete a field: a transfer
  // the user re-types as an expense keeps its stored transferDirection forever, and
  // honouring it would render that expense as a green inflow.
  if (t.type === 'transfer' && t.transferDirection) return t.transferDirection === 'in';

  const title = t.title.toLowerCase();
  const account = linkedAccount(t, accounts);
  const isDebtAccount = account?.type === 'credit_card' || account?.type === 'personal_loan';

  if (TRANSFER_IN.test(title) || DEPOSIT.test(title)) return true;
  if (TRANSFER_OUT.test(title)) return false;
  // A card row typed 'expense' is a DEBIT — a purchase at a merchant with "payment"
  // in its name must not render as debt going down. Loans are exempt because the
  // Monarch mapper forces ttype='expense' on every loan-titled row
  // (functions-sync/sync_core.py), so the stored type carries no direction there.
  if (isDebtAccount && SIGN_PAYMENT.test(title) &&
      (account?.type === 'personal_loan' || t.type !== 'expense')) return true;

  return t.type === 'income';
}

// ============================================================================
// FIN-INCOME-001 — approved income sources and the unknown-inflow default
//
// THE PRODUCT RULE: money entering an account is EARNED INCOME only when it matches
// an active approved source, or the owner explicitly confirmed it. Every other
// positive row is an `unknown_inflow` — genuine cash that raises the balance and
// counts for nothing in income analytics, forecasts or recurring estimates.
//
// A positive row must NEVER become income because it is large, recurring, called
// "deposit", arrived by Zelle, came from the same person twice, landed near payday,
// resembles a paycheck, or was tagged "Paychecks" by an importer. Provider
// categories SUGGEST; `users/{uid}/income` is AUTHORITATIVE.
// ============================================================================

/** The one predicate that answers "does this add to income totals". */
export const countsAsEarnedIncome = (m: FinancialMeaning): boolean => m === 'earned_income';

const COST_MEANINGS: readonly FinancialMeaning[] = [
  'personal_expense', 'shared_expense', 'reimbursable_expense', 'business_expense',
  'subscription', 'recurring_bill', 'one_time_expense',
  /**
   * A loan repayment IS a cost here, and deliberately unlike `card_payment`.
   *
   * A card payment settles spending the ledger already recorded row by row, so counting
   * it again would count it twice. A loan repayment settles money that arrived as cash
   * and left as an obligation — in a CASH-FLOW app, the money going out each month is
   * the thing the owner has to plan around, and the interest inside it is a real cost
   * that has nowhere else to land.
   *
   * The owner asked for this explicitly. The known ceiling: if the borrowed money was
   * spent on rows that are also in this ledger, those rows and these repayments both
   * count, and the principal is counted twice. Modelling the lender as a `personal_loan`
   * account is what separates principal from interest, and is the upgrade path.
   */
  'loan_repayment',
  // Same reasoning, same accepted ceiling — see the note on the value in `@/types`.
  'chit_fund_contribution',
];

/**
 * The one predicate that answers "does this reduce net worth as personal cost".
 * 1 = a cost, -1 = a cost coming back (a refund nets against spending),
 * 0 = money you already had, or money arriving. FIN-REVIEW-002 §3.1.3.
 */
export const personalCostSign = (m: FinancialMeaning): 1 | 0 | -1 =>
  COST_MEANINGS.includes(m) ? 1 : m === 'refund' ? -1 : 0;

/**
 * Owner intent, resolved ONCE in UserProfileContext and threaded into every
 * calculation. This is the app's financial policy object — the single answer to
 * "what does this owner consider real money" — not a bag of options.
 *
 * FIN-PENDING-001 (#86) widened it from income-only. It is deliberately the SAME
 * object rather than a second context: every screen that makes a financial claim
 * already passes this, so a new policy field reaches all of them without a single
 * call-site edit. A parallel `PendingContext` would have to be threaded through the
 * same thirty call sites and could drift out of step with this one.
 */
export interface FinancialPolicy {
  /** `users/{uid}/income` — the approved sources. */
  sources?: IncomeSource[];
  /** `users/{uid}/reviews`, keyed by transaction id. */
  reviews?: Record<string, InflowReview>;
  /**
   * FIN-PENDING-001. Treat provider holds as effective financial activity.
   *
   * Read-time interpretation ONLY. Nothing ever writes `pending: false` — storage
   * keeps provider truth, so this flips back losslessly and the audit trail survives.
   * Rows stay badged `Pending` in every mode.
   *
   * Scope is deliberately asymmetric — STATE yes, PATTERN INFERENCE no. Balances,
   * income, spending, budgets, Flow and the forecast baseline honour it. Recurring
   * detection, behaviour projections, bill matching and the review queue never do:
   * a $1 fuel pre-auth must not seed a permanent recurring bill, and a 6-month
   * average must not move daily on rows that post at a different amount.
   */
  includePending?: boolean;
}

/** @deprecated Use `FinancialPolicy`. Kept so no call site had to change in #86. */
export type IncomeContext = FinancialPolicy;

/**
 * "This calculation is posted-only, and that is the intended answer."
 *
 * Every money function takes the policy as a REQUIRED argument (#102). It used to be
 * optional, and six of seven balance call sites simply never passed one — so the owner
 * turned the setting on and Dashboard, Forecast and History did not move. The tests were
 * green because they called the library with a policy; nothing checked that the PAGES
 * did. An optional argument cannot be audited, only remembered.
 *
 * Pass this where posted-only is deliberate — pattern inference, bill matching, the
 * review queue — so intent is written down instead of inferred from an absent argument.
 */
export const POSTED_ONLY: FinancialPolicy = Object.freeze({});

/** Reason ids, sharing FIN-REVIEW-002 §2.4's vocabulary so there is one set. */
export type InflowReviewReason =
  | 'inflow_unknown_credit'
  | 'inflow_unmatched_deposit'
  | 'inflow_income_source_conflict';

/** Lowercase, punctuation collapsed — "LARKSPUR STUDIO*PAYROLL" -> "larkspur studio payroll". */
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

// A 1-2 character alias matches nearly every statement line, which would turn one
// sloppy source into "everything is my salary". Validation, not tidiness.
const MIN_ALIAS = 3;

const aliasesOf = (s: IncomeSource): string[] =>
  [s.name, ...(s.matchAliases ?? [])].map(norm).filter((a) => a.length >= MIN_ALIAS);

/** Active AND approved. `userApproved` absent = approved: the owner typed it in. */
export const activeApprovedSources = (sources?: IncomeSource[]): IncomeSource[] =>
  (sources ?? []).filter((s) => s.isActive && s.userApproved !== false);

type Inflow = Classifiable &
  Partial<Pick<Transaction, 'id' | 'amount' | 'merchant' | 'description' | 'sourceCategory'>>;

/**
 * Which approved sources explain this credit. Deterministic; all rules required:
 *
 *  1. NAME — the row's OWN text (title / merchant / description) contains one of the
 *     source's aliases. `sourceCategory` is deliberately NOT in the haystack: an
 *     importer's "Paychecks" label is a suggestion and must never decide.
 *  2. ACCOUNT — when the source names deposit accounts, the row must sit on one.
 *  3. AMOUNT — SUPPORTING ONLY. A configured tolerance can reject a name match; no
 *     amount ever creates one. Size, cadence, sender and payday proximity are not
 *     evidence at all, at any strength.
 *
 * Returning a LIST rather than a best guess is the point: two matches is a question
 * for the owner, not a coin toss (see resolveInflow).
 */
export function matchApprovedSources(t: Inflow, sources?: IncomeSource[]): IncomeSource[] {
  const hay = norm(`${t.title} ${t.merchant ?? ''} ${t.description ?? ''}`);
  const cents = t.amount === undefined ? undefined : Math.round(t.amount * 100);
  return activeApprovedSources(sources).filter((s) => {
    if (!aliasesOf(s).some((a) => hay.includes(a))) return false;
    if (s.depositAccountIds?.length && !(t.accountId && s.depositAccountIds.includes(t.accountId))) return false;
    if (s.amountToleranceCents !== undefined && cents !== undefined) {
      if (Math.abs(cents - Math.round(s.amount * 100)) > s.amountToleranceCents) return false;
    }
    return true;
  });
}

export interface InflowResolution {
  meaning: FinancialMeaning;
  reasons: InflowReviewReason[];
  /** The sources that matched: one when resolved, several when ambiguous. */
  sourceIds: string[];
  reason: string;
  confidence: number;
}

/** Resolves FIN-LEDGER-001's `income_candidate` hand-off into a settled meaning. */
export function resolveInflow(t: Inflow, income?: IncomeContext): InflowResolution {
  const matched = matchApprovedSources(t, income?.sources);
  if (matched.length === 1) {
    return {
      meaning: 'earned_income', reasons: [], sourceIds: [matched[0].id], confidence: 0.9,
      reason: `matches your approved income source "${matched[0].name}"`,
    };
  }
  if (matched.length > 1) {
    return {
      meaning: 'unknown_inflow',
      reasons: ['inflow_income_source_conflict'],
      sourceIds: matched.map((s) => s.id),
      confidence: 0.2,
      reason: `matches ${matched.length} approved income sources — yours to decide, not ours to guess`,
    };
  }
  return {
    meaning: 'unknown_inflow',
    reasons: [DEPOSIT.test(t.title.toLowerCase()) ? 'inflow_unmatched_deposit' : 'inflow_unknown_credit'],
    sourceIds: [],
    confidence: 0.3,
    reason: 'no approved income source explains this credit — real money, not counted as income',
  };
}

// ============================================================================
// The one shared interpretation (FIN-LEDGER-001 §E)
//
// Every surface that makes a financial claim reads THIS, never raw `t.type`.
// Before it, Flow/Analytics/Cashflow/History went through classifyTransaction()
// while Calendar/Dashboard/Budgets/Reminders/Export read the stored type, so a
// credit-card payment was a transfer on one screen and both income AND expense
// on another.
//
// Scope line: this is the ledger-level interpretation of ONE transaction.
// Whether an inflow is *earned income* — approved income sources, the
// "unknown inflow is not income" default, the replacement for the
// monthlyAverages() fallback — belongs to FIN-INCOME-001 and is NOT decided here.
// `meaning: 'income_candidate'` says exactly that: an inflow this layer will not
// call spending, with the earned-income question left open on purpose.
// ============================================================================

/** What the row IS. Ledger-level; not FIN-INCOME-001's earned-income enum. */
export type LedgerMeaning =
  | 'spending'
  | 'income_candidate'
  | 'internal_transfer'
  | 'card_payment'
  | 'refund'
  | 'reward';

/** Whether a total includes this row. Never omission-by-accident. */
export type Treatment = 'counted' | 'excluded';

export interface TransactionInterpretation {
  /** The authoritative classification — classifyTransaction(), not the stored type. */
  type: TransactionType;
  /** Which way the money moved for the account the row sits on. */
  direction: 'inflow' | 'outflow';
  meaning: LedgerMeaning;
  /**
   * FIN-INCOME-001's shared meaning — the settled answer `meaning` leaves open.
   * `income_candidate` resolves here into `earned_income` or `unknown_inflow`.
   * This, not `meaning`, is what FIN-REVIEW-002 and FIN-SETTLEMENT-003 read.
   */
  financialMeaning: FinancialMeaning;
  /** The approved source that explains an earned-income row, when one does. */
  incomeSourceId?: string;
  income: Treatment;
  expense: Treatment;
  transfer: 'none' | 'internal_leg' | 'card_settlement';
  pending: 'posted' | 'pending';
  /** Counts toward the income/spending baseline a forecast projects forward. */
  forecast: Treatment;
  /** Counts against a category budget. */
  budget: Treatment;
  /** 0..1, an explainable ladder — never a model output. */
  confidence: number;
  /** The evidence, in words, for the reason strings shown in review/diagnostics. */
  reason: string;
}

export function interpretTransaction(
  t: Inflow,
  accounts?: PaymentAccount[],
  income?: IncomeContext
): TransactionInterpretation {
  const type = classifyTransaction(t, accounts);
  const title = t.title.toLowerCase();
  const account = linkedAccount(t, accounts);
  const inflow = isPositive(t, accounts);
  const settlement = type === 'transfer' && isCardSettlement(t, accounts);
  const pending: 'posted' | 'pending' = t.pending ? 'pending' : 'posted';

  // Refund/reward only on a debt account for the inbound case, mirroring how
  // buildFlowGraph() already splits them out — so Flow and every other surface
  // put the same row in the same bucket.
  const debt = account?.type === 'credit_card' || account?.type === 'personal_loan';
  const named = { title: t.title, merchant: t.merchant, sourceCategory: t.sourceCategory };

  let meaning: LedgerMeaning;
  let confidence: number;
  let reason: string;
  if (type === 'transfer') {
    meaning = settlement ? 'card_payment' : 'internal_transfer';
    if (t.type === 'transfer') {
      confidence = 1;
      reason = 'stored type is transfer (provider-sourced); never re-derived';
    } else {
      confidence = 0.8;
      reason = settlement
        ? 'title matches a card-payment form and names a card account of yours'
        : 'title matches a transfer form';
    }
  } else if (debt && inflow && isReward(named)) {
    meaning = 'reward';
    confidence = 0.6;
    reason = 'card credit whose text reads as rewards/cashback';
  } else if (isRefund(named)) {
    meaning = 'refund';
    confidence = 0.6;
    reason = 'text reads as a refund/reimbursement/reversal';
  } else if (type === 'income') {
    meaning = 'income_candidate';
    confidence = INCOME.test(title) ? 0.7 : 0.5;
    reason = INCOME.test(title)
      ? 'title matches a deposit/payroll form; earned-income status is FIN-INCOME-001s call'
      : 'stored type is income; earned-income status is FIN-INCOME-001s call';
  } else {
    meaning = 'spending';
    confidence = 0.5;
    reason = 'no transfer, card-payment or income signal — treated as spending';
  }

  // --- FIN-INCOME-001: settle the question the ladder above left open --------
  // A transfer is provider-sourced and is NEVER re-derived (see classifyTransaction),
  // so a review record cannot turn one into income. Everything else the owner may
  // decide for themselves — that is what "or the user explicitly confirms it" means,
  // and it is why review state lives in its own document rather than in `category`.
  //
  // FIN-SETTLEMENT-003 narrows that veto by exactly one case, and this is the root
  // cause it was blocking: a row that NAMES AN EXTERNAL COUNTERPARTY. The provider
  // category `Transfer` means "money moved"; it does not mean "money moved between
  // accounts you own", and only a counterparty row can tell those two apart. Measured
  // on the real export: 261 of 284 counterparty rows ($259,206.71 across 81 distinct
  // counterparties) are provider-typed `Transfer`, so without this the owner could
  // confirm an answer and the app would keep calling it an internal transfer. Every
  // other transfer keeps the veto untouched.
  const review = t.id ? income?.reviews?.[t.id] : undefined;
  // The veto narrows by ONE more case: a transfer-typed row the OWNER has confirmed as
  // something other than earned income. Live importers collapse provider categories like
  // "Loan Payment" to type 'transfer' and store no counterparty text — measured on the
  // live ledger, all 22 Upstart rows arrive that way — so without this the owner's own
  // confirmed answer about their loan payments was silently ignored. The income golden
  // rule is untouched: earned_income on a transfer row still requires a named external
  // counterparty; no confirmation can turn a bare own-account move into income.
  const overridable =
    type !== 'transfer'
    || namesExternalCounterparty(t)
    || (review?.state === 'confirmed' && !!review.meaning && review.meaning !== 'earned_income');
  const confirmed =
    overridable && review?.state === 'confirmed' && review.meaning ? review.meaning : undefined;

  let financialMeaning: FinancialMeaning;
  let incomeSourceId: string | undefined;
  if (confirmed) {
    financialMeaning = confirmed;
    incomeSourceId = review?.incomeSourceId;
    confidence = 1;
    reason = 'you confirmed this classification';
  } else if (meaning === 'income_candidate') {
    const r = resolveInflow(t, income);
    financialMeaning = r.meaning;
    incomeSourceId = r.sourceIds.length === 1 ? r.sourceIds[0] : undefined;
    confidence = r.confidence;
    reason = r.reason;
  } else {
    financialMeaning =
      meaning === 'card_payment' ? 'card_payment'
      : meaning === 'internal_transfer' ? 'internal_transfer'
      : meaning === 'refund' ? 'refund'
      : meaning === 'reward' ? 'other_non_income_credit'
      : 'personal_expense';
  }

  // A hold is not settled history — unless the owner has said to treat it as one
  // (FIN-PENDING-001). This is the ONE place that decision lives; a consumer that
  // forgets to ask still gets 'excluded', which is why the default is the safe one.
  const held = pending === 'pending' && !income?.includePending;
  if (held) reason += '; pending hold, excluded from posted totals';

  // A CONFIRMED meaning decides its own treatment; a DERIVED one still defers to the
  // classifier's type. Without this split the override above would change the label and
  // not the number: `type` stays `transfer` forever (it is never re-derived), so
  // confirming "this money is gone" left it counted as neither income nor spending.
  // The predicates are the existing ones — `countsAsEarnedIncome` and `personalCostSign`
  // — so there is still exactly one place that decides what a meaning costs.
  // `loan_repayment` is deliberately NOT here. It was, on the reasoning that a closed
  // loan must not keep projecting payments — but that is an argument about a loan that
  // has ENDED, and it is exactly backwards for one that has not: a forecast that hides
  // the payment you are contractually committed to makes you look richer than you are.
  // Recurrence detection is what stops a finished loan projecting, not the meaning.
  const settledAsTransfer = confirmed
    ? financialMeaning === 'internal_transfer' || financialMeaning === 'card_payment'
    : type === 'transfer';

  // The ONE earned-income gate. `type === 'income'` alone used to be enough, which is
  // how refunds, reimbursements and one-off deposits became salary.
  const incomeTreatment: Treatment =
    !held && (confirmed ? true : type === 'income') && countsAsEarnedIncome(financialMeaning)
      ? 'counted'
      : 'excluded';
  const expense: Treatment =
    !held && (confirmed ? personalCostSign(financialMeaning) === 1 : type === 'expense')
      ? 'counted'
      : 'excluded';

  return {
    type,
    direction: inflow ? 'inflow' : 'outflow',
    meaning,
    financialMeaning,
    incomeSourceId,
    income: incomeTreatment,
    expense,
    transfer: type !== 'transfer' ? 'none' : settlement ? 'card_settlement' : 'internal_leg',
    pending,
    forecast: !held && !settledAsTransfer ? 'counted' : 'excluded',
    budget: expense,
    confidence,
    reason,
  };
}

/** A row is posted unless the provider says it is still a hold. */
export const isPosted = (t: Pick<Transaction, 'pending'>) => t.pending !== true;

/** Settled history only. The explicit opposite of "we forgot to filter". */
export const postedOnly = <T extends Pick<Transaction, 'pending'>>(ts: T[]): T[] =>
  ts.filter(isPosted);

/**
 * Does this row participate in totals under `policy`? Posted rows always; a hold only
 * when the owner opted in (FIN-PENDING-001).
 *
 * Use this instead of a bare `isPosted` wherever the answer should follow the owner's
 * setting. Where a module deliberately stays posted-only — pattern inference — it keeps
 * calling `isPosted` directly, so the two cases stay visibly different at the call site
 * rather than hiding behind an omitted argument.
 */
export const countsUnder = (t: Pick<Transaction, 'pending'>, policy?: FinancialPolicy): boolean =>
  isPosted(t) || !!policy?.includePending;

/**
 * Drop holds that a posted row has already replaced (FIN-PENDING-001 / #85).
 *
 * The sync deletes a hold when the charge posts, but there is a window — between the
 * bank posting it and our next run — where both rows exist. Counting both would double
 * the charge, which is only invisible today because holds count for nothing.
 *
 * The match is Plaid's OWN `pending_transaction_id`, captured at ingest as
 * `pendingTransactionId`. Deliberately NOT amount+date: a hold routinely posts at a
 * different figure (tips, fuel pre-auth), so amount matching would both miss real twins
 * and fuse unrelated same-value rows. No linkage means no drop — a visible duplicate the
 * owner can act on beats a silent guess about their money.
 *
 * Applied once where transactions enter the app, so no screen can forget it.
 */
export function withoutSupersededHolds<T extends Pick<Transaction, 'id' | 'pending' | 'pendingTransactionId'>>(
  ts: T[]
): T[] {
  const superseded = new Set<string>();
  for (const t of ts) if (t.pendingTransactionId) superseded.add(t.pendingTransactionId);
  if (!superseded.size) return ts;
  return ts.filter((t) => !(t.pending && superseded.has(t.id)));
}

type Summable = Inflow & Pick<Transaction, 'amount'>;

const sumBy = (
  ts: Summable[],
  accounts: PaymentAccount[] | undefined,
  key: 'income' | 'expense',
  income?: IncomeContext
) =>
  ts.reduce(
    (s, t) => s + (interpretTransaction(t, accounts, income)[key] === 'counted' ? Math.round(t.amount * 100) : 0),
    0
  );

/**
 * Total EARNED income, INTEGER CENTS, posted rows only. The one income total every
 * screen reads. Without an `income` context there are no approved sources, so the
 * honest answer is 0 — the app does not guess money into existence.
 */
export const sumIncomeCents = (ts: Summable[], accounts: PaymentAccount[] | undefined, income: FinancialPolicy) =>
  sumBy(ts, accounts, 'income', income);

/**
 * Total money out, INTEGER CENTS, posted rows only. The one spending total.
 *
 * `income` is optional and carries the REVIEW RECORDS, not just income sources: without
 * it this function cannot see a confirmation, so a row the owner has confirmed as
 * spending would be silently left out. Callers that hold the context pass it.
 */
export const sumExpenseCents = (ts: Summable[], accounts: PaymentAccount[] | undefined, income: FinancialPolicy) =>
  sumBy(ts, accounts, 'expense', income);

// ----------------------------------------------------------------------------
// The unknown-inflow review queue (FIN-INCOME-001 §6)
//
// The deterministic SELECTOR only. FIN-REVIEW-002 owns the workspace, the AI
// discussion and the confirmation UI, and imports this.
// ----------------------------------------------------------------------------

export interface InflowReviewItem {
  transactionId: string;
  date: string;
  /** INTEGER CENTS. Dollars exist at the render layer. */
  amountCents: number;
  accountId?: string;
  meaning: FinancialMeaning;
  state: InflowReviewState;
  reasons: InflowReviewReason[];
  /** Populated when two or more approved sources matched — the ambiguity itself. */
  candidateSourceIds: string[];
  /** Plain language, for the reason line the workspace shows. */
  reason: string;
}

type Queueable = Summable & Pick<Transaction, 'id' | 'date'>;

/**
 * Every credit the app cannot explain, newest first.
 *
 * In: `unknown_inflow` rows with no terminal review state — including ambiguous
 * two-source matches, which are a question rather than a guess.
 * Out: earned income, transfers, card payments, refunds, rewards, outflows, and
 * anything the owner has already confirmed or dismissed. Pending rows are judged
 * identically to posted ones (FIN-REVIEW-002 §2.5); the caller shows the badge.
 */
export function selectInflowReviewQueue(
  ts: Queueable[],
  accounts?: PaymentAccount[],
  income?: IncomeContext
): InflowReviewItem[] {
  const items = ts.flatMap((t): InflowReviewItem[] => {
    const state = income?.reviews?.[t.id]?.state ?? 'unreviewed';
    if (state === 'confirmed' || state === 'dismissed') return [];
    const i = interpretTransaction(t, accounts, income);
    if (i.financialMeaning !== 'unknown_inflow') return [];
    const r = resolveInflow(t, income);
    return [{
      transactionId: t.id,
      date: t.date,
      amountCents: Math.round(t.amount * 100),
      accountId: t.accountId,
      meaning: i.financialMeaning,
      state,
      reasons: r.reasons,
      candidateSourceIds: r.sourceIds,
      reason: i.reason,
    }];
  });

  // Deterministic: newest first, ties broken by id, so the same ledger always
  // produces the same queue and the tests above can assert on order.
  items.sort((a, b) => b.date.localeCompare(a.date) || a.transactionId.localeCompare(b.transactionId));

  // Counts and reason codes only — never an amount, a title or a transaction id.
  emit({
    eventName: 'InflowReview.QueueBuilt',
    traceId: newTraceId(),
    component: 'classify.selectInflowReviewQueue',
    calculationName: 'selectInflowReviewQueue',
    recordCount: items.length,
    resultStatus: items.length ? 'ok' : 'empty',
    severity: 'debug',
    metadata: {
      scannedCount: ts.length,
      approvedSourceCount: activeApprovedSources(income?.sources).length,
      reasonCounts: items.reduce<Record<string, number>>((acc, i) => {
        for (const r of i.reasons) acc[r] = (acc[r] ?? 0) + 1;
        return acc;
      }, {}),
    },
  });

  return items;
}

/** Re-exported so consumers import the taxonomy from the module that owns it. */
export { FINANCIAL_MEANINGS };
export type { FinancialMeaning, InflowReview, InflowReviewState };
