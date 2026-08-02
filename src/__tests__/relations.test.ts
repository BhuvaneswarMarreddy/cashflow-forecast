/**
 * FIN-RELATION-001 §11.1 — the link model (R1–R16).
 *
 * Every fixture here is INVENTED. Demo ids, demo merchants, round invented amounts.
 * No production value, provider id, account number or real description appears.
 *
 * The anchor fixture is the sanitized combined refund from
 * docs/features/REFUNDS-RETURNS-AND-DUPLICATES.md §11.3:
 *   demo-purchase-a $1,100.00 + demo-purchase-b $100.00 -> demo-refund-ab $1,200.00
 *   110000 + 10000 === 120000, two allocations.
 */

import {
  LINK_TYPES,
  LinkType,
  TransactionLink,
  TxRef,
  buildLink,
  buildLinkId,
  canTransition,
  confirmedAllocatedAgainstTarget,
  confirmedAllocatedFromSource,
  linkIndex,
  orderSymmetricPair,
  toTxRef,
  validateLink,
} from '@/lib/relations';
import { Transaction } from '@/types';

const V = 'refund-match-v1';
const NOW = '2026-08-02T10:00:00.000Z';

const tx = (over: Partial<Transaction> = {}): Transaction => ({
  id: 'demo-tx',
  title: 'Demo Row',
  amount: 10,
  type: 'expense',
  category: 'shopping',
  paymentMethod: 'visa',
  accountId: 'demo-card-9021',
  date: '2026-07-12',
  ...over,
});

const PURCHASE_A = tx({ id: 'demo-purchase-a', title: 'Demo Amazon Lens', merchant: 'DEMO AMAZON', amount: 1100, date: '2026-07-12' });
const PURCHASE_B = tx({ id: 'demo-purchase-b', title: 'Demo Amazon Filter', merchant: 'DEMO AMAZON', amount: 100, date: '2026-07-14' });
const COMBINED_CREDIT = tx({ id: 'demo-refund-ab', title: 'Demo Amazon Refund', merchant: 'DEMO AMAZON', amount: 1200, type: 'income', date: '2026-07-31' });

const refs = (...ts: Transaction[]): TxRef[] => ts.map(toTxRef);

/** A confirmed link, straight from the builder, or an exception with the failing rule. */
function mustBuild(
  input: Parameters<typeof buildLink>[0],
  ctx: Parameters<typeof buildLink>[1]
): TransactionLink {
  const r = buildLink(input, ctx);
  if (!r.ok) throw new Error(`expected a valid link, got ${r.ruleId}`);
  return r.link;
}

const confirmed = (
  source: string,
  target: string,
  cents: number,
  linkType: LinkType = 'refund_of'
): TransactionLink => ({
  id: buildLinkId(linkType, source, target),
  linkType,
  sourceTransactionId: source,
  targetTransactionId: target,
  allocatedAmountCents: cents,
  status: 'confirmed',
  algorithmVersion: V,
  confirmedAt: NOW,
  confirmedBy: 'user',
  createdAt: NOW,
  updatedAt: NOW,
});

describe('R1 one-to-one: one credit fully refunds one purchase', () => {
  it('stores one link whose allocation equals both rows', () => {
    const purchase = tx({ id: 'demo-purchase-c', amount: 45 });
    const credit = tx({ id: 'demo-refund-c', amount: 45, type: 'income' });

    const link = mustBuild(
      {
        linkType: 'refund_of',
        sourceTransactionId: credit.id,
        targetTransactionId: purchase.id,
        allocatedAmountCents: 4500,
        status: 'confirmed',
        confirmedAt: NOW,
        confirmedBy: 'user',
        algorithmVersion: V,
      },
      { transactions: refs(purchase, credit) }
    );

    expect(link.id).toBe('refund_of~demo-refund-c~demo-purchase-c');
    expect(link.allocatedAmountCents).toBe(4500);
    expect(confirmedAllocatedAgainstTarget([link], purchase.id)).toBe(toTxRef(purchase).amountCents);
    expect(confirmedAllocatedFromSource([link], credit.id)).toBe(toTxRef(credit).amountCents);
  });
});

describe('R2 one-to-many: the sanitized combined refund', () => {
  it('allocates $1,200.00 across $1,100.00 + $100.00 as two links summing exactly', () => {
    const ctx = { transactions: refs(PURCHASE_A, PURCHASE_B, COMBINED_CREDIT) };

    const a = mustBuild(
      { linkType: 'refund_of', sourceTransactionId: COMBINED_CREDIT.id, targetTransactionId: PURCHASE_A.id, allocatedAmountCents: 110000, status: 'confirmed', confirmedAt: NOW, confirmedBy: 'user', algorithmVersion: V },
      ctx
    );
    const b = mustBuild(
      { linkType: 'refund_of', sourceTransactionId: COMBINED_CREDIT.id, targetTransactionId: PURCHASE_B.id, allocatedAmountCents: 10000, status: 'confirmed', confirmedAt: NOW, confirmedBy: 'user', algorithmVersion: V },
      { ...ctx, links: [a] }
    );

    const links = [a, b];
    expect(links).toHaveLength(2);
    // Hand-computed truth, integer cents.
    expect(110000 + 10000).toBe(120000);
    expect(confirmedAllocatedFromSource(links, COMBINED_CREDIT.id)).toBe(120000);
    expect(confirmedAllocatedFromSource(links, COMBINED_CREDIT.id)).toBe(toTxRef(COMBINED_CREDIT).amountCents);
    expect(confirmedAllocatedAgainstTarget(links, PURCHASE_A.id)).toBe(110000);
    expect(confirmedAllocatedAgainstTarget(links, PURCHASE_B.id)).toBe(10000);
  });
});

describe('R3 many-to-one: three credits against one purchase', () => {
  it('stores three links whose sum stays within the purchase', () => {
    const purchase = tx({ id: 'demo-purchase-d', amount: 300 });
    const credits = [
      tx({ id: 'demo-refund-d1', amount: 100, type: 'income' }),
      tx({ id: 'demo-refund-d2', amount: 100, type: 'income' }),
      tx({ id: 'demo-refund-d3', amount: 50, type: 'income' }),
    ];
    const ctx = { transactions: refs(purchase, ...credits) };

    const links: TransactionLink[] = [];
    for (const [i, cents] of [10000, 10000, 5000].entries()) {
      links.push(
        mustBuild(
          { linkType: 'partial_refund_of', sourceTransactionId: credits[i].id, targetTransactionId: purchase.id, allocatedAmountCents: cents, status: 'confirmed', confirmedAt: NOW, confirmedBy: 'user', algorithmVersion: V },
          { ...ctx, links: [...links] }
        )
      );
    }

    expect(links).toHaveLength(3);
    expect(confirmedAllocatedAgainstTarget(links, purchase.id)).toBe(25000);
    expect(confirmedAllocatedAgainstTarget(links, purchase.id)).toBeLessThanOrEqual(30000);
  });
});

describe('R4 partial allocation leaves the remainder unrefunded', () => {
  it('stores partial_refund_of at 90000 against an 110000 purchase', () => {
    const credit = tx({ id: 'demo-refund-partial', amount: 900, type: 'income' });
    const link = mustBuild(
      { linkType: 'partial_refund_of', sourceTransactionId: credit.id, targetTransactionId: PURCHASE_A.id, allocatedAmountCents: 90000, status: 'confirmed', confirmedAt: NOW, confirmedBy: 'user', algorithmVersion: V },
      { transactions: refs(PURCHASE_A, credit) }
    );

    expect(link.linkType).toBe('partial_refund_of');
    expect(link.allocatedAmountCents).toBe(90000);
    expect(toTxRef(PURCHASE_A).amountCents - confirmedAllocatedAgainstTarget([link], PURCHASE_A.id)).toBe(20000);
  });
});

describe('R5 integer cents only', () => {
  it('rejects 41.2 and accepts 4120', () => {
    const purchase = tx({ id: 'demo-purchase-e', amount: 64.2 });
    const credit = tx({ id: 'demo-refund-e', amount: 64.2, type: 'income' });
    const ctx = { transactions: refs(purchase, credit) };
    const draft = { linkType: 'refund_of' as const, sourceTransactionId: credit.id, targetTransactionId: purchase.id, status: 'suggested' as const, algorithmVersion: V };

    expect(validateLink({ ...draft, allocatedAmountCents: 41.2 }, ctx)).toEqual({ ok: false, ruleId: 'V1' });
    expect(validateLink({ ...draft, allocatedAmountCents: 4120 }, ctx)).toEqual({ ok: true });

    const built = buildLink({ ...draft, allocatedAmountCents: 41.2 }, ctx);
    expect(built.ok).toBe(false);
  });
});

describe('R6 Number.isInteger guards', () => {
  it.each([NaN, Infinity, -Infinity, -1, 0, 0.5, -0.01])('rejects %p', (cents) => {
    const purchase = tx({ id: 'demo-purchase-f', amount: 50 });
    const credit = tx({ id: 'demo-refund-f', amount: 50, type: 'income' });
    expect(
      validateLink(
        { linkType: 'refund_of', sourceTransactionId: credit.id, targetTransactionId: purchase.id, allocatedAmountCents: cents, status: 'suggested', algorithmVersion: V },
        { transactions: refs(purchase, credit) }
      )
    ).toEqual({ ok: false, ruleId: 'V1' });
  });
});

describe('R7 direction convention for symmetric relations', () => {
  const earlier = { id: 'demo-charge-early', date: '2026-07-10' };
  const later = { id: 'demo-charge-late', date: '2026-07-11' };

  it('points later -> earlier regardless of discovery order', () => {
    expect(orderSymmetricPair(earlier, later)).toEqual({
      sourceTransactionId: 'demo-charge-late',
      targetTransactionId: 'demo-charge-early',
    });
    expect(orderSymmetricPair(later, earlier)).toEqual(orderSymmetricPair(earlier, later));
  });

  it('breaks a same-date tie on the lexicographically greater id, both orders', () => {
    const a = { id: 'demo-charge-aaa', date: '2026-07-10' };
    const b = { id: 'demo-charge-bbb', date: '2026-07-10' };
    expect(orderSymmetricPair(a, b)).toEqual({
      sourceTransactionId: 'demo-charge-bbb',
      targetTransactionId: 'demo-charge-aaa',
    });
    expect(orderSymmetricPair(b, a)).toEqual(orderSymmetricPair(a, b));
  });
});

describe('R8 duplicate-link idempotency', () => {
  it('proposing the same relation twice yields one id, not two documents', () => {
    const ctx = { transactions: refs(PURCHASE_A, COMBINED_CREDIT) };
    const input = { linkType: 'refund_of' as const, sourceTransactionId: COMBINED_CREDIT.id, targetTransactionId: PURCHASE_A.id, allocatedAmountCents: 110000, status: 'suggested' as const, algorithmVersion: V };

    const first = mustBuild(input, ctx);
    const second = mustBuild(input, { ...ctx, links: [first] });

    expect(second.id).toBe(first.id);
    expect(new Set([first.id, second.id]).size).toBe(1);
  });
});

describe('R9 self-link rejection, every link type', () => {
  it.each(LINK_TYPES)('rejects a %s whose source is its target', (linkType) => {
    const self = tx({ id: 'demo-self-row', amount: 20 });
    expect(
      validateLink(
        { linkType, sourceTransactionId: self.id, targetTransactionId: self.id, allocatedAmountCents: 2000, status: 'suggested', algorithmVersion: V },
        { transactions: refs(self) }
      )
    ).toEqual({ ok: false, ruleId: 'V2' });
  });
});

describe('R10 the id builder never emits an ambiguous id', () => {
  it('throws when a transaction id contains the separator', () => {
    expect(() => buildLinkId('refund_of', 'demo~odd', 'demo-purchase-a')).toThrow(/~/);
    expect(() => buildLinkId('refund_of', 'demo-refund-ab', 'demo~odd')).toThrow(/~/);
    expect(buildLinkId('refund_of', 'demo-refund-ab', 'demo-purchase-a')).toBe('refund_of~demo-refund-ab~demo-purchase-a');
  });
});

describe('R11 over-allocation on the purchase side', () => {
  const purchase = tx({ id: 'demo-purchase-g', amount: 100 });
  const creditOne = tx({ id: 'demo-refund-g1', amount: 100, type: 'income' });
  const creditTwo = tx({ id: 'demo-refund-g2', amount: 100, type: 'income' });
  const existing = [confirmed(creditOne.id, purchase.id, 10000)];
  const draft = {
    linkType: 'refund_of' as const,
    sourceTransactionId: creditTwo.id,
    targetTransactionId: purchase.id,
    allocatedAmountCents: 10000,
    status: 'confirmed' as const,
    confirmedAt: NOW,
    confirmedBy: 'user' as const,
    algorithmVersion: V,
  };

  it('is rejected without an explicit over_refunded state', () => {
    expect(
      validateLink(draft, { transactions: refs(purchase, creditOne, creditTwo), links: existing })
    ).toEqual({ ok: false, ruleId: 'V5' });
  });

  it('is accepted with it, and is never clamped', () => {
    const r = buildLink(draft, { transactions: refs(purchase, creditOne, creditTwo), links: existing, allow: ['over_refunded'] });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.link.allocatedAmountCents).toBe(10000);
    expect(confirmedAllocatedAgainstTarget([...existing, ...(r.ok ? [r.link] : [])], purchase.id)).toBe(20000);
  });
});

describe('R12 over-allocation on the credit side', () => {
  const credit = tx({ id: 'demo-refund-h', amount: 100, type: 'income' });
  const purchaseOne = tx({ id: 'demo-purchase-h1', amount: 100 });
  const purchaseTwo = tx({ id: 'demo-purchase-h2', amount: 100 });
  const existing = [confirmed(credit.id, purchaseOne.id, 10000)];
  const draft = {
    linkType: 'refund_of' as const,
    sourceTransactionId: credit.id,
    targetTransactionId: purchaseTwo.id,
    allocatedAmountCents: 10000,
    status: 'confirmed' as const,
    confirmedAt: NOW,
    confirmedBy: 'user' as const,
    algorithmVersion: V,
  };

  it('is rejected without an explicit over_allocated_credit state', () => {
    expect(
      validateLink(draft, { transactions: refs(credit, purchaseOne, purchaseTwo), links: existing })
    ).toEqual({ ok: false, ruleId: 'V4' });
  });

  it('is accepted with it', () => {
    const r = buildLink(draft, { transactions: refs(credit, purchaseOne, purchaseTwo), links: existing, allow: ['over_allocated_credit'] });
    expect(r.ok).toBe(true);
  });
});

describe('R13 under-allocation is allowed', () => {
  it('produces no warning, no padding and no phantom link', () => {
    const credit = tx({ id: 'demo-refund-i', amount: 900, type: 'income' });
    const r = buildLink(
      { linkType: 'partial_refund_of', sourceTransactionId: credit.id, targetTransactionId: PURCHASE_A.id, allocatedAmountCents: 90000, status: 'confirmed', confirmedAt: NOW, confirmedBy: 'user', algorithmVersion: V },
      { transactions: refs(PURCHASE_A, credit) }
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.link.allocatedAmountCents).toBe(90000);
    expect(Object.keys(r.link)).not.toContain('warning');
    expect(linkIndex([r.link]).get(PURCHASE_A.id)).toHaveLength(1);
  });
});

describe('R14 raw transactions are never modified', () => {
  it('leaves the transaction document byte-identical across create -> confirm -> supersede -> reject', () => {
    const purchase = Object.freeze(tx({ id: 'demo-purchase-j', amount: 100 }));
    const credit = Object.freeze(tx({ id: 'demo-refund-j', amount: 100, type: 'income' }));
    const before = JSON.stringify([purchase, credit]);
    const ctx = { transactions: refs(purchase, credit) };

    const created = mustBuild(
      { linkType: 'refund_of', sourceTransactionId: credit.id, targetTransactionId: purchase.id, allocatedAmountCents: 10000, status: 'suggested', algorithmVersion: V },
      ctx
    );
    const confirmedLink = mustBuild(
      { ...created, status: 'confirmed', confirmedAt: NOW, confirmedBy: 'user' },
      ctx
    );
    const replacement = mustBuild(
      { linkType: 'partial_refund_of', sourceTransactionId: credit.id, targetTransactionId: purchase.id, allocatedAmountCents: 5000, status: 'confirmed', confirmedAt: NOW, confirmedBy: 'user', algorithmVersion: V },
      ctx
    );
    mustBuild(
      { ...confirmedLink, status: 'superseded', confirmedAt: undefined, confirmedBy: undefined, supersededByLinkId: replacement.id },
      { ...ctx, links: [replacement] }
    );
    mustBuild({ ...replacement, status: 'rejected', confirmedAt: undefined, confirmedBy: undefined }, ctx);

    expect(JSON.stringify([purchase, credit])).toBe(before);
  });
});

describe('R15 status transitions', () => {
  const legal: [string, string][] = [
    ['suggested', 'confirmed'], ['suggested', 'rejected'], ['suggested', 'provisional'],
    ['provisional', 'confirmed'], ['provisional', 'rejected'],
    ['confirmed', 'superseded'], ['confirmed', 'rejected'],
    ['rejected', 'suggested'],
  ];
  const illegal: [string, string][] = [
    ['superseded', 'confirmed'], ['superseded', 'rejected'], ['superseded', 'suggested'],
    ['confirmed', 'suggested'], ['confirmed', 'provisional'],
    ['rejected', 'confirmed'], ['provisional', 'suggested'],
  ];

  it.each(legal)('allows %s -> %s', (from, to) => {
    expect(canTransition(from as never, to as never)).toBe(true);
  });

  it.each(illegal)('rejects %s -> %s', (from, to) => {
    expect(canTransition(from as never, to as never)).toBe(false);
  });

  it('requires a resolvable supersededByLinkId for superseded, and confirmedAt iff confirmed/provisional', () => {
    const purchase = tx({ id: 'demo-purchase-k', amount: 100 });
    const credit = tx({ id: 'demo-refund-k', amount: 100, type: 'income' });
    const ctx = { transactions: refs(purchase, credit) };
    const base = { linkType: 'refund_of' as const, sourceTransactionId: credit.id, targetTransactionId: purchase.id, allocatedAmountCents: 10000, algorithmVersion: V };

    expect(validateLink({ ...base, status: 'superseded', supersededByLinkId: 'refund_of~nope~nope' }, ctx)).toEqual({ ok: false, ruleId: 'V7' });
    expect(validateLink({ ...base, status: 'superseded' }, ctx)).toEqual({ ok: false, ruleId: 'V7' });
    // V8: confirmedAt present iff confirmed | provisional
    expect(validateLink({ ...base, status: 'confirmed', confirmedBy: 'user' }, ctx)).toEqual({ ok: false, ruleId: 'V8' });
    expect(validateLink({ ...base, status: 'suggested', confirmedAt: NOW }, ctx)).toEqual({ ok: false, ruleId: 'V8' });
    expect(validateLink({ ...base, status: 'confirmed', confirmedAt: NOW, confirmedBy: 'user' }, ctx)).toEqual({ ok: true });
  });

  it('permits confirmedBy system only for card_payment_pair', () => {
    const bankLeg = tx({ id: 'demo-bank-leg', amount: 300, type: 'transfer' });
    const cardLeg = tx({ id: 'demo-card-leg', amount: 300, type: 'transfer' });
    const ctx = { transactions: refs(bankLeg, cardLeg) };
    const base = { sourceTransactionId: bankLeg.id, targetTransactionId: cardLeg.id, allocatedAmountCents: 30000, status: 'confirmed' as const, confirmedAt: NOW, confirmedBy: 'system' as const, algorithmVersion: V };

    expect(validateLink({ ...base, linkType: 'card_payment_pair' }, ctx)).toEqual({ ok: true });
    expect(validateLink({ ...base, linkType: 'refund_of' }, ctx)).toEqual({ ok: false, ruleId: 'V7' });
  });
});

describe('R16 only confirmed links count', () => {
  it('a suggested link contributes zero to every allocation total', () => {
    const suggestedLink: TransactionLink = { ...confirmed(COMBINED_CREDIT.id, PURCHASE_A.id, 110000), status: 'suggested', confirmedAt: undefined, confirmedBy: undefined };

    expect(confirmedAllocatedFromSource([suggestedLink], COMBINED_CREDIT.id)).toBe(0);
    expect(confirmedAllocatedAgainstTarget([suggestedLink], PURCHASE_A.id)).toBe(0);

    // …so the credit's full amount is still allocatable.
    const r = buildLink(
      { linkType: 'refund_of', sourceTransactionId: COMBINED_CREDIT.id, targetTransactionId: PURCHASE_B.id, allocatedAmountCents: 10000, status: 'confirmed', confirmedAt: NOW, confirmedBy: 'user', algorithmVersion: V },
      { transactions: refs(PURCHASE_A, PURCHASE_B, COMBINED_CREDIT), links: [suggestedLink] }
    );
    expect(r.ok).toBe(true);
  });

  it('V3: both endpoints must resolve in the current ledger', () => {
    expect(
      validateLink(
        { linkType: 'refund_of', sourceTransactionId: COMBINED_CREDIT.id, targetTransactionId: 'demo-vanished-row', allocatedAmountCents: 100, status: 'suggested', algorithmVersion: V },
        { transactions: refs(COMBINED_CREDIT) }
      )
    ).toEqual({ ok: false, ruleId: 'V3' });
  });

  it('V10: a cross-currency link is rejected as unvalidatable', () => {
    expect(
      validateLink(
        { linkType: 'refund_of', sourceTransactionId: 'demo-inr-credit', targetTransactionId: 'demo-usd-purchase', allocatedAmountCents: 100, status: 'suggested', algorithmVersion: V },
        { transactions: [{ id: 'demo-inr-credit', amountCents: 100000, currency: 'INR' }, { id: 'demo-usd-purchase', amountCents: 100000, currency: 'USD' }] }
      )
    ).toEqual({ ok: false, ruleId: 'V10' });
  });
});
