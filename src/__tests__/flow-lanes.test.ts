/**
 * FIN-FLOW-001 — the three defects the owner reported on their live Flow screen.
 *
 *  A. refunds, cashback, card charges and stray expense-category credits stood on the
 *     INCOME side, beside Paychecks;
 *  B. a quarter of a million dollars sat in buckets called "other";
 *  C. labels printed through each other.
 *
 * Everything here is invented — merchants, amounts, ids. No real financial data.
 */

import { PaymentAccount, Transaction } from '@/types';
import { buildFlowGraph, FlowGraph } from '@/lib/flows';
import { REFUND_MATCH_VERSION, purchaseEconomics, refundEconomics } from '@/lib/refunds';
import { TransactionLink } from '@/lib/relations';
import { flowNetting } from '@/lib/flow-netting';
import {
  BORROWED_ON_CARDS, CARD_CREDIT_UNEXPLAINED, MONEY_BACK, REWARDS, TOP_CATEGORIES,
  columnCounts, columnFits, fitLabel, inflowLane, labelMaxChars, residualCategoryLabel,
  sankeyHeightFor, spendingCategoryIndex, spendingLane, unpairedLegLane,
} from '@/lib/flow-lanes';

// --- invented fixtures ------------------------------------------------------

const bank: PaymentAccount = {
  id: 'acc-bank', name: 'Willow Everyday', type: 'bank_account', provider: 'chase',
  openingBalance: 0, openingDate: '2000-01-01', color: '#111', isActive: true,
} as PaymentAccount;

const card: PaymentAccount = {
  id: 'acc-card', name: 'Willow Rewards Card', type: 'credit_card', provider: 'amex',
  lastFourDigits: '4242', openingBalance: 0, openingDate: '2000-01-01', color: '#222', isActive: true,
} as PaymentAccount;

const ACCOUNTS = [bank, card];

const tx = (o: Partial<Transaction> & { id: string; title: string; amount: number }): Transaction => ({
  type: 'expense', category: 'other', paymentMethod: 'other', date: '2026-05-10',
  sources: ['simplefin'], ...o,
});

const PURCHASE = tx({
  id: 'p-lamp', title: 'Fernvale Lamp', merchant: 'FERNVALE', amount: 200,
  sourceCategory: 'Shopping', accountId: 'acc-card', date: '2026-05-02',
});
const CREDIT = tx({
  id: 'c-lamp', title: 'Fernvale Refund', merchant: 'FERNVALE', amount: 200,
  type: 'income', sourceCategory: 'Shopping', accountId: 'acc-card', date: '2026-05-09',
});
const PAYCHECK = tx({
  id: 'i-pay', title: 'Payroll Deposit Larkspur', amount: 3000,
  type: 'income', sourceCategory: 'Paychecks', accountId: 'acc-bank', date: '2026-05-01',
});

const confirmedLink = (source: string, target: string, cents: number): TransactionLink => ({
  id: `refund_of~${source}~${target}`, linkType: 'refund_of',
  sourceTransactionId: source, targetTransactionId: target,
  allocatedAmountCents: cents, status: 'confirmed', algorithmVersion: REFUND_MATCH_VERSION,
  confirmedAt: '2026-05-11T00:00:00.000Z', createdAt: '2026-05-11T00:00:00.000Z', updatedAt: '2026-05-11T00:00:00.000Z',
});

const sum = (g: FlowGraph, pred: (l: { source: string; target: string; cents: number }) => boolean) =>
  g.links.filter(pred).reduce((s, l) => s + l.cents, 0);

/** Every node with both an in and an out edge balances, and sources === sinks. */
const assertConserved = (g: FlowGraph) => {
  const inBy = new Map<string, number>(), outBy = new Map<string, number>();
  for (const l of g.links) {
    inBy.set(l.target, (inBy.get(l.target) ?? 0) + l.cents);
    outBy.set(l.source, (outBy.get(l.source) ?? 0) + l.cents);
  }
  for (const n of g.nodes) {
    const i = inBy.get(n.id) ?? 0, o = outBy.get(n.id) ?? 0;
    if (i > 0 && o > 0) expect(i).toBe(o);
  }
  const sources = g.nodes.filter((n) => !inBy.has(n.id)).reduce((s, n) => s + (outBy.get(n.id) ?? 0), 0);
  const sinks = g.nodes.filter((n) => !outBy.has(n.id)).reduce((s, n) => s + (inBy.get(n.id) ?? 0), 0);
  expect(sources).toBe(sinks);
};

// ===========================================================================
// A. money coming back is not money earned
// ===========================================================================

describe('A — refunds and credits are not income', () => {
  const LEDGER = [PAYCHECK, PURCHASE, CREDIT];

  it('A1 a CONFIRMED refund reduces the category it reverses and leaves the income side entirely', () => {
    const links = [confirmedLink(CREDIT.id, PURCHASE.id, 20000)];
    const g = buildFlowGraph(LEDGER, ACCOUNTS, {}, { netting: flowNetting(LEDGER, ACCOUNTS, links) });

    // the category it reverses is reduced to the cent…
    expect(sum(g, (l) => l.target === 'cat:Shopping')).toBe(0);
    expect(g.nettedRefundCents).toBe(20000);
    // …and the credit is nowhere on the left at all — not as income, not as money back.
    expect(g.links.some((l) => l.source === MONEY_BACK.id)).toBe(false);
    expect(g.links.some((l) => l.source.startsWith('inc:') && l.source !== 'inc:Paychecks')).toBe(false);
    assertConserved(g);
  });

  it('A2 an UNCONFIRMED refund is NOT netted, and does NOT stand beside earned income', () => {
    const g = buildFlowGraph(LEDGER, ACCOUNTS);

    // not netted: the purchase is still in the category at full size
    expect(sum(g, (l) => l.target === 'cat:Shopping')).toBe(20000);
    expect(g.nettedRefundCents).toBe(0);
    // …and the credit sits in its own, clearly-labelled, non-income lane
    expect(sum(g, (l) => l.source === MONEY_BACK.id)).toBe(20000);
    const lane = g.nodes.find((n) => n.id === MONEY_BACK.id)!;
    expect(lane.kind).not.toBe('source');
    expect(lane.kind).toBe('credit');
    expect(lane.label).toBe('Money back (unreviewed)');
    // the income lane beside it is the paycheck, and only the paycheck
    expect(g.nodes.filter((n) => n.kind === 'source').map((n) => n.id)).toEqual(['inc:Paychecks']);
    assertConserved(g);
  });

  it('A3 a SUGGESTED link nets nothing — an unproven match may not move a cent', () => {
    const suggested = { ...confirmedLink(CREDIT.id, PURCHASE.id, 20000), status: 'suggested' as const };
    const g = buildFlowGraph(LEDGER, ACCOUNTS, {}, { netting: flowNetting(LEDGER, ACCOUNTS, [suggested]) });
    expect(g.nettedRefundCents).toBe(0);
    expect(sum(g, (l) => l.target === 'cat:Shopping')).toBe(20000);
    expect(sum(g, (l) => l.source === MONEY_BACK.id)).toBe(20000);
  });

  it('A4 cashback is never an income source', () => {
    const cashback = tx({
      id: 'c-cash', title: 'Cashback Reward', amount: 25, type: 'income',
      accountId: 'acc-card', sourceCategory: 'Rewards', date: '2026-05-20',
    });
    const g = buildFlowGraph([PAYCHECK, PURCHASE, cashback], ACCOUNTS);
    expect(sum(g, (l) => l.source === REWARDS.id)).toBe(2500);
    expect(g.nodes.find((n) => n.id === REWARDS.id)!.kind).toBe('credit');
    expect(g.links.some((l) => l.source === `inc:Rewards`)).toBe(false);
    expect(inflowLane(cashback, { accounts: ACCOUNTS, spendingCategories: new Set() })).toEqual(REWARDS);
  });

  it('A5 card purchases are framed as borrowing, never as income', () => {
    // a card with an unpaid balance: the issuer fronted the cash for the purchase
    const owing = { ...card, openingBalance: 200 } as PaymentAccount;
    const g = buildFlowGraph([PURCHASE], [bank, owing]);
    const borrowed = g.nodes.find((n) => n.id === BORROWED_ON_CARDS.id)!;
    expect(borrowed.label).toBe('Borrowed on your cards');
    expect(borrowed.kind).toBe('card');   // filtered and coloured as card money…
    expect(borrowed.kind).not.toBe('source'); // …never as an income source
    expect(g.nodes.filter((n) => n.kind === 'source')).toEqual([]);
    assertConserved(g);
  });

  it('A6 an expense-category credit is money back, not an income source called Insurance', () => {
    const premium = tx({ id: 'e-ins', title: 'Coppice Mutual', amount: 400, sourceCategory: 'Insurance', accountId: 'acc-bank' });
    const rebate = tx({ id: 'i-ins', title: 'Coppice Mutual', amount: 154, type: 'income', sourceCategory: 'Insurance', accountId: 'acc-bank', date: '2026-05-15' });
    const g = buildFlowGraph([PAYCHECK, premium, rebate], ACCOUNTS);
    expect(sum(g, (l) => l.source === MONEY_BACK.id)).toBe(15400);
    expect(g.links.some((l) => l.source === 'inc:Insurance')).toBe(false);
    // and a category the ledger never spends in is still income
    expect(g.links.some((l) => l.source === 'inc:Paychecks')).toBe(true);
  });

  it('A7 GROSS stays reachable: the same ledger with no links is the untouched picture', () => {
    const links = [confirmedLink(CREDIT.id, PURCHASE.id, 20000)];
    const net = buildFlowGraph(LEDGER, ACCOUNTS, {}, { netting: flowNetting(LEDGER, ACCOUNTS, links) });
    const gross = buildFlowGraph(LEDGER, ACCOUNTS, {}, {}); // what the page's "Show gross" renders

    expect(sum(gross, (l) => l.target === 'cat:Shopping')).toBe(20000);
    expect(sum(net, (l) => l.target === 'cat:Shopping')).toBe(0);
    // the rows themselves never change: both graphs point at the same transactions
    expect(new Set(Object.values(gross.nodeTxnIds).flat()))
      .toEqual(new Set(Object.values(net.nodeTxnIds).flat()));
    // and the row-level arithmetic still reports gross beside net
    expect(purchaseEconomics(PURCHASE, links).grossPurchaseCents).toBe(20000);
    expect(purchaseEconomics(PURCHASE, links).netEconomicCostCents).toBe(0);
    assertConserved(gross);
    assertConserved(net);
  });

  it('A8 conservation holds on a synthetic ledger, netted and gross alike', () => {
    const links = [confirmedLink(CREDIT.id, PURCHASE.id, 20000)];
    for (const opts of [{}, { netting: flowNetting(LEDGER, ACCOUNTS, links) }]) {
      const g = buildFlowGraph(LEDGER, ACCOUNTS, {}, opts);
      assertConserved(g);
    }
  });

  it('A9 a confirmed link whose purchase is outside the period nets nothing', () => {
    // otherwise the credit vanishes from an account whose purchase is off-screen and
    // that account silently stops balancing.
    const links = [confirmedLink(CREDIT.id, PURCHASE.id, 20000)];
    const g = buildFlowGraph(LEDGER, ACCOUNTS, { start: '2026-05-05' }, { netting: flowNetting(LEDGER, ACCOUNTS, links) });
    expect(g.nettedRefundCents).toBe(0);
    expect(sum(g, (l) => l.source === MONEY_BACK.id)).toBe(20000);
    assertConserved(g);
  });
});

// ===========================================================================
// B. no more buckets called "other"
// ===========================================================================

describe('B — every "other" bucket splits into lanes that mean something', () => {
  it('B1 unpaired legs split by what the row IS and which way it went', () => {
    const leg = (id: string, dir: 'in' | 'out', category: string, accountId: string) =>
      tx({ id, title: 'Willow Bank', amount: 100, type: 'transfer', transferDirection: dir, sourceCategory: category, accountId });

    expect(unpairedLegLane(leg('a', 'in', 'Transfer', 'acc-bank'), 'in').id).toBe('self-ext-in');
    expect(unpairedLegLane(leg('b', 'out', 'Transfer', 'acc-bank'), 'out').id).toBe('self-ext-out');
    expect(unpairedLegLane(leg('c', 'in', 'Credit Card Payment', 'acc-card'), 'in').id).toBe('cardpay-in');
    expect(unpairedLegLane(leg('d', 'out', 'Credit Card Payment', 'acc-bank'), 'out').id).toBe('cardpay-out');

    // every lane names its own reason — none of them says "other"
    for (const l of [
      unpairedLegLane(leg('a', 'in', 'Transfer', 'acc-bank'), 'in'),
      unpairedLegLane(leg('d', 'out', 'Credit Card Payment', 'acc-bank'), 'out'),
    ]) {
      expect(l.label).toMatch(/other leg not found/);
      expect(l.label.toLowerCase()).not.toMatch(/other money/);
    }
  });

  it('B2 the real shape — legs with no partner land in four named lanes, not one bucket', () => {
    // reproduces the owner's shape: settlement legs and plain transfer legs, both
    // directions, none of which can pair because the far side was never imported.
    const legs = [
      tx({ id: 'u1', title: 'Willow Bank', amount: 900, type: 'transfer', transferDirection: 'in', sourceCategory: 'Transfer', accountId: 'acc-bank', date: '2026-05-03' }),
      tx({ id: 'u2', title: 'Willow Bank', amount: 300, type: 'transfer', transferDirection: 'out', sourceCategory: 'Transfer', accountId: 'acc-bank', date: '2026-05-04' }),
      tx({ id: 'u3', title: 'Willow Bank', amount: 700, type: 'transfer', transferDirection: 'in', sourceCategory: 'Credit Card Payment', accountId: 'acc-card', date: '2026-05-06' }),
      tx({ id: 'u4', title: 'Willow Bank', amount: 500, type: 'transfer', transferDirection: 'out', sourceCategory: 'Credit Card Payment', accountId: 'acc-bank', date: '2026-05-07' }),
    ];
    const g = buildFlowGraph([PAYCHECK, ...legs], ACCOUNTS);
    expect(sum(g, (l) => l.source === 'self-ext-in')).toBe(90000);
    expect(sum(g, (l) => l.target === 'self-ext-out')).toBe(30000);
    expect(sum(g, (l) => l.source === 'cardpay-in')).toBe(70000);
    expect(sum(g, (l) => l.target === 'cardpay-out')).toBe(50000);
    for (const n of g.nodes) expect(n.label).not.toMatch(/^Other money/);
    assertConserved(g);
  });

  it('B3 spending keeps 20 named categories, and the residual states its own size', () => {
    const rows = Array.from({ length: 26 }, (_, i) =>
      tx({ id: `s${i}`, title: `Merchant ${i}`, merchant: `MERCHANT ${i}`, amount: 1000 - i * 10, sourceCategory: `Category ${String(i).padStart(2, '0')}`, accountId: 'acc-bank' })
    );
    const g = buildFlowGraph([PAYCHECK, ...rows], ACCOUNTS);
    expect(g.nodes.filter((n) => n.kind === 'category' && n.id !== 'cat:other')).toHaveLength(TOP_CATEGORIES);
    const residual = g.nodes.find((n) => n.id === 'cat:other')!;
    expect(residual.label).toBe(residualCategoryLabel(6));
    expect(residual.label).toBe('6 smaller categories');
    expect(residual.label).not.toMatch(/other/i);
    assertConserved(g);
  });

  it('B4 a genuinely uncategorisable row lands in a small residual that names its reason', () => {
    const nameless = tx({ id: 'x1', title: '', merchant: '', amount: 42, sourceCategory: '', accountId: 'acc-bank' });
    const g = buildFlowGraph([PAYCHECK, nameless], ACCOUNTS);
    const lane = g.nodes.find((n) => n.kind === 'category')!;
    expect(lane.label).toBe('No category in your export');
    expect(sum(g, (l) => l.target === lane.id)).toBe(4200);
  });

  it('B5 a category the export itself calls "Other" falls back to who was paid', () => {
    expect(spendingLane('Other', 'BRIGHTLEAF')).toEqual({ key: 'nocat:BRIGHTLEAF', label: 'BRIGHTLEAF · no category' });
    expect(spendingLane('Uncategorized', 'BRIGHTLEAF').label).toBe('BRIGHTLEAF · no category');
    expect(spendingLane('Groceries', 'BRIGHTLEAF')).toEqual({ key: 'Groceries', label: 'Groceries' });
    // and it does that in the graph, so "Other" never names a lane on its own
    const rows = [
      tx({ id: 'o1', title: 'Brightleaf', merchant: 'BRIGHTLEAF', amount: 300, sourceCategory: 'Other', accountId: 'acc-bank' }),
      tx({ id: 'o2', title: 'Brightleaf', merchant: 'BRIGHTLEAF', amount: 100, sourceCategory: 'Other', accountId: 'acc-bank' }),
    ];
    const g = buildFlowGraph([PAYCHECK, ...rows], ACCOUNTS);
    expect(g.nodes.some((n) => n.label === 'Other')).toBe(false);
    expect(sum(g, (l) => l.target === 'cat:nocat:BRIGHTLEAF')).toBe(40000);
  });

  it('B6 spendingCategoryIndex reads the whole ledger, not the visible period', () => {
    const idx = spendingCategoryIndex([PURCHASE, PAYCHECK], ACCOUNTS);
    expect(idx.has('Shopping')).toBe(true);
    expect(idx.has('Paychecks')).toBe(false);
  });

  it('B7 an unexplained card credit says so instead of claiming to be a refund', () => {
    const odd = tx({ id: 'c-odd', title: 'Brightleaf Adjustment', amount: 60, type: 'income', sourceCategory: 'Investments', accountId: 'acc-card', date: '2026-05-18' });
    const g = buildFlowGraph([PAYCHECK, PURCHASE, odd], ACCOUNTS);
    expect(sum(g, (l) => l.source === CARD_CREDIT_UNEXPLAINED.id)).toBe(6000);
    expect(g.nodes.find((n) => n.id === CARD_CREDIT_UNEXPLAINED.id)!.kind).toBe('credit');
  });
});

// ===========================================================================
// The netting layer agrees with FIN-REFUND-001's own arithmetic
// ===========================================================================

describe('flowNetting consumes the existing modules rather than diverging from them', () => {
  it('N1 allocation totals equal purchaseEconomics() and refundEconomics(), to the cent', () => {
    const links = [confirmedLink(CREDIT.id, PURCHASE.id, 12500)];
    const { allocations } = flowNetting([PAYCHECK, PURCHASE, CREDIT], ACCOUNTS, links);
    const perPurchase = allocations.filter((a) => a.purchaseId === PURCHASE.id).reduce((s, a) => s + a.cents, 0);
    const perCredit = allocations.filter((a) => a.creditId === CREDIT.id).reduce((s, a) => s + a.cents, 0);
    expect(perPurchase).toBe(purchaseEconomics(PURCHASE, links).confirmedRefundedCents);
    expect(perCredit).toBe(refundEconomics(CREDIT, links).allocatedRefundCents);
  });

  it('N2 a partly-allocated credit keeps its unallocated remainder in the money-back lane', () => {
    const links = [confirmedLink(CREDIT.id, PURCHASE.id, 12500)];
    const g = buildFlowGraph([PAYCHECK, PURCHASE, CREDIT], ACCOUNTS, {}, {
      netting: flowNetting([PAYCHECK, PURCHASE, CREDIT], ACCOUNTS, links),
    });
    expect(sum(g, (l) => l.target === 'cat:Shopping')).toBe(20000 - 12500);
    expect(sum(g, (l) => l.source === MONEY_BACK.id)).toBe(20000 - 12500);
    expect(refundEconomics(CREDIT, links).unallocatedRefundCents).toBe(7500);
    assertConserved(g);
  });

  it('N3 the card-credit ladder places a confirmed reversal, whatever the text says', () => {
    // "reversal_of" is rung 3 — a LINK-derived fact that outranks a row whose words say
    // nothing at all. Without the ladder this credit would read as merely unexplained.
    const quiet = tx({
      id: 'c-quiet', title: 'Brightleaf', merchant: 'BRIGHTLEAF', amount: 80,
      type: 'income', sourceCategory: 'Investments', accountId: 'acc-card', date: '2026-05-21',
    });
    const spend = tx({ id: 'p-quiet', title: 'Brightleaf', merchant: 'BRIGHTLEAF', amount: 80, sourceCategory: 'Investments', accountId: 'acc-card', date: '2026-05-12' });
    const LEDGER = [PAYCHECK, spend, quiet];
    // With no link the ladder determines NOTHING (rung 7), and says so by recording no
    // lane — which is what lets the leaf apply the evidence it can see.
    const bare = flowNetting(LEDGER, ACCOUNTS, []);
    expect(bare.laneOf.has(quiet.id)).toBe(false);
    expect(inflowLane(quiet, { accounts: ACCOUNTS, laneOf: bare.laneOf, spendingCategories: new Set() }))
      .toEqual(CARD_CREDIT_UNEXPLAINED);

    const reversal: TransactionLink = {
      ...confirmedLink(quiet.id, spend.id, 8000), id: `reversal_of~${quiet.id}~${spend.id}`, linkType: 'reversal_of',
    };
    const withLink = flowNetting(LEDGER, ACCOUNTS, [reversal]);
    expect(withLink.laneOf.get(quiet.id)).toEqual(MONEY_BACK);
  });
});

// ===========================================================================
// C. labels that do not print through each other
// ===========================================================================

describe('C — label layout', () => {
  it('C1 a column always gets enough height for non-overlapping label positions', () => {
    // one column of N nodes; every one of them needs a slot the label can sit in
    for (const n of [2, 9, 21, 40]) {
      const nodes = [{ id: 'src' }, ...Array.from({ length: n }, (_, i) => ({ id: `t${i}` }))];
      const links = Array.from({ length: n }, (_, i) => ({ source: 'src', target: `t${i}` }));
      const height = sankeyHeightFor(nodes, links);
      expect(columnFits(n, height)).toBe(true);
      // …and the positions those slots imply really are non-overlapping: an 11px label
      // needs ~13px, and every slot is at least the node padding apart.
      const slot = height / n;
      expect(slot).toBeGreaterThanOrEqual(13);
    }
  });

  it('C2 the guard is what fails at the old fixed height, which is the reported bug', () => {
    expect(columnFits(40, 560)).toBe(false);          // 40 nodes in 560px: labels collide
    expect(columnFits(40, sankeyHeightFor(
      [{ id: 's' }, ...Array.from({ length: 40 }, (_, i) => ({ id: `t${i}` }))],
      Array.from({ length: 40 }, (_, i) => ({ source: 's', target: `t${i}` }))
    ))).toBe(true);
  });

  it('C3 a long label is cut to the gutter and keeps the whole string in its title', () => {
    const long = 'Customized Cash Rewards Visa Signature · $30,482.79';
    const interior = labelMaxChars({ depth: 1, maxDepth: 3, plotWidthPx: 654, rightMarginPx: 230, nodeWidthPx: 12 });
    const shown = fitLabel(long, interior);
    expect(shown.length).toBeLessThanOrEqual(interior);
    expect(shown.endsWith('…')).toBe(true);
    expect(long.startsWith(shown.slice(0, -1).trimEnd())).toBe(true); // nothing invented
    // a label that already fits is left exactly alone
    expect(fitLabel('Groceries', interior)).toBe('Groceries');
  });

  it('C4 the last column gets the reserved right margin, interior columns get the pitch', () => {
    const last = labelMaxChars({ depth: 3, maxDepth: 3, plotWidthPx: 654, rightMarginPx: 230, nodeWidthPx: 12 });
    const interior = labelMaxChars({ depth: 1, maxDepth: 3, plotWidthPx: 654, rightMarginPx: 230, nodeWidthPx: 12 });
    expect(last).toBeGreaterThan(interior);
    // an interior label can never be wide enough to reach the next column's node
    const pitchPx = (654 - 12) / 3;
    expect(interior * 6).toBeLessThan(pitchPx);
  });

  it('C5 real graph geometry: no column is asked to fit in less room than it needs', () => {
    const rows = Array.from({ length: 30 }, (_, i) =>
      tx({ id: `s${i}`, title: `Merchant ${i}`, merchant: `M${i}`, amount: 500 + i, sourceCategory: `Cat ${i}`, accountId: 'acc-bank' })
    );
    const g = buildFlowGraph([PAYCHECK, ...rows], ACCOUNTS);
    const height = sankeyHeightFor(g.nodes, g.links);
    const counts = columnCounts(g.nodes, g.links);
    expect(Math.max(...counts)).toBeGreaterThan(1); // the fixture really does crowd a column
    for (const count of counts) expect(columnFits(count, height)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// D. Payroll drawn as "Other" — reported from the owner's live screen
// ---------------------------------------------------------------------------

describe('D an income row with no provider category is named by its PAYER', () => {
  // Exactly the shape that reached the owner's chart: real payroll, semi-monthly,
  // arriving with no provider category at all. `category` defaults to 'other'.
  const payroll = (id: string, date: string, amount: number): Transaction =>
    tx({ id, title: 'The Canton Payroll', merchant: 'The Canton Payroll', amount, type: 'income', date, accountId: 'acc-bank' });

  const ROWS = [
    payroll('pay-1', '2026-06-22', 4326.25),
    payroll('pay-2', '2026-07-07', 4351.25),
    payroll('pay-3', '2026-07-22', 4309.93),
  ];

  // "Other" is in the spending index because uncategorised SPENDING reads as "Other"
  // too — which is the whole trap.
  const uncategorisedSpend = tx({ id: 'sp-1', title: 'Corner shop', amount: 40, accountId: 'acc-bank' });
  const spendingCategories = spendingCategoryIndex([uncategorisedSpend], ACCOUNTS);

  it('has "Other" in the spending index — the condition that caused this', () => {
    expect(spendingCategories.has('Other')).toBe(true);
  });

  it('names the lane after the payer, not the expense-category default', () => {
    const lane = inflowLane(ROWS[0], { accounts: ACCOUNTS, spendingCategories });
    // Was `inc:Other`, drawn on the chart as a lane literally called "Other".
    expect(lane.id).toBe('inc:The Canton Payroll');
    expect(lane.label).toBe('The Canton Payroll');
    expect(lane.kind).toBe('source');
  });

  it('does not draw payroll as money coming back', () => {
    // The second bug on the same line: `displayCategory` substituted "Other", the
    // spending index contains "Other", so this rung swallowed the row.
    expect(inflowLane(ROWS[0], { accounts: ACCOUNTS, spendingCategories })).not.toEqual(MONEY_BACK);
  });

  it('still trusts the provider category when there IS one', () => {
    // The behaviour this rung was built for must survive: a credit the provider tagged
    // with a category the owner spends in is money coming back, not an income source.
    const insuranceRefund = tx({
      id: 'ins-1', title: 'Trellis Mutual', merchant: 'Trellis Mutual', amount: 154,
      type: 'income', sourceCategory: 'Insurance', accountId: 'acc-bank',
    });
    const spendsInsurance = spendingCategoryIndex(
      [tx({ id: 'sp-2', title: 'Trellis Mutual', amount: 300, sourceCategory: 'Insurance', accountId: 'acc-bank' })],
      ACCOUNTS
    );
    expect(inflowLane(insuranceRefund, { accounts: ACCOUNTS, spendingCategories: spendsInsurance })).toEqual(MONEY_BACK);
  });

  it('names it by payer on the APPROVED-SOURCE branch too', () => {
    // Two call sites build an `inc:` lane — one for money an approved source claims,
    // one for everything else that survives the ladder. Both were using the expense
    // category, so fixing only the branch a test happens to hit fixes nothing.
    const income = {
      sources: [{
        id: 'src-canton', name: 'The Canton Payroll', amount: 4330, frequency: 'biweekly' as const,
        isActive: true, userApproved: true,
      }],
    };
    const lane = inflowLane(ROWS[0], { accounts: ACCOUNTS, spendingCategories, income } as never);
    expect(lane.id).toBe('inc:The Canton Payroll');
  });

  it('the three deposits land in ONE payer lane on the chart', () => {
    const g: FlowGraph = buildFlowGraph([...ROWS, uncategorisedSpend], ACCOUNTS);
    const inc = g.nodes.filter((n) => n.id.startsWith('inc:'));
    expect(inc.map((n) => n.label)).toEqual(['The Canton Payroll']);
    const cents = g.links.filter((l) => l.source === inc[0].id).reduce((s, l) => s + l.cents, 0);
    expect(cents).toBe(1298743); // $12,987.43 — the figure the owner saw under "Other"
  });
});

// ---------------------------------------------------------------------------
// E. Confirmed non-income meanings get their OWN lanes — found on the live screen
// ---------------------------------------------------------------------------

describe('E a confirmed non-income meaning is never drawn as income', () => {
  // After the owner named their loan, chit pool and tax refunds, the totals excluded
  // them (the earned-income gate held) but the chart still DREW them in `inc:` lanes:
  // the tile read $246,998.82 "earned" against a true $211,967.63. A lane the totals
  // exclude and the chart includes is a lie with an alibi.
  const inflow = (id: string, meaning: string) => {
    const t = tx({ id, title: 'DEMO CREDIT', merchant: 'DEMO CREDIT', amount: 500, type: 'income', accountId: 'acc-bank' });
    const income = { reviews: { [id]: { transactionId: id, state: 'confirmed', meaning, updatedAt: '', source: 'user' } } };
    return inflowLane(t, { accounts: ACCOUNTS, spendingCategories: new Set<string>(), income } as never);
  };

  it('routes each confirmed meaning to its own lane, none of them inc:', () => {
    expect(inflow('l1', 'loan_proceeds').id).toBe('borrowed-in');
    expect(inflow('c1', 'chit_fund_payout').id).toBe('chit-in');
    expect(inflow('o1', 'other_non_income_credit').id).toBe('credits-other');
    expect(inflow('i1', 'internal_transfer').id).toBe('self-ext-in'); // merges with the existing stub
    expect(inflow('r1', 'receivable_repayment').id).toBe('person-in:others');
    expect(inflow('s1', 'shared_expense_reimbursement').id).toBe('person-in:others');
  });

  it('confirmed earned income still lands in an inc: lane', () => {
    expect(inflow('e1', 'earned_income').id).toMatch(/^inc:/);
  });

  it('an UNANSWERED inflow keeps the fallback — the honest inc: lane the queue asks about', () => {
    const t = tx({ id: 'u1', title: 'MYSTERY DEPOSIT', merchant: 'MYSTERY DEPOSIT', amount: 500, type: 'income', accountId: 'acc-bank' });
    expect(inflowLane(t, { accounts: ACCOUNTS, spendingCategories: new Set<string>() }).id).toMatch(/^inc:/);
  });
});
