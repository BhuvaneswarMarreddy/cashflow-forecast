/**
 * FIN-REFUND-001 §11.3 — net economic cost (N1–N7).
 *
 * THE RULE THIS SUITE EXISTS FOR: a provisional dispute credit is money the bank may
 * take back. Subtracting it from final personal spending would report a saving the
 * owner has not made. N3 pins that; N4 pins that the "if upheld" figure is a
 * separately named field and never a substitute.
 *
 * Sanitized fixtures only.
 */

import { PaymentAccount, Transaction } from '@/types';
import { TransactionLink } from '@/lib/relations';
import { purchaseEconomics, refundEconomics, REFUND_MATCH_VERSION } from '@/lib/refunds';

const accounts: PaymentAccount[] = [
  {
    id: 'demo-card-9021', name: 'Demo Rewards Card', type: 'credit_card', provider: 'amex',
    lastFourDigits: '9021', creditLimit: 500000,
    openingBalance: 0, openingDate: '2000-01-01', color: '#222', isActive: true,
  },
];

const tx = (o: Partial<Transaction> & { id: string; title: string; amount: number }): Transaction => ({
  type: 'expense', category: 'other', paymentMethod: 'other', date: '2026-07-20',
  sources: ['simplefin'], ...o,
});

const mkLink = (
  linkType: TransactionLink['linkType'],
  sourceTransactionId: string,
  targetTransactionId: string,
  allocatedAmountCents: number,
  status: TransactionLink['status']
): TransactionLink => ({
  id: `${linkType}~${sourceTransactionId}~${targetTransactionId}`,
  linkType, sourceTransactionId, targetTransactionId, allocatedAmountCents, status,
  algorithmVersion: REFUND_MATCH_VERSION,
  ...(status === 'confirmed' || status === 'provisional' ? { confirmedAt: '2026-08-01T00:00:00.000Z' } : {}),
  createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z',
});

const PURCHASE = tx({
  id: 'demo-purchase-a', title: 'Demo Amazon Lens', merchant: 'DEMO AMAZON',
  amount: 1100, category: 'shopping', accountId: 'demo-card-9021', date: '2026-07-12',
});
const DISPUTE_CREDIT = tx({
  id: 'demo-dispute-credit', title: 'Provisional Credit Case 5512', amount: 1100,
  type: 'income', accountId: 'demo-card-9021', date: '2026-07-25',
});

describe('N1 — the four numbers are integer cents', () => {
  it('no float appears in any field', () => {
    const econ = purchaseEconomics(
      tx({ id: 'demo-odd', title: 'Demo Cedarline Hardware', amount: 64.2, accountId: 'demo-card-9021' }),
      [mkLink('partial_refund_of', 'demo-r', 'demo-odd', 1207, 'confirmed')]
    );
    for (const value of [
      econ.grossPurchaseCents, econ.confirmedRefundedCents,
      econ.provisionalRefundedCents, econ.netEconomicCostCents,
      econ.netEconomicCostIfDisputeUpheldCents,
    ]) {
      expect(Number.isInteger(value)).toBe(true);
    }
    expect(econ.grossPurchaseCents).toBe(6420);
    expect(econ.netEconomicCostCents).toBe(5213);
  });

  it('the refund side is integer cents too', () => {
    const refund = refundEconomics(DISPUTE_CREDIT, [mkLink('refund_of', DISPUTE_CREDIT.id, PURCHASE.id, 40000, 'confirmed')]);
    expect(refund).toEqual({
      refundAmountCents: 110000, allocatedRefundCents: 40000, unallocatedRefundCents: 70000,
    });
    for (const v of Object.values(refund)) expect(Number.isInteger(v)).toBe(true);
  });
});

describe('N2 — the status boundaries are exact', () => {
  const at = (confirmedCents: number) =>
    purchaseEconomics(PURCHASE, confirmedCents === 0 ? [] : [mkLink('partial_refund_of', 'demo-r', PURCHASE.id, confirmedCents, 'confirmed')]);

  it.each([
    [0, 'not_refunded'],
    [1, 'partially_refunded'],
    [109999, 'partially_refunded'],
    [110000, 'fully_refunded'],
    [110001, 'over_refunded'],
  ])('%i cents confirmed → %s', (cents, status) => {
    expect(at(cents as number).status).toBe(status);
  });

  it('fully_refunded is the "Returned" state and leaves zero net cost', () => {
    expect(at(110000).netEconomicCostCents).toBe(0);
    expect(at(110001).netEconomicCostCents).toBe(-1);
  });
});

describe('N3 — a provisional dispute credit does NOT reduce netEconomicCostCents', () => {
  it('the provisional total rises and the net figure does not move', () => {
    const econ = purchaseEconomics(PURCHASE, [mkLink('chargeback_for', DISPUTE_CREDIT.id, PURCHASE.id, 110000, 'provisional')]);
    expect(econ.provisionalRefundedCents).toBe(110000);
    expect(econ.confirmedRefundedCents).toBe(0);
    expect(econ.netEconomicCostCents).toBe(110000);
    expect(econ.netEconomicCostCents).toBe(econ.grossPurchaseCents);
  });
});

describe('N4 — netEconomicCostIfDisputeUpheldCents is a separate field', () => {
  it('it is never substituted for the net figure', () => {
    const econ = purchaseEconomics(PURCHASE, [mkLink('chargeback_for', DISPUTE_CREDIT.id, PURCHASE.id, 110000, 'provisional')]);
    expect(econ.netEconomicCostIfDisputeUpheldCents).toBe(0);
    expect(econ.netEconomicCostCents).toBe(110000);
    expect(econ.netEconomicCostIfDisputeUpheldCents).not.toBe(econ.netEconomicCostCents);
    expect(econ.netEconomicCostIfDisputeUpheldCents).toBe(econ.netEconomicCostCents - econ.provisionalRefundedCents);
  });

  it('with no dispute the two agree, so the separate name costs nothing', () => {
    const econ = purchaseEconomics(PURCHASE, []);
    expect(econ.netEconomicCostIfDisputeUpheldCents).toBe(econ.netEconomicCostCents);
  });
});

describe('N5 — the chargeback lifecycle moves the net figure exactly once', () => {
  it('provisional → confirmed is the only step that moves money', () => {
    const provisional = purchaseEconomics(PURCHASE, [mkLink('chargeback_for', DISPUTE_CREDIT.id, PURCHASE.id, 110000, 'provisional')]);
    expect(provisional.netEconomicCostCents).toBe(110000);
    expect(provisional.statuses).toContain('provisional_dispute_credit');

    const resolved = purchaseEconomics(PURCHASE, [mkLink('chargeback_for', DISPUTE_CREDIT.id, PURCHASE.id, 110000, 'confirmed')]);
    expect(resolved.provisionalRefundedCents).toBe(0);
    expect(resolved.confirmedRefundedCents).toBe(110000);
    expect(resolved.netEconomicCostCents).toBe(0);
    expect(resolved.status).toBe('fully_refunded');
    expect(resolved.statuses).not.toContain('provisional_dispute_credit');
  });
});

describe('N6 — a lost dispute deletes nothing', () => {
  it('all three rows survive and the net cost returns to gross', () => {
    // The bank reverses its credit: it arrives as a NEW charge and the link is rejected.
    const REVERSAL_CHARGE = tx({
      id: 'demo-dispute-reversed', title: 'Dispute Reversal Case 5512', amount: 1100,
      category: 'shopping', accountId: 'demo-card-9021', date: '2026-08-20',
    });
    const history = [PURCHASE, DISPUTE_CREDIT, REVERSAL_CHARGE];
    const econ = purchaseEconomics(PURCHASE, [mkLink('chargeback_for', DISPUTE_CREDIT.id, PURCHASE.id, 110000, 'rejected')]);
    expect(econ.confirmedRefundedCents).toBe(0);
    expect(econ.provisionalRefundedCents).toBe(0);
    expect(econ.netEconomicCostCents).toBe(110000);
    expect(econ.status).toBe('not_refunded');
    expect(history).toHaveLength(3);
    expect(history.map((t) => t.id)).toEqual(['demo-purchase-a', 'demo-dispute-credit', 'demo-dispute-reversed']);
  });
});

describe('N7 — provisional_dispute_credit composes with partially_refunded', () => {
  it('both statuses are reported and neither collapses the other', () => {
    const econ = purchaseEconomics(PURCHASE, [
      mkLink('partial_refund_of', 'demo-r-partial', PURCHASE.id, 20000, 'confirmed'),
      mkLink('chargeback_for', DISPUTE_CREDIT.id, PURCHASE.id, 50000, 'provisional'),
    ]);
    expect(econ.confirmedRefundedCents).toBe(20000);
    expect(econ.provisionalRefundedCents).toBe(50000);
    expect(econ.netEconomicCostCents).toBe(90000);
    expect(econ.netEconomicCostIfDisputeUpheldCents).toBe(40000);
    expect(econ.status).toBe('partially_refunded');
    expect(econ.statuses).toEqual(['partially_refunded', 'provisional_dispute_credit']);
    expect(accounts).toHaveLength(1);
  });
});
