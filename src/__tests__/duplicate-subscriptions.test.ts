/**
 * FIN-DUPLICATE-001 §11.2 — duplicate subscriptions across accounts (S1–S16).
 *
 * The headline capability, and the defect it fixes: detectRecurring() groups by merchant
 * ALONE and reports the modal account, so two live subscriptions to one service on two
 * cards collapse into a single RecurringItem and the second is invisible BY CONSTRUCTION.
 * detectRecurringByAccount() supersedes that grouping key and nothing else.
 *
 * Every service, merchant, amount and id below is invented.
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { PaymentAccount, Transaction } from '@/types';
import {
  ACTIVE_CADENCE_MULTIPLE,
  MAX_DISPERSION,
  MIN_IN_BAND,
  MIN_SERIES_CENTS,
  MIN_UNIQUE_DAYS,
  detectRecurringByAccount,
  detectDuplicateSubscriptions,
  generateDuplicateCandidates,
} from '@/lib/duplicates';
import { confirmAlias, seedServiceFamily, serviceFamilyId, resolveServiceIdentity } from '@/lib/service-identity';

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

/** One account's charges for one merchant. `entries` is [date, dollars]. */
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

const opts = (todayISO: string, extra: Record<string, unknown> = {}) => ({
  todayISO,
  generatedAt: '2026-06-30T00:00:00.000Z',
  ...extra,
});

const subs = (txs: Transaction[], todayISO: string, extra: Record<string, unknown> = {}) =>
  detectDuplicateSubscriptions(txs, ACCOUNTS, opts(todayISO, extra));

const SPRING = ['2026-04', '2026-05', '2026-06'];

describe('S1 a duplicate subscription across accounts is detected', () => {
  it('finds one service billed on two cards with three overlapping months', () => {
    const rows = [
      ...charges('demo-a', CARD_A, 'NOVACAST', onDay(5, SPRING, 12.99)),
      ...charges('demo-b', CARD_B, 'NOVACAST', onDay(18, SPRING, 12.99)),
    ];
    const { candidates, estimates } = subs(rows, '2026-06-25');

    expect(candidates).toHaveLength(1);
    const [c] = candidates;
    expect(c.candidateType).toBe('duplicate_subscription');
    expect(c.status).toBe('unreviewed');
    expect(c.evidence.sameAccount).toBe(false);
    expect(c.evidence.cadence).toBe('monthly');
    expect(c.evidence.overlappingPeriods).toBe(3);
    expect(c.evidence.merchantMatch).toBe('exact');
    // Identity is anchored on the EARLIEST charge of each account's series, so a new
    // charge next month cannot resurrect an alert the owner already decided.
    expect(c.transactionIds).toEqual(['demo-a-0', 'demo-b-0']);
    expect(estimates).toHaveLength(1);
    expect(estimates[0].potentialAnnualDuplicateCostCents).toBe(1299 * 12);

    // The defect this fixes: the merchant-only grouping sees ONE item; ours sees two.
    const series = detectRecurringByAccount(rows, ACCOUNTS, opts('2026-06-25'));
    expect(series.map((s) => s.accountId).sort()).toEqual([CARD_B, CARD_A].sort());
  });
});

describe('S2 E1 — at least two charges on each account', () => {
  it('emits nothing when the second account has a single charge', () => {
    const rows = [
      ...charges('demo-a', CARD_A, 'NOVACAST', onDay(5, SPRING, 12.99)),
      ...charges('demo-b', CARD_B, 'NOVACAST', [['2026-05-18', 12.99]]),
    ];
    expect(subs(rows, '2026-06-25').candidates).toHaveLength(0);
  });
});

describe('S3 E2 — at least two overlapping billing periods', () => {
  it('treats a single overlapping month as a migration, not a duplicate', () => {
    const rows = [
      ...charges('demo-a', CARD_A, 'NOVACAST', onDay(5, ['2026-02', '2026-03', '2026-04'], 12.99)),
      ...charges('demo-b', CARD_B, 'NOVACAST', onDay(10, ['2026-04', '2026-05'], 12.99)),
    ];
    expect(subs(rows, '2026-05-20').candidates).toHaveLength(0);
  });
});

describe('S4 E3 — an anchor series must exist', () => {
  it('refuses two relaxed series with no properly-detected cadence behind either', () => {
    const rows = [
      ...charges('demo-a', CARD_A, 'NOVACAST', onDay(5, ['2026-04', '2026-05'], 12.99)),
      ...charges('demo-b', CARD_B, 'NOVACAST', onDay(18, ['2026-04', '2026-05'], 12.99)),
    ];
    const series = detectRecurringByAccount(rows, ACCOUNTS, opts('2026-05-25'));
    expect(series).toHaveLength(2);
    expect(series.every((s) => s.anchor === false)).toBe(true);
    expect(subs(rows, '2026-05-25').candidates).toHaveLength(0);
  });
});

describe('S5 E4 — both series must still be active', () => {
  it('emits nothing when one side lapsed beyond 1.5x its own cadence', () => {
    const rows = [
      ...charges('demo-a', CARD_A, 'NOVACAST', onDay(5, ['2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06'], 12.99)),
      ...charges('demo-b', CARD_B, 'NOVACAST', onDay(10, ['2026-01', '2026-02', '2026-03'], 12.99)),
    ];
    const series = detectRecurringByAccount(rows, ACCOUNTS, opts('2026-06-25'));
    expect(series.find((s) => s.accountId === CARD_B)?.active).toBe(false);
    expect(subs(rows, '2026-06-25').candidates).toHaveLength(0);
  });
});

describe('S6 E5 — same-account repetition belongs to the immediate-duplicate case', () => {
  it('emits no subscription candidate for one service on one card', () => {
    const rows = charges('demo-a', CARD_A, 'NOVACAST', onDay(5, ['2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06'], 12.99));
    expect(subs(rows, '2026-06-25').candidates).toHaveLength(0);
  });
});

describe('S7 merchant aliases map to one service family', () => {
  it('unifies two statement forms with no configuration at all, via rule 1', () => {
    // normalizeMerchant strips `[#*]\S*`, so the two forms are already one string.
    expect(resolveServiceIdentity({ merchant: 'NOVACAST*BILL' }).serviceFamilyId).toBe(serviceFamilyId('NOVACAST'));
    expect(resolveServiceIdentity({ merchant: 'NOVACAST' }).serviceFamilyId).toBe(serviceFamilyId('NOVACAST'));

    const rows = [
      ...charges('demo-a', CARD_A, 'NOVACAST*BILL', onDay(5, SPRING, 12.99)),
      ...charges('demo-b', CARD_B, 'NOVACAST', onDay(18, SPRING, 12.99)),
    ];
    const { candidates } = subs(rows, '2026-06-25');
    expect(candidates).toHaveLength(1);
    expect(candidates[0].evidence.merchantMatch).toBe('exact');
    expect(candidates[0].status).toBe('unreviewed');
  });
});

describe('S8 an unknown alias requires review', () => {
  it('proposes the merge as needs_more_information and never applies it', () => {
    const rows = [
      ...charges('demo-a', CARD_A, 'NOVACAST', onDay(5, SPRING, 12.99)),
      ...charges('demo-b', CARD_B, 'NOVACAST STUDIOS', onDay(18, SPRING, 12.99)),
    ];
    const { candidates } = subs(rows, '2026-06-25');
    expect(candidates).toHaveLength(1);
    expect(candidates[0].status).toBe('needs_more_information');
    expect(candidates[0].evidence.reasonCodes).toContain('alias_unconfirmed');
    expect(candidates[0].evidence.merchantMatch).toBe('alias');

    // No auto-merge: the two families are still distinct until the owner says otherwise.
    expect(resolveServiceIdentity({ merchant: 'NOVACAST STUDIOS' }).serviceFamilyId).not.toBe(
      resolveServiceIdentity({ merchant: 'NOVACAST' }).serviceFamilyId
    );
  });
});

describe('S9 confirming the alias writes it into the family', () => {
  it('stops asking the same question once the owner has answered it', () => {
    const family = confirmAlias(seedServiceFamily('NOVACAST', '2026-06-01T00:00:00.000Z'), 'NOVACAST STUDIOS', '2026-06-02T00:00:00.000Z');
    expect(family.aliases).toEqual(['NOVACAST', 'NOVACAST STUDIOS']);

    const rows = [
      ...charges('demo-a', CARD_A, 'NOVACAST', onDay(5, SPRING, 12.99)),
      ...charges('demo-b', CARD_B, 'NOVACAST STUDIOS', onDay(18, SPRING, 12.99)),
    ];
    const { candidates } = subs(rows, '2026-06-25', { families: [family] });
    expect(candidates).toHaveLength(1);
    expect(candidates[0].status).toBe('unreviewed');
    expect(candidates[0].evidence.merchantMatch).toBe('alias');
    expect(candidates[0].evidence.reasonCodes).not.toContain('alias_unconfirmed');
  });
});

/**
 * Additive to the spec's 37: the drift guard for §2.1. duplicates.ts re-declares the four
 * reused rules as named constants because flows.ts does not export them, so something has
 * to fail when one copy changes without the other. This is that something.
 */
describe('the reused detectRecurring rules are pinned to flows.ts', () => {
  it('fails the moment either copy of the four rules drifts from the other', () => {
    const flows = readFileSync(join(process.cwd(), 'src/lib/flows.ts'), 'utf8');
    const body = flows.slice(flows.indexOf('export function detectRecurring('), flows.indexOf('projectNetWorth'));
    expect(body).toContain('dates.length < 3'); // rule 1: unique days
    expect(body).toContain('med < 500'); // rule 3: >= $5
    expect(body).toContain('med * 0.25'); // dispersion
    expect(body).toContain('inBand < 0.6'); // rule 2: in-band ratio
    expect(body).toContain('hi * 1.5'); // active window
    expect([MIN_UNIQUE_DAYS, MIN_SERIES_CENTS, MAX_DISPERSION, MIN_IN_BAND, ACTIVE_CADENCE_MULTIPLE]).toEqual([
      3, 500, 0.25, 0.6, 1.5,
    ]);
  });
});

describe('S10 no service is hardcoded', () => {
  it('contains no vendor name literal in either owned module', () => {
    const source = ['src/lib/duplicates.ts', 'src/lib/service-identity.ts']
      .map((f) => readFileSync(join(process.cwd(), f), 'utf8'))
      .join('\n')
      .toUpperCase();
    const vendors = [
      'CHATGPT', 'OPENAI', 'NETFLIX', 'SPOTIFY', 'HULU', 'DISNEY', 'AMAZON', 'PRIME VIDEO',
      'APPLE', 'GOOGLE', 'MICROSOFT', 'ADOBE', 'DROPBOX', 'NOVACAST', 'ANTHROPIC',
    ];
    for (const vendor of vendors) expect(source).not.toContain(vendor);
    // and no bundled registry masquerading as one
    expect(source).not.toMatch(/KNOWN_SERVICES|VENDOR_LIST|MERCHANT_REGISTRY/);
  });
});

describe('S11 a modest price increase preserves historical continuity', () => {
  it('keeps 2000 -> 2200 -> 2400 as one series', () => {
    const rows = charges('demo-a', CARD_A, 'NOVACAST', [
      ['2026-01-05', 20], ['2026-02-05', 20], ['2026-03-05', 22],
      ['2026-04-05', 22], ['2026-05-05', 24], ['2026-06-05', 24],
    ]);
    const series = detectRecurringByAccount(rows, ACCOUNTS, opts('2026-06-25'));
    expect(series).toHaveLength(1);
    expect(series[0].occurrences).toBe(6);
    expect(series[0].anchor).toBe(true);
    expect(series[0].reasonCodes).not.toContain('price_step_exceeded');
  });
});

describe('S12 a single step over 25% splits the series and is reported', () => {
  it('reports the split rather than silently merging two products', () => {
    const rows = charges('demo-a', CARD_A, 'NOVACAST', [
      ['2026-01-05', 20], ['2026-02-05', 20], ['2026-03-05', 20],
      ['2026-04-05', 30], ['2026-05-05', 30], ['2026-06-05', 30],
    ]);
    const series = detectRecurringByAccount(rows, ACCOUNTS, opts('2026-06-25'));
    expect(series).toHaveLength(2);
    expect(series.map((s) => s.medianCents).sort((a, b) => a - b)).toEqual([2000, 3000]);
    expect(series.some((s) => s.reasonCodes.includes('price_step_exceeded'))).toBe(true);
  });
});

describe('S13 tax variation stays one band; a differing currency splits the group', () => {
  it('tolerates a 50-cent tax wobble and never converts across currencies', () => {
    const wobble = charges('demo-a', CARD_A, 'NOVACAST', [
      ['2026-03-05', 12.99], ['2026-04-05', 13.49], ['2026-05-05', 12.99], ['2026-06-05', 13.49],
    ]);
    const series = detectRecurringByAccount(wobble, ACCOUNTS, opts('2026-06-25'));
    expect(series).toHaveLength(1);
    expect(series[0].occurrences).toBe(4);

    const rows = [
      ...charges('demo-a', CARD_A, 'NOVACAST', onDay(5, SPRING, 12.99)),
      ...charges('demo-b', CARD_B, 'NOVACAST', onDay(18, SPRING, 12.99)),
    ];
    const currencyOf = (t: Transaction) => (t.accountId === CARD_B ? 'EUR' : 'USD');
    expect(subs(rows, '2026-06-25', { currencyOf }).candidates).toHaveLength(0);
    expect(subs(rows, '2026-06-25').candidates).toHaveLength(1);
  });
});

describe('S14 a charge after a cancellation is a high-priority alert', () => {
  it('emits continued_charge_after_cancellation on the first charge past the effective date', () => {
    const rows = charges('demo-a', CARD_A, 'NOVACAST', onDay(5, ['2026-01', '2026-02', '2026-03', '2026-04'], 12.99));
    const cancellations = [{ serviceFamilyId: serviceFamilyId('NOVACAST'), effectiveDate: '2026-03-10' }];
    const { candidates } = generateDuplicateCandidates(rows, ACCOUNTS, opts('2026-04-25', { cancellations }));

    const alert = candidates.find((c) => c.candidateType === 'continued_charge_after_cancellation');
    expect(alert).toBeDefined();
    expect(alert!.transactionIds).toContain('demo-a-3'); // the 2026-04-05 charge
    expect(alert!.score).toBeGreaterThanOrEqual(0.9);
    expect(alert!.proposedLinks).toEqual([]);
    expect(candidates[0]).toBe(alert); // ranked first
  });
});

describe('S15 a cancellation that worked says nothing at all', () => {
  it('emits no candidate when no charge posts after the effective date', () => {
    const rows = charges('demo-a', CARD_A, 'NOVACAST', onDay(5, ['2026-01', '2026-02', '2026-03', '2026-04'], 12.99));
    const cancellations = [{ serviceFamilyId: serviceFamilyId('NOVACAST'), effectiveDate: '2026-04-30' }];
    const { candidates } = generateDuplicateCandidates(rows, ACCOUNTS, opts('2026-05-25', { cancellations }));
    expect(candidates.filter((c) => c.candidateType === 'continued_charge_after_cancellation')).toHaveLength(0);
  });
});

describe('S16 subscription_overlap when the cadences differ', () => {
  it('carries the annualized figures that make a monthly and a yearly comparable', () => {
    const months = ['2025-01', '2025-02', '2025-03', '2025-04', '2025-05', '2025-06', '2025-07',
      '2025-08', '2025-09', '2025-10', '2025-11', '2025-12', '2026-01', '2026-02', '2026-03',
      '2026-04', '2026-05', '2026-06'];
    const rows = [
      ...charges('demo-a', CARD_A, 'NOVACAST', onDay(15, months, 12.99)),
      ...charges('demo-b', CARD_B, 'NOVACAST', [['2024-06-10', 129], ['2025-06-10', 129], ['2026-06-10', 129]]),
    ];
    const { candidates, estimates } = subs(rows, '2026-06-25');
    expect(candidates).toHaveLength(1);
    expect(candidates[0].candidateType).toBe('subscription_overlap');
    expect(candidates[0].evidence.overlappingPeriods).toBeGreaterThanOrEqual(2);
    // The yearly side annualizes through the reused BANDS multiplier: 12900 * (1/12) = 1075.
    expect(estimates[0].duplicateMonthlyCents).toBe(1075);
    expect(estimates[0].potentialAnnualDuplicateCostCents).toBe(12900);
  });
});
