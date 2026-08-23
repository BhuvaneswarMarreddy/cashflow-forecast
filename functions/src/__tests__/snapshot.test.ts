import { withDerivedBalances } from '@/lib/forecast';
import type { MappingRule } from '@/lib/mapping-rules';
import type { PaymentAccount, Transaction } from '@/types';

import { buildSnapshot, interpretLedgerRows, mapAccount, mapTransaction, type Ledger } from '../snapshot';

/**
 * The one invariant `homeSnapshot` exists to hold.
 *
 * The mobile client renders a balance and a list of signed amounts side by
 * side. If the sign it shows on a row disagrees with the effect that row had on
 * the balance, the screen contradicts itself and neither figure can be trusted.
 * Both come from `isPositive()` here — this asserts they still reconcile.
 *
 * Dates sit in the past on purpose: `deriveAccountBalance` treats anything after
 * today as forecast and excludes it.
 */
const txn = (over: Partial<Transaction>): Transaction => ({
  id: 't',
  title: 'Row',
  amount: 0,
  type: 'expense',
  category: 'other',
  paymentMethod: 'bank-transfer',
  date: '2026-02-01',
  ...over,
});

describe('snapshot mapping', () => {
  it('reconciles a cash account: opening + every mapped amount = the balance shown', () => {
    const checking: PaymentAccount = {
      id: 'chk',
      name: 'Checking',
      type: 'bank_account',
      provider: 'bank-transfer',
      color: '#000000',
      isActive: true,
      openingBalance: 1000,
      openingDate: '2026-01-01',
    };
    const transactions = [
      txn({ id: 'rent', title: 'Rent', amount: 250, type: 'expense', category: 'rent', accountId: 'chk' }),
      txn({ id: 'pay', title: 'Salary', amount: 500, type: 'income', accountId: 'chk', date: '2026-02-02' }),
    ];

    const [derived] = withDerivedBalances([checking], transactions, {});
    const rows = transactions.map((t) => mapTransaction(t, [checking]));

    expect(rows.map((r) => r.amountCents)).toEqual([-25_000, 50_000]);
    expect(mapAccount(derived).balanceCents).toBe(
      100_000 + rows.reduce((sum, r) => sum + r.amountCents, 0),
    );
  });

  it('keeps a card balance as the amount OWED, so a purchase raises it', () => {
    const card: PaymentAccount = {
      id: 'card',
      name: 'Amex',
      type: 'credit_card',
      provider: 'amex',
      color: '#000000',
      isActive: true,
      openingBalance: 100,
      openingDate: '2026-01-01',
      creditLimit: 5000,
      lastFourDigits: '1234',
    };
    const purchase = txn({ id: 'buy', title: 'Groceries', amount: 40, category: 'food', accountId: 'card' });

    const [derived] = withDerivedBalances([card], [purchase], {});
    const mapped = mapAccount(derived);

    expect(mapped.balanceCents).toBe(14_000);
    expect(mapped.availableCents).toBe(500_000 - 14_000);
    expect(mapped.kind).toBe('credit-card');
    expect(mapped.mask).toBe('1234');
  });

  it('flags an account with no opening anchor as stale rather than quoting it flatly', () => {
    const unanchored: PaymentAccount = {
      id: 'x',
      name: 'Old savings',
      type: 'bank_account',
      provider: 'bank-transfer',
      color: '#000000',
      isActive: true,
      openingBalance: 0,
    };
    expect(mapAccount(unanchored).status).toBe('stale');
  });
});

/**
 * `interpretLedgerRows` is what makes `readLedger` — and therefore every
 * callable built on it — agree with the browser's TransactionContext, which
 * applies mapping rules first and the superseded-hold guard second
 * (src/context/TransactionContext.tsx:174-181). Before this, the server read
 * raw Firestore rows and ignored both, so a rule the owner set in the browser
 * (or a hold whose posted twin had already arrived) produced different
 * figures server-side than what the owner sees on screen.
 */
describe('ledger interpretation', () => {
  // 'groceries' is not a member of ExpenseCategory in this codebase (see
  // src/types/index.ts) — 'food' is the real bucket a COSTCO rule would set.
  const foodRule: MappingRule = {
    id: 'r1',
    match: { field: 'merchant', op: 'contains', value: 'COSTCO' },
    set: { category: 'food' },
    createdAt: '2026-08-01T00:00:00.000Z',
    enabled: true,
  };

  it('applies a merchant rule to every matching row before any figure is derived', () => {
    const rows = [
      txn({ id: 't1', merchant: 'COSTCO WHSE #55', title: 'COSTCO', category: 'shopping' }),
      txn({ id: 't2', merchant: 'TRADER JOES', title: 'TJ', category: 'other' }),
    ];

    const out = interpretLedgerRows(rows, [foodRule]);

    expect(out.find((t) => t.id === 't1')?.category).toBe('food');
    // Unrelated rows pass through untouched — a rule only ever narrows.
    expect(out.find((t) => t.id === 't2')?.category).toBe('other');
  });

  it('rules then holds, the browser order: a hold is dropped, and the posted row it left behind still gets the rule', () => {
    const hold = txn({
      id: 'hold1',
      merchant: 'COSTCO WHSE #55',
      title: 'COSTCO',
      category: 'shopping',
      pending: true,
    });
    // Plaid's own linkage: the posted row names the hold it replaces.
    const posted = txn({
      id: 'posted1',
      merchant: 'COSTCO WHSE #55',
      title: 'COSTCO',
      category: 'shopping',
      pending: false,
      pendingTransactionId: 'hold1',
    });

    const out = interpretLedgerRows([hold, posted], [foodRule]);

    expect(out.map((t) => t.id)).toEqual(['posted1']);
    expect(out[0].category).toBe('food');
  });

  it('is a no-op with no rules and no holds — readLedger is safe for a user who has set neither', () => {
    const rows = [txn({ id: 't1', merchant: 'COSTCO WHSE #55', title: 'COSTCO', category: 'shopping' })];
    expect(interpretLedgerRows(rows, [])).toEqual(rows);
  });
});

/**
 * Finding 2. Cloud Functions run in UTC; the owner is in Chicago (or wherever
 * `settings.timezone` says). `buildSnapshot` never set `process.env.TZ`, so
 * `deriveAccountBalance`'s `format(new Date(), 'yyyy-MM-dd')` — and every other
 * "today" downstream — read the runtime's UTC date instead of the owner's.
 *
 * Why this test spies on `Date` construction rather than asserting a computed
 * calendar day: V8 caches its resolved local timezone the first time ANY code
 * localises a `Date` in a process, and jest's own runner does that during its
 * bootstrap — before this file's first line runs. A later `process.env.TZ =`
 * reassignment is then invisible to `new Date().toString()`/`format()` for the
 * rest of that jest worker (verified with a plain, jest-free `node -e`
 * reproduction, where the identical reassignment DOES change the calendar day
 * every time — this is a jest-process quirk, not a flaw in the fix). So instead
 * of reading a `Date`'s localised output, this asserts what actually matters
 * and IS reliably observable here: `process.env.TZ` already holds the owner's
 * zone at the moment `buildSnapshot` constructs its first `Date` — i.e. the
 * assignment happened, unconditionally, before any date work.
 */
describe('buildSnapshot — sets process.env.TZ from the owner\'s setting before any date work (Finding 2)', () => {
  const realTZ = process.env.TZ;
  afterEach(() => {
    process.env.TZ = realTZ;
  });

  const checking: PaymentAccount = {
    id: 'chk',
    name: 'Checking',
    type: 'bank_account',
    provider: 'bank-transfer',
    color: '#000000',
    isActive: true,
    openingBalance: 1000,
    openingDate: '2026-01-01',
  };

  const ledgerAt = (timezone?: string): Ledger => ({
    accounts: [checking],
    transactions: [],
    incomeSources: [],
    reviews: {},
    bills: [],
    goals: [],
    safetyThreshold: 500,
    includePending: false,
    assumedMonthlySpend: null,
    lastBankSyncAt: null,
    rules: [],
    timezone,
  });

  /** `process.env.TZ` at the instant buildSnapshot's FIRST `new Date()` fires. */
  const tzSeenByFirstDate = (ledger: Ledger): string | undefined => {
    const RealDate = global.Date;
    let seen: string | undefined;
    class SpyDate extends RealDate {
      constructor(...args: ConstructorParameters<typeof Date>) {
        super(...args);
        if (seen === undefined) seen = process.env.TZ;
      }
    }
    global.Date = SpyDate as unknown as DateConstructor;
    try {
      buildSnapshot(ledger);
    } finally {
      global.Date = RealDate;
    }
    return seen;
  };

  it('reads settings.timezone — the same field importCsv.ts reads — and it is already in effect before the first date computation', () => {
    expect(tzSeenByFirstDate(ledgerAt('Asia/Kolkata'))).toBe('Asia/Kolkata');
  });

  it('falls back to America/Chicago, the same fallback importCsv.ts uses, when no timezone is stored', () => {
    expect(tzSeenByFirstDate(ledgerAt(undefined))).toBe('America/Chicago');
  });

  it('sets it unconditionally — a warm instance carrying a previous invocation\'s zone does not survive a differently-configured owner', () => {
    process.env.TZ = 'Pacific/Auckland'; // stands in for a previous invocation's leftover zone
    expect(tzSeenByFirstDate(ledgerAt('Asia/Kolkata'))).toBe('Asia/Kolkata');
  });
});
