/**
 * #83 — an anchor nobody set must not delete history.
 *
 * `deriveAccountBalance` skips every row dated before `openingDate`, believing those
 * rows are already inside `openingBalance`. That is only sound when a human actually
 * claimed the balance. `parseFloat(form.balance) || 0` collapsed a BLANK field and a
 * typed `0` into the same number, so an empty field asserted "$0.00 as of today" and
 * every imported row before today silently stopped counting.
 *
 * The blank-vs-typed-zero distinction is the whole fix, so it is what these pin.
 */
import { openingAnchor } from '@/lib/accounts';
import { deriveAccountBalance } from '@/lib/forecast';
import type { PaymentAccount, Transaction } from '@/types';

const TODAY = '2026-08-08';
const POSTED_ONLY = { includePending: false } as never;

const account = (over: Partial<PaymentAccount> = {}): PaymentAccount => ({
  id: 'a1', name: 'Checking', type: 'bank_account', provider: 'chase',
  openingBalance: 0, color: '#000', isActive: true, ...over,
} as PaymentAccount);

const txn = (date: string, amount: number): Transaction => ({
  id: `t-${date}-${amount}`, accountId: 'a1', title: 'Deposit', amount,
  type: amount > 0 ? 'income' : 'expense', category: 'other',
  paymentMethod: 'chase', date: `${date}T00:00:00.000Z`,
} as Transaction);

describe('openingAnchor', () => {
  it('makes NO anchor when the balance field was left blank', () => {
    expect(openingAnchor('', TODAY)).toEqual({ openingBalance: 0 });
    expect(openingAnchor('   ', TODAY)).toEqual({ openingBalance: 0 });
    expect(openingAnchor(undefined, TODAY)).toEqual({ openingBalance: 0 });
  });

  it('anchors on a typed zero — that IS a claim', () => {
    expect(openingAnchor('0', TODAY)).toEqual({ openingBalance: 0, openingDate: TODAY });
  });

  it('anchors on a real number', () => {
    expect(openingAnchor('2500.50', TODAY)).toEqual({ openingBalance: 2500.5, openingDate: TODAY });
  });

  it('makes no anchor from unparseable input rather than guessing zero', () => {
    expect(openingAnchor('abc', TODAY)).toEqual({ openingBalance: 0 });
  });
});

describe('#83: history behind an un-set anchor', () => {
  const history = [txn('2024-01-15', 500), txn('2024-06-20', 300), txn('2025-03-01', 200)];

  it('counts the full history when no anchor was ever set', () => {
    // The regression: this returned 0, because every row predated today's stamp.
    expect(deriveAccountBalance(account(), history, POSTED_ONLY)).toBe(1000);
  });

  it('still excludes pre-anchor rows when a human DID set the anchor', () => {
    const anchored = account({ openingBalance: 5000, openingDate: '2025-01-01' });
    // Only the 2025-03-01 row is after the anchor; the 2024 rows are inside the 5000.
    expect(deriveAccountBalance(anchored, history, POSTED_ONLY)).toBe(5200);
  });

  it('an auto-created account carries no anchor at all', () => {
    // CSVImportModal's shape: nothing was claimed, so nothing may be excluded.
    const autoCreated = openingAnchor(undefined, TODAY);
    expect(autoCreated.openingDate).toBeUndefined();
    expect(deriveAccountBalance(account(autoCreated), history, POSTED_ONLY)).toBe(1000);
  });
});
