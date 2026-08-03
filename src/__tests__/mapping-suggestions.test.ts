/**
 * MAP-001 — grouping the unmapped, suggesting from the owner's own data, and the
 * terminal "leave it unknown" answer.
 *
 * Every fixture here is INVENTED: made-up merchants, made-up amounts, made-up ids.
 * No row, merchant string or figure from the owner's export appears in this file.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { InflowReview, PaymentAccount, Transaction } from '@/types';
import { MappingRule, applyMappingRules, rulePreview, describeRule } from '@/lib/mapping-rules';
import {
  GROUP_UNKNOWN_REASON,
  MappingGroup,
  buildGroupRule,
  buildMappingGroups,
  confirmGroupMeaning,
  groupPreview,
  groupScopes,
  markGroupUnknown,
} from '@/lib/mapping-suggestions';

const ACCOUNTS: PaymentAccount[] = [
  { id: 'chk', name: 'Demo Checking', type: 'bank_account', openingBalance: 0, openingDate: '2024-01-01', provider: 'other', color: '#000', isActive: true },
  { id: 'sav', name: 'Demo Savings', type: 'bank_account', openingBalance: 0, openingDate: '2024-01-01', provider: 'other', color: '#000', isActive: true },
  { id: 'card', name: 'Demo Rewards Card', type: 'credit_card', openingBalance: 0, openingDate: '2024-01-01', provider: 'other', color: '#000', isActive: true },
] as PaymentAccount[];

let seq = 0;
const tx = (over: Partial<Transaction>): Transaction => ({
  id: `t${++seq}`,
  title: 'NORTHWIND DEPOSIT',
  merchant: 'NORTHWIND DEPOSIT',
  description: 'NORTHWIND DEPOSIT',
  sourceCategory: 'Other Income',
  amount: 120,
  type: 'income',
  category: 'other',
  paymentMethod: 'other',
  date: '2025-03-01',
  accountId: 'chk',
  ...over,
} as Transaction);

/** N inflows from one invented merchant, one per month — the collapse case. */
const deposits = (n: number, over: Partial<Transaction> = {}): Transaction[] =>
  Array.from({ length: n }, (_, i) =>
    tx({ date: `2025-${String((i % 12) + 1).padStart(2, '0')}-05`, ...over })
  );

const groupFor = (groups: MappingGroup[], value: string) =>
  groups.find((g) => g.signalValue === value)!;

/** A generated rule as the store would hold it, so `rulePreview`/`applyMappingRules` take it. */
const stored = (r: ReturnType<typeof buildGroupRule>): MappingRule =>
  ({ id: 'generated', createdAt: '2026-08-02T00:00:00Z', ...r! });

beforeEach(() => { seq = 0; });

// ---------------------------------------------------------------------------
// A. Grouping — one decision instead of N
// ---------------------------------------------------------------------------

describe('M1 grouping collapses many rows into one decision', () => {
  it('turns 12 unknown deposits from one merchant into a single group', () => {
    const rows = deposits(12);
    const groups = buildMappingGroups({ transactions: rows, accounts: ACCOUNTS });
    expect(groups).toHaveLength(1);
    expect(groups[0].rowCount).toBe(12);
    expect(groups[0].transactionIds).toHaveLength(12);
    expect(groups[0].kind).toBe('unknown_inflow');
  });

  it('normalizes the merchant, so a #-suffixed statement line joins the same group', () => {
    const rows = [
      ...deposits(3),
      tx({ merchant: 'NORTHWIND DEPOSIT#88213', title: 'NORTHWIND DEPOSIT#88213', date: '2025-06-05' }),
    ];
    const groups = buildMappingGroups({ transactions: rows, accounts: ACCOUNTS });
    expect(groups).toHaveLength(1);
    expect(groups[0].rowCount).toBe(4);
  });

  it('keeps two counterparties apart even when the transport text is identical', () => {
    // FIN-REVIEW-002 §7.3: Zelle is a transport, not a meaning. Two people, two groups.
    const rows = [
      tx({ merchant: 'Zelle', title: 'Zelle', description: 'Zelle payment from ALDEN RUIZ CONF1', date: '2025-04-02' }),
      tx({ merchant: 'Zelle', title: 'Zelle', description: 'Zelle payment from ALDEN RUIZ CONF2', date: '2025-05-02' }),
      tx({ merchant: 'Zelle', title: 'Zelle', description: 'Zelle payment from BRISA OKON CONF3', date: '2025-06-02' }),
    ];
    const groups = buildMappingGroups({ transactions: rows, accounts: ACCOUNTS });
    expect(groups).toHaveLength(2);
    expect(groups.every((g) => g.signal === 'counterparty')).toBe(true);
    expect(groupFor(groups, 'ALDEN RUIZ').rowCount).toBe(2);
    expect(groupFor(groups, 'BRISA OKON').rowCount).toBe(1);
  });

  it('ranks by impact — row count times amount — so the biggest group is answered first', () => {
    const rows = [
      ...deposits(2, { merchant: 'SMALL PAYER', title: 'SMALL PAYER', amount: 10 }),
      ...deposits(6, { merchant: 'BIG PAYER', title: 'BIG PAYER', amount: 900 }),
      ...deposits(4, { merchant: 'MID PAYER', title: 'MID PAYER', amount: 100 }),
    ];
    const groups = buildMappingGroups({ transactions: rows, accounts: ACCOUNTS });
    expect(groups.map((g) => g.signalValue)).toEqual(['BIG PAYER', 'MID PAYER', 'SMALL PAYER']);
    expect(groups[0].impactScore).toBeGreaterThan(groups[1].impactScore);
  });

  it('carries the signals a decision needs: dates, accounts, source categories, amount range', () => {
    const rows = [
      tx({ date: '2025-01-05', amount: 100, accountId: 'chk', sourceCategory: 'Other Income' }),
      tx({ date: '2025-08-05', amount: 300, accountId: 'sav', sourceCategory: 'Interest' }),
    ];
    const g = buildMappingGroups({ transactions: rows, accounts: ACCOUNTS })[0];
    expect(g.firstDate).toBe('2025-01-05');
    expect(g.lastDate).toBe('2025-08-05');
    expect(g.accountIds.sort()).toEqual(['chk', 'sav']);
    expect(g.sourceCategories.sort()).toEqual(['Interest', 'Other Income']);
    expect([g.minCents, g.maxCents]).toEqual([10000, 30000]);
    expect(g.direction).toBe('inflow');
  });

  it('groups unpaired transfer legs by merchant AND direction, never mixing the two ways', () => {
    const legs = [
      tx({ id: 'L1', type: 'transfer', transferDirection: 'out', merchant: 'ORION TRANSFER', title: 'ORION TRANSFER', amount: 50, date: '2025-02-01' }),
      tx({ id: 'L2', type: 'transfer', transferDirection: 'out', merchant: 'ORION TRANSFER', title: 'ORION TRANSFER', amount: 60, date: '2025-03-01' }),
      tx({ id: 'L3', type: 'transfer', transferDirection: 'in', merchant: 'ORION TRANSFER', title: 'ORION TRANSFER', amount: 70, date: '2025-04-01' }),
    ];
    const groups = buildMappingGroups({
      transactions: legs, accounts: ACCOUNTS, unpairedLegIds: ['L1', 'L2', 'L3'],
    });
    expect(groups).toHaveLength(2);
    expect(groups.every((g) => g.kind === 'unpaired_leg')).toBe(true);
    expect(groups.map((g) => g.direction).sort()).toEqual(['inflow', 'outflow']);
  });
});

// ---------------------------------------------------------------------------
// B. Suggestions — derived, never invented
// ---------------------------------------------------------------------------

describe('M2 suggestions come from evidence already in the ledger', () => {
  it('suggests nothing when the ledger holds no evidence at all', () => {
    const g = buildMappingGroups({ transactions: deposits(3), accounts: ACCOUNTS })[0];
    expect(g.suggestion).toBeNull();
  });

  it('reuses a rule the owner already confirmed for this merchant', () => {
    const rules: MappingRule[] = [{
      id: 'r1', enabled: true, createdAt: '2025-01-01T00:00:00Z',
      match: { field: 'merchant', op: 'contains', value: 'NORTHWIND' },
      set: { sourceCategory: 'Consulting' },
    }];
    const g = buildMappingGroups({ transactions: deposits(3), accounts: ACCOUNTS, rules })[0];
    expect(g.suggestion?.evidence).toBe('existing_rule');
    expect(g.suggestion?.set).toEqual({ sourceCategory: 'Consulting' });
    expect(g.suggestion?.why).toMatch(/rule/i);
  });

  it('reuses the owner\'s own past answers for the same merchant, and counts them', () => {
    const past = deposits(4, { merchant: 'NORTHWIND DEPOSIT' });
    const open = deposits(2);
    const reviews: Record<string, InflowReview> = Object.fromEntries(
      past.map((t) => [t.id, {
        transactionId: t.id, state: 'confirmed' as const, meaning: 'gift_or_personal_transfer' as const,
        source: 'user' as const, updatedAt: '2025-01-01T00:00:00Z',
      }])
    );
    const g = buildMappingGroups({
      transactions: [...past, ...open], accounts: ACCOUNTS, income: { sources: [], reviews },
    })[0];
    expect(g.rowCount).toBe(2); // the four answered rows are out of the queue
    expect(g.suggestion?.evidence).toBe('prior_confirmation');
    expect(g.suggestion?.meaning).toBe('gift_or_personal_transfer');
    expect(g.suggestion?.supportCount).toBe(4);
    expect(g.suggestion?.why).toContain('4');
  });

  it('suggests earned income only when an APPROVED source matches amount and cadence', () => {
    const rows = [
      tx({ merchant: 'HARBOR PAYROLL', title: 'HARBOR PAYROLL', amount: 2000, date: '2025-01-03' }),
      tx({ merchant: 'HARBOR PAYROLL', title: 'HARBOR PAYROLL', amount: 2000, date: '2025-02-03' }),
      tx({ merchant: 'HARBOR PAYROLL', title: 'HARBOR PAYROLL', amount: 2000, date: '2025-03-03' }),
    ];
    // The source is named nothing like the bank text — which is exactly why these rows
    // are still unknown. Amount and cadence are the only evidence there is.
    const sources = [{
      id: 's1', name: 'Contract Retainer', amount: 2000, frequency: 'monthly' as const,
      isActive: true, userApproved: true,
    }];
    // Without the source: no suggestion. With it: earned income, explainable.
    expect(buildMappingGroups({ transactions: rows, accounts: ACCOUNTS })[0].suggestion).toBeNull();
    const g = buildMappingGroups({ transactions: rows, accounts: ACCOUNTS, income: { sources, reviews: {} } })[0];
    expect(g.suggestion?.evidence).toBe('approved_income_source');
    expect(g.suggestion?.meaning).toBe('earned_income');
    expect(g.suggestion?.why).toMatch(/monthly/i);
  });

  it('suggests an internal transfer when the opposite leg is in another owned account that day', () => {
    const rows = [
      tx({ id: 'IN1', merchant: 'VESPER MOVE', title: 'VESPER MOVE', amount: 500, date: '2025-05-10', accountId: 'chk' }),
      tx({ id: 'OUT1', merchant: 'VESPER MOVE', title: 'VESPER MOVE', amount: 500, date: '2025-05-10', accountId: 'sav', type: 'expense' }),
    ];
    const g = buildMappingGroups({ transactions: rows, accounts: ACCOUNTS })[0];
    expect(g.suggestion?.evidence).toBe('same_day_opposite_leg');
    expect(g.suggestion?.meaning).toBe('internal_transfer');
    expect(g.suggestion?.supportCount).toBe(1);
  });

  it('every suggestion explains itself in one sentence a human can check', () => {
    const rules: MappingRule[] = [{
      id: 'r1', enabled: true, createdAt: '2025-01-01T00:00:00Z',
      match: { field: 'merchant', op: 'contains', value: 'NORTHWIND' },
      set: { sourceCategory: 'Consulting' },
    }];
    const g = buildMappingGroups({ transactions: deposits(3), accounts: ACCOUNTS, rules })[0];
    expect(g.suggestion!.why.split('.').filter(Boolean)).toHaveLength(1);
    expect(g.suggestion!.confidence).toBeGreaterThan(0);
    expect(g.suggestion!.confidence).toBeLessThanOrEqual(1);
  });

  it('ships no vendor list and no invented category vocabulary', () => {
    const source = readFileSync(join(process.cwd(), 'src/lib/mapping-suggestions.ts'), 'utf8');
    const upper = source.toUpperCase();
    const vendors = [
      'CHATGPT', 'OPENAI', 'NETFLIX', 'SPOTIFY', 'HULU', 'DISNEY', 'AMAZON', 'PRIME VIDEO',
      'APPLE', 'GOOGLE', 'MICROSOFT', 'ADOBE', 'DROPBOX', 'WALMART', 'TARGET', 'COSTCO',
      'STARBUCKS', 'UBER', 'LYFT', 'VENMO', 'PAYPAL', 'CHASE', 'WELLS FARGO', 'ANTHROPIC',
    ];
    for (const vendor of vendors) expect(upper).not.toContain(vendor);
    expect(source).not.toMatch(/KNOWN_MERCHANTS|VENDOR_LIST|MERCHANT_REGISTRY|MERCHANT_CATALOGUE|SEED_MERCHANTS/);
    // Every category a suggestion can propose comes from a row or a rule, never a literal.
    expect(source).not.toMatch(/category:\s*'(?!\$)/);
  });
});

// ---------------------------------------------------------------------------
// C. "Leave it unknown" — terminal
// ---------------------------------------------------------------------------

describe('M3 leaving a group unknown stops the queue asking', () => {
  it('writes one dismissal per row, through the existing review record', () => {
    const g = buildMappingGroups({ transactions: deposits(5), accounts: ACCOUNTS })[0];
    const writes = markGroupUnknown(g, '2026-08-02T00:00:00Z');
    expect(writes).toHaveLength(5);
    expect(writes.every((w) => w.state === 'dismissed')).toBe(true);
    expect(writes.every((w) => w.reasons?.includes(GROUP_UNKNOWN_REASON))).toBe(true);
    expect(writes.every((w) => w.source === 'user')).toBe(true);
  });

  it('does not rebuild the group on a re-run — including for rows imported afterwards', () => {
    const rows = deposits(5);
    const g = buildMappingGroups({ transactions: rows, accounts: ACCOUNTS })[0];
    const reviews = Object.fromEntries(
      markGroupUnknown(g, '2026-08-02T00:00:00Z').map((r) => [r.transactionId, r])
    );
    expect(buildMappingGroups({ transactions: rows, accounts: ACCOUNTS, income: { sources: [], reviews } })).toEqual([]);

    // A later import brings two more rows of the same pattern. Still silent.
    const later = [...rows, ...deposits(2, { date: '2026-07-05' })];
    expect(buildMappingGroups({ transactions: later, accounts: ACCOUNTS, income: { sources: [], reviews } })).toEqual([]);
  });

  it('silences only the group that was answered', () => {
    const rows = [...deposits(3), ...deposits(3, { merchant: 'CALDERA FUND', title: 'CALDERA FUND' })];
    const groups = buildMappingGroups({ transactions: rows, accounts: ACCOUNTS });
    const reviews = Object.fromEntries(
      markGroupUnknown(groupFor(groups, 'NORTHWIND DEPOSIT'), '2026-08-02T00:00:00Z').map((r) => [r.transactionId, r])
    );
    const after = buildMappingGroups({ transactions: rows, accounts: ACCOUNTS, income: { sources: [], reviews } });
    expect(after.map((g) => g.signalValue)).toEqual(['CALDERA FUND']);
  });

  it('a confirmed group does not reappear either', () => {
    const rows = deposits(4);
    const g = buildMappingGroups({ transactions: rows, accounts: ACCOUNTS })[0];
    const writes = confirmGroupMeaning(g, 'gift_or_personal_transfer', '2026-08-02T00:00:00Z');
    expect(writes.every((w) => w.state === 'confirmed' && w.meaning === 'gift_or_personal_transfer')).toBe(true);
    const reviews = Object.fromEntries(writes.map((r) => [r.transactionId, r]));
    expect(buildMappingGroups({ transactions: rows, accounts: ACCOUNTS, income: { sources: [], reviews } })).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// D. Scope, preview and the confirmation gate
// ---------------------------------------------------------------------------

describe('M4 nothing applies until the owner has seen what it would do', () => {
  it('offers only the scopes the group can actually express', () => {
    const single = buildMappingGroups({ transactions: deposits(3), accounts: ACCOUNTS })[0];
    expect(groupScopes(single)).toEqual([
      'only_this_group', 'same_normalized_merchant', 'merchant_and_account',
      'merchant_and_direction', 'future_only',
    ]);
    // Two accounts → "merchant + account" is not a single answer, so it is not offered.
    const multi = buildMappingGroups({
      transactions: [tx({ accountId: 'chk' }), tx({ accountId: 'sav' })], accounts: ACCOUNTS,
    })[0];
    expect(groupScopes(multi)).not.toContain('merchant_and_account');
    // A counterparty group gains the counterparty scope.
    const person = buildMappingGroups({
      transactions: [tx({ merchant: 'Zelle', title: 'Zelle', description: 'Zelle payment from ALDEN RUIZ CONF1' })],
      accounts: ACCOUNTS,
    })[0];
    expect(groupScopes(person)).toContain('same_counterparty');
  });

  it('"this group only" creates no rule at all', () => {
    const g = buildMappingGroups({ transactions: deposits(3), accounts: ACCOUNTS })[0];
    expect(buildGroupRule(g, 'only_this_group', { sourceCategory: 'Gifts' })).toBeNull();
  });

  it('shows affected count, date range and the future answer BEFORE anything applies', () => {
    const rows = deposits(3);
    const g = buildMappingGroups({ transactions: rows, accounts: ACCOUNTS })[0];
    const rule = buildGroupRule(g, 'same_normalized_merchant', { sourceCategory: 'Gifts' })!;
    const preview = groupPreview(g, rule, { transactions: rows, accounts: ACCOUNTS });
    expect(preview.affectedCount).toBe(3);
    expect(preview.dateRange).toBe('2025-01-05 to 2025-03-05');
    expect(preview.includesFutureRows).toBe(true);
    expect(preview.whatChanges).toContain('Gifts');
    expect(preview.budgetEffect).toBeTruthy();
    expect(preview.forecastEffect).toBeTruthy();
    expect(preview.flowEffect).toBeTruthy();
    // The rows are untouched — a preview is a calculation, not a write.
    expect(rows.every((t) => t.sourceCategory === 'Other Income')).toBe(true);
  });

  it('"future only" states that history is left alone, and matches no existing row', () => {
    const rows = deposits(3);
    const g = buildMappingGroups({ transactions: rows, accounts: ACCOUNTS })[0];
    const rule = buildGroupRule(g, 'future_only', { sourceCategory: 'Gifts' }, '2026-08-02')!;
    expect(rule.match.onOrAfter).toBe('2026-08-02');
    const preview = groupPreview(g, rule, { transactions: rows, accounts: ACCOUNTS });
    expect(preview.affectedCount).toBe(0);
    expect(preview.includesFutureRows).toBe(true);
    expect(preview.dateRange).toBe('no existing rows');
  });

  it('a broad rule cannot be applied in one click', () => {
    // §7.3's threshold is 25 rows or 10% of the ledger, whichever is SMALLER, so both
    // cases need a ledger big enough for the percentage not to be the binding one.
    const filler = deposits(300, { merchant: 'UNRELATED', title: 'UNRELATED' });
    const wide = [...deposits(40), ...filler];
    const g = buildMappingGroups({ transactions: wide, accounts: ACCOUNTS })[0];
    const rule = buildGroupRule(g, 'same_normalized_merchant', { sourceCategory: 'Gifts' })!;
    expect(g.signalValue).toBe('UNRELATED'); // the bigger group ranks first
    expect(groupPreview(g, rule, { transactions: wide, accounts: ACCOUNTS }).needsExtraConfirmation).toBe(true);

    const narrow = [...deposits(3), ...filler];
    const small = buildMappingGroups({ transactions: narrow, accounts: ACCOUNTS })
      .find((x) => x.signalValue === 'NORTHWIND DEPOSIT')!;
    const smallRule = buildGroupRule(small, 'same_normalized_merchant', { sourceCategory: 'Gifts' })!;
    expect(groupPreview(small, smallRule, { transactions: narrow, accounts: ACCOUNTS }).needsExtraConfirmation).toBe(false);
  });
});

describe('M5 a generated rule matches exactly the rows previewed and no more', () => {
  it('does not reach outflows to the same merchant when the scope names a direction', () => {
    // The measured failure: `merchant contains X` alone pulled in the merchant's
    // OUTFLOWS as well, which would have rewritten spending rows.
    const inflows = deposits(3, { merchant: 'MERIDIAN CO', title: 'MERIDIAN CO' });
    const outflows = deposits(5, { merchant: 'MERIDIAN CO', title: 'MERIDIAN CO', type: 'expense', date: '2025-09-09' });
    const all = [...inflows, ...outflows];
    const g = buildMappingGroups({ transactions: all, accounts: ACCOUNTS })[0];

    const broad = buildGroupRule(g, 'same_normalized_merchant', { sourceCategory: 'Gifts' })!;
    expect(rulePreview(stored(broad), all).matches).toBe(8); // honest: it says it hits all 8

    const scoped = buildGroupRule(g, 'merchant_and_direction', { sourceCategory: 'Gifts' })!;
    const preview = groupPreview(g, scoped, { transactions: all, accounts: ACCOUNTS });
    expect(preview.affectedCount).toBe(3);
    const changed = all.filter((t) => applyMappingRules(t, [stored(scoped)]) !== t);
    expect(changed).toHaveLength(preview.affectedCount);
    expect(changed.every((t) => t.type === 'income')).toBe(true);
  });

  it('the account scope changes rows on that account and nowhere else', () => {
    const here = deposits(3, { accountId: 'chk' });
    const there = deposits(4, { accountId: 'sav', date: '2025-07-07' });
    const all = [...here, ...there];
    const g = buildMappingGroups({ transactions: here, accounts: ACCOUNTS })[0];
    const rule = buildGroupRule(g, 'merchant_and_account', { sourceCategory: 'Gifts' })!;
    const preview = groupPreview(g, rule, { transactions: all, accounts: ACCOUNTS });
    expect(preview.affectedCount).toBe(3);
    const changed = all.filter((t) => applyMappingRules(t, [stored(rule)]) !== t);
    expect(changed.map((t) => t.accountId)).toEqual(['chk', 'chk', 'chk']);
  });

  it('the counterparty scope reaches that person and not the other', () => {
    const all = [
      tx({ merchant: 'Zelle', title: 'Zelle', description: 'Zelle payment from ALDEN RUIZ CONF1', date: '2025-04-02' }),
      tx({ merchant: 'Zelle', title: 'Zelle', description: 'Zelle payment from ALDEN RUIZ CONF2', date: '2025-05-02' }),
      tx({ merchant: 'Zelle', title: 'Zelle', description: 'Zelle payment from BRISA OKON CONF3', date: '2025-06-02' }),
    ];
    const g = groupFor(buildMappingGroups({ transactions: all, accounts: ACCOUNTS }), 'ALDEN RUIZ');
    const rule = buildGroupRule(g, 'same_counterparty', { sourceCategory: 'Repayment' })!;
    const preview = groupPreview(g, rule, { transactions: all, accounts: ACCOUNTS });
    expect(preview.affectedCount).toBe(2);
    const changed = all.filter((t) => applyMappingRules(t, [stored(rule)]) !== t);
    expect(changed).toHaveLength(2);
    expect(changed.every((t) => (t.description ?? '').includes('ALDEN RUIZ'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// E. The rule engine's existing behaviour is untouched
// ---------------------------------------------------------------------------

describe('M6 the additive rule fields change nothing that already worked', () => {
  const legacy: MappingRule = {
    id: 'old', enabled: true, createdAt: '2024-01-01T00:00:00Z',
    match: { field: 'merchant', op: 'contains', value: 'ORCHID' },
    set: { category: 'food' },
  };

  it('a rule with no direction, account or date still matches every row it used to', () => {
    const rows = [
      tx({ merchant: 'ORCHID CAFE', type: 'expense', date: '2020-01-01' }),
      tx({ merchant: 'ORCHID CAFE', type: 'income', date: '2030-01-01' }),
      tx({ merchant: 'ORCHID CAFE', type: 'transfer', transferDirection: 'in', date: '2025-01-01' }),
    ];
    expect(rulePreview(legacy, rows).matches).toBe(3);
    for (const r of rows) expect(applyMappingRules(r, [legacy]).category).toBe('food');
  });

  it('precedence is unchanged — the first enabled matching rule still wins', () => {
    const newer: MappingRule = { ...legacy, id: 'new', set: { category: 'shopping' } };
    const row = tx({ merchant: 'ORCHID CAFE', type: 'expense' });
    expect(applyMappingRules(row, [newer, legacy]).category).toBe('shopping');
    expect(applyMappingRules(row, [legacy, newer]).category).toBe('food');
  });

  it('a disabled rule is still ignored, and an empty needle still matches nothing', () => {
    expect(applyMappingRules(tx({ merchant: 'ORCHID CAFE' }), [{ ...legacy, enabled: false }]).category).toBe('other');
    expect(applyMappingRules(tx({ merchant: 'ORCHID CAFE' }), [{ ...legacy, match: { ...legacy.match, value: '  ' } }]).category).toBe('other');
  });

  it('describeRule says the new qualifiers out loud instead of hiding them', () => {
    const scoped: MappingRule = {
      ...legacy,
      match: { ...legacy.match, direction: 'inflow', accountId: 'chk', onOrAfter: '2026-01-01' },
    };
    const text = describeRule(scoped);
    expect(text).toMatch(/money in/i);
    expect(text).toMatch(/2026-01-01/);
    expect(describeRule(legacy)).not.toMatch(/money in|money out/i);
  });
});
