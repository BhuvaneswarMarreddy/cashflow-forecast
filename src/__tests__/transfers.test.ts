import { matchTransfers } from '@/lib/transfers';
import { PaymentAccount, Transaction } from '@/types';

const bank = (id: string): PaymentAccount => ({
  id, name: id, type: 'bank_account', provider: 'chase', openingBalance: 0, openingDate: '2000-01-01', color: '#000', isActive: true,
});
const card = (id: string): PaymentAccount => ({
  id, name: id, type: 'credit_card', provider: 'visa', openingBalance: 0, openingDate: '2000-01-01', color: '#000', isActive: true,
});
const leg = (o: Partial<Transaction>): Transaction => ({
  id: Math.random().toString(), title: '', amount: 0, type: 'transfer',
  category: 'other', paymentMethod: 'chase', date: '2026-06-28', ...o,
});

describe('matchTransfers', () => {
  const accounts = [bank('bofa'), card('visa'), bank('chase')];

  test('pairs the two legs of one movement (bank -> card) into a net-zero pair', () => {
    const txns = [
      leg({ accountId: 'bofa', amount: 700, transferDirection: 'out', title: 'Payment to Visa' }),
      leg({ accountId: 'visa', amount: 700, transferDirection: 'in', title: 'Payment from BofA' }),
    ];
    const m = matchTransfers(txns, accounts);
    expect(m.pairs).toHaveLength(1);
    expect(m.pairs[0].fromAccountId).toBe('bofa');
    expect(m.pairs[0].toAccountId).toBe('visa');
    expect(m.unmatchedOut).toHaveLength(0);
    expect(m.unmatchedIn).toHaveLength(0);
  });

  test('a leg whose counterpart account is not imported stays UNMATCHED', () => {
    // Money left BofA to an external account that was never imported — only one leg exists.
    const txns = [leg({ accountId: 'bofa', amount: 500, transferDirection: 'out', title: 'Zelle to landlord' })];
    const m = matchTransfers(txns, accounts);
    expect(m.pairs).toHaveLength(0);
    expect(m.unmatchedOut).toHaveLength(1);
  });

  test('does not pair two legs on the same account, or mismatched amounts', () => {
    const txns = [
      leg({ accountId: 'bofa', amount: 500, transferDirection: 'out' }),
      leg({ accountId: 'bofa', amount: 500, transferDirection: 'in' }),   // same account
      leg({ accountId: 'visa', amount: 499, transferDirection: 'in' }),    // wrong amount
    ];
    const m = matchTransfers(txns, accounts);
    expect(m.pairs).toHaveLength(0);
  });

  test('matches within the date window but not outside it', () => {
    const near = [
      leg({ accountId: 'bofa', amount: 200, transferDirection: 'out', date: '2026-06-28' }),
      leg({ accountId: 'visa', amount: 200, transferDirection: 'in', date: '2026-06-30' }),
    ];
    expect(matchTransfers(near, accounts).pairs).toHaveLength(1);

    const far = [
      leg({ accountId: 'bofa', amount: 200, transferDirection: 'out', date: '2026-06-01' }),
      leg({ accountId: 'visa', amount: 200, transferDirection: 'in', date: '2026-06-30' }),
    ];
    expect(matchTransfers(far, accounts).pairs).toHaveLength(0);
  });

  test('real income and expenses are never treated as transfer legs', () => {
    const txns = [
      leg({ accountId: 'bofa', amount: 3000, type: 'income', title: 'Paycheck' }),
      leg({ accountId: 'visa', amount: 80, type: 'expense', title: 'Home Depot' }),
    ];
    const m = matchTransfers(txns, accounts);
    expect(m.pairs).toHaveLength(0);
    expect(m.unmatchedOut).toHaveLength(0);
    expect(m.unmatchedIn).toHaveLength(0);
  });
});

describe('matchTransfers is deterministic (#168)', () => {
  // The traced ledger from #168: four $2,000 legs. A should take Q (1 day) and leave P for B.
  const accounts = [bank('chk'), bank('biz'), bank('sav'), bank('brk')];
  const A = leg({ id: 'A', accountId: 'chk', amount: 2000, transferDirection: 'out', date: '2026-03-01' });
  const B = leg({ id: 'B', accountId: 'biz', amount: 2000, transferDirection: 'out', date: '2026-03-05' });
  const P = leg({ id: 'P', accountId: 'sav', amount: 2000, transferDirection: 'in', date: '2026-03-03' });
  const Q = leg({ id: 'Q', accountId: 'brk', amount: 2000, transferDirection: 'in', date: '2026-02-28' });
  const summary = (txns: Transaction[]) => {
    const m = matchTransfers(txns, accounts);
    return { pairs: m.pairs.map((p) => `${p.out.id}-${p.inbound.id}`).sort(), matchedTotal: m.matchedTotal };
  };

  test('the same ledger matched $2,000 or $4,000 depending on array order — now always the nearest pairing', () => {
    const expected = { pairs: ['A-Q', 'B-P'], matchedTotal: 4000 };
    for (const order of [[A, B, P, Q], [A, B, Q, P], [Q, P, B, A], [P, A, Q, B]]) {
      expect(summary(order)).toEqual(expected);
    }
  });

  test('the paired-delete partner never changes with Firestore order', () => {
    for (const order of [[A, B, P, Q], [Q, P, B, A]]) {
      expect(pairedLegId('A', order, accounts)).toBe('Q');
      expect(pairedLegId('P', order, accounts)).toBe('B');
    }
  });

  test('an equal-distance tie goes to the earlier leg, then the lower id — never to array order', () => {
    const out = leg({ id: 'o', accountId: 'chk', amount: 50, transferDirection: 'out', date: '2026-03-10' });
    const early = leg({ id: 'z-early', accountId: 'sav', amount: 50, transferDirection: 'in', date: '2026-03-09' });
    const late = leg({ id: 'a-late', accountId: 'brk', amount: 50, transferDirection: 'in', date: '2026-03-11' });
    expect(pairedLegId('o', [out, late, early], accounts)).toBe('z-early');
    expect(pairedLegId('o', [out, early, late], accounts)).toBe('z-early');
  });

  test('a one-cent gap never pairs, at any magnitude (float tolerance flipped at $2,000 vs $2,500)', () => {
    for (const dollars of [10, 100, 500, 1000, 2000, 2500, 5000]) {
      const txns = [
        leg({ id: 'o', accountId: 'chk', amount: dollars, transferDirection: 'out' }),
        leg({ id: 'i', accountId: 'sav', amount: Math.round((dollars + 0.01) * 100) / 100, transferDirection: 'in' }),
      ];
      expect([dollars, matchTransfers(txns, accounts).pairs.length]).toEqual([dollars, 0]);
    }
  });

  test('float noise in stored dollars still pairs the same cents', () => {
    const txns = [
      leg({ id: 'o', accountId: 'chk', amount: 0.1 + 0.2, transferDirection: 'out' }),
      leg({ id: 'i', accountId: 'sav', amount: 0.3, transferDirection: 'in' }),
    ];
    expect(matchTransfers(txns, accounts).pairs).toHaveLength(1);
  });
});

import { pairedLegId } from '@/lib/transfers';
describe('pairedLegId', () => {
  const accounts = [bank('bofa'), card('visa')];
  test('returns the counterpart leg of a matched transfer, null otherwise', () => {
    const out = leg({ id: 'out1', accountId: 'bofa', amount: 700, transferDirection: 'out' });
    const inn = leg({ id: 'in1', accountId: 'visa', amount: 700, transferDirection: 'in' });
    const spend = leg({ id: 'buy', accountId: 'visa', amount: 20, type: 'expense', transferDirection: undefined });
    const txns = [out, inn, spend];
    expect(pairedLegId('out1', txns, accounts)).toBe('in1');
    expect(pairedLegId('in1', txns, accounts)).toBe('out1');
    expect(pairedLegId('buy', txns, accounts)).toBeNull();
  });
});
