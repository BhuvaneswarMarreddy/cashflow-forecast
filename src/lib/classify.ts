/**
 * The one transaction classifier. Rule order is load-bearing —
 * "Payroll Deposit Transfer from Savings" resolves differently under any
 * permutation, so do not reorder without a failing test.
 */

import { PaymentAccount, Transaction, TransactionType } from '@/types';

// A row only needs these fields to be classified, so partial/in-flight rows
// (e.g. a CSV preview row that has no id yet) can use the same code path.
type Classifiable = Pick<Transaction, 'type' | 'title'> &
  Partial<Pick<Transaction, 'accountId' | 'transferDirection'>>;

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

export function classifyTransaction(
  t: Classifiable,
  accounts?: PaymentAccount[]
): TransactionType {
  // A stored 'transfer' came from the source data (Monarch's own category column),
  // which beats guessing from a merchant string. Never re-derive it.
  if (t.type === 'transfer') return 'transfer';

  const title = t.title.toLowerCase();

  if (TRANSFER.test(title)) return 'transfer';

  // A payment landing ON a credit card is the second leg of a bank->card transfer.
  // ponytail: credit_card only, not personal_loan — widening this would silently
  // reclassify every loan payment out of expenses and inflate the runway.
  if (linkedAccount(t, accounts)?.type === 'credit_card' && CARD_PAYMENT.test(title)) {
    return 'transfer';
  }

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
  if (isDebtAccount && SIGN_PAYMENT.test(title)) return true;

  return t.type === 'income';
}
