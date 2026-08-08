import { PaymentAccount } from '@/types';

const BIG = Number.MAX_SAFE_INTEGER;

/**
 * The number to SHOW for an account: the derived current balance when present
 * (accounts that passed through withDerivedBalances), else the opening anchor.
 * Use this everywhere a balance is displayed/summed; use `.openingBalance` only
 * when you specifically mean the anchor.
 */
export const currentOf = (a: PaymentAccount): number => a.currentBalance ?? a.openingBalance;

/** Stable order: sortIndex asc; undefined sorts to the end; ties broken by name. */
export function sortAccounts(accounts: PaymentAccount[]): PaymentAccount[] {
  return [...accounts].sort((x, y) => {
    const ix = x.sortIndex ?? BIG, iy = y.sortIndex ?? BIG;
    return ix !== iy ? ix - iy : x.name.localeCompare(y.name);
  });
}

/** New contiguous sortIndex for each id in orderedIds that exists in accounts. */
export function reindex(orderedIds: string[], accounts: PaymentAccount[]): Array<{ id: string; sortIndex: number }> {
  const known = new Set(accounts.map((a) => a.id));
  return orderedIds.filter((id) => known.has(id)).map((id, i) => ({ id, sortIndex: i }));
}

/**
 * Reconcile an account against the user's real balance. Anchor-only: any drift
 * re-anchors (openingBalance = the entered balance, openingDate = today), which
 * resets net-since-anchor to zero and makes later pre-today imports harmless.
 */
export function reconcile(
  account: PaymentAccount, enteredCurrent: number, derivedCurrent: number, todayISO: string
): { driftCents: number; reanchor?: { openingBalance: number; openingDate: string } } {
  const driftCents = Math.round((enteredCurrent - derivedCurrent) * 100);
  if (driftCents === 0) return { driftCents: 0 };
  return { driftCents, reanchor: { openingBalance: enteredCurrent, openingDate: todayISO } };
}

/**
 * The account display order the owner dragged into place.
 *
 * `getAccounts()` reads with an isActive filter and no ordering, so Firestore
 * hands back document order. Reordering therefore persisted a sortIndex per
 * account and then appeared to be ignored — the arrangement was correct until
 * the next load, which is what "reordering is not accurate" looks like.
 *
 * A missing sortIndex sorts LAST, not first: accounts created before the feature
 * existed have none, and treating that as 0 would jump them ahead of everything
 * the owner actually placed. Array.prototype.sort is stable, so equal keys keep
 * their relative order.
 */
export function sortByDisplayOrder<T extends { sortIndex?: number }>(accounts: readonly T[]): T[] {
  const key = (a: T) => a.sortIndex ?? Number.MAX_SAFE_INTEGER;
  return [...accounts].sort((a, b) => key(a) - key(b));
}

/** Every account whose balance IS cash the owner can spend. */
export const isCashAccount = (a: PaymentAccount) =>
  a.type === 'bank_account' || a.type === 'debit_card' || a.type === 'cash';

/** Every account whose balance is money the owner OWES. */
export const isDebtAccount = (a: PaymentAccount) =>
  a.type === 'credit_card' || a.type === 'personal_loan';

/**
 * Cash minus everything owed. ONE definition, because two screens showing different
 * net-worth figures is the failure this module exists to prevent — Accounts computed
 * it inline and nothing else could reuse it.
 *
 * Balances must already be DERIVED (withDerivedBalances), so whether holds count is
 * decided upstream by the owner's policy and is not re-litigated here.
 */
export function netWorthOf(accounts: readonly PaymentAccount[]): number {
  const cash = accounts.filter(isCashAccount).reduce((s, a) => s + currentOf(a), 0);
  const debt = accounts.filter(isDebtAccount).reduce((s, a) => s + currentOf(a), 0);
  return cash - debt;
}
