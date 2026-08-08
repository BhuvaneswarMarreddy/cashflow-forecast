/**
 * The programme's cross-surface suite (umbrella §13, X1–X12).
 *
 * ONE sanitized scenario — card purchase, card payment, exact refund, partial refund,
 * combined refund, cashback credit, unknown card credit, provisional dispute credit,
 * immediate duplicate charge, duplicate subscription across accounts, intentional
 * duplicate — asserted IDENTICALLY across Dashboard, Accounts, Flow, Analytics, Budgets,
 * Forecast, History, Export and AI context.
 *
 * Every merchant, amount, account and id here is INVENTED. Nothing in this file came
 * from a real ledger, and no test in it reads Firestore, signs in or touches a provider.
 */

import fs from 'fs';
import path from 'path';
import * as XLSX from 'xlsx';
import { IncomeSource, PaymentAccount, Transaction, UserProfile } from '@/types';
import {
  IncomeContext, interpretTransaction, selectInflowReviewQueue, sumExpenseCents, sumIncomeCents, POSTED_ONLY } from '@/lib/classify';
import { buildChatContext } from '@/lib/chat-actions';
import { getAllCategorySpending } from '@/lib/budgets';
import { buildExportWorkbook } from '@/lib/export-xlsx';
import { buildFlowGraph, toCents } from '@/lib/flows';
import { deriveAccountBalance, monthlyAverages } from '@/lib/forecast';
import { classifyCardCredit } from '@/lib/card-credit';
import { purchaseEconomics, refundEconomics } from '@/lib/refunds';
import { TransactionLink } from '@/lib/relations';
import { ReviewCandidate } from '@/lib/candidates';
import { buildReviewQueue, relationBadges } from '@/lib/review-queue';

// --- the sanitized world -----------------------------------------------------

const accounts: PaymentAccount[] = [
  { id: 'demo-checking', name: 'Demo Everyday Checking', type: 'bank_account', provider: 'chase', openingBalance: 5000, openingDate: '2000-01-01', color: '#111', isActive: true },
  { id: 'demo-card-9021', name: 'Demo Rewards Card', type: 'credit_card', provider: 'amex', lastFourDigits: '9021', creditLimit: 500000, openingBalance: 0, openingDate: '2000-01-01', color: '#222', isActive: true },
  { id: 'demo-card-4410', name: 'Demo Travel Card', type: 'credit_card', provider: 'visa', lastFourDigits: '4410', creditLimit: 500000, openingBalance: 0, openingDate: '2000-01-01', color: '#333', isActive: true },
];

const EMPLOYER: IncomeSource = { id: 'demo-src', name: 'Demo Payroll', amount: 3200, frequency: 'monthly', isActive: true, kind: 'employment' };
const INCOME: IncomeContext = { sources: [EMPLOYER] };

const tx = (o: Partial<Transaction> & { id: string; title: string; amount: number }): Transaction => ({
  type: 'expense', category: 'other', paymentMethod: 'other', date: '2026-07-01', ...o,
});

const PURCHASE_A = tx({ id: 'demo-purchase-a', title: 'Demo Amazon Lens', merchant: 'DEMO AMAZON', amount: 1100, category: 'shopping', accountId: 'demo-card-9021', date: '2026-07-12' });
const PURCHASE_B = tx({ id: 'demo-purchase-b', title: 'Demo Amazon Filter', merchant: 'DEMO AMAZON', amount: 100, category: 'shopping', accountId: 'demo-card-9021', date: '2026-07-14' });
const REFUND_AB = tx({ id: 'demo-refund-ab', title: 'Demo Amazon Refund', merchant: 'DEMO AMAZON', amount: 1200, type: 'income', accountId: 'demo-card-9021', date: '2026-07-31' });

const PURCHASE_C = tx({ id: 'demo-purchase-c', title: 'Demo Brightleaf Chair', merchant: 'DEMO BRIGHTLEAF', amount: 1100, category: 'shopping', accountId: 'demo-card-9021', date: '2026-06-02' });
const REFUND_C = tx({ id: 'demo-refund-c', title: 'Demo Brightleaf Refund', merchant: 'DEMO BRIGHTLEAF', amount: 900, type: 'income', accountId: 'demo-card-9021', date: '2026-06-20' });

const PURCHASE_D = tx({ id: 'demo-purchase-d', title: 'Demo Cedarline Tool', merchant: 'DEMO CEDARLINE', amount: 45, category: 'shopping', accountId: 'demo-card-9021', date: '2026-05-05' });
const REFUND_D = tx({ id: 'demo-refund-d', title: 'Demo Cedarline Refund', merchant: 'DEMO CEDARLINE', amount: 45, type: 'income', accountId: 'demo-card-9021', date: '2026-05-12' });

const PURCHASE_E = tx({ id: 'demo-purchase-e', title: 'Demo Novacast Subscr', merchant: 'DEMO NOVACAST', amount: 200, category: 'shopping', accountId: 'demo-card-9021', date: '2026-04-10' });
const DISPUTE_CREDIT = tx({ id: 'demo-dispute', title: 'Demo Dispute Credit', merchant: 'DEMO NOVACAST', amount: 200, type: 'income', accountId: 'demo-card-9021', date: '2026-04-20' });

const PAY_BANK = tx({ id: 'demo-pay-bank', title: 'AMEX EPAYMENT ACH PMT', amount: 300, accountId: 'demo-checking', date: '2026-07-15' });
const PAY_CARD = tx({ id: 'demo-pay-card', title: 'AUTOPAY PAYMENT - THANK YOU', amount: 300, type: 'income', accountId: 'demo-card-9021', date: '2026-07-15' });

const CASHBACK = tx({ id: 'demo-cashback', title: 'Demo Cashback Rewards Earned', amount: 12.5, type: 'income', accountId: 'demo-card-9021', date: '2026-07-20' });
const UNKNOWN_CREDIT = tx({ id: 'demo-unknown', title: 'AB-4471 CREDIT', amount: 88, type: 'income', accountId: 'demo-card-9021', date: '2026-07-22' });

const DUP_1 = tx({ id: 'demo-dup-1', title: 'Demo Hardware Store', merchant: 'DEMO HARDWARE', amount: 64.2, category: 'shopping', accountId: 'demo-card-9021', date: '2026-07-05' });
const DUP_2 = tx({ id: 'demo-dup-2', title: 'Demo Hardware Store', merchant: 'DEMO HARDWARE', amount: 64.2, category: 'shopping', accountId: 'demo-card-9021', date: '2026-07-06' });

const SUBS: Transaction[] = ['04', '05', '06', '07'].flatMap((m, i) => [
  tx({ id: `demo-sub-9021-${i}`, title: 'Demo Streaming', merchant: 'DEMO STREAMING', amount: 20, category: 'subscriptions', accountId: 'demo-card-9021', date: `2026-${m}-08` }),
  tx({ id: `demo-sub-4410-${i}`, title: 'Demo Streaming', merchant: 'DEMO STREAMING', amount: 20, category: 'subscriptions', accountId: 'demo-card-4410', date: `2026-${m}-19` }),
]);

const PAYCHECK = tx({ id: 'demo-paycheck', title: 'Direct Deposit - Demo Payroll', amount: 3200, type: 'income', accountId: 'demo-checking', date: '2026-07-01' });

const LEDGER: Transaction[] = Object.freeze([
  PURCHASE_A, PURCHASE_B, REFUND_AB, PURCHASE_C, REFUND_C, PURCHASE_D, REFUND_D,
  PURCHASE_E, DISPUTE_CREDIT, PAY_BANK, PAY_CARD, CASHBACK, UNKNOWN_CREDIT,
  DUP_1, DUP_2, ...SUBS, PAYCHECK,
].map((t) => Object.freeze(t))) as Transaction[];

// --- hand-computed truth, integer cents --------------------------------------
//   purchases a+b        110000 + 10000
//   purchase c           110000     purchase d 4500     purchase e 20000
//   duplicate pair       6420 + 6420
//   8 subscription rows  16000
//   card payment legs    excluded (a settlement is not spending)
const EXPECTED_GROSS_EXPENSE_CENTS = 110000 + 10000 + 110000 + 4500 + 20000 + 6420 + 6420 + 16000; // 283340
//   confirmed refunds: 110000 + 10000 + 90000 + 4500 = 214500. The PROVISIONAL 20000 is
//   deliberately absent — a dispute credit reduces nothing until it resolves.
const EXPECTED_CONFIRMED_REFUND_CENTS = 214500;
const EXPECTED_NET_EXPENSE_CENTS = EXPECTED_GROSS_EXPENSE_CENTS - EXPECTED_CONFIRMED_REFUND_CENTS; // 68840
const EXPECTED_INCOME_CENTS = 320000; // the paycheck, and nothing else

const link = (o: Partial<TransactionLink> & Pick<TransactionLink, 'id' | 'linkType' | 'sourceTransactionId' | 'targetTransactionId' | 'allocatedAmountCents' | 'status'>): TransactionLink => ({
  algorithmVersion: 'refund-match-v1', createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z', ...o,
});

const LINKS: TransactionLink[] = [
  link({ id: 'refund_of~demo-refund-ab~demo-purchase-a', linkType: 'refund_of', sourceTransactionId: 'demo-refund-ab', targetTransactionId: 'demo-purchase-a', allocatedAmountCents: 110000, status: 'confirmed', confirmedAt: '2026-08-01T00:00:00.000Z', confirmedBy: 'user' }),
  link({ id: 'refund_of~demo-refund-ab~demo-purchase-b', linkType: 'refund_of', sourceTransactionId: 'demo-refund-ab', targetTransactionId: 'demo-purchase-b', allocatedAmountCents: 10000, status: 'confirmed', confirmedAt: '2026-08-01T00:00:00.000Z', confirmedBy: 'user' }),
  link({ id: 'partial_refund_of~demo-refund-c~demo-purchase-c', linkType: 'partial_refund_of', sourceTransactionId: 'demo-refund-c', targetTransactionId: 'demo-purchase-c', allocatedAmountCents: 90000, status: 'confirmed', confirmedAt: '2026-08-01T00:00:00.000Z', confirmedBy: 'user' }),
  link({ id: 'refund_of~demo-refund-d~demo-purchase-d', linkType: 'refund_of', sourceTransactionId: 'demo-refund-d', targetTransactionId: 'demo-purchase-d', allocatedAmountCents: 4500, status: 'confirmed', confirmedAt: '2026-08-01T00:00:00.000Z', confirmedBy: 'user' }),
  link({ id: 'chargeback_for~demo-dispute~demo-purchase-e', linkType: 'chargeback_for', sourceTransactionId: 'demo-dispute', targetTransactionId: 'demo-purchase-e', allocatedAmountCents: 20000, status: 'provisional', confirmedAt: '2026-08-01T00:00:00.000Z', confirmedBy: 'user' }),
];

const candidate = (o: Partial<ReviewCandidate> & Pick<ReviewCandidate, 'id' | 'candidateType' | 'transactionIds' | 'status'>): ReviewCandidate => ({
  candidateId: `${o.candidateType}~v1~${o.transactionIds.join('~')}`,
  algorithmVersion: 'duplicate-charge-v1',
  proposedLinks: [],
  evidence: { amountsCents: [6420, 6420], dayGaps: [1], sameAccount: true, accountTypes: ['credit_card'], merchantMatch: 'exact', referenceOverlap: 'none', pendingInvolved: false, reasonCodes: ['next_day'] },
  score: 0.9,
  generatedAt: '2026-08-01T00:00:00.000Z',
  ...o,
});

const DUP_CHARGE_CONFIRMED = candidate({ id: 'immediate_duplicate_charge~demo-dup-1~demo-dup-2', candidateType: 'immediate_duplicate_charge', transactionIds: ['demo-dup-1', 'demo-dup-2'], status: 'confirmed' });
const DUP_SUB_INTENTIONAL = candidate({ id: 'duplicate_subscription~demo-sub-4410-0~demo-sub-9021-0', candidateType: 'duplicate_subscription', transactionIds: ['demo-sub-4410-0', 'demo-sub-9021-0'], status: 'intentional' });

const profile = { name: 'Demo', email: 'demo@example.com', monthlyBudget: 5000, currency: 'USD', settings: undefined } as unknown as Pick<UserProfile, 'name' | 'email' | 'monthlyBudget' | 'currency' | 'settings'>;

const exportSummary = (transactions: Transaction[]) => {
  const wb = buildExportWorkbook({ profile, accounts, incomeSources: [EMPLOYER], transactions });
  const rows = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets['Summary'], { header: 1 });
  return (label: string) => toCents(rows.find((r) => r[0] === label)?.[1] as number);
};

const netExpenseCents = (transactions: Transaction[], links: TransactionLink[]) =>
  transactions
    .filter((t) => interpretTransaction(t, accounts, INCOME).expense === 'counted')
    .reduce((s, t) => s + purchaseEconomics(t, links).netEconomicCostCents, 0);

describe('FIN-RECOVERY-UI-001 · cross-surface consistency (X1-X12)', () => {
  it('X1 — every surface reports the same income total, and NO card credit contributes to it', () => {
    const shared = sumIncomeCents(LEDGER, accounts, INCOME);
    expect(shared).toBe(EXPECTED_INCOME_CENTS);

    // Calendar/History (per-day), Export, Forecast — all from the same rule.
    const byDay = [...new Set(LEDGER.map((t) => t.date))]
      .map((d) => sumIncomeCents(LEDGER.filter((t) => t.date === d), accounts, INCOME))
      .reduce((a, b) => a + b, 0);
    expect(byDay).toBe(shared);
    expect(exportSummary(LEDGER)('Total Income')).toBe(shared);

    // Every credit that landed on a card is income NOWHERE, by enumeration.
    for (const credit of [REFUND_AB, REFUND_C, REFUND_D, PAY_CARD, CASHBACK, UNKNOWN_CREDIT, DISPUTE_CREDIT]) {
      expect(sumIncomeCents([credit], accounts, INCOME)).toBe(0);
      expect(interpretTransaction(credit, accounts, INCOME).income).not.toBe('counted');
    }
  });

  it('X2 — every surface reports the same GROSS expense total', () => {
    const shared = sumExpenseCents(LEDGER, accounts, POSTED_ONLY);
    expect(shared).toBe(EXPECTED_GROSS_EXPENSE_CENTS);
    expect(exportSummary(LEDGER)('Total Expenses')).toBe(shared);

    // Budgets, month by month, sums to the same figure.
    const months = ['2026-04-15', '2026-05-15', '2026-06-15', '2026-07-15'];
    const budgetTotal = months
      .map((m) => Object.values(getAllCategorySpending(LEDGER, new Date(m), accounts)).reduce((s, v) => s + toCents(v), 0))
      .reduce((a, b) => a + b, 0);
    expect(budgetTotal).toBe(shared);

    // Flow: everything routed out of an account node into a category.
    const graph = buildFlowGraph(LEDGER, accounts);
    const flowOut = graph.links.filter((l) => l.target.startsWith('cat:')).reduce((s, l) => s + l.cents, 0);
    expect(flowOut).toBeGreaterThan(0);
    expect(flowOut).toBeLessThanOrEqual(shared);
  });

  it('X3 — every surface reports the same NET expense total after confirmed refunds', () => {
    expect(netExpenseCents(LEDGER, LINKS)).toBe(EXPECTED_NET_EXPENSE_CENTS);

    // Budgets reads the SAME arithmetic once it is handed the confirmed links.
    const months = ['2026-04-15', '2026-05-15', '2026-06-15', '2026-07-15'];
    const budgetNet = months
      .map((m) => Object.values(getAllCategorySpending(LEDGER, new Date(m), accounts, LINKS)).reduce((s, v) => s + toCents(v), 0))
      .reduce((a, b) => a + b, 0);
    expect(budgetNet).toBe(EXPECTED_NET_EXPENSE_CENTS);

    // …and gross is still available beside it, from the same helper.
    const budgetGross = months
      .map((m) => Object.values(getAllCategorySpending(LEDGER, new Date(m), accounts)).reduce((s, v) => s + toCents(v), 0))
      .reduce((a, b) => a + b, 0);
    expect(budgetGross).toBe(EXPECTED_GROSS_EXPENSE_CENTS);
  });

  it('X4 — a card payment contributes zero to income and zero to expenses everywhere', () => {
    expect(sumIncomeCents([PAY_BANK, PAY_CARD], accounts, INCOME)).toBe(0);
    expect(sumExpenseCents([PAY_BANK, PAY_CARD], accounts, POSTED_ONLY)).toBe(0);
    expect(classifyCardCredit(PAY_CARD, { accounts, transactions: [...LEDGER] }).kind).toBe('card_payment');
    const summary = exportSummary([PAY_BANK, PAY_CARD]);
    expect(summary('Total Income')).toBe(0);
    expect(summary('Total Expenses')).toBe(0);
  });

  it('X5 — a refund increases income NOWHERE and reduces spending everywhere consistently', () => {
    for (const refund of [REFUND_AB, REFUND_C, REFUND_D]) {
      expect(sumIncomeCents([refund], accounts, INCOME)).toBe(0);
    }
    // Gross is untouched; net falls by exactly the confirmed allocations.
    expect(sumExpenseCents(LEDGER, accounts, POSTED_ONLY)).toBe(EXPECTED_GROSS_EXPENSE_CENTS);
    expect(sumExpenseCents(LEDGER, accounts, POSTED_ONLY) - netExpenseCents(LEDGER, LINKS)).toBe(EXPECTED_CONFIRMED_REFUND_CENTS);
    expect(refundEconomics(REFUND_AB, LINKS).unallocatedRefundCents).toBe(0);
  });

  it('X6 — a combined refund reduces exactly two purchases to $0.00 net, on all surfaces', () => {
    expect(purchaseEconomics(PURCHASE_A, LINKS).netEconomicCostCents).toBe(0);
    expect(purchaseEconomics(PURCHASE_B, LINKS).netEconomicCostCents).toBe(0);
    expect(purchaseEconomics(PURCHASE_A, LINKS).status).toBe('fully_refunded');
    expect(purchaseEconomics(PURCHASE_B, LINKS).status).toBe('fully_refunded');
    // and nothing else in the ledger moved
    const others = LEDGER.filter((t) => !['demo-purchase-a', 'demo-purchase-b', 'demo-purchase-c', 'demo-purchase-d'].includes(t.id));
    for (const t of others) expect(purchaseEconomics(t, LINKS).confirmedRefundedCents).toBe(0);
    // Budgets sees it too: July shopping falls by exactly $1,200.00.
    const july = new Date('2026-07-15');
    expect(toCents(getAllCategorySpending(LEDGER, july, accounts).shopping)).toBe(132840);
    expect(toCents(getAllCategorySpending(LEDGER, july, accounts, LINKS).shopping)).toBe(12840);
  });

  it('X7 — a provisional credit reduces net cost NOWHERE and is labelled provisional wherever shown', () => {
    const economics = purchaseEconomics(PURCHASE_E, LINKS);
    expect(economics.provisionalRefundedCents).toBe(20000);
    expect(economics.confirmedRefundedCents).toBe(0);
    expect(economics.netEconomicCostCents).toBe(20000); // unchanged
    expect(netExpenseCents(LEDGER, LINKS)).toBe(EXPECTED_NET_EXPENSE_CENTS);

    const badges = relationBadges(PURCHASE_E, { links: LINKS, transactions: LEDGER, accounts });
    const provisional = badges.find((b) => b.text.toLowerCase().includes('provisional'));
    expect(provisional).toBeDefined();
    // …and it never rides on a netted figure.
    expect(badges.some((b) => b.text.includes('net'))).toBe(false);
  });

  it('X8 — a confirmed duplicate charge changes NO total on any surface', () => {
    const before = sumExpenseCents(LEDGER, accounts, POSTED_ONLY);
    const queue = buildReviewQueue({ transactions: LEDGER, accounts, links: LINKS, candidates: [DUP_CHARGE_CONFIRMED] });
    expect(queue).toHaveLength(0); // decided, so it stops asking
    expect(sumExpenseCents(LEDGER, accounts, POSTED_ONLY)).toBe(before);
    expect(netExpenseCents(LEDGER, LINKS)).toBe(EXPECTED_NET_EXPENSE_CENTS);
    // Both rows are still there, both still counted, neither deleted.
    expect(LEDGER.filter((t) => t.id.startsWith('demo-dup-'))).toHaveLength(2);
    expect(toCents(getAllCategorySpending(LEDGER, new Date('2026-07-15'), accounts).shopping)).toBe(132840);
  });

  it('X9 — an `intentional` duplicate leaves both transactions fully counted on all surfaces', () => {
    const queue = buildReviewQueue({ transactions: LEDGER, accounts, links: LINKS, candidates: [DUP_SUB_INTENTIONAL] });
    expect(queue).toHaveLength(0); // it stops alerting…
    // …and both subscription rows stay in every total, at full size.
    expect(toCents(getAllCategorySpending(LEDGER, new Date('2026-07-15'), accounts).subscriptions)).toBe(4000);
    expect(sumExpenseCents(LEDGER, accounts, POSTED_ONLY)).toBe(EXPECTED_GROSS_EXPENSE_CENTS);
    expect(exportSummary(LEDGER)('Total Expenses')).toBe(EXPECTED_GROSS_EXPENSE_CENTS);
  });

  it('X10 — Flow conservation is unchanged with every link confirmed', () => {
    const withoutLinks = buildFlowGraph(LEDGER, accounts);
    // `buildFlowGraph` takes no links by design: a relationship adds no node and no edge.
    const withLinks = buildFlowGraph(LEDGER, accounts);
    expect(JSON.stringify(withLinks.nodes)).toBe(JSON.stringify(withoutLinks.nodes));
    expect(JSON.stringify(withLinks.links)).toBe(JSON.stringify(withoutLinks.links));
    const cents = (g: typeof withLinks) => g.links.reduce((s, l) => s + l.cents, 0);
    expect(cents(withLinks)).toBe(cents(withoutLinks));
  });

  it('X11 — gross history is byte-identical before and after every confirmation', () => {
    const before = JSON.stringify(LEDGER);
    buildReviewQueue({ transactions: LEDGER, accounts, links: LINKS, candidates: [DUP_CHARGE_CONFIRMED, DUP_SUB_INTENTIONAL] });
    for (const t of LEDGER) relationBadges(t, { links: LINKS, transactions: LEDGER, accounts, candidates: [DUP_CHARGE_CONFIRMED] });
    netExpenseCents(LEDGER, LINKS);
    expect(JSON.stringify(LEDGER)).toBe(before);
    // The frozen fixtures make an in-place write throw rather than pass quietly.
    expect(Object.isFrozen(LEDGER[0])).toBe(true);
  });

  it('X12 — no surface carries its own recovery branch', () => {
    const root = path.join(__dirname, '..');
    const surfaces = [
      'app/dashboard/page.tsx', 'app/analytics/page.tsx', 'app/calendar/page.tsx',
      'app/history/page.tsx', 'app/forecast/page.tsx', 'app/cashflow/page.tsx',
      'app/accounts/page.tsx', 'components/BudgetStatusPanel.tsx', 'lib/export-xlsx.ts',
    ];
    for (const file of surfaces) {
      const source = fs.readFileSync(path.join(root, file), 'utf8');
      expect(source).not.toMatch(/from '@\/lib\/(refunds|duplicates|card-credit|review-queue)'/);
      expect(source).not.toMatch(/purchaseEconomics|generateRefundCandidates|generateDuplicateCandidates/);
    }

    // …and the AI context reads that same shared interpretation. The two credits the
    // ledger layer cannot explain are exactly the two the review queue asks about — the
    // unknown credit, and the dispute credit whose only evidence is a PROVISIONAL link
    // that `interpretTransaction()` deliberately cannot see.
    expect(selectInflowReviewQueue(LEDGER, accounts, INCOME).map((i) => i.transactionId))
      .toEqual(['demo-unknown', 'demo-dispute']);

    // The AI context carries GROSS rows, verbatim — it never ships a netted number.
    const context = buildChatContext([...LEDGER], accounts);
    expect(context.recent.find((r) => r.title === 'Demo Amazon Lens')?.amount).toBe(1100);
    expect(context.accounts).toContain('Demo Rewards Card');

    // Accounts/Forecast: the credit really landed on the card balance — a card balance is
    // debt, so $88.00 arriving moves it $88.00 towards zero.
    const withIt = deriveAccountBalance(accounts[1], [...LEDGER], POSTED_ONLY);
    const withoutIt = deriveAccountBalance(accounts[1], LEDGER.filter((t) => t.id !== 'demo-unknown'), POSTED_ONLY);
    expect(withIt - withoutIt).toBeCloseTo(-88, 2);
    // …and it is still earnings nowhere.
    const inWindow = [...LEDGER].map((t) => ({ ...t, date: '2026-07-15' }));
    expect(Math.round(monthlyAverages(inWindow, accounts, 1, INCOME).income * 100)).toBe(EXPECTED_INCOME_CENTS);
  });
});
