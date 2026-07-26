import { PaymentAccount } from '@/types';

const BIG = Number.MAX_SAFE_INTEGER;

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
