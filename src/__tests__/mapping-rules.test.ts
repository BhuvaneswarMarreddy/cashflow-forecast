import { applyMappingRules, describeRule, MappingRule, rulePreview } from '@/lib/mapping-rules';
import { classifyTransaction } from '@/lib/classify';
import { PaymentAccount, Transaction } from '@/types';

const rule = (over: Partial<MappingRule> & Pick<MappingRule, 'match' | 'set'>): MappingRule => ({
  id: 'r1',
  createdAt: '2026-07-29T00:00:00.000Z',
  enabled: true,
  ...over,
});

const txn = (over: Partial<Transaction> = {}): Transaction => ({
  id: 't1',
  title: 'INSTACART*SF',
  amount: 84.12,
  type: 'expense',
  category: 'other',
  paymentMethod: 'visa',
  date: '2026-07-01',
  ...over,
});

describe('applyMappingRules', () => {
  it('applies the set fields of a matching rule', () => {
    const r = rule({
      match: { field: 'merchant', op: 'contains', value: 'instacart' },
      set: { category: 'food', sourceCategory: 'Groceries' },
    });
    const out = applyMappingRules(txn({ merchant: 'Instacart' }), [r]);

    expect(out.category).toBe('food');
    expect(out.sourceCategory).toBe('Groceries');
    expect(out.amount).toBe(84.12); // everything else untouched
  });

  it('matches case-insensitively in both directions', () => {
    const r = rule({
      match: { field: 'title', op: 'contains', value: 'ROYAL biryani' },
      set: { sourceCategory: 'Dining' },
    });
    expect(applyMappingRules(txn({ title: 'royal BIRYANI house #22' }), [r]).sourceCategory).toBe('Dining');
  });

  it('honours op: equals (whole field, trimmed) vs contains', () => {
    const eq = rule({
      match: { field: 'merchant', op: 'equals', value: 'Carvana' },
      set: { sourceCategory: 'Car Loan' },
    });
    expect(applyMappingRules(txn({ merchant: '  carvana ' }), [eq]).sourceCategory).toBe('Car Loan');
    expect(applyMappingRules(txn({ merchant: 'Carvana Payments' }), [eq]).sourceCategory).toBeUndefined();
  });

  it('first ENABLED match wins', () => {
    const first = rule({
      id: 'a',
      match: { field: 'merchant', op: 'contains', value: 'instacart' },
      set: { sourceCategory: 'Groceries' },
    });
    const second = rule({
      id: 'b',
      match: { field: 'merchant', op: 'contains', value: 'instacart' },
      set: { sourceCategory: 'Delivery' },
    });
    expect(applyMappingRules(txn({ merchant: 'Instacart' }), [first, second]).sourceCategory).toBe('Groceries');
  });

  it('skips disabled rules and falls through to the next one', () => {
    const off = rule({
      id: 'a',
      enabled: false,
      match: { field: 'merchant', op: 'contains', value: 'instacart' },
      set: { sourceCategory: 'Delivery' },
    });
    const on = rule({
      id: 'b',
      match: { field: 'merchant', op: 'contains', value: 'instacart' },
      set: { sourceCategory: 'Groceries' },
    });
    expect(applyMappingRules(txn({ merchant: 'Instacart' }), [off, on]).sourceCategory).toBe('Groceries');
    expect(applyMappingRules(txn({ merchant: 'Instacart' }), [off]).sourceCategory).toBeUndefined();
  });

  it('passes the row through untouched when nothing matches', () => {
    const t = txn({ merchant: 'Shell' });
    const r = rule({
      match: { field: 'merchant', op: 'contains', value: 'instacart' },
      set: { category: 'food' },
    });
    expect(applyMappingRules(t, [r])).toBe(t);
    expect(applyMappingRules(t, [])).toBe(t);
  });

  it('does not match when the named field is absent on the row', () => {
    const r = rule({
      match: { field: 'description', op: 'contains', value: 'instacart' },
      set: { category: 'food' },
    });
    // merchant says Instacart, but the rule reads `description`, which this row lacks.
    expect(applyMappingRules(txn({ merchant: 'Instacart' }), [r]).category).toBe('other');
  });

  it('never matches on an empty value (would otherwise rewrite the whole ledger)', () => {
    const r = rule({
      match: { field: 'title', op: 'contains', value: '   ' },
      set: { category: 'food' },
    });
    expect(applyMappingRules(txn(), [r]).category).toBe('other');
  });

  it('is pure — the input row is never mutated', () => {
    const t = txn({ merchant: 'Instacart' });
    const snapshot = JSON.parse(JSON.stringify(t));
    const r = rule({
      match: { field: 'merchant', op: 'contains', value: 'instacart' },
      set: { category: 'food', merchant: 'Instacart' },
    });

    const out = applyMappingRules(t, [r]);
    expect(t).toEqual(snapshot);
    expect(out).not.toBe(t);
  });

  it('ignores undefined set fields instead of blanking the row', () => {
    const t = txn({ merchant: 'Instacart', sourceCategory: 'Shopping' });
    const r = rule({
      match: { field: 'merchant', op: 'contains', value: 'instacart' },
      set: { category: 'food', sourceCategory: undefined },
    });
    expect(applyMappingRules(t, [r]).sourceCategory).toBe('Shopping');
  });

  it('works on partial/in-flight rows (no id yet)', () => {
    const r = rule({
      match: { field: 'title', op: 'contains', value: 'amzn' },
      set: { category: 'shopping' },
    });
    const inFlight: Partial<Transaction> = { title: 'AMZN Mktp US' };
    expect(applyMappingRules(inFlight, [r]).category).toBe('shopping');
  });
});

describe('rules vs classifyTransaction', () => {
  const accounts: PaymentAccount[] = [
    {
      id: 'card1',
      name: 'Amex',
      type: 'credit_card',
      provider: 'amex',
      color: '#000',
      isActive: true,
      openingBalance: 0,
      openingDate: '2026-01-01',
    },
  ];

  it('the owner\'s category beats the heuristic — classify never touches category', () => {
    // "AMZ_STORECRD_PMT" on a card is a transfer to the classifier, but the owner said
    // Carvana is a Car Loan; the label they set is what every screen shows.
    const t = txn({ title: 'CARVANA AUTO PYMT', accountId: 'card1', category: 'other' });
    const r = rule({
      match: { field: 'title', op: 'contains', value: 'carvana' },
      set: { sourceCategory: 'Car Loan', category: 'transportation' },
    });

    const ruled = applyMappingRules(t, [r]);
    expect(ruled.sourceCategory).toBe('Car Loan');
    expect(ruled.category).toBe('transportation');
    // Rules run BEFORE classify, and classify leaves the owner's labels alone.
    expect(classifyTransaction(ruled, accounts)).toBe(classifyTransaction(t, accounts));
  });

  it('a rule that sets type transfer survives the classifier', () => {
    const t = txn({ title: 'ZELLE TO MOM', type: 'expense' });
    expect(classifyTransaction(t)).toBe('expense');

    const r = rule({
      match: { field: 'title', op: 'contains', value: 'zelle to mom' },
      set: { type: 'transfer' },
    });
    expect(classifyTransaction(applyMappingRules(t, [r]))).toBe('transfer');
  });

  it('KNOWN CEILING: a rule setting type expense loses to a transfer-shaped title', () => {
    // Documented in mapping-rules.ts — classifyTransaction re-derives type from the title
    // for everything except a stored 'transfer'. Fixing it needs a guard in classify.ts.
    const t = txn({ title: 'ONLINE TRANSFER TO SAVINGS' });
    const r = rule({
      match: { field: 'title', op: 'contains', value: 'online transfer to savings' },
      set: { type: 'expense' },
    });
    const ruled = applyMappingRules(t, [r]);

    expect(ruled.type).toBe('expense');
    expect(classifyTransaction(ruled)).toBe('transfer');
  });
});

describe('rulePreview', () => {
  const rows: Transaction[] = [
    txn({ id: '1', merchant: 'Instacart', category: 'other' }),
    txn({ id: '2', merchant: 'INSTACART*SF', category: 'other' }),
    txn({ id: '3', merchant: 'instacart', category: 'other' }),
    txn({ id: '4', merchant: 'Shell', category: 'transportation' }),
    txn({ id: '5', merchant: 'Instacart', category: 'food' }), // already correct
  ];

  it('counts only the rows the rule would actually change', () => {
    const r = rule({
      match: { field: 'merchant', op: 'contains', value: 'instacart' },
      set: { category: 'food' },
    });
    const preview = rulePreview(r, rows);

    expect(preview.matches).toBe(3); // row 5 already food, row 4 is not Instacart
    expect(preview.sample.map((t) => t.id)).toEqual(['1', '2', '3']);
  });

  it('caps the sample at 5 while still counting everything', () => {
    const many = Array.from({ length: 12 }, (_, i) => txn({ id: `x${i}`, merchant: 'Instacart' }));
    const r = rule({
      match: { field: 'merchant', op: 'contains', value: 'instacart' },
      set: { category: 'food' },
    });
    const preview = rulePreview(r, many);

    expect(preview.matches).toBe(12);
    expect(preview.sample).toHaveLength(5);
  });

  it('reports zero for a rule that matches nothing', () => {
    const r = rule({
      match: { field: 'merchant', op: 'contains', value: 'wegmans' },
      set: { category: 'food' },
    });
    expect(rulePreview(r, rows)).toEqual({ matches: 0, sample: [] });
  });

  it('previews a disabled rule too — it answers "what would this do?"', () => {
    const r = rule({
      enabled: false,
      match: { field: 'merchant', op: 'contains', value: 'instacart' },
      set: { category: 'food' },
    });
    expect(rulePreview(r, rows).matches).toBe(3);
  });
});

describe('describeRule', () => {
  it('reads as plain English', () => {
    expect(
      describeRule(
        rule({ match: { field: 'merchant', op: 'contains', value: 'AMZN' }, set: { category: 'shopping' } })
      )
    ).toBe('merchant contains "AMZN" → category Shopping');
  });

  it('lists every field the rule sets', () => {
    expect(
      describeRule(
        rule({
          match: { field: 'title', op: 'equals', value: 'CARVANA' },
          set: { category: 'transportation', sourceCategory: 'Car Loan', type: 'expense', merchant: 'Carvana' },
        })
      )
    ).toBe('title equals "CARVANA" → category Transportation, label "Car Loan", type expense, merchant "Carvana"');
  });

  it('says so when a rule sets nothing', () => {
    expect(describeRule(rule({ match: { field: 'title', op: 'contains', value: 'x' }, set: {} }))).toBe(
      'title contains "x" → no change'
    );
  });
});
