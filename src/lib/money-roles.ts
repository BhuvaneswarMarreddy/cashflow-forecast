/**
 * MODEL-004 (#45) — the six roles every total in the app rolls up to.
 *
 *   Earned · Spent · Saved · Invested · Transferred · Reimbursed
 *
 * The engine already knows these distinctions; the screens do not speak them, so
 * a settlement number and a spending number look alike and "spending" inflates
 * whenever money merely moves. This layer names the roles once so every surface
 * can group by the same six words.
 *
 * PURE MAPPING, and deliberately so. Nothing here re-derives a classification —
 * it consumes `financialMeaning` from `interpretTransaction()` exactly as
 * `flow-lanes.ts` does. A second opinion about what a row means would just be a
 * new way for two screens to disagree, which is the failure this exists to end.
 *
 * It also does NOT re-litigate the owner's decisions encoded in the meanings.
 * `loan_repayment` and `chit_fund_contribution` count as spending because the
 * owner said so — "even loan payment is also spending" — on the grounds that in
 * a cash-flow app the money leaving each month is the thing to plan around. Both
 * therefore roll up to Spent here, not Transferred, however tempting the
 * balance-sheet argument is.
 */

import { FINANCIAL_MEANINGS, type FinancialMeaning } from '@/types';

export const MONEY_ROLES = [
  'earned',
  'spent',
  'saved',
  'invested',
  'transferred',
  'reimbursed',
] as const;

export type MoneyRole = (typeof MONEY_ROLES)[number];

/** Plain words for a screen. No jargon — a persona review flagged every term the app invented. */
export const ROLE_LABELS: Record<MoneyRole, string> = {
  earned: 'Earned',
  spent: 'Spent',
  saved: 'Saved',
  invested: 'Invested',
  transferred: 'Moved',
  reimbursed: 'Paid back to you',
};

/**
 * One line explaining what the role counts, in the user's terms rather than the
 * ledger's. Screens should render these instead of writing their own.
 */
export const ROLE_BLURBS: Record<MoneyRole, string> = {
  earned: 'Money that came in as pay',
  spent: 'Money that is gone',
  saved: 'Money you set aside',
  invested: 'Money you put to work',
  transferred: 'Money that moved without being spent',
  reimbursed: 'Money you spent and got back',
};

/**
 * The mapping. Every meaning lands in exactly one role, and the exhaustiveness
 * test in money-roles.test.ts fails the build if a new meaning is added without
 * one — silence here would let a new value fall into "spending" by default,
 * which is the direction that misleads.
 */
const ROLE_OF: Record<FinancialMeaning, MoneyRole> = {
  // --- Spent: money that is gone -------------------------------------------
  personal_expense: 'spent',
  shared_expense: 'spent',
  reimbursable_expense: 'spent', // the claim back arrives separately, as reimbursed
  business_expense: 'spent',
  subscription: 'spent',
  recurring_bill: 'spent',
  one_time_expense: 'spent',
  // Owner's call, recorded in types/index.ts: the principal is not consumption,
  // but the money leaves every month and that is what a cash-flow app plans for.
  loan_repayment: 'spent',
  chit_fund_contribution: 'spent',

  // --- Transferred: money that moved, without being earned or spent ---------
  internal_transfer: 'transferred',
  // Settling a card is not buying anything; the purchases were spending when
  // they happened. This is the Aug-2026 rule and it is not re-opened here.
  card_payment: 'transferred',
  // Borrowing raises cash and a liability together — never income.
  loan_proceeds: 'transferred',
  // Treated like loan_proceeds by the model: real money, never income.
  chit_fund_payout: 'transferred',
  // Selling converts an asset into cash; net worth is unchanged.
  sale_proceeds: 'transferred',
  // Money arriving from a person. Kept out of Earned deliberately — a gift is
  // not pay, and counting it as income would inflate the figure that drives
  // runway and budgets.
  gift_or_personal_transfer: 'transferred',

  // --- Earned ---------------------------------------------------------------
  earned_income: 'earned',

  // --- Reimbursed: money you already spent, coming back ---------------------
  refund: 'reimbursed',
  shared_expense_reimbursement: 'reimbursed',
  receivable_repayment: 'reimbursed',

  // --- Not yet answerable ---------------------------------------------------
  // Both are inflows the owner has not classified. They are NOT earned: calling
  // an unknown credit income is exactly how income inflates.
  other_non_income_credit: 'transferred',
  unknown_inflow: 'transferred',
};

export function roleOf(meaning: FinancialMeaning): MoneyRole {
  return ROLE_OF[meaning];
}

/** Every meaning that rolls up to a role — the inverse, for filters and legends. */
export function meaningsInRole(role: MoneyRole): FinancialMeaning[] {
  return FINANCIAL_MEANINGS.filter((m) => ROLE_OF[m] === role);
}

/**
 * The roles no meaning can currently reach, and therefore the roles a screen
 * must not present as a category with a number beside it.
 *
 * `saved` and `invested` are in the vocabulary because they are real things
 * people do with money, but the data model cannot yet see either: there is no
 * savings or investment account type (`AccountType` is credit_card | debit_card
 * | bank_account | cash | personal_loan), so a transfer into savings is
 * indistinguishable from any other move between your own accounts.
 *
 * Naming that here, and testing it, is the honest alternative to inventing a
 * detector — the same choice `chit_fund_payout` documents for itself.
 */
export function unreachableRoles(): MoneyRole[] {
  return MONEY_ROLES.filter((r) => meaningsInRole(r).length === 0);
}

export interface RoleTotals {
  earned: number;
  spent: number;
  saved: number;
  invested: number;
  transferred: number;
  reimbursed: number;
}

const EMPTY: RoleTotals = {
  earned: 0, spent: 0, saved: 0, invested: 0, transferred: 0, reimbursed: 0,
};

/**
 * Rolls interpreted rows up to the six totals.
 *
 * Takes `{ meaning, amount }` rather than transactions so it cannot be tempted
 * into classifying anything: the caller has already asked
 * `interpretTransaction()`, and this only adds up.
 */
export function totalsByRole(
  rows: ReadonlyArray<{ meaning: FinancialMeaning; amount: number }>
): RoleTotals {
  const totals: RoleTotals = { ...EMPTY };
  for (const row of rows) totals[roleOf(row.meaning)] += row.amount;
  return totals;
}
