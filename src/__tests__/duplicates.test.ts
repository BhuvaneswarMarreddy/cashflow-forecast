/**
 * FIN-DUPLICATE-001 §11.1 — immediate duplicate charges (U1–U12).
 *
 * Every fixture is INVENTED. No real merchant, balance, account number or token appears
 * here, and nothing in this file reads production data or touches a network.
 *
 * The load-bearing assertion of the whole file is U1: the TECHNICAL duplicate layer
 * (src/lib/fingerprint.ts) sits BELOW this work, and a row pair the ingest layer already
 * decided is one row must never surface as an economic-duplicate or subscription alert.
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { PaymentAccount, Transaction } from '@/types';
import { sumExpenseCents, POSTED_ONLY } from '@/lib/classify';
import { getAllCategorySpending } from '@/lib/budgets';
import { buildFlowGraph } from '@/lib/flows';
import { mergeCandidateRun, rankCandidates } from '@/lib/candidates';
import { clearEvents, recentEvents } from '@/lib/obs/events';
import {
  DUPLICATE_CHARGE_VERSION,
  detectImmediateDuplicates,
  generateDuplicateCandidates,
} from '@/lib/duplicates';

const tx = (o: Partial<Transaction> & { id: string; amount: number }): Transaction =>
  ({
    title: o.merchant ?? o.id,
    type: 'expense',
    category: 'other',
    paymentMethod: 'bank-transfer',
    date: '2026-05-10',
    accountId: 'demo-card-9021',
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

const ACCOUNTS = [acct({ id: 'demo-card-9021' }), acct({ id: 'demo-card-4410' })];
const TODAY = '2026-06-30';
const OPTS = { todayISO: TODAY, generatedAt: '2026-06-30T00:00:00.000Z' };

const duplicates = (txs: Transaction[]) => detectImmediateDuplicates(txs, ACCOUNTS, OPTS);

/** Two posted charges for one economic event: same card, same shop, one day apart. */
const DOUBLE_TAP: Transaction[] = [
  tx({ id: 'demo-tap-a', amount: 64.2, merchant: 'TIDEWATER SUPPLY', date: '2026-05-10', fingerprint: 'demo-card-9021|-6420|2026-05-10' }),
  tx({ id: 'demo-tap-b', amount: 64.2, merchant: 'TIDEWATER SUPPLY', date: '2026-05-11', fingerprint: 'demo-card-9021|-6420|2026-05-11' }),
];

describe('U1 the technical duplicate layer sits BELOW this work', () => {
  it('surfaces neither a charge nor a subscription alert when the fingerprints are equal', () => {
    // Same account, same signed cents, same day — the ingest layer already decided these
    // are one row. This detector must stay out of it.
    const rows = [
      tx({ id: 'demo-twin-a', amount: 41.2, merchant: 'HARBORLIGHT CLOUD', date: '2026-05-10', fingerprint: 'demo-card-9021|-4120|2026-05-10' }),
      tx({ id: 'demo-twin-b', amount: 41.2, merchant: 'HARBORLIGHT CLOUD', date: '2026-05-10', fingerprint: 'demo-card-9021|-4120|2026-05-10' }),
    ];
    const run = generateDuplicateCandidates(rows, ACCOUNTS, OPTS);
    expect(run.candidates).toHaveLength(0);
    expect(run.candidates.filter((c) => c.candidateType === 'immediate_duplicate_charge')).toHaveLength(0);
    expect(run.candidates.filter((c) => c.candidateType === 'duplicate_subscription')).toHaveLength(0);
  });
});

describe('U2 an immediate duplicate candidate is generated', () => {
  it('scores two same-cent charges one day apart at or above 0.75 and proposes one link', () => {
    clearEvents();
    const run = generateDuplicateCandidates(DOUBLE_TAP, ACCOUNTS, OPTS);
    const [candidate] = run.candidates;

    expect(run.candidates).toHaveLength(1);
    expect(candidate.candidateType).toBe('immediate_duplicate_charge');
    expect(candidate.algorithmVersion).toBe(DUPLICATE_CHARGE_VERSION);
    expect(candidate.score).toBeGreaterThanOrEqual(0.75);
    expect(candidate.transactionIds).toEqual(['demo-tap-a', 'demo-tap-b']);
    expect(candidate.evidence.sameAccount).toBe(true);
    expect(candidate.evidence.dayGaps).toEqual([1]);
    expect(candidate.evidence.merchantMatch).toBe('exact');
    expect(candidate.proposedLinks).toEqual([
      {
        linkType: 'duplicate_candidate',
        sourceTransactionId: 'demo-tap-b', // the LATER row acts
        targetTransactionId: 'demo-tap-a',
        allocatedAmountCents: 6420,
      },
    ]);

    // Observability: a count and reason codes, never merchant text or an amount as a value.
    const generated = recentEvents().find((e) => e.eventName === 'DuplicateCharge.CandidateGenerated');
    expect(generated?.recordCount).toBe(1);
    expect(generated?.metadata?.algorithmVersion).toBe(DUPLICATE_CHARGE_VERSION);
    expect(JSON.stringify(recentEvents())).not.toContain('TIDEWATER');
  });
});

describe('U3 a legitimate repeated purchase produces no high-confidence duplicate', () => {
  it('caps a daily same-amount purchase at 0.30 and ranks it below every other candidate', () => {
    const coffee = Array.from({ length: 20 }, (_, i) =>
      tx({
        id: `demo-cup-${String(i).padStart(2, '0')}`,
        amount: 6.5,
        merchant: 'TIDEWATER COFFEE BAR',
        date: `2026-05-${String(i + 1).padStart(2, '0')}`,
        fingerprint: `demo-card-9021|-650|2026-05-${String(i + 1).padStart(2, '0')}`,
      })
    );
    const candidates = rankCandidates(duplicates([...coffee, ...DOUBLE_TAP]));
    const cups = candidates.filter((c) => c.transactionIds.every((id) => id.startsWith('demo-cup')));
    const tap = candidates.find((c) => c.transactionIds.includes('demo-tap-a'))!;

    expect(cups.length).toBeGreaterThan(0);
    for (const c of cups) expect(c.score).toBeLessThanOrEqual(0.3);
    expect(candidates.indexOf(tap)).toBeLessThan(candidates.indexOf(cups[0]));
    expect(cups[0].evidence.reasonCodes).toContain('repeat_purchase_pattern');
  });
});

describe('U4 amounts differing by one cent are not a duplicate', () => {
  it('requires exact integer-cent equality', () => {
    const rows = [
      DOUBLE_TAP[0],
      tx({ id: 'demo-tap-c', amount: 64.21, merchant: 'TIDEWATER SUPPLY', date: '2026-05-11', fingerprint: 'demo-card-9021|-6421|2026-05-11' }),
    ];
    expect(duplicates(rows)).toHaveLength(0);
  });
});

describe('U5 the three-day boundary is exact', () => {
  it('accepts a 3-day gap and refuses a 4-day gap', () => {
    const at = (date: string, id: string) =>
      tx({ id, amount: 64.2, merchant: 'TIDEWATER SUPPLY', date, fingerprint: `demo-card-9021|-6420|${date}` });
    expect(duplicates([at('2026-05-10', 'demo-gap-a'), at('2026-05-13', 'demo-gap-b')])).toHaveLength(1);
    expect(duplicates([at('2026-05-10', 'demo-gap-a'), at('2026-05-14', 'demo-gap-b')])).toHaveLength(0);
  });
});

describe('U6 a pending hold plus its posted twin is not a duplicate', () => {
  it('never pairs a hold with a posted row', () => {
    const rows = [
      DOUBLE_TAP[0],
      tx({ id: 'demo-hold-b', amount: 64.2, merchant: 'TIDEWATER SUPPLY', date: '2026-05-11', pending: true }),
    ];
    const candidates = duplicates(rows);
    expect(candidates).toHaveLength(0);
  });
});

describe('U7 two same-amount charges on different accounts are not an immediate duplicate', () => {
  it('keeps the cross-account case out of §3 entirely', () => {
    const rows = [
      DOUBLE_TAP[0],
      tx({
        id: 'demo-tap-other',
        amount: 64.2,
        merchant: 'TIDEWATER SUPPLY',
        date: '2026-05-11',
        accountId: 'demo-card-4410',
        fingerprint: 'demo-card-4410|-6420|2026-05-11',
      }),
    ];
    expect(duplicates(rows)).toHaveLength(0);
  });
});

describe('U8 confirming a duplicate charge changes no total', () => {
  it('leaves sumExpenseCents, category spending and Flow conservation identical', () => {
    const month = new Date('2026-05-15T00:00:00Z');
    const before = {
      expense: sumExpenseCents(DOUBLE_TAP, ACCOUNTS, POSTED_ONLY),
      categories: getAllCategorySpending(DOUBLE_TAP, month, ACCOUNTS),
      flow: buildFlowGraph(DOUBLE_TAP, ACCOUNTS).links.map((l) => l.cents),
      rows: JSON.stringify(DOUBLE_TAP),
    };

    const [candidate] = duplicates(DOUBLE_TAP);
    // "Confirming" is a status on the ALERT. Nothing in this module can reach a total.
    const confirmed = { ...candidate, status: 'confirmed' as const };
    expect(confirmed.status).toBe('confirmed');

    expect(sumExpenseCents(DOUBLE_TAP, ACCOUNTS, POSTED_ONLY)).toBe(before.expense);
    expect(getAllCategorySpending(DOUBLE_TAP, month, ACCOUNTS)).toEqual(before.categories);
    expect(buildFlowGraph(DOUBLE_TAP, ACCOUNTS).links.map((l) => l.cents)).toEqual(before.flow);
    expect(JSON.stringify(DOUBLE_TAP)).toBe(before.rows);
    expect(before.expense).toBe(12840); // both charges stay counted, in full
  });
});

describe('U9 no transaction is deleted by any path in this module', () => {
  it('has no delete call in its source and the rules deny delete on both new collections', () => {
    const source = ['src/lib/duplicates.ts', 'src/lib/service-identity.ts']
      .map((f) => readFileSync(join(process.cwd(), f), 'utf8'))
      .join('\n');
    expect(source).not.toMatch(/deleteDoc|deleteField|\.delete\(|removeTransaction/);

    const rules = readFileSync(join(process.cwd(), 'firestore.rules'), 'utf8');
    for (const collection of ['links', 'reviewCandidates']) {
      const start = rules.indexOf(`match /${collection}/{`);
      expect(start).toBeGreaterThan(-1);
      expect(rules.slice(start, rules.indexOf('match /', start + 10))).toContain('allow delete: if false');
    }
  });
});

describe('U10 the sweep is a bounded window, not a full cross product', () => {
  it('grows comparisons linearly from 1k to 5k rows', () => {
    const ledger = (n: number) =>
      Array.from({ length: n }, (_, i) =>
        tx({
          id: `demo-row-${i}`,
          amount: 10 + (i % 97),
          merchant: `DEMO MERCHANT ${i % 40}`,
          date: new Date(Date.UTC(2024, 0, 1) + i * 86_400_000).toISOString().slice(0, 10),
        })
      );
    const comparisons = (n: number) => {
      const stats = { comparisons: 0 };
      detectImmediateDuplicates(ledger(n), ACCOUNTS, { ...OPTS, todayISO: '2030-01-01', stats });
      return stats.comparisons;
    };
    const [c1, c5] = [comparisons(1000), comparisons(5000)];
    expect(c1).toBeGreaterThan(0);
    // Linear in n: 5x the rows costs ~5x the comparisons. A cross product would be 25x.
    expect(c5).toBeLessThan(c1 * 8);
  });
});

describe('U11 candidate identity is deterministic across discovery orders', () => {
  it('produces the same identityKey whichever order the rows arrive in', () => {
    const forward = duplicates(DOUBLE_TAP).map((c) => c.id);
    const reverse = duplicates([...DOUBLE_TAP].reverse()).map((c) => c.id);
    expect(forward).toEqual(reverse);
    expect(forward[0]).toBe('immediate_duplicate_charge~demo-tap-a~demo-tap-b');
  });
});

describe('U12 a dismissed duplicate charge does not reappear', () => {
  it('suppresses the identityKey on the second run', () => {
    const [first] = duplicates(DOUBLE_TAP);
    const stored = [{ ...first, status: 'dismissed' as const }];
    const merged = mergeCandidateRun(duplicates(DOUBLE_TAP), stored);
    expect(merged.writes).toHaveLength(0);
    expect(merged.suppressed).toEqual([first.id]);
  });
});
