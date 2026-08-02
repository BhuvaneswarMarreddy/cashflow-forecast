/**
 * FIN-REFUND-001 §11.2 — refund matching (M1–M21).
 *
 * The anchor (umbrella §11.3) is sanitized: two invented purchases on an invented
 * demo card come back as one invented combined credit. What survives from the real
 * pattern is only the SHAPE — 110000 + 10000 === 120000, exactly.
 *
 * Nothing here writes a link. The generator proposes; the owner confirms.
 */

import { PaymentAccount, Transaction } from '@/types';
import { sumIncomeCents, IncomeContext, interpretTransaction } from '@/lib/classify';
import { detectRecurring, toCents } from '@/lib/flows';
import { monthlyAverages } from '@/lib/forecast';
import { TransactionLink, validateLink, toTxRef } from '@/lib/relations';
import { isTerminalCandidateStatus, mergeCandidateRun } from '@/lib/candidates';
import {
  MAX_CANDIDATE_PURCHASES,
  MAX_COMBINATION_SIZE,
  MAX_COMBINATIONS,
  REFUND_MATCH_VERSION,
  COMBINED_REFUND_VERSION,
  DIFFERENT_ACCOUNT_PENALTY,
  findCombinations,
  generateRefundCandidates,
  purchaseEconomics,
  netCategorySpendingCents,
  refundConfidence,
} from '@/lib/refunds';
import { classifyCardCredit, CARD_CREDIT_TO_INFLOW_MEANING } from '@/lib/card-credit';
import { clearEvents, recentEvents } from '@/lib/obs/events';

const accounts: PaymentAccount[] = [
  {
    id: 'demo-card-9021', name: 'Demo Rewards Card', type: 'credit_card', provider: 'amex',
    lastFourDigits: '9021', creditLimit: 500000,
    openingBalance: 0, openingDate: '2000-01-01', color: '#222', isActive: true,
  },
  {
    id: 'demo-card-7714', name: 'Demo Travel Card', type: 'credit_card', provider: 'chase',
    lastFourDigits: '7714', creditLimit: 300000,
    openingBalance: 0, openingDate: '2000-01-01', color: '#223', isActive: true,
  },
  {
    id: 'demo-chk', name: 'Demo Everyday Checking', type: 'bank_account', provider: 'chase',
    openingBalance: 500000, openingDate: '2000-01-01', color: '#111', isActive: true,
  },
];

const tx = (o: Partial<Transaction> & { id: string; title: string; amount: number }): Transaction => ({
  type: 'expense', category: 'other', paymentMethod: 'other', date: '2026-07-20',
  sources: ['simplefin'], ...o,
});

const confirmed = (
  linkType: TransactionLink['linkType'],
  sourceTransactionId: string,
  targetTransactionId: string,
  allocatedAmountCents: number,
  status: TransactionLink['status'] = 'confirmed'
): TransactionLink => ({
  id: `${linkType}~${sourceTransactionId}~${targetTransactionId}`,
  linkType, sourceTransactionId, targetTransactionId, allocatedAmountCents, status,
  algorithmVersion: REFUND_MATCH_VERSION,
  ...(status === 'confirmed' || status === 'provisional' ? { confirmedAt: '2026-08-01T00:00:00.000Z' } : {}),
  createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z',
});

// --- the sanitized anchor fixture (umbrella §11.3) ---------------------------
const PURCHASE_A = tx({
  id: 'demo-purchase-a', title: 'Demo Amazon Lens', merchant: 'DEMO AMAZON',
  amount: 1100, category: 'shopping', accountId: 'demo-card-9021', date: '2026-07-12',
});
const PURCHASE_B = tx({
  id: 'demo-purchase-b', title: 'Demo Amazon Filter', merchant: 'DEMO AMAZON',
  amount: 100, category: 'shopping', accountId: 'demo-card-9021', date: '2026-07-14',
});
const COMBINED_CREDIT = tx({
  id: 'demo-refund-ab', title: 'Demo Amazon Refund', merchant: 'DEMO AMAZON',
  amount: 1200, type: 'income', accountId: 'demo-card-9021', date: '2026-07-31',
});
const ANCHOR = [PURCHASE_A, PURCHASE_B, COMBINED_CREDIT];

describe('M1 — exact refund', () => {
  const purchase = tx({
    id: 'demo-p-45', title: 'Demo Brightleaf Coffee', merchant: 'DEMO BRIGHTLEAF',
    amount: 45, category: 'food', accountId: 'demo-card-9021', date: '2026-07-10',
  });
  const credit = tx({
    id: 'demo-r-45', title: 'Demo Brightleaf Refund', merchant: 'DEMO BRIGHTLEAF',
    amount: 45, type: 'income', accountId: 'demo-card-9021', date: '2026-07-18',
  });

  it('proposes one refund_of and reduces the purchase to zero once confirmed', () => {
    clearEvents();
    const run = generateRefundCandidates([purchase, credit], accounts, []);
    const match = run.candidates.find((c) => c.candidateType === 'refund_match');
    expect(match).toBeDefined();
    expect(match!.status).toBe('unreviewed');
    expect(match!.proposedLinks).toEqual([
      { linkType: 'refund_of', sourceTransactionId: credit.id, targetTransactionId: purchase.id, allocatedAmountCents: 4500 },
    ]);
    expect(match!.score).toBe(1);
    expect(refundConfidence(match!.score)).toBe('high');

    const econ = purchaseEconomics(purchase, [confirmed('refund_of', credit.id, purchase.id, 4500)]);
    expect(econ.grossPurchaseCents).toBe(4500);
    expect(econ.confirmedRefundedCents).toBe(4500);
    expect(econ.netEconomicCostCents).toBe(0);
    expect(econ.status).toBe('fully_refunded');
  });

  it('emits Refund.CandidateGenerated with counts only — never a description or an amount', () => {
    clearEvents();
    generateRefundCandidates([purchase, credit], accounts, []);
    const event = recentEvents().find((e) => e.eventName === 'Refund.CandidateGenerated');
    expect(event).toBeDefined();
    expect(event!.metadata).toMatchObject({
      algorithmVersion: REFUND_MATCH_VERSION, exactCount: 1, partialCount: 0, combinedCount: 0,
    });
    const serialised = JSON.stringify(recentEvents());
    expect(serialised).not.toContain('Brightleaf');
    expect(serialised).not.toContain('Demo Brightleaf Refund');
  });
});

describe('M2 — partial refund: $1,100.00 purchase, $900.00 credit → $200.00 net', () => {
  const credit = tx({
    id: 'demo-refund-900', title: 'Demo Amazon Refund', merchant: 'DEMO AMAZON',
    amount: 900, type: 'income', accountId: 'demo-card-9021', date: '2026-07-30',
  });

  it('proposes one partial_refund_of of 90000', () => {
    const run = generateRefundCandidates([PURCHASE_A, credit], accounts, []);
    const match = run.candidates.find((c) => c.candidateType === 'partial_refund_match');
    expect(match).toBeDefined();
    expect(match!.proposedLinks).toEqual([
      { linkType: 'partial_refund_of', sourceTransactionId: credit.id, targetTransactionId: PURCHASE_A.id, allocatedAmountCents: 90000 },
    ]);
  });

  it('leaves 20000 of net economic cost, status partially_refunded', () => {
    const econ = purchaseEconomics(PURCHASE_A, [confirmed('partial_refund_of', credit.id, PURCHASE_A.id, 90000)]);
    expect(econ.grossPurchaseCents).toBe(110000);
    expect(econ.confirmedRefundedCents).toBe(90000);
    expect(econ.netEconomicCostCents).toBe(20000);
    expect(econ.status).toBe('partially_refunded');
  });
});

describe('M3 — combined refund: 110000 + 10000 === 120000', () => {
  it('the arithmetic is exact integer cents', () => {
    expect(toCents(PURCHASE_A.amount) + toCents(PURCHASE_B.amount)).toBe(120000);
    expect(toCents(COMBINED_CREDIT.amount)).toBe(120000);
  });

  it('produces one combined candidate with TWO allocations totalling exactly 120000', () => {
    const run = generateRefundCandidates(ANCHOR, accounts, []);
    const match = run.candidates.find((c) => c.candidateType === 'combined_refund_match');
    expect(match).toBeDefined();
    expect(match!.algorithmVersion).toBe(COMBINED_REFUND_VERSION);
    expect(match!.status).toBe('unreviewed');
    expect(match!.proposedLinks).toHaveLength(2);
    expect(match!.proposedLinks.reduce((s, l) => s + l.allocatedAmountCents, 0)).toBe(120000);
    expect(match!.proposedLinks.map((l) => l.targetTransactionId).sort()).toEqual(['demo-purchase-a', 'demo-purchase-b']);
    expect(match!.transactionIds).toEqual(['demo-purchase-a', 'demo-purchase-b', 'demo-refund-ab']);
  });

  it('nets BOTH purchases to $0.00 once confirmed, and three rows remain', () => {
    const links = [
      confirmed('refund_of', COMBINED_CREDIT.id, PURCHASE_A.id, 110000),
      confirmed('refund_of', COMBINED_CREDIT.id, PURCHASE_B.id, 10000),
    ];
    expect(purchaseEconomics(PURCHASE_A, links).netEconomicCostCents).toBe(0);
    expect(purchaseEconomics(PURCHASE_B, links).netEconomicCostCents).toBe(0);
    expect(purchaseEconomics(PURCHASE_A, links).status).toBe('fully_refunded');
    expect(purchaseEconomics(PURCHASE_B, links).status).toBe('fully_refunded');
    expect(ANCHOR).toHaveLength(3);
    expect(sumIncomeCents(ANCHOR, accounts, { sources: [] })).toBe(0);
  });
});

describe('M4 — the combined match is order-independent', () => {
  it('reversed input order gives the same candidate id and the same allocations', () => {
    const forward = generateRefundCandidates(ANCHOR, accounts, []);
    const reversed = generateRefundCandidates([...ANCHOR].reverse(), accounts, []);
    const pick = (r: typeof forward) => r.candidates.find((c) => c.candidateType === 'combined_refund_match')!;
    expect(pick(reversed).id).toBe(pick(forward).id);
    expect(pick(reversed).candidateId).toBe(pick(forward).candidateId);
    expect([...pick(reversed).proposedLinks].sort((a, b) => a.targetTransactionId.localeCompare(b.targetTransactionId)))
      .toEqual([...pick(forward).proposedLinks].sort((a, b) => a.targetTransactionId.localeCompare(b.targetTransactionId)));
  });

  it('the walk itself is order-independent', () => {
    const asc = findCombinations(120000, [
      { id: 'demo-purchase-b', amountCents: 10000 }, { id: 'demo-purchase-a', amountCents: 110000 },
    ]);
    const desc = findCombinations(120000, [
      { id: 'demo-purchase-a', amountCents: 110000 }, { id: 'demo-purchase-b', amountCents: 10000 },
    ]);
    expect(asc.combinations.map((c) => c.map((p) => p.id).sort()))
      .toEqual(desc.combinations.map((c) => c.map((p) => p.id).sort()));
  });
});

describe('M5 — a purchase larger than the credit is dropped before the walk', () => {
  it('drops it at step 1', () => {
    const r = findCombinations(5000, [
      { id: 'big', amountCents: 110000 }, { id: 'a', amountCents: 3000 }, { id: 'b', amountCents: 2000 },
    ]);
    expect(r.combinations).toHaveLength(1);
    expect(r.combinations[0].map((p) => p.id).sort()).toEqual(['a', 'b']);
    expect(r.combinations.flat().some((p) => p.id === 'big')).toBe(false);
  });
});

describe('M6 — only exact sums are recorded', () => {
  // The third purchase matters: with only [3000, 1999] the "cannot reach the target"
  // prune returns before any subset is formed, so the equality check is never reached
  // and the test would pass even with a tolerance bolted on. A spare 1000 keeps the
  // remaining-sum above the target, forcing the walk to form {3000,1999} = 4999 and
  // REJECT it on exactness alone.
  const purchases = [
    { id: 'a', amountCents: 3000 }, { id: 'b', amountCents: 1999 }, { id: 'c', amountCents: 1000 },
  ];

  it('a combination off by one cent is not returned', () => {
    const r = findCombinations(5000, purchases);
    expect(r.subsetsVisited).toBeGreaterThan(0); // the walk really did form subsets
    expect(r.combinations).toEqual([]);
  });

  it('the same purchases at exactly 4999 do match', () => {
    const r = findCombinations(4999, purchases);
    expect(r.combinations).toHaveLength(1);
    expect(r.combinations[0].map((p) => p.id).sort()).toEqual(['a', 'b']);
  });

  it('no tolerance exists in either direction — 5001 matches nothing either', () => {
    expect(findCombinations(5001, purchases).combinations).toEqual([]);
  });
});

describe('M7 — MAX_COMBINATIONS = 5', () => {
  it('a fixture with more than five valid combinations returns exactly five', () => {
    // Ten purchases of 1000 → C(10,2) = 45 valid pairs summing to 2000.
    const purchases = Array.from({ length: 10 }, (_, i) => ({ id: `p${i}`, amountCents: 1000 }));
    const r = findCombinations(2000, purchases);
    expect(MAX_COMBINATIONS).toBe(5);
    expect(r.combinations).toHaveLength(5);
    expect(r.combinations.every((c) => c.reduce((s, p) => s + p.amountCents, 0) === 2000)).toBe(true);
  });
});

describe('M8 — MAX_COMBINATION_SIZE = 4', () => {
  it('a valid five-purchase combination is not returned', () => {
    const purchases = Array.from({ length: 5 }, (_, i) => ({ id: `p${i}`, amountCents: 1000 }));
    expect(MAX_COMBINATION_SIZE).toBe(4);
    expect(findCombinations(5000, purchases).combinations).toEqual([]);
    // Four of them summing to 4000 is still reachable.
    expect(findCombinations(4000, purchases).combinations.length).toBeGreaterThan(0);
    expect(findCombinations(4000, purchases).combinations.every((c) => c.length <= 4)).toBe(true);
  });
});

describe('M9 — multiple partial refunds accumulate', () => {
  it('30000 + 30000 + 20000 against 110000 leaves 30000', () => {
    const links = [
      confirmed('partial_refund_of', 'demo-r1', PURCHASE_A.id, 30000),
      confirmed('partial_refund_of', 'demo-r2', PURCHASE_A.id, 30000),
      confirmed('partial_refund_of', 'demo-r3', PURCHASE_A.id, 20000),
    ];
    const econ = purchaseEconomics(PURCHASE_A, links);
    expect(econ.confirmedRefundedCents).toBe(80000);
    expect(econ.netEconomicCostCents).toBe(30000);
    expect(econ.status).toBe('partially_refunded');
  });
});

describe('M10 — a fourth partial that would exceed the purchase is rejected, not clamped', () => {
  it('V5 refuses it and the stored total does not move', () => {
    const stored = [
      confirmed('partial_refund_of', 'demo-r1', PURCHASE_A.id, 30000),
      confirmed('partial_refund_of', 'demo-r2', PURCHASE_A.id, 30000),
      confirmed('partial_refund_of', 'demo-r3', PURCHASE_A.id, 20000),
    ];
    const fourth = tx({ id: 'demo-r4', title: 'Demo Amazon Refund', amount: 400, type: 'income', accountId: 'demo-card-9021' });
    const result = validateLink(
      {
        linkType: 'partial_refund_of', sourceTransactionId: fourth.id, targetTransactionId: PURCHASE_A.id,
        allocatedAmountCents: 40000, status: 'confirmed', algorithmVersion: REFUND_MATCH_VERSION,
        confirmedAt: '2026-08-01T00:00:00.000Z',
      },
      { transactions: [toTxRef(PURCHASE_A), toTxRef(fourth)], links: stored }
    );
    expect(result).toEqual({ ok: false, ruleId: 'V5' });
    expect(purchaseEconomics(PURCHASE_A, stored).netEconomicCostCents).toBe(30000);
  });
});

describe('M11 — an ambiguous refund goes to review with NO auto-confirm', () => {
  const twinA = tx({
    id: 'demo-twin-a', title: 'Demo Amazon Lens', merchant: 'DEMO AMAZON',
    amount: 60, category: 'shopping', accountId: 'demo-card-9021', date: '2026-07-10',
  });
  const twinB = tx({
    id: 'demo-twin-b', title: 'Demo Amazon Lens', merchant: 'DEMO AMAZON',
    amount: 60, category: 'shopping', accountId: 'demo-card-9021', date: '2026-07-11',
  });
  const credit = tx({
    id: 'demo-twin-refund', title: 'Demo Amazon Refund', merchant: 'DEMO AMAZON',
    amount: 60, type: 'income', accountId: 'demo-card-9021', date: '2026-07-20',
  });

  it('emits both candidates unreviewed, flags ambiguous_match and presents no answer', () => {
    const run = generateRefundCandidates([twinA, twinB, credit], accounts, []);
    const exact = run.candidates.filter((c) => c.candidateType === 'refund_match');
    expect(exact).toHaveLength(2);
    expect(exact.every((c) => c.status === 'unreviewed')).toBe(true);
    expect(exact.every((c) => c.evidence.reasonCodes.includes('ambiguous_match'))).toBe(true);
    expect(Math.abs(exact[0].score - exact[1].score)).toBeLessThanOrEqual(0.05);
  });

  it('writes no link — the generator only proposes', () => {
    const run = generateRefundCandidates([twinA, twinB, credit], accounts, []);
    // The run carries candidates and counters, and no link collection at all: there is
    // no code path from generation to a written link, at any score.
    expect(Object.keys(run).sort()).toEqual(['candidates', 'creditsEvaluated', 'durationMs', 'subsetsVisited']);
    expect(run.candidates.every((c) => !isTerminalCandidateStatus(c.status))).toBe(true);
    expect(purchaseEconomics(twinA, []).netEconomicCostCents).toBe(6000);
    expect(purchaseEconomics(twinB, []).netEconomicCostCents).toBe(6000);
  });
});

describe('M12 — a pending credit is not a finalized refund', () => {
  const purchase = tx({
    id: 'demo-p-hold', title: 'Demo Cedarline Hardware', merchant: 'DEMO CEDARLINE',
    amount: 64.2, category: 'shopping', accountId: 'demo-card-9021', date: '2026-07-10',
  });
  const pendingCredit = tx({
    id: 'pending_demo-r-hold', title: 'Demo Cedarline Refund', merchant: 'DEMO CEDARLINE',
    amount: 64.2, type: 'income', accountId: 'demo-card-9021', date: '2026-07-18', pending: true,
  });

  it('generates no candidate, writes no link and reduces no cost', () => {
    const run = generateRefundCandidates([purchase, pendingCredit], accounts, []);
    expect(run.candidates).toEqual([]);
    expect(interpretTransaction(pendingCredit, accounts).pending).toBe('pending');
    expect(purchaseEconomics(purchase, []).netEconomicCostCents).toBe(6420);
  });
});

describe('M13 — a refund is matched only within the account it credited', () => {
  const purchase = tx({
    id: 'demo-p-cross', title: 'Demo Fernvale Outfitters', merchant: 'DEMO FERNVALE',
    amount: 200, category: 'shopping', accountId: 'demo-card-9021', date: '2026-07-10',
  });
  const sameAccountCredit = tx({
    id: 'demo-r-same', title: 'Demo Fernvale Refund', merchant: 'DEMO FERNVALE',
    amount: 200, type: 'income', accountId: 'demo-card-9021', date: '2026-07-18',
  });
  const otherAccountCredit = tx({
    id: 'demo-r-other', title: 'Demo Fernvale Refund', merchant: 'DEMO FERNVALE',
    amount: 200, type: 'income', accountId: 'demo-card-7714', date: '2026-07-18',
  });

  const run = (credit: Transaction) => generateRefundCandidates([purchase, credit], accounts, []);

  it('matches the credit that landed on the charged card', () => {
    const c = run(sameAccountCredit).candidates.find((x) => x.candidateType === 'refund_match');
    expect(c).toBeDefined();
    expect(c!.evidence.sameAccount).toBe(true);
  });

  it('proposes NOTHING for an identical credit on a different card', () => {
    // Same merchant, same amount, same day, same everything but the account. That is a
    // coincidence, not evidence: a merchant refunds the card it charged.
    expect(run(otherAccountCredit).candidates).toHaveLength(0);
  });

  it('leaves the cross-account credit visible rather than silently dropping it', () => {
    // It must not vanish. Unmatched is the correct outcome, so the owner still sees it
    // in the queue as a card credit needing an answer.
    const { kind } = classifyCardCredit(otherAccountCredit, { accounts, links: [] });
    expect(kind).toBe('unknown_card_credit');
    expect(CARD_CREDIT_TO_INFLOW_MEANING[kind]).not.toBe('earned_income');
  });

  it('never emits a candidate whose evidence says sameAccount:false', () => {
    const ledger = [purchase, sameAccountCredit, otherAccountCredit];
    const all = generateRefundCandidates(ledger, accounts, []).candidates;
    expect(all.every((c) => c.evidence.sameAccount)).toBe(true);
  });

  it('keeps the penalty as defence in depth even though it is now unreachable', () => {
    expect(DIFFERENT_ACCOUNT_PENALTY).toBe(0.2);
  });
});

describe('M14 — a posted replacement appears exactly once', () => {
  const purchase = tx({
    id: 'demo-p-replace', title: 'Demo Cedarline Hardware', merchant: 'DEMO CEDARLINE',
    amount: 64.2, category: 'shopping', accountId: 'demo-card-9021', date: '2026-07-10',
  });
  const hold = tx({
    id: 'pending_demo-r-replace', title: 'Demo Cedarline Refund', merchant: 'DEMO CEDARLINE',
    amount: 60, type: 'income', accountId: 'demo-card-9021', date: '2026-07-18', pending: true,
  });
  const posted = tx({
    id: 'demo-r-replace', title: 'Demo Cedarline Refund', merchant: 'DEMO CEDARLINE',
    amount: 64.2, type: 'income', accountId: 'demo-card-9021', date: '2026-07-18',
  });

  it('the hold and its posted twin never both generate a candidate', () => {
    const run = generateRefundCandidates([purchase, hold, posted], accounts, []);
    expect(run.candidates).toHaveLength(1);
    expect(run.candidates[0].transactionIds).toEqual(['demo-p-replace', 'demo-r-replace']);
    expect(run.candidates[0].evidence.pendingInvolved).toBe(false);
  });

  it('re-running the generator is idempotent — same ids, nothing duplicated', () => {
    const first = generateRefundCandidates([purchase, hold, posted], accounts, []);
    const second = generateRefundCandidates([purchase, hold, posted], accounts, []);
    expect(second.candidates.map((c) => c.id)).toEqual(first.candidates.map((c) => c.id));
    const merged = mergeCandidateRun(second.candidates, first.candidates.map((c) => ({ ...c, status: 'dismissed' as const })));
    expect(merged.writes).toEqual([]);
    expect(merged.suppressed).toEqual(first.candidates.map((c) => c.id));
  });
});

describe('M15 — gross history is preserved', () => {
  it('both transaction documents are byte-identical after confirmation', () => {
    const before = JSON.stringify(ANCHOR);
    const links = [
      confirmed('refund_of', COMBINED_CREDIT.id, PURCHASE_A.id, 110000),
      confirmed('refund_of', COMBINED_CREDIT.id, PURCHASE_B.id, 10000),
    ];
    purchaseEconomics(PURCHASE_A, links);
    purchaseEconomics(PURCHASE_B, links);
    generateRefundCandidates(ANCHOR, accounts, links);
    expect(JSON.stringify(ANCHOR)).toBe(before);
    // Gross stays gross; net is derived, never stored on the row.
    expect(purchaseEconomics(PURCHASE_A, links).grossPurchaseCents).toBe(110000);
    expect(PURCHASE_A.amount).toBe(1100);
  });
});

describe('M16 — net spending is reduced by exactly the confirmed refund', () => {
  const ledger = [PURCHASE_A, PURCHASE_B, COMBINED_CREDIT];

  it('netCategorySpendingCents falls by the confirmed allocation and by nothing else', () => {
    const gross = netCategorySpendingCents(ledger, [], accounts);
    expect(gross.shopping).toBe(120000);

    const net = netCategorySpendingCents(
      ledger, [confirmed('refund_of', COMBINED_CREDIT.id, PURCHASE_B.id, 10000)], accounts
    );
    expect(net.shopping).toBe(110000);
    expect(gross.shopping - net.shopping).toBe(10000);
  });
});

describe('M17 — earned income is unchanged by a refund, before AND after linking', () => {
  // FIN-INCOME-001 settled this: a refund contributes ZERO to earned income already.
  // The point of the test is that LINKING changes net SPENDING and never income.
  const PAYCHECK = tx({
    id: 'demo-paycheck', title: 'Direct Deposit - Larkspur Studio', amount: 3200,
    type: 'income', accountId: 'demo-chk', date: '2026-07-15',
  });
  const INCOME: IncomeContext = {
    sources: [{ id: 'src-employer', name: 'Larkspur Studio', amount: 3200, frequency: 'biweekly', isActive: true, kind: 'employment' }],
  };
  const ledger = [...ANCHOR, PAYCHECK];

  it('the refund contributes 0 both before and after the links are confirmed', () => {
    const links = [
      confirmed('refund_of', COMBINED_CREDIT.id, PURCHASE_A.id, 110000),
      confirmed('refund_of', COMBINED_CREDIT.id, PURCHASE_B.id, 10000),
    ];
    expect(sumIncomeCents([COMBINED_CREDIT], accounts, INCOME)).toBe(0);
    expect(sumIncomeCents(ledger, accounts, INCOME)).toBe(320000);

    // Confirming links moves NET SPENDING …
    expect(netCategorySpendingCents(ledger, [], accounts).shopping).toBe(120000);
    expect(netCategorySpendingCents(ledger, links, accounts).shopping).toBe(0);
    // … and leaves earned income exactly where it was: the paycheck only.
    expect(sumIncomeCents(ledger, accounts, INCOME)).toBe(320000);
    expect(interpretTransaction(COMBINED_CREDIT, accounts, INCOME).income).toBe('excluded');
  });
});

describe('M18 — budget impact is reduced by the refund and by nothing else', () => {
  const OTHER_CATEGORY = tx({
    id: 'demo-food', title: 'Demo Willowbrook Market', merchant: 'DEMO WILLOWBROOK',
    amount: 120, category: 'food', accountId: 'demo-card-9021', date: '2026-07-13',
  });
  const ledger = [PURCHASE_A, PURCHASE_B, OTHER_CATEGORY, COMBINED_CREDIT];

  it('only the refunded category moves', () => {
    const gross = netCategorySpendingCents(ledger, [], accounts);
    const net = netCategorySpendingCents(
      ledger, [confirmed('refund_of', COMBINED_CREDIT.id, PURCHASE_A.id, 110000)], accounts
    );
    expect(gross.shopping).toBe(120000);
    expect(net.shopping).toBe(10000);
    expect(net.food).toBe(gross.food);
    expect(net.food).toBe(12000);
  });

  it('a suggested link changes no budget number', () => {
    const suggested = [confirmed('refund_of', COMBINED_CREDIT.id, PURCHASE_A.id, 110000, 'suggested')];
    expect(netCategorySpendingCents(ledger, suggested, accounts).shopping).toBe(120000);
  });
});

describe('M19 — the forecast never treats a refund as recurring income', () => {
  it('a monthly refund series produces no recurring item and no income baseline', () => {
    const series = [0, 1, 2, 3, 4].map((i) =>
      tx({
        id: `demo-monthly-refund-${i}`, title: 'Demo Amazon Refund', merchant: 'DEMO AMAZON',
        amount: 50, type: 'income', accountId: 'demo-card-9021', date: `2026-0${3 + i}-14`,
      })
    );
    // detectRecurring only groups expense rows, so a refund cannot become a recurring item.
    expect(detectRecurring(series, accounts, '2026-08-01')).toEqual([]);
    // And without an approved income source it adds nothing to the projected baseline.
    expect(monthlyAverages(series, accounts, 6, { sources: [] }).income).toBe(0);
    expect(sumIncomeCents(series, accounts, { sources: [] })).toBe(0);
  });
});

describe('M20 — the bound holds, empirically', () => {
  // Credits are deliberately LARGER than every single purchase at their merchant, so
  // neither an exact nor a partial match short-circuits the combined search. A fixture
  // where the walk never runs would make the counter read 0 and assert nothing.
  const bigLedger = (rows: number): Transaction[] => {
    const out: Transaction[] = [];
    for (let i = 0; i < rows; i++) {
      const isCredit = i % 25 === 0;
      out.push(tx({
        id: `demo-bulk-${i}`,
        title: isCredit ? `Demo Merchant ${i % 40} Refund` : `Demo Merchant ${i % 40}`,
        merchant: `DEMO MERCHANT ${i % 40}`,
        amount: isCredit ? 250 : 10 + (i % 90),
        type: isCredit ? 'income' : 'expense',
        category: 'shopping',
        accountId: i % 3 === 0 ? 'demo-card-7714' : 'demo-card-9021',
        date: `2026-0${1 + (i % 7)}-${String(1 + (i % 28)).padStart(2, '0')}`,
      }));
    }
    return out;
  };

  it('Σ(k=1..4) C(12,k) = 793 — the stated worst case', () => {
    const choose = (n: number, k: number) => {
      let r = 1;
      for (let i = 0; i < k; i++) r = (r * (n - i)) / (i + 1);
      return Math.round(r);
    };
    expect([1, 2, 3, 4].map((k) => choose(MAX_CANDIDATE_PURCHASES, k))).toEqual([12, 66, 220, 495]);
    expect([1, 2, 3, 4].reduce((s, k) => s + choose(MAX_CANDIDATE_PURCHASES, k), 0)).toBe(793);
  });

  it.each([1000, 2000, 5000])('on a %i-row ledger the walk stays under R × 793', (rows) => {
    const ledger = bigLedger(rows);
    const started = Date.now();
    const run = generateRefundCandidates(ledger, accounts, []);
    const elapsed = Date.now() - started;

    expect(run.creditsEvaluated).toBeGreaterThan(0);
    // The counter must show the walk actually ran, or the bound below asserts nothing.
    expect(run.subsetsVisited).toBeGreaterThan(0);
    expect(run.subsetsVisited).toBeLessThan(run.creditsEvaluated * 793);
    // Constant work per credit is what makes the total linear in n.
    expect(run.subsetsVisited / run.creditsEvaluated).toBeLessThanOrEqual(793);
    expect(elapsed).toBeLessThan(20000);
  });

  it('per-credit work does not grow with the ledger', () => {
    const perCredit = [1000, 2000, 5000].map((rows) => {
      const run = generateRefundCandidates(bigLedger(rows), accounts, []);
      expect(run.subsetsVisited).toBeGreaterThan(0);
      return run.subsetsVisited / run.creditsEvaluated;
    });
    // Measured: ~10.6, ~15.2, ~13.8 subsets per credit at 1k/2k/5k. Bounded and
    // non-growing — 5x the ledger does not multiply the per-credit work.
    for (const w of perCredit) expect(w).toBeLessThanOrEqual(793);
    expect(Math.max(...perCredit)).toBeLessThan(50);
  });

  it('no single credit exceeds 793 subsets, under adversarial targets', () => {
    // Twelve identical purchases with a target no subset can hit is the shape that
    // defeats both prunes for longest: prune 1 only bites near the cap and prune 2
    // never fires, so the walk explores the most subsets it structurally can.
    const purchases = Array.from({ length: MAX_CANDIDATE_PURCHASES }, (_, i) => ({
      id: `p${String(i).padStart(2, '0')}`, amountCents: 1000,
    }));
    const observed = [3500, 4500, 5500, 11500].map((target) => findCombinations(target, purchases).subsetsVisited);
    // Measured: 219, 494, 329, 4. The stated worst case is an upper bound, never met.
    for (const subsets of observed) expect(subsets).toBeLessThanOrEqual(793);
    expect(Math.max(...observed)).toBeGreaterThan(400); // the walk really is exploring
    expect(findCombinations(4000, purchases).subsetsVisited).toBeLessThanOrEqual(793);
  });
});

describe('M21 — only a confirmed link moves a number', () => {
  it('a suggested link contributes zero to PurchaseEconomics', () => {
    const suggested = [confirmed('refund_of', COMBINED_CREDIT.id, PURCHASE_A.id, 110000, 'suggested')];
    const econ = purchaseEconomics(PURCHASE_A, suggested);
    expect(econ.confirmedRefundedCents).toBe(0);
    expect(econ.netEconomicCostCents).toBe(110000);
    expect(econ.status).toBe('not_refunded');
  });

  it('a rejected link contributes zero too', () => {
    const rejected = [confirmed('refund_of', COMBINED_CREDIT.id, PURCHASE_A.id, 110000, 'rejected')];
    expect(purchaseEconomics(PURCHASE_A, rejected).netEconomicCostCents).toBe(110000);
  });
});
