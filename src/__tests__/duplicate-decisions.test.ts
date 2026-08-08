/**
 * FIN-DUPLICATE-001 §11.3 — avoidable cost and review decisions (A1–A9).
 *
 * The rule the whole section exists to protect: a duplicate decision is a statement about
 * the ALERT, never about the money. Nothing here deletes, hides, reduces or reclassifies a
 * transaction, and the avoidable-cost figure is a number beside a question — never a
 * saving, never a forecast event, never a budget adjustment.
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { PaymentAccount, Transaction } from '@/types';
import { sumExpenseCents, POSTED_ONLY } from '@/lib/classify';
import { getAllCategorySpending } from '@/lib/budgets';
import { generateForecast } from '@/lib/forecast';
import { mergeCandidateRun } from '@/lib/candidates';
import { clearEvents, recentEvents } from '@/lib/obs/events';
import {
  DUPLICATE_SUBSCRIPTION_VERSION,
  POTENTIAL_ANNUAL_DUPLICATE_COST_LABEL,
  detectDuplicateSubscriptions,
  emitDuplicateDecision,
} from '@/lib/duplicates';

const tx = (o: Partial<Transaction> & { id: string; amount: number }): Transaction =>
  ({
    title: o.merchant ?? o.id,
    type: 'expense',
    category: 'other',
    paymentMethod: 'bank-transfer',
    date: '2026-05-10',
    ...o,
  }) as Transaction;

const acct = (o: Partial<PaymentAccount> & { id: string }): PaymentAccount =>
  ({
    name: o.id,
    type: 'credit_card',
    provider: 'chase',
    color: '#000',
    isActive: true,
    openingBalance: 0,
    openingDate: '2000-01-01',
    ...o,
  }) as PaymentAccount;

const CARD_A = 'demo-card-9021';
const CARD_B = 'demo-card-4410';
const ACCOUNTS = [acct({ id: CARD_A }), acct({ id: CARD_B })];
const SPRING = ['2026-04', '2026-05', '2026-06'];
const TODAY = '2026-06-25';

const charges = (prefix: string, accountId: string, merchant: string, entries: Array<[string, number]>): Transaction[] =>
  entries.map(([date, amount], i) =>
    tx({
      id: `${prefix}-${i}`,
      amount,
      merchant,
      date,
      accountId,
      fingerprint: `${accountId}|${-Math.round(amount * 100)}|${date}`,
    })
  );

const onDay = (dayOfMonth: number, months: string[], amount: number): Array<[string, number]> =>
  months.map((m) => [`${m}-${String(dayOfMonth).padStart(2, '0')}`, amount]);

const pair = (amountA: number, amountB: number, dayB = 18): Transaction[] => [
  ...charges('demo-a', CARD_A, 'NOVACAST', onDay(5, SPRING, amountA)),
  ...charges('demo-b', CARD_B, 'NOVACAST', onDay(dayB, SPRING, amountB)),
];

const run = (rows: Transaction[]) =>
  detectDuplicateSubscriptions(rows, ACCOUNTS, { todayISO: TODAY, generatedAt: '2026-06-30T00:00:00.000Z' });

const SOURCE = ['src/lib/duplicates.ts', 'src/lib/service-identity.ts']
  .map((f) => readFileSync(join(process.cwd(), f), 'utf8'))
  .join('\n');

describe('A1 the annualized estimate is correct in integer cents', () => {
  it('multiplies monthlyCents by 12 with no float step anywhere', () => {
    const { estimates } = run(pair(20, 20));
    expect(estimates).toHaveLength(1);
    expect(estimates[0].duplicateMonthlyCents).toBe(2000);
    expect(estimates[0].potentialAnnualDuplicateCostCents).toBe(24000);
    expect(Number.isInteger(estimates[0].potentialAnnualDuplicateCostCents)).toBe(true);
  });
});

describe('A2 the cheaper series is used', () => {
  it('never the dearer side and never the sum', () => {
    const { estimates } = run(pair(20, 22));
    expect(estimates[0].duplicateMonthlyCents).toBe(2000);
    expect(estimates[0].potentialAnnualDuplicateCostCents).toBe(24000);
    expect(estimates[0].potentialAnnualDuplicateCostCents).not.toBe(26400); // the dearer
    expect(estimates[0].potentialAnnualDuplicateCostCents).not.toBe(50400); // the sum
    expect(estimates[0].cheaperAccountId).toBe(CARD_A);
  });
});

describe('A3 a yearly cadence annualizes through the reused BANDS multiplier', () => {
  it('does not hand-write a division by twelve', () => {
    const months = ['2025-07', '2025-08', '2025-09', '2025-10', '2025-11', '2025-12',
      '2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06'];
    const rows = [
      ...charges('demo-a', CARD_A, 'NOVACAST', onDay(15, months, 30)),
      ...charges('demo-b', CARD_B, 'NOVACAST', [['2024-06-10', 240], ['2025-06-10', 240], ['2026-06-10', 240]]),
    ];
    const { estimates } = run(rows);
    // 24000 cents yearly * (1/12) = 2000 monthly, the same rounding step as flows.ts.
    expect(estimates[0].duplicateMonthlyCents).toBe(2000);
    expect(estimates[0].potentialAnnualDuplicateCostCents).toBe(24000);
  });
});

describe('A4 the estimate is labelled "potential annual duplicate cost"', () => {
  it('carries the label on the returned object and claims no saving anywhere', () => {
    const { estimates } = run(pair(20, 20));
    expect(estimates[0].label).toBe('potential annual duplicate cost');
    expect(POTENTIAL_ANNUAL_DUPLICATE_COST_LABEL).toBe('potential annual duplicate cost');
    for (const forbidden of ['savings', 'you will save', 'guaranteed', 'money back']) {
      expect(SOURCE.toLowerCase()).not.toContain(forbidden);
    }
  });
});

describe('A5 the estimate never enters the forecast', () => {
  it('produces no ForecastEvent and adjusts no balance', () => {
    const rows = pair(20, 20);
    const forecast = () => generateForecast(100000, ACCOUNTS, [], rows, 0, 30);
    const before = JSON.stringify(forecast());

    const { estimates } = run(rows);
    expect(estimates[0].potentialAnnualDuplicateCostCents).toBe(24000);

    const after = forecast();
    expect(JSON.stringify(after)).toBe(before);
    for (const event of after.events) {
      expect(event.description.toLowerCase()).not.toContain('duplicate');
      expect(Math.abs(event.amount)).not.toBe(240);
    }
  });
});

describe('A6 intentional marking suppresses reappearance', () => {
  it('holds across a duplicate-subscription-v1 -> v2 algorithm bump', () => {
    clearEvents();
    const rows = pair(20, 20);
    const [first] = run(rows).candidates;
    expect(first.algorithmVersion).toBe(DUPLICATE_SUBSCRIPTION_VERSION);

    emitDuplicateDecision(first.candidateType, 'intentional', 'different_owner');
    const stored = [{ ...first, status: 'intentional' as const }];

    // A version bump re-evaluates only UNREVIEWED candidates; the doc id carries no
    // version, so the decision cannot be reinterpreted.
    const bumped = run(rows).candidates.map((c) => ({ ...c, algorithmVersion: 'duplicate-subscription-v2' }));
    const merged = mergeCandidateRun(bumped, stored);
    expect(merged.writes).toHaveLength(0);
    expect(merged.suppressed).toEqual([first.id]);
    expect(merged.unchanged[0].algorithmVersion).toBe(DUPLICATE_SUBSCRIPTION_VERSION);

    const event = recentEvents().find((e) => e.eventName === 'DuplicateCandidate.MarkedIntentional');
    expect(event?.metadata).toEqual({ candidateType: 'duplicate_subscription', reasonCode: 'different_owner' });
  });
});

describe('A7 the different-owner case stays a real, shared expense', () => {
  it('leaves both sides fully counted in every total', () => {
    const rows = pair(20, 20);
    const month = new Date('2026-05-15T00:00:00Z');
    const expense = sumExpenseCents(rows, ACCOUNTS, POSTED_ONLY);
    const categories = getAllCategorySpending(rows, month, ACCOUNTS);

    const [candidate] = run(rows).candidates;
    const decided = { ...candidate, status: 'intentional' as const };
    expect(decided.status).toBe('intentional');

    expect(sumExpenseCents(rows, ACCOUNTS, POSTED_ONLY)).toBe(expense);
    expect(getAllCategorySpending(rows, month, ACCOUNTS)).toEqual(categories);
    expect(expense).toBe(12000); // 6 charges x $20, nothing reduced
  });
});

describe('A8 a business label is a label only', () => {
  it('makes no tax, deductibility or export claim', () => {
    const { candidates, estimates } = run(pair(20, 20));
    const keys = [...Object.keys(candidates[0]), ...Object.keys(candidates[0].evidence), ...Object.keys(estimates[0])];
    for (const key of keys) expect(key).not.toMatch(/tax|deduct/i);
    expect(SOURCE.toLowerCase()).not.toMatch(/deductib|tax.?categor|write.?off/);

    clearEvents();
    emitDuplicateDecision('duplicate_subscription', 'intentional', 'business');
    const event = recentEvents().find((e) => e.eventName === 'DuplicateCandidate.MarkedIntentional');
    expect(event?.metadata?.reasonCode).toBe('business');
  });
});

describe('A9 every decision leaves both transaction documents byte-identical', () => {
  it('never writes a field onto a row, under any decision', () => {
    const rows = pair(20, 20).map((t) => Object.freeze(t));
    const snapshot = JSON.stringify(rows);

    const { candidates, estimates } = detectDuplicateSubscriptions(Object.freeze(rows) as Transaction[], ACCOUNTS, {
      todayISO: TODAY,
      generatedAt: '2026-06-30T00:00:00.000Z',
    });
    for (const status of ['confirmed', 'intentional', 'dismissed'] as const) {
      emitDuplicateDecision(candidates[0].candidateType, status, 'intentional');
    }

    expect(JSON.stringify(rows)).toBe(snapshot);
    expect(estimates).toHaveLength(1);
  });
});
