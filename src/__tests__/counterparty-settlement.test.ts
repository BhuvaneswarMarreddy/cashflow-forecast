/**
 * FIN-SETTLEMENT-003 — the counterparty lines.
 *
 * Every fixture here is INVENTED: made-up people, made-up amounts, made-up ids. Where a
 * test reproduces something measured on the owner's real export it reproduces the SHAPE
 * — the row count, the direction split, the category mix — and never a real name or a
 * real value. The one literal that is not invented is `REMITLY`, which is a service and
 * is already the key `personFrom()` mints in `src/lib/counterparty.ts`.
 *
 * THE RULE UNDER TEST, above every other: nothing auto-applies. The owner's stated
 * intent sets the DEFAULT a proposal carries. Only a confirmation moves a number.
 */
import { PaymentAccount, Transaction } from '@/types';
import {
  interpretTransaction,
  personalCostSign,
  sumExpenseCents,
} from '@/lib/classify';
import { buildFlowGraph, counterpartyRowIds, toCents } from '@/lib/flows';
import { namesExternalCounterparty } from '@/lib/counterparty';
import { detectCounterpartyLedger } from '@/lib/mapping-evidence';
import {
  GROUP_MEANINGS,
  MappingGroup,
  OUTFLOW_GROUP_MEANINGS,
  buildMappingGroups,
  confirmGroupMeaning,
  groupMeanings,
  markGroupUnknown,
} from '@/lib/mapping-suggestions';

const ACCOUNTS: PaymentAccount[] = [
  { id: 'chk', name: 'Demo Checking', type: 'bank_account', openingBalance: 0, openingDate: '2020-01-01', provider: 'other', color: '#000', isActive: true },
  { id: 'sav', name: 'Demo Savings', type: 'bank_account', openingBalance: 0, openingDate: '2020-01-01', provider: 'other', color: '#000', isActive: true },
] as PaymentAccount[];

let seq = 0;
beforeEach(() => { seq = 0; });

/** A Zelle-shaped row naming an invented counterparty. */
const zelle = (
  who: string,
  dir: 'in' | 'out',
  amount: number,
  date: string,
  over: Partial<Transaction> = {}
): Transaction => ({
  id: `z${++seq}`,
  title: 'Zelle',
  merchant: 'Zelle',
  description: `Zelle payment ${dir === 'out' ? 'to' : 'from'} ${who} Conf# ab${seq}cd`,
  sourceCategory: 'Transfer',
  amount,
  type: 'transfer',
  transferDirection: dir,
  category: 'other',
  paymentMethod: 'other',
  date,
  accountId: 'chk',
  ...over,
} as Transaction);

const dirOf = (t: Transaction) => (t.transferDirection === 'in' ? 'in' : 'out') as 'in' | 'out';
const ledgerOf = (rows: Transaction[]) => detectCounterpartyLedger(rows, dirOf)!;

/** Every group the owner would see, with the counterparty lanes wired in. */
const groupsFor = (rows: Transaction[], over: Record<string, unknown> = {}): MappingGroup[] => {
  const graph = buildFlowGraph(rows, ACCOUNTS);
  return buildMappingGroups({
    transactions: rows,
    accounts: ACCOUNTS,
    unpairedLegIds: [],
    counterpartyRowIds: counterpartyRowIds(graph),
    ...over,
  });
};

const forParty = (groups: MappingGroup[], who: string, direction: 'inflow' | 'outflow') =>
  groups.find((g) => g.signalValue === who && g.direction === direction);

// ---------------------------------------------------------------------------
// 1. detectCounterpartyLedger — the arithmetic
// ---------------------------------------------------------------------------

describe('detectCounterpartyLedger', () => {
  it('counts a lend-then-repay as at most one turn of the balance', () => {
    // Fronted $900 across three sends, repaid across four. The balance owes, then
    // squares, then owes the other way once at the end.
    const l = ledgerOf([
      zelle('JORDAN AVERY', 'out', 300, '2025-01-05'),
      zelle('JORDAN AVERY', 'out', 300, '2025-01-19'),
      zelle('JORDAN AVERY', 'out', 300, '2025-02-02'),
      zelle('JORDAN AVERY', 'in', 400, '2025-03-01'),
      zelle('JORDAN AVERY', 'in', 400, '2025-04-01'),
      zelle('JORDAN AVERY', 'in', 300, '2025-05-01'),
    ]);
    expect(l).toMatchObject({
      outRows: 3, inRows: 3, outCents: 90_000, inCents: 110_000, netCents: -20_000,
      signFlips: 1, firstDirection: 'out', settled: false,
    });
  });

  it('counts a running tab as many turns of the balance', () => {
    const l = ledgerOf([
      zelle('RILEY OKONKWO', 'out', 200, '2025-01-05'),
      zelle('RILEY OKONKWO', 'in', 500, '2025-01-20'),
      zelle('RILEY OKONKWO', 'out', 700, '2025-02-10'),
      zelle('RILEY OKONKWO', 'in', 600, '2025-03-04'),
      zelle('RILEY OKONKWO', 'out', 400, '2025-03-28'),
    ]);
    expect(l.signFlips).toBeGreaterThanOrEqual(2);
  });

  it('calls an exactly-even relationship settled, and a zero balance is not a turn', () => {
    const l = ledgerOf([
      zelle('PARKER LINDQVIST', 'out', 500, '2025-02-01'),
      zelle('PARKER LINDQVIST', 'in', 500, '2025-02-17'),
    ]);
    expect(l).toMatchObject({ settled: true, netCents: 0, signFlips: 0, spanDays: 16 });
  });

  it('reports a one-way line rather than refusing it — "nothing came back" is a fact', () => {
    const l = ledgerOf([
      zelle('AVA TREMBLAY', 'out', 250, '2025-01-05'),
      zelle('AVA TREMBLAY', 'out', 250, '2025-04-05'),
    ]);
    expect(l).toMatchObject({ inRows: 0, inCents: 0, netCents: 50_000, signFlips: 0, settled: false });
  });

  it('returns null only for no rows', () => {
    expect(detectCounterpartyLedger([], dirOf)).toBeNull();
  });

  it('keeps the owner\'s own category words and drops the importer\'s plumbing ones', () => {
    const l = ledgerOf([
      zelle('SASHA BRENNAN', 'out', 100, '2025-01-05', { sourceCategory: 'Transfer' }),
      zelle('SASHA BRENNAN', 'out', 100, '2025-01-06', { sourceCategory: 'Credit Card Payment' }),
      zelle('SASHA BRENNAN', 'out', 100, '2025-01-07', { sourceCategory: '' }),
      zelle('SASHA BRENNAN', 'out', 100, '2025-01-08', { sourceCategory: 'Uncategorized' }),
      zelle('SASHA BRENNAN', 'out', 100, '2025-01-09', { sourceCategory: 'Rent' }),
      zelle('SASHA BRENNAN', 'out', 100, '2025-01-10', { sourceCategory: 'Home Improvement' }),
    ]);
    expect(l.ownerCategories).toEqual(['Home Improvement', 'Rent']);
    expect(l.ownerCategorisedRows).toBe(2);
  });

  it('is order-independent — the rows are sorted before the balance is walked', () => {
    const rows = [
      zelle('KAI NAKAMURA', 'out', 300, '2025-01-05'),
      zelle('KAI NAKAMURA', 'in', 300, '2025-03-05'),
    ];
    expect(ledgerOf([...rows].reverse())).toEqual(ledgerOf(rows));
  });
});

// ---------------------------------------------------------------------------
// 2. The terminal lane — the defect this task exists to close
// ---------------------------------------------------------------------------

describe('the counterparty lanes stop being terminal', () => {
  const oneWayOut = () =>
    Array.from({ length: 6 }, (_, i) =>
      zelle('AVA TREMBLAY', 'out', 400, `2025-0${i + 1}-11`)
    );

  it('asks NOTHING about outbound counterparty rows when the lane is not wired in', () => {
    // The measured Phase 1 state: 0 of 155 outbound counterparty rows reached the queue.
    const rows = oneWayOut();
    const groups = buildMappingGroups({ transactions: rows, accounts: ACCOUNTS });
    expect(groups.flatMap((g) => g.transactionIds)).toHaveLength(0);
  });

  it('asks about them once the graph\'s own person rows are fed in', () => {
    const rows = oneWayOut();
    const g = forParty(groupsFor(rows), 'AVA TREMBLAY', 'outflow')!;
    expect(g.kind).toBe('counterparty_line');
    expect(g.rowCount).toBe(6);
    expect(g.totalCents).toBe(240_000);
  });

  it('reads the rows off the graph rather than re-deriving them', () => {
    const rows = oneWayOut();
    const graph = buildFlowGraph(rows, ACCOUNTS);
    const fromGraph = counterpartyRowIds(graph).sort();
    expect(fromGraph).toEqual(rows.map((r) => r.id).sort());
  });

  it('never asks twice about a row the owner has already answered', () => {
    const rows = oneWayOut();
    const reviews = Object.fromEntries(
      rows.map((r) => [r.id, { transactionId: r.id, state: 'confirmed' as const, meaning: 'personal_expense' as const, updatedAt: '2025-07-01' }])
    );
    expect(forParty(groupsFor(rows, { income: { sources: [], reviews } }), 'AVA TREMBLAY', 'outflow')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 3. The two evidence kinds
// ---------------------------------------------------------------------------

describe('counterparty_settlement', () => {
  const lendThenRepay = () => [
    zelle('JORDAN AVERY', 'out', 300, '2025-01-05'),
    zelle('JORDAN AVERY', 'out', 300, '2025-01-19'),
    zelle('JORDAN AVERY', 'out', 300, '2025-02-02'),
    zelle('JORDAN AVERY', 'in', 400, '2025-03-01'),
    zelle('JORDAN AVERY', 'in', 400, '2025-04-01'),
    zelle('JORDAN AVERY', 'in', 300, '2025-05-01'),
  ];

  it('reads a lend-then-repay as money coming back that was lent', () => {
    const g = forParty(groupsFor(lendThenRepay()), 'JORDAN AVERY', 'inflow')!;
    expect(g.suggestion).toMatchObject({
      evidence: 'counterparty_settlement',
      meaning: 'receivable_repayment',
    });
    expect(g.suggestion!.why).toMatch(/both ways/);
  });

  it('reads a running tab as a shared cost being squared up', () => {
    const rows = [
      zelle('RILEY OKONKWO', 'out', 200, '2025-01-05'),
      zelle('RILEY OKONKWO', 'in', 500, '2025-01-20'),
      zelle('RILEY OKONKWO', 'out', 700, '2025-02-10'),
      zelle('RILEY OKONKWO', 'in', 600, '2025-03-04'),
      zelle('RILEY OKONKWO', 'out', 400, '2025-03-28'),
    ];
    expect(forParty(groupsFor(rows), 'RILEY OKONKWO', 'inflow')!.suggestion).toMatchObject({
      evidence: 'counterparty_settlement',
      meaning: 'shared_expense_reimbursement',
    });
  });

  it('never exceeds 0.85 — a shape is inference and can never outrank an answer', () => {
    const g = forParty(groupsFor(lendThenRepay()), 'JORDAN AVERY', 'inflow')!;
    expect(g.suggestion!.confidence).toBeLessThanOrEqual(0.85);
  });

  it('proposes nothing for the OUTFLOW side of a two-way line — the taxonomy has no "money I lent"', () => {
    expect(forParty(groupsFor(lendThenRepay()), 'JORDAN AVERY', 'outflow')!.suggestion).toBeNull();
  });

  it('does not fire for a one-way line, in either direction', () => {
    const rows = [zelle('AVA TREMBLAY', 'out', 250, '2025-01-05'), zelle('AVA TREMBLAY', 'out', 250, '2025-04-05')];
    expect(forParty(groupsFor(rows), 'AVA TREMBLAY', 'outflow')!.suggestion).toBeNull();
  });

  it('never answers a person-to-person credit with "this reverses a purchase"', () => {
    // Both legs of a Zelle row carry the SAME transport string, so the refund matcher can
    // pair a person's payment to you against your payment to someone else. Measured on
    // the real export: 30 counterparty inflow groups were answered `refund_candidate`
    // before this guard. A person is not a merchant you bought from.
    const rows = [
      zelle('AVA TREMBLAY', 'out', 250, '2025-01-05'),
      zelle('MORGAN DELACROIX', 'in', 250, '2025-01-09'),
    ];
    const g = forParty(groupsFor(rows), 'MORGAN DELACROIX', 'inflow')!;
    expect(g.suggestion?.evidence).not.toBe('refund_candidate');
    expect(g.suggestion?.meaning).not.toBe('refund');
  });

  it('never answers a person-to-person row with "money between your own accounts"', () => {
    // Equal, opposite, same day, both accounts owned — `same_day_opposite_leg`'s exact
    // signature. But the row NAMES someone else, and those two statements contradict.
    const rows = [
      zelle('MORGAN DELACROIX', 'in', 750, '2025-05-10'),
      {
        id: 'own-sweep', title: 'Online Transfer to Savings', merchant: 'Online Transfer to Savings',
        description: 'ONLINE TRANSFER TO SAVINGS 1234', sourceCategory: 'Transfer', amount: 750,
        type: 'transfer', transferDirection: 'out', category: 'other', paymentMethod: 'other',
        date: '2025-05-10', accountId: 'sav',
      } as Transaction,
    ];
    const g = forParty(groupsFor(rows), 'MORGAN DELACROIX', 'inflow')!;
    expect(g.suggestion?.evidence).not.toBe('same_day_opposite_leg');
    expect(g.suggestion?.meaning).not.toBe('internal_transfer');
  });
});

describe('owner_stated_category', () => {
  /**
   * The REMITLY SHAPE, as a shape: one counterparty, many outbound rows, ZERO inbound
   * rows ever, and a handful the owner filed under a category of their own instead of
   * leaving them as a transfer. Measured on the real export: 78 rows, 100% outbound,
   * 5 of them owner-categorised.
   *
   * The counterparty here is INVENTED on purpose — this must fire on shape, not on a
   * name. There is no vendor list.
   */
  const remittanceShape = (who = 'AVA TREMBLAY') =>
    Array.from({ length: 12 }, (_, i) =>
      zelle(who, 'out', 500 + i * 37, `2025-${String(i + 1).padStart(2, '0')}-11`, {
        sourceCategory: i < 2 ? 'Send Abroad' : 'Transfer',
      })
    );

  it('proposes the owner\'s own words: money that left', () => {
    const g = forParty(groupsFor(remittanceShape()), 'AVA TREMBLAY', 'outflow')!;
    expect(g.suggestion).toMatchObject({
      evidence: 'owner_stated_category',
      meaning: 'personal_expense',
      supportCount: 2,
    });
    expect(personalCostSign(g.suggestion!.meaning!)).toBe(1);
  });

  it('carries the measured one-way evidence in the sentence the owner reads', () => {
    const why = forParty(groupsFor(remittanceShape()), 'AVA TREMBLAY', 'outflow')!.suggestion!.why;
    expect(why).toMatch(/Send Abroad/);
    expect(why).toMatch(/nothing has ever come back/);
    expect(why).toMatch(/12 rows out, none in/);
  });

  it('fires on shape, not on a name — the same rows under a different party behave identically', () => {
    const a = forParty(groupsFor(remittanceShape('AVA TREMBLAY')), 'AVA TREMBLAY', 'outflow')!;
    const b = forParty(groupsFor(remittanceShape('MORGAN DELACROIX')), 'MORGAN DELACROIX', 'outflow')!;
    expect(a.suggestion!.evidence).toBe(b.suggestion!.evidence);
    expect(a.suggestion!.confidence).toBe(b.suggestion!.confidence);
  });

  it('stays below the confidence an answer the owner actually gave would carry', () => {
    expect(forParty(groupsFor(remittanceShape()), 'AVA TREMBLAY', 'outflow')!.suggestion!.confidence)
      .toBeLessThanOrEqual(0.85);
  });

  it('says nothing when the owner has said nothing — every row left as a transfer', () => {
    const rows = remittanceShape().map((t) => ({ ...t, sourceCategory: 'Transfer' } as Transaction));
    expect(forParty(groupsFor(rows), 'AVA TREMBLAY', 'outflow')!.suggestion).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 4. The answer list — an outflow group has to be answerable
// ---------------------------------------------------------------------------

describe('the answers offered', () => {
  it('offers spending answers for an outflow group and credit answers for an inflow one', () => {
    expect(groupMeanings('outflow')).toBe(OUTFLOW_GROUP_MEANINGS);
    expect(groupMeanings('inflow')).toBe(GROUP_MEANINGS);
    expect(groupMeanings('outflow').map((m) => m.value)).toContain('personal_expense');
    // Offering "someone paying me back" for money going OUT is a lie the UI cannot tell.
    expect(groupMeanings('outflow').map((m) => m.value)).not.toContain('receivable_repayment');
    expect(groupMeanings('inflow').map((m) => m.value)).not.toContain('personal_expense');
  });
});

// ---------------------------------------------------------------------------
// 5. NOTHING AUTO-APPLIES — and what a confirmation actually does
// ---------------------------------------------------------------------------

describe('nothing auto-applies', () => {
  const sends = () =>
    Array.from({ length: 12 }, (_, i) =>
      zelle('AVA TREMBLAY', 'out', 1000, `2025-${String(i + 1).padStart(2, '0')}-11`, {
        sourceCategory: i < 2 ? 'Send Abroad' : 'Transfer',
      })
    );

  it('leaves every number exactly where it was until the owner confirms', () => {
    const rows = sends();
    // The proposal exists...
    expect(forParty(groupsFor(rows), 'AVA TREMBLAY', 'outflow')!.suggestion!.meaning).toBe('personal_expense');
    // ...and has changed nothing.
    expect(sumExpenseCents(rows, ACCOUNTS)).toBe(0);
    expect(interpretTransaction(rows[0], ACCOUNTS).financialMeaning).toBe('internal_transfer');
    expect(interpretTransaction(rows[0], ACCOUNTS).expense).toBe('excluded');
  });

  it('counts the money as spending once, and only once, the owner confirms', () => {
    const rows = sends();
    const group = forParty(groupsFor(rows), 'AVA TREMBLAY', 'outflow')!;
    const reviews = Object.fromEntries(
      confirmGroupMeaning(group, 'personal_expense', '2025-07-01').map((r) => [r.transactionId, r])
    );
    const income = { sources: [], reviews };

    expect(interpretTransaction(rows[0], ACCOUNTS, income)).toMatchObject({
      type: 'transfer',           // the provider's word is still never re-derived
      financialMeaning: 'personal_expense',
      expense: 'counted',
      forecast: 'counted',
      budget: 'counted',
      confidence: 1,
    });
    expect(sumExpenseCents(rows, ACCOUNTS, income)).toBe(toCents(12_000));
  });

  /**
   * A mix the real export actually contains: rows the importer left as `Transfer`, and
   * rows the owner had already filed under a category of their own — which
   * `classifyTransaction()` therefore ALREADY calls spending. The two undo paths behave
   * differently on that second kind, and only one of them is an undo.
   */
  const mixed = () => [
    ...sends(),
    zelle('AVA TREMBLAY', 'out', 800, '2026-01-11', { type: 'expense', transferDirection: undefined, sourceCategory: 'Send Abroad' }),
  ];

  it('is undone by clearing the answer — the derived behaviour comes back EXACTLY', () => {
    const rows = mixed();
    const baseline = sumExpenseCents(rows, ACCOUNTS);
    expect(baseline).toBe(80_000); // the one row the importer already made spending

    const group = forParty(groupsFor(rows), 'AVA TREMBLAY', 'outflow')!;
    const confirmed = {
      sources: [],
      reviews: Object.fromEntries(
        confirmGroupMeaning(group, 'personal_expense', '2025-07-01').map((r) => [r.transactionId, r])
      ),
    };
    expect(sumExpenseCents(rows, ACCOUNTS, confirmed)).toBe(1_280_000);

    // "I can't classify these" — the terminal answer the card already offers. It is not
    // `confirmed`, so every row falls back to what the classifier derives.
    const cleared = {
      sources: [],
      reviews: Object.fromEntries(markGroupUnknown(group, '2025-07-02').map((r) => [r.transactionId, r])),
    };
    expect(sumExpenseCents(rows, ACCOUNTS, cleared)).toBe(baseline);
  });

  it('answering it back to a transfer is a DIFFERENT answer, not an undo', () => {
    // It also suppresses the row the importer had already made spending — correctly, and
    // that is the point: it is the owner saying something new, not a rollback.
    const rows = mixed();
    const group = forParty(groupsFor(rows), 'AVA TREMBLAY', 'outflow')!;
    const asTransfer = {
      sources: [],
      reviews: Object.fromEntries(
        confirmGroupMeaning(group, 'internal_transfer', '2025-07-02').map((r) => [r.transactionId, r])
      ),
    };
    expect(sumExpenseCents(rows, ACCOUNTS, asTransfer)).toBe(0);
    expect(sumExpenseCents(rows, ACCOUNTS)).toBe(80_000); // below the derived baseline
    expect(interpretTransaction(rows[0], ACCOUNTS, asTransfer).forecast).toBe('excluded');
  });

  it('does not move the Flow chart — confirming changes totals, not the picture', () => {
    const rows = sends();
    const group = forParty(groupsFor(rows), 'AVA TREMBLAY', 'outflow')!;
    const before = buildFlowGraph(rows, ACCOUNTS);
    const income = {
      sources: [],
      reviews: Object.fromEntries(
        confirmGroupMeaning(group, 'personal_expense', '2025-07-01').map((r) => [r.transactionId, r])
      ),
    };
    const after = buildFlowGraph(rows, ACCOUNTS, {}, { income });
    expect(after.links).toEqual(before.links);
    expect(after.nodes).toEqual(before.nodes);
  });
});

// ---------------------------------------------------------------------------
// 6. The predicate fix — narrowed by exactly one case
// ---------------------------------------------------------------------------

describe('a confirmation may override a provider transfer ONLY when it names a counterparty', () => {
  const review = (id: string, meaning: 'personal_expense' | 'earned_income') => ({
    sources: [],
    reviews: {
      [id]: { transactionId: id, state: 'confirmed' as const, meaning, source: 'user' as const, updatedAt: '2025-07-01' },
    },
  });

  it('recognises a counterparty row', () => {
    expect(namesExternalCounterparty(zelle('AVA TREMBLAY', 'out', 100, '2025-01-01'))).toBe(true);
  });

  it('does NOT recognise a row naming the owner themselves', () => {
    const own = zelle('ME', 'out', 100, '2025-01-01');
    expect(namesExternalCounterparty(own)).toBe(false);
  });

  it('keeps the veto for an ordinary internal transfer — the one that has no counterparty', () => {
    const t = {
      id: 'sweep1', title: 'Online Transfer to Savings', merchant: 'Online Transfer to Savings',
      description: 'ONLINE TRANSFER TO SAVINGS 1234', sourceCategory: 'Transfer',
      amount: 900, type: 'transfer', transferDirection: 'out', category: 'other',
      paymentMethod: 'other', date: '2025-04-01', accountId: 'chk',
    } as Transaction;
    const i = interpretTransaction(t, ACCOUNTS, review('sweep1', 'personal_expense'));
    // The provider said this money moved between accounts. No counterparty, no override.
    expect(i.financialMeaning).toBe('internal_transfer');
    expect(i.expense).toBe('excluded');
    expect(sumExpenseCents([t], ACCOUNTS, review('sweep1', 'personal_expense'))).toBe(0);
  });

  it('keeps the veto for a row naming the owner\'s own name on both sides', () => {
    const t = zelle('ME', 'out', 900, '2025-04-01');
    expect(interpretTransaction(t, ACCOUNTS, review(t.id, 'personal_expense')).expense).toBe('excluded');
  });

  it('a derived meaning still defers to the classifier — only a CONFIRMED one decides', () => {
    // No review at all: an ordinary expense row is spending because its TYPE says so,
    // exactly as before. The new branch must not have changed the un-reviewed path.
    const t = zelle('AVA TREMBLAY', 'out', 100, '2025-01-01', { type: 'expense', transferDirection: undefined, sourceCategory: 'Rent' });
    expect(interpretTransaction(t, ACCOUNTS).expense).toBe('counted');
    expect(sumExpenseCents([t], ACCOUNTS)).toBe(10_000);
  });
});
