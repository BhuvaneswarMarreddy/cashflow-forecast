/**
 * Reported from the live app: "reordering is not accurate".
 *
 * Dragging worked and PERSISTED — reorderPaymentAccounts writes a sortIndex per
 * account in one batch. But getAccounts() read them back with only an isActive
 * filter and no ordering, so Firestore returned them in document order and the
 * saved arrangement was discarded on the next load. The order looked right until
 * you refreshed.
 */
import { sortByDisplayOrder } from '@/lib/accounts';
import type { PaymentAccount } from '@/types';

const a = (id: string, sortIndex?: number) => ({ id, name: id, sortIndex }) as PaymentAccount;

describe('sortByDisplayOrder', () => {
  it('honours the order the user dragged', () => {
    const rows = [a('c', 2), a('a', 0), a('b', 1)];
    expect(sortByDisplayOrder(rows).map((x) => x.id)).toEqual(['a', 'b', 'c']);
  });

  it('puts never-ordered accounts after ordered ones, keeping their own order', () => {
    // Accounts that predate the reorder feature have no sortIndex. Treating a
    // missing index as 0 would jump them to the front on every load.
    const rows = [a('legacy1'), a('legacy2'), a('placed', 0)];
    expect(sortByDisplayOrder(rows).map((x) => x.id)).toEqual(['placed', 'legacy1', 'legacy2']);
  });

  it('does not mutate the caller’s array', () => {
    const rows = [a('b', 1), a('a', 0)];
    sortByDisplayOrder(rows);
    expect(rows.map((x) => x.id)).toEqual(['b', 'a']);
  });

  it('is stable for equal indexes', () => {
    const rows = [a('x', 0), a('y', 0)];
    expect(sortByDisplayOrder(rows).map((x) => x.id)).toEqual(['x', 'y']);
  });
});
