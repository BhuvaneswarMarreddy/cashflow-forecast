import { PaymentAccount } from '@/types';
import { sortAccounts, reindex } from '@/lib/accounts';

const a = (o: Partial<PaymentAccount> & { id: string }): PaymentAccount => ({
  name: o.id, type: 'bank_account', provider: 'chase', openingBalance: 0,
  openingDate: '2026-01-01', balance: 0, color: '#000', isActive: true, ...o,
} as PaymentAccount);

describe('sortAccounts', () => {
  it('orders by sortIndex, undefined to the end tie-broken by name', () => {
    const out = sortAccounts([
      a({ id: 'z', sortIndex: 2 }), a({ id: 'a' }), a({ id: 'm', sortIndex: 0 }), a({ id: 'b' }),
    ]);
    expect(out.map((x) => x.id)).toEqual(['m', 'z', 'a', 'b']);
  });
});

describe('reindex', () => {
  it('assigns contiguous indices in the given id order, skipping unknown ids', () => {
    const accts = [a({ id: 'a' }), a({ id: 'b' }), a({ id: 'c' })];
    expect(reindex(['c', 'a', 'b'], accts)).toEqual([
      { id: 'c', sortIndex: 0 }, { id: 'a', sortIndex: 1 }, { id: 'b', sortIndex: 2 },
    ]);
    expect(reindex(['c', 'ghost', 'a'], accts).map((x) => x.id)).toEqual(['c', 'a']);
  });
});

import { reconcile } from '@/lib/accounts';
describe('reconcile', () => {
  const bank = a({ id: 'b', type: 'bank_account', openingBalance: 1000, openingDate: '2026-02-01' });
  it('no drift → no re-anchor', () => {
    expect(reconcile(bank, 1150, 1150, '2026-03-01')).toEqual({ driftCents: 0 });
  });
  it('drift → re-anchor to the entered balance at today', () => {
    const r = reconcile(bank, 1200, 1150, '2026-03-01');
    expect(r.driftCents).toBe(5000);
    expect(r.reanchor).toEqual({ openingBalance: 1200, openingDate: '2026-03-01' });
  });
});
