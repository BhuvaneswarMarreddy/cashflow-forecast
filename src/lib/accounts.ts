import { PaymentAccount, DriftObservation, DriftStatus } from '@/types';

const BIG = Number.MAX_SAFE_INTEGER;

/**
 * The number to SHOW for an account: the derived current balance when present
 * (accounts that passed through withDerivedBalances), else the opening anchor.
 * Use this everywhere a balance is displayed/summed; use `.openingBalance` only
 * when you specifically mean the anchor.
 */
export const currentOf = (a: PaymentAccount): number => a.currentBalance ?? a.openingBalance;

/**
 * True when nobody has ever asserted a starting balance for this account.
 *
 * Its derived balance is then NET MOVEMENT across the rows we hold, not a bank
 * balance. Real, defensible, and it must never be presented as the latter.
 */
export const isUnanchored = (a: PaymentAccount): boolean => !a.openingDate;

/** Stable order: sortIndex asc; undefined sorts to the end; ties broken by name. */
export function sortAccounts(accounts: PaymentAccount[]): PaymentAccount[] {
  return [...accounts].sort((x, y) => {
    const ix = x.sortIndex ?? BIG, iy = y.sortIndex ?? BIG;
    return ix !== iy ? ix - iy : x.name.localeCompare(y.name);
  });
}

/**
 * The opening anchor — or no anchor at all (#83).
 *
 * An anchor is a claim: "as of THIS date, the balance was THIS." `deriveAccountBalance`
 * believes it completely and skips every row dated before `openingDate`, on the grounds
 * that those rows are already inside `openingBalance`.
 *
 * That is only true when a human actually made the claim. Every creation site used to
 * write `parseFloat(form.balance) || 0` with `openingDate: today`, and `|| 0` collapses
 * a BLANK field and a typed `0` into the same value — so leaving the balance empty
 * asserted "$0.00, as of today", and two years of imported history silently vanished
 * behind it. The CSV importer hardcoded exactly that pair for every auto-created account.
 *
 * So the raw string decides, not the parsed number: blank means the user asserted
 * nothing and there is no anchor, which lets `openingKey` fall back to '0000-00-00' and
 * the whole history count. A typed `0` is a real claim and anchors normally.
 */
export function openingAnchor(
  raw: string | number | null | undefined,
  todayISO: string
): { openingBalance: number; openingDate?: string } {
  const trimmed = typeof raw === 'number' ? String(raw) : (raw ?? '').trim();
  const parsed = Number(trimmed);
  if (trimmed === '' || !Number.isFinite(parsed)) return { openingBalance: 0 };
  return { openingBalance: parsed, openingDate: todayISO };
}

/** New contiguous sortIndex for each id in orderedIds that exists in accounts. */
export function reindex(orderedIds: string[], accounts: PaymentAccount[]): Array<{ id: string; sortIndex: number }> {
  const known = new Set(accounts.map((a) => a.id));
  return orderedIds.filter((id) => known.has(id)).map((id, i) => ({ id, sortIndex: i }));
}

export interface DriftContext {
  includePending: boolean;
  providerCheckedAt?: string;
  source: 'user' | 'sync';
}

/**
 * Reconcile an account against a real balance. Anchor-only: any drift re-anchors
 * (openingBalance = the entered balance, openingDate = today), which resets
 * net-since-anchor to zero and makes later pre-today imports harmless.
 *
 * The observation is returned ALWAYS, including at zero drift — a clean check is
 * evidence too, and callers persist it before applying `reanchor`.
 */
export function reconcile(
  account: PaymentAccount,
  enteredCurrent: number,
  derivedCurrent: number,
  todayISO: string,
  ctx: DriftContext
): { driftCents: number; reanchor?: { openingBalance: number; openingDate: string }; observation: DriftObservation } {
  const enteredCents = Math.round(enteredCurrent * 100);
  const derivedCents = Math.round(derivedCurrent * 100);
  const driftCents = enteredCents - derivedCents;
  const observation: DriftObservation = {
    accountId: account.id,
    at: new Date().toISOString(),
    enteredCents,
    derivedCents,
    driftCents,
    includePending: ctx.includePending,
    // Omit the key entirely rather than write `undefined`: Firestore's addDoc rejects
    // undefined at ANY depth (not just top-level), and stripUndefined() in audit.ts
    // only strips the entry's OWN keys, never descending into `after`. The only
    // production caller (UserProfileContext.reconcileAccount) never passes
    // providerCheckedAt, so every write hit this and threw inside addDoc — silently,
    // because recordAudit's catch (by design) must never fail the write it observes.
    // Every drift observation was being recorded and then discarded, 100% of the time.
    ...(ctx.providerCheckedAt ? { providerCheckedAt: ctx.providerCheckedAt } : {}),
    anchored: !isUnanchored(account),
    source: ctx.source,
  };
  // Zero drift on an ANCHORED account must not move openingDate — UI-106's guarantee
  // that an unchanged balance can't silently re-date the anchor. An UNANCHORED account
  // has no anchor for that guarantee to protect: there is no earlier claim a write here
  // could disturb, and the save IS the owner's first assertion. Short-circuiting for
  // BOTH left the owner's most likely path — open ReconcileSheet, see the prefilled
  // derived figure, agree it's right, confirm — writing nothing: the account stayed
  // unanchored forever while the sheet reported success (#83 round 4a Defect 1).
  if (driftCents === 0 && !isUnanchored(account)) return { driftCents: 0, observation };
  return { driftCents, reanchor: { openingBalance: enteredCurrent, openingDate: todayISO }, observation };
}

/**
 * An unanchored account has no claim to violate, so it is never PASS.
 * Staleness is DERIVED from the sync schedule rather than a fixed hour count:
 * the overnight gap between the 19:00 and 07:00 runs is itself 12 hours, so any
 * fixed 6h/12h threshold would mark every account stale every morning.
 */
export function driftStatus(o: DriftObservation, lastScheduledSlotISO: string): DriftStatus {
  if (!o.anchored) return 'NOT_APPLICABLE';
  if (o.driftCents === 0) return 'PASS';
  if (o.providerCheckedAt && o.providerCheckedAt < lastScheduledSlotISO) return 'STALE_INPUT';
  return 'VIOLATION';
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

/** The earliest transaction date on an account, for the "net since …" caption. */
export function earliestRowDate(
  accountId: string,
  transactions: readonly { accountId?: string; date: string }[]
): string | undefined {
  let earliest: string | undefined;
  for (const t of transactions) {
    if (t.accountId !== accountId) continue;
    const day = t.date.slice(0, 10);
    if (!earliest || day < earliest) earliest = day;
  }
  return earliest;
}

/**
 * The account(s) a displayed figure actually represents (#83 Finding 1).
 *
 * Forecast's headline card switches between a combined total ('all') and one
 * account's balance depending on the dropdown. `UnanchoredNote` must count only
 * what that figure includes — passing every account regardless of selection let
 * a correctly-anchored single account show "includes 1 unanchored account"
 * borrowed from an account that isn't even part of the number on screen.
 *
 * When selectedId is 'all', the figure is a CASH TOTAL only (see calculateCurrentCash),
 * excluding credit cards and loans. This function must match that filter, so
 * `UnanchoredNote` never claims an unanchored debt account affects a cash figure
 * that excludes it.
 */
export function accountsBehindFigure(
  selectedId: string,
  accounts: readonly PaymentAccount[]
): readonly PaymentAccount[] {
  if (selectedId === 'all') return accounts.filter(isCashAccount);
  const one = accounts.find((a) => a.id === selectedId);
  return one ? [one] : [];
}

/**
 * The single-account balance caption every screen showing ONE account's balance uses:
 * "as of {date}" when anchored, else "net since {earliest row} · no starting balance
 * set" (or just the latter when there are no rows at all). Written once (#83 Finding
 * 2/3) so AccountDetailModal and History's per-account tile — both new call sites —
 * can't drift into different wording for the same account the way two separately
 * hand-rolled copies eventually would.
 */
export function balanceCaption(
  account: Pick<PaymentAccount, 'id' | 'openingDate'>,
  transactions: readonly { accountId?: string; date: string }[]
): string {
  if (account.openingDate) return `as of ${account.openingDate.slice(0, 10)}`;
  const since = earliestRowDate(account.id, transactions);
  return since ? `net since ${since} · no starting balance set` : 'no starting balance set';
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
