import { Transaction, PaymentAccount } from '@/types';
import {
  toCents, signedCents, signedRealNowCents, balanceAtEndOfDay,
  personFrom, isSelfPerson, displayPerson,
} from '@/lib/flows';

export const tx = (o: Partial<Transaction> & { id: string; amount: number }): Transaction => ({
  title: o.id, type: 'expense', category: 'other', paymentMethod: 'bank-transfer',
  date: '2026-01-15', ...o,
} as Transaction);

export const acct = (o: Partial<PaymentAccount> & { id: string; balance: number }): PaymentAccount => ({
  name: o.id, type: 'bank_account', provider: 'chase', color: '#000', isActive: true,
  // Test ergonomics: fixtures pass `balance` = the current/real balance. Anchor it at an
  // early date so the whole synthetic ledger counts as post-anchor (net from opening).
  openingBalance: o.balance, openingDate: '2000-01-01', ...o,
} as PaymentAccount);

describe('cents & balance rollback', () => {
  const bank = acct({ id: 'b1', balance: 100 });
  const card = acct({ id: 'c1', balance: 30, type: 'credit_card', provider: 'amex' });
  const accounts = [bank, card];

  it('toCents avoids float drift', () => {
    expect(toCents(19.99)).toBe(1999);
    expect(toCents(0.1 + 0.2)).toBe(30);
  });

  it('signedRealNowCents negates debt accounts', () => {
    expect(signedRealNowCents(bank)).toBe(10000);
    expect(signedRealNowCents(card)).toBe(-3000);
  });

  it('signedCents follows isPositive', () => {
    const income = tx({ id: 'i', amount: 50, type: 'income', accountId: 'b1' });
    const expense = tx({ id: 'e', amount: 20, type: 'expense', accountId: 'b1' });
    expect(signedCents(income, accounts)).toBe(5000);
    expect(signedCents(expense, accounts)).toBe(-2000);
  });

  it('balanceAtEndOfDay rolls back from the real balance', () => {
    const txns = [
      tx({ id: 'a', amount: 40, type: 'income', accountId: 'b1', date: '2026-01-10' }),
      tx({ id: 'b', amount: 15, type: 'expense', accountId: 'b1', date: '2026-01-20' }),
    ];
    // balance now 100; before the 01-20 expense it was 100 + 15 = 115
    expect(balanceAtEndOfDay(bank, txns, accounts, '2026-01-15')).toBe(11500);
    // before the 01-10 income it was 115 - 40 = 75
    expect(balanceAtEndOfDay(bank, txns, accounts, '2026-01-05')).toBe(7500);
  });
});

describe('person extraction', () => {
  it('parses the four real statement shapes', () => {
    expect(personFrom('Zelle payment to SRIDEVI GOGINENI Conf# ab12cd')).toBe('SRIDEVI GOGINENI');
    expect(personFrom('Zelle payment from LOK SUNDEEP PULUKURI 12345678')).toBe('LOK PULUKURI');
    expect(personFrom('Zelle Transfer Conf# X9Y8Z7; VENU GOPAL GUNTUPALLI')).toBe('VENU GUNTUPALLI');
    // Chase glues a BACxxxx confirmation token straight after the name ($23,300 of self rows)
    expect(personFrom('Zelle payment from BHUVANESWAR REDDY MARREDDY BACmc15udzvd')).toBe('BHUVANESWAR MARREDDY');
  });
  it('routes remittance to the Remitly node', () => {
    expect(personFrom('RMTLY* US1234 REMITLY')).toBe('REMITLY');
  });
  it('strips memo suffixes', () => {
    expect(personFrom('Zelle payment to VENU ANNA for "RENT"; conf 123')).toBe('VENU ANNA');
  });
  it('returns null on non-person text', () => {
    expect(personFrom('AMAZON MKTPL*AB12 SEATTLE')).toBeNull();
    expect(personFrom(undefined)).toBeNull();
  });
  it('detects self in all its forms', () => {
    expect(isSelfPerson('BHUVANESWAR MARREDDY')).toBe(true);
    expect(isSelfPerson('BHUVANESWAR REDDY')).toBe(true);
    expect(isSelfPerson('ME')).toBe(true);
    expect(isSelfPerson('SRIDEVI GOGINENI')).toBe(false);
  });
  it('title-cases for display', () => {
    expect(displayPerson('SRIDEVI GOGINENI')).toBe('Sridevi Gogineni');
  });
});

import { buildFlowGraph } from '@/lib/flows';

describe('buildFlowGraph', () => {
  // Distilled real-world scenario covering every stub branch.
  const bankA = acct({ id: 'A', balance: 100 });
  const bankB = acct({ id: 'B', balance: 500 });
  const cardC = acct({ id: 'C', balance: 30, type: 'credit_card', provider: 'amex' });
  const accounts = [bankA, bankB, cardC];

  const txns = [
    tx({ id: 'pay', amount: 300, type: 'income', accountId: 'A', sourceCategory: 'Paychecks', date: '2026-01-02' }),
    tx({ id: 'food', amount: 50, type: 'expense', accountId: 'A', sourceCategory: 'Groceries', date: '2026-01-03' }),
    // A -> card C payment, both legs
    tx({ id: 'payA', amount: 120, type: 'transfer', transferDirection: 'out', accountId: 'A', date: '2026-01-05' }),
    tx({ id: 'payC', amount: 120, type: 'transfer', transferDirection: 'in', accountId: 'C', date: '2026-01-05' }),
    // card purchase
    tx({ id: 'shop', amount: 100, type: 'expense', accountId: 'C', sourceCategory: 'Shopping', date: '2026-01-06' }),
    // A <-> B both directions: A->B 200, B->A 80  => net A->B 120 via hub
    tx({ id: 'ab-o', amount: 200, type: 'transfer', transferDirection: 'out', accountId: 'A', date: '2026-01-08' }),
    tx({ id: 'ab-i', amount: 200, type: 'transfer', transferDirection: 'in', accountId: 'B', date: '2026-01-08' }),
    tx({ id: 'ba-o', amount: 80, type: 'transfer', transferDirection: 'out', accountId: 'B', date: '2026-01-09' }),
    tx({ id: 'ba-i', amount: 80, type: 'transfer', transferDirection: 'in', accountId: 'A', date: '2026-01-09' }),
    // people
    tx({ id: 'zin', amount: 60, type: 'income', accountId: 'B', description: 'Zelle payment from LOK PULUKURI 123', date: '2026-01-10' }),
    tx({ id: 'zout', amount: 40, type: 'expense', accountId: 'B', description: 'Zelle payment to SRIDEVI GOGINENI Conf# x', date: '2026-01-11' }),
    // unmatched self leg
    tx({ id: 'me', amount: 25, type: 'transfer', transferDirection: 'out', accountId: 'B', description: 'Zelle payment to Me', date: '2026-01-12' }),
  ];

  const g = buildFlowGraph(txns, accounts);
  const find = (s: string, t: string) =>
    g.links.find((l) => l.source === s && l.target === t)?.cents;

  it('conserves every cent (sources === sinks)', () => {
    const ids = new Set(g.nodes.map((n) => n.id));
    for (const l of g.links) {
      expect(ids.has(l.source)).toBe(true);
      expect(ids.has(l.target)).toBe(true);
    }
    const inBy = new Map<string, number>(), outBy = new Map<string, number>();
    for (const l of g.links) {
      inBy.set(l.target, (inBy.get(l.target) ?? 0) + l.cents);
      outBy.set(l.source, (outBy.get(l.source) ?? 0) + l.cents);
    }
    // every intermediate node balances exactly
    for (const n of g.nodes) {
      const i = inBy.get(n.id) ?? 0, o = outBy.get(n.id) ?? 0;
      if (i > 0 && o > 0) expect(i).toBe(o);
    }
    const sources = g.nodes.filter((n) => !inBy.has(n.id)).reduce((s, n) => s + (outBy.get(n.id) ?? 0), 0);
    const sinks = g.nodes.filter((n) => !outBy.has(n.id)).reduce((s, n) => s + (inBy.get(n.id) ?? 0), 0);
    expect(sources).toBe(sinks);
  });

  it('routes bank<->bank through the hub as net positions', () => {
    expect(find('acct:A', 'hub')).toBe(12000);   // net A->B 120
    expect(find('hub', 'acct:B')).toBe(12000);
    expect(find('acct:A', 'acct:B')).toBeUndefined();
  });

  it('keeps bank->card payments direct with gross both ways', () => {
    const l = g.links.find((x) => x.source === 'acct:A' && x.target === 'acct:C')!;
    expect(l.cents).toBe(12000);
    expect(l.grossForwardCents).toBe(12000);
    expect(l.grossReverseCents).toBe(0);
  });

  it('reports gross both directions in the between matrix', () => {
    expect(g.between).toContainEqual({ from: 'A', to: 'B', moves: 1, cents: 20000 });
    expect(g.between).toContainEqual({ from: 'B', to: 'A', moves: 1, cents: 8000 });
  });

  it('splits people into in/out nodes and catches self', () => {
    expect(find('person-in:LOK PULUKURI', 'acct:B')).toBe(6000);
    expect(find('acct:B', 'person-out:SRIDEVI GOGINENI')).toBe(4000);
    expect(find('acct:B', 'self-ext-out')).toBe(2500);
  });

  it('computes the verified stub branches', () => {
    // A: residual = 300−50−120−200+80 = +10; closing 100 => opening 90 => plausible bank
    expect(find('opening', 'acct:A')).toBe(9000);
    expect(find('acct:A', 'held')).toBe(10000);
    // C: in 120, out 100 => residual +20; closing −30 => opening −50 => pre-export debt paid down 20
    expect(find('acct:C', 'debt-down')).toBe(2000);
    const rc = g.reconciliation.find((r) => r.accountId === 'C')!;
    expect(rc.verdict).toBe('pre-export-debt');
    expect(rc.openingCents).toBe(-5000);
  });

  it('flags impossible bank openings as missing rows', () => {
    // bankA with balance 0.50 instead: closing 50, residual +1000 → opening −950 impossible
    const poorA = [acct({ id: 'A', balance: 0.5 }), bankB, cardC];
    const g2 = buildFlowGraph(txns, poorA);
    const gap = g2.links.find((l) => l.source === 'acct:A' && l.target === 'missing-out')!;
    expect(gap.cents).toBe(950);
    expect(g2.reconciliation.find((r) => r.accountId === 'A')!.verdict).toBe('missing-rows');
  });

  it('respects the period and rolls the opening back exactly', () => {
    const g3 = buildFlowGraph(txns, accounts, { start: '2026-01-06' });
    // A's balance at end of 01-05: 100 − (−200 + 80) = 220 → opening for the sub-period
    const r = g3.reconciliation.find((x) => x.accountId === 'A')!;
    expect(r.openingCents).toBe(22000);
  });
});

import { detectRecurring, projectNetWorth } from '@/lib/flows';

describe('detectRecurring', () => {
  const accounts = [acct({ id: 'A', balance: 100 })];
  const monthly = (id: string, merchant: string, amount: number, months: number[]) =>
    months.map((m) => tx({
      id: `${id}${m}`, amount, merchant,
      date: `2026-${String(m).padStart(2, '0')}-14`, accountId: 'A',
    }));

  it('detects a stable monthly subscription and normalizes trailing store numbers', () => {
    const txns = monthly('v', 'VERIZON 800123', 49.99, [1, 2, 3, 4, 5, 6, 7]);
    const [item] = detectRecurring(txns, accounts, '2026-07-23');
    expect(item).toMatchObject({
      merchant: 'VERIZON', cadence: 'monthly', medianCents: 4999,
      monthlyCents: 4999, occurrences: 7, active: true,
    });
  });

  it('does not let leading digits be stripped from a brand', () => {
    const txns = monthly('e', '650 INDUSTRIES', 19, [4, 5, 6, 7]);
    expect(detectRecurring(txns, accounts, '2026-07-23')[0].merchant).toBe('650 INDUSTRIES');
  });

  it('rejects ad-hoc spending whose gap MEDIAN happens to look monthly', () => {
    const dates = ['2024-01-05', '2025-08-01', '2025-10-26', '2025-11-08', '2025-11-30', '2025-12-29'];
    const txns = dates.map((d, i) => tx({ id: `q${i}`, amount: 32, merchant: 'QUIKTRIP', date: d, accountId: 'A' }));
    expect(detectRecurring(txns, accounts, '2026-07-23')).toHaveLength(0);
  });

  it('dedupes same-day double charges before cadence math', () => {
    const txns = [
      tx({ id: 'p1', amount: 20, merchant: 'PERPLEXITY', date: '2026-02-14', accountId: 'A' }),
      tx({ id: 'p2', amount: 20, merchant: 'PERPLEXITY', date: '2026-02-14', accountId: 'A' }),
      tx({ id: 'p3', amount: 20, merchant: 'PERPLEXITY', date: '2026-03-14', accountId: 'A' }),
    ];
    expect(detectRecurring(txns, accounts, '2026-07-23')).toHaveLength(0); // 2 unique dates < 3
  });

  it('rejects sub-$5 artifacts and marks lapsed subscriptions inactive', () => {
    const cents = detectRecurring(monthly('w', 'WITHHOLD', 0.01, [1, 2, 3]), accounts, '2026-07-23');
    expect(cents).toHaveLength(0);
    const lapsed = detectRecurring(monthly('g', 'GYM', 26.92, [1, 2, 3]), accounts, '2026-07-23');
    expect(lapsed[0].active).toBe(false); // last seen 03-14, today 07-23
  });
});

describe('projectNetWorth', () => {
  const accounts = [acct({ id: 'A', balance: 1000 }), acct({ id: 'C', balance: 400, type: 'credit_card', provider: 'amex' })];
  // Jan..Jun 2026: +500 income, −200 expense each month; net +300/mo. July is current (ignored).
  const txns = [1, 2, 3, 4, 5, 6].flatMap((m) => [
    tx({ id: `i${m}`, amount: 500, type: 'income', accountId: 'A', date: `2026-0${m}-05` }),
    tx({ id: `e${m}`, amount: 200, type: 'expense', accountId: 'A', date: `2026-0${m}-10` }),
  ]).concat([tx({ id: 'ijul', amount: 9999, type: 'income', accountId: 'A', date: '2026-07-05' })]);

  it('averages the 6 full months before the current one', () => {
    const p = projectNetWorth(txns, accounts, '2026-07-23');
    expect(p.startCents).toBe(60000); // 1000 − 400 debt
    expect(p.monthlyRateCents).toBe(30000);
    expect(p.points).toHaveLength(13);
    expect(p.points[0]).toEqual({ month: '2026-07', cents: 60000 });
    expect(p.points[12]).toEqual({ month: '2027-07', cents: 60000 + 12 * 30000 });
  });

  it('counts unmatched person outflows (remittance) against the rate', () => {
    const withRemit = txns.concat([2, 3, 4].map((m) => tx({
      id: `r${m}`, amount: 100, type: 'transfer', transferDirection: 'out', accountId: 'A',
      description: 'RMTLY* REMITLY', date: `2026-0${m}-20`,
    })));
    const p = projectNetWorth(withRemit, accounts, '2026-07-23');
    expect(p.monthlyRateCents).toBe(30000 - 5000); // 300/mo remittance over 6 months
  });
});
