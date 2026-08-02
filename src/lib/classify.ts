/**
 * The one transaction classifier. Rule order is load-bearing —
 * "Payroll Deposit Transfer from Savings" resolves differently under any
 * permutation, so do not reorder without a failing test.
 */

import { PaymentAccount, PaymentMethod, Transaction, TransactionType } from '@/types';

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
  t: Classifiable & Partial<Pick<Transaction, 'amount' | 'merchant' | 'sourceCategory'>>,
  accounts?: PaymentAccount[]
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

  // A hold is not settled history. Excluding it here is the ONE place that
  // decision lives; a consumer that forgets to ask still gets 'excluded'.
  const held = pending === 'pending';
  if (held) reason += '; pending hold, excluded from posted totals';

  const income: Treatment = !held && type === 'income' ? 'counted' : 'excluded';
  const expense: Treatment = !held && type === 'expense' ? 'counted' : 'excluded';

  return {
    type,
    direction: inflow ? 'inflow' : 'outflow',
    meaning,
    income,
    expense,
    transfer: type !== 'transfer' ? 'none' : settlement ? 'card_settlement' : 'internal_leg',
    pending,
    forecast: !held && type !== 'transfer' ? 'counted' : 'excluded',
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

type Summable = Classifiable & Pick<Transaction, 'amount'> &
  Partial<Pick<Transaction, 'merchant' | 'sourceCategory'>>;

const sumBy = (
  ts: Summable[],
  accounts: PaymentAccount[] | undefined,
  key: 'income' | 'expense'
) =>
  ts.reduce(
    (s, t) => s + (interpretTransaction(t, accounts)[key] === 'counted' ? Math.round(t.amount * 100) : 0),
    0
  );

/** Total money in, INTEGER CENTS, posted rows only. The one income total. */
export const sumIncomeCents = (ts: Summable[], accounts?: PaymentAccount[]) =>
  sumBy(ts, accounts, 'income');

/** Total money out, INTEGER CENTS, posted rows only. The one spending total. */
export const sumExpenseCents = (ts: Summable[], accounts?: PaymentAccount[]) =>
  sumBy(ts, accounts, 'expense');
