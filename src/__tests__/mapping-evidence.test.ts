/**
 * MAP-002 — intelligent analysis: the evidence the ledger already carries.
 *
 * Every fixture here is INVENTED. Made-up payers, made-up amounts, made-up ids. Where a
 * test reproduces something measured on the owner's real export it reproduces the SHAPE
 * — the row count, the cadence, the span, the direction — and never a real value.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { FINANCIAL_MEANINGS, PaymentAccount, Transaction, isFinancialMeaning } from '@/types';
import { countsAsEarnedIncome, interpretTransaction, personalCostSign } from '@/lib/classify';
import { generateRefundCandidates } from '@/lib/refunds';
import {
  detectPayerSeries, missingPeriods, refundEvidenceFor, seriesEndDate, sharedTokens,
} from '@/lib/mapping-evidence';
import { GROUP_MEANINGS, MappingGroup, OUTFLOW_GROUP_MEANINGS, buildMappingGroups } from '@/lib/mapping-suggestions';

const ACCOUNTS: PaymentAccount[] = [
  { id: 'chk', name: 'Demo Checking', type: 'bank_account', openingBalance: 0, openingDate: '2020-01-01', provider: 'other', color: '#000', isActive: true },
  { id: 'sav', name: 'Demo Savings', type: 'bank_account', openingBalance: 0, openingDate: '2020-01-01', provider: 'other', color: '#000', isActive: true },
  { id: 'card', name: 'Demo Rewards Card', type: 'credit_card', openingBalance: 0, openingDate: '2020-01-01', provider: 'other', color: '#000', isActive: true },
] as PaymentAccount[];

let seq = 0;
const tx = (over: Partial<Transaction>): Transaction => ({
  id: `t${++seq}`,
  title: 'GENERIC ROW',
  merchant: 'GENERIC ROW',
  description: 'GENERIC ROW',
  sourceCategory: 'Other Income',
  amount: 100,
  type: 'income',
  category: 'other',
  paymentMethod: 'other',
  date: '2025-03-01',
  accountId: 'chk',
  ...over,
} as Transaction);

beforeEach(() => { seq = 0; });

const addDays = (d: string, n: number) =>
  new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

const groupFor = (groups: MappingGroup[], value: string) => groups.find((g) => g.signalValue === value)!;

// ---------------------------------------------------------------------------
// THE PHXAGILE SHAPE — salary is not a transfer
// ---------------------------------------------------------------------------

/**
 * The measured failure, as a shape: ONE external payer, 21 semi-monthly inflows across
 * twelve months into a deposit account, and every one of them followed the SAME DAY by an
 * equal outflow to another account the owner holds — because pay lands and is immediately
 * moved on to meet an obligation.
 *
 * `same_day_opposite_leg` used to answer this with `internal_transfer` at 0.9 confidence.
 * It is salary.
 */
function payrollThenSweep(payer = 'ATLAS FIELDWORK LLC'): Transaction[] {
  const rows: Transaction[] = [];
  let date = '2024-05-31';
  for (let i = 0; i < 21; i++) {
    const amount = 5500 + (i % 3) * 40; // real pay wobbles; it is still one band
    rows.push(tx({
      id: `pay${i}`, merchant: payer, title: payer,
      description: `${payer} DIRECT DEP PPD ID 55${i}`,
      sourceCategory: 'Paychecks', amount, date, accountId: 'chk', type: 'income',
    }));
    // Same day, same amount, into another account the owner holds. The old trap.
    rows.push(tx({
      id: `sweep${i}`, merchant: 'SAVINGS SWEEP', title: 'SAVINGS SWEEP',
      description: 'SAVINGS SWEEP', amount, date, accountId: 'sav', type: 'expense',
    }));
    date = addDays(date, i % 2 === 0 ? 15 : 16);
  }
  return rows;
}

describe('E1 an external payer is never called an internal transfer', () => {
  it('does NOT suggest internal_transfer for 21 salary deposits swept the same day', () => {
    const rows = payrollThenSweep();
    const g = groupFor(buildMappingGroups({ transactions: rows, accounts: ACCOUNTS }), 'ATLAS FIELDWORK LLC');
    expect(g.rowCount).toBe(21);
    expect(g.suggestion?.meaning).not.toBe('internal_transfer');
    expect(g.suggestion?.evidence).not.toBe('same_day_opposite_leg');
    // And it is not silence either — the ledger knows what this is.
    expect(g.suggestion?.evidence).toBe('payroll_shape');
    expect(g.suggestion?.meaning).toBe('earned_income');
  });

  it('still suggests internal_transfer for a genuine one-off move between two owned accounts', () => {
    const rows = [
      tx({ id: 'IN1', merchant: 'VESPER MOVE', title: 'VESPER MOVE', amount: 500, date: '2025-05-10', accountId: 'chk' }),
      tx({ id: 'OUT1', merchant: 'VESPER MOVE', title: 'VESPER MOVE', amount: 500, date: '2025-05-10', accountId: 'sav', type: 'expense' }),
    ];
    const g = buildMappingGroups({ transactions: rows, accounts: ACCOUNTS })[0];
    expect(g.suggestion?.evidence).toBe('same_day_opposite_leg');
    expect(g.suggestion?.meaning).toBe('internal_transfer');
  });

  it('refuses the transfer suggestion when the opposite leg is NOT an account the owner holds', () => {
    // Identical rows, but the far account is not in the owner's list. Nothing owned, no
    // transfer — the rung never consulted the account list before this fix.
    const rows = [
      tx({ id: 'IN1', merchant: 'VESPER MOVE', title: 'VESPER MOVE', amount: 500, date: '2025-05-10', accountId: 'chk' }),
      tx({ id: 'OUT1', merchant: 'VESPER MOVE', title: 'VESPER MOVE', amount: 500, date: '2025-05-10', accountId: 'not-mine', type: 'expense' }),
    ];
    expect(buildMappingGroups({ transactions: rows, accounts: ACCOUNTS })[0].suggestion).toBeNull();
  });

  it('refuses it for a cadenced payer even when the payroll rung itself declines', () => {
    // Pay into a CREDIT CARD: the payroll rung wants a deposit account and stands down,
    // and the answer is still "not a transfer" rather than "probably a transfer".
    const rows = payrollThenSweep().map((t) =>
      t.id.startsWith('pay') ? ({ ...t, accountId: 'card' } as Transaction) : t
    );
    const g = groupFor(buildMappingGroups({ transactions: rows, accounts: ACCOUNTS }), 'ATLAS FIELDWORK LLC');
    expect(g.suggestion).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The payroll shape, the income source it offers, and the end date it derives
// ---------------------------------------------------------------------------

describe('E2 the payroll shape, detected and explained', () => {
  it('finds one payer, a cadence, a deposit account and a multi-month window', () => {
    const g = groupFor(buildMappingGroups({ transactions: payrollThenSweep(), accounts: ACCOUNTS }), 'ATLAS FIELDWORK LLC');
    expect(g.suggestion?.evidence).toBe('payroll_shape');
    expect(g.suggestion?.supportCount).toBe(21);
    expect(g.firstDate).toBe('2024-05-31');
    expect(g.suggestion?.why).toContain('2024-05-31');
    expect(g.suggestion?.why).toContain(g.lastDate);
    expect(g.suggestion!.confidence).toBeGreaterThanOrEqual(0.5);
    expect(g.suggestion!.confidence).toBeLessThanOrEqual(0.85);
  });

  it('offers an income source pre-filled from the rows themselves', () => {
    const g = groupFor(buildMappingGroups({ transactions: payrollThenSweep(), accounts: ACCOUNTS }), 'ATLAS FIELDWORK LLC');
    const offer = g.suggestion!.incomeSourceOffer!;
    expect(offer.name).toBe('ATLAS FIELDWORK LLC');
    expect(offer.frequency).toBe('biweekly');
    expect(offer.amount).toBe(5540); // the median of the invented band, in dollars
    expect(offer.depositAccountIds).toEqual(['chk']);
    // The aliases are words every row's own text contains, not a dictionary.
    expect(offer.matchAliases!.length).toBeGreaterThan(0);
    for (const alias of offer.matchAliases!) {
      expect(payrollThenSweep()[0].description!.toUpperCase()).toContain(alias);
    }
    expect(offer.userApproved).toBe(true);
    expect((offer as { id?: string }).id).toBeUndefined(); // a proposal has no identity yet
  });

  it('derives endDate from the LAST occurrence when the series has clearly stopped', () => {
    // The ledger runs a further year past the last payment. Nothing arrived; it is over.
    const later = Array.from({ length: 6 }, (_, i) =>
      tx({ merchant: 'GROCERS', title: 'GROCERS', type: 'expense', amount: 40, date: `2026-0${i + 1}-04`, accountId: 'chk' })
    );
    const rows = [...payrollThenSweep(), ...later];
    const g = groupFor(buildMappingGroups({ transactions: rows, accounts: ACCOUNTS }), 'ATLAS FIELDWORK LLC');
    expect(g.suggestion!.incomeSourceOffer!.endDate).toBe(g.lastDate);
    expect(g.suggestion!.incomeSourceOffer!.isActive).toBe(false);
    expect(g.suggestion!.why).toContain(`none since ${g.lastDate}`);
  });

  it('gives a STILL-RUNNING series no endDate at all', () => {
    // The ledger ends the day after the last payment. Nothing is overdue, nothing ended.
    const rows = payrollThenSweep();
    const last = rows.filter((t) => t.id.startsWith('pay')).map((t) => t.date).sort().pop()!;
    const g = groupFor(
      buildMappingGroups({
        transactions: [...rows, tx({ merchant: 'GROCERS', title: 'GROCERS', type: 'expense', amount: 40, date: addDays(last, 1), accountId: 'chk' })],
        accounts: ACCOUNTS,
      }),
      'ATLAS FIELDWORK LLC'
    );
    expect(g.suggestion!.incomeSourceOffer!.endDate).toBeUndefined();
    expect(g.suggestion!.incomeSourceOffer!.isActive).toBe(true);
    expect(g.suggestion!.why).not.toContain('none since');
  });

  it('withholds the offer — but not the suggestion — for a band no income source can express', () => {
    const rows = Array.from({ length: 4 }, (_, i) =>
      tx({ merchant: 'QUARTER CO', title: 'QUARTER CO', amount: 900, date: addDays('2024-01-05', i * 91), accountId: 'chk' })
    );
    const g = buildMappingGroups({ transactions: rows, accounts: ACCOUNTS })[0];
    expect(g.suggestion?.evidence).toBe('payroll_shape');
    expect(g.suggestion?.incomeSourceOffer).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Missing periods — a finding, never a candidate
// ---------------------------------------------------------------------------

describe('E3 periods the cadence expected and the ledger does not have', () => {
  /** Monthly pay with THREE months silently absent — the measured shape. */
  const holed = () => {
    const rows: Transaction[] = [];
    for (let m = 0; m < 13; m++) {
      if ([4, 8, 11].includes(m)) continue; // three months with nothing at all
      const date = addDays('2024-05-15', m * 30);
      rows.push(tx({ id: `h${m}`, merchant: 'ORNSTEIN LABS', title: 'ORNSTEIN LABS', amount: 4200, date, accountId: 'chk' }));
    }
    return rows;
  };

  it('reports the count and the months, as a finding rather than a question', () => {
    const g = buildMappingGroups({ transactions: holed(), accounts: ACCOUNTS })[0];
    expect(g.rowCount).toBe(10);
    expect(g.findings).toHaveLength(1);
    expect(g.findings[0]).toMatch(/3 expected payments from this payer are absent/);
    expect(g.findings[0]).toContain('2024-09');
    expect(g.findings[0]).toContain('2025-01');
    expect(g.findings[0]).toContain('2025-04');
    // A finding is not an answer: it proposes no meaning and nothing can confirm it.
    expect(g.findings[0]).not.toMatch(/confirm/i);
  });

  it('counts nothing after the last payment — a series that stopped is not a series with holes', () => {
    const rows = [
      ...holed(),
      tx({ merchant: 'GROCERS', title: 'GROCERS', type: 'expense', amount: 40, date: '2027-01-01', accountId: 'chk' }),
    ];
    const g = buildMappingGroups({ transactions: rows, accounts: ACCOUNTS })[0];
    expect(g.findings[0]).toMatch(/3 expected payments/);   // still 3, not 3 + two years
  });

  it('reports nothing for an unbroken series', () => {
    const rows = Array.from({ length: 8 }, (_, i) =>
      tx({ merchant: 'STEADY WORKS', title: 'STEADY WORKS', amount: 3000, date: addDays('2025-01-10', i * 30), accountId: 'chk' })
    );
    expect(buildMappingGroups({ transactions: rows, accounts: ACCOUNTS })[0].findings).toEqual([]);
  });

  it('does not accumulate drift on a semi-monthly cadence whose gaps alternate', () => {
    // 13/16/13/16… is one payer paying twice a month. A fixed grid would drift into
    // phantom absences; dividing each real gap by the median cannot.
    const rows: Transaction[] = [];
    let date = '2025-01-15';
    for (let i = 0; i < 20; i++) {
      rows.push(tx({ merchant: 'SEMI PAY', title: 'SEMI PAY', amount: 2000, date, accountId: 'chk' }));
      date = addDays(date, i % 2 === 0 ? 16 : 13);
    }
    const series = detectPayerSeries(rows)!;
    expect(missingPeriods(rows, series).missing).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Refund evidence — cited from FIN-REFUND-001's own generator
// ---------------------------------------------------------------------------

describe('E4 a credit that already has a refund proposal says so', () => {
  const purchaseAndCredit = () => [
    tx({ id: 'buy', merchant: 'HOLLOWAY GOODS', title: 'HOLLOWAY GOODS', amount: 240, date: '2025-04-02', accountId: 'card', type: 'expense', sourceCategory: 'Shopping', category: 'shopping' }),
    tx({ id: 'back', merchant: 'HOLLOWAY GOODS', title: 'HOLLOWAY GOODS', amount: 240, date: '2025-04-20', accountId: 'card', type: 'income', sourceCategory: 'Shopping' }),
  ];

  it('cites the real generator, and matches nothing itself', () => {
    const rows = purchaseAndCredit();
    const run = generateRefundCandidates(rows, ACCOUNTS, [], { generatedAt: '2026-08-02T00:00:00Z' });
    expect(run.candidates.length).toBeGreaterThan(0);

    const g = buildMappingGroups({
      transactions: rows, accounts: ACCOUNTS, refundCandidates: run.candidates,
    })[0];
    expect(g.suggestion?.evidence).toBe('refund_candidate');
    expect(g.suggestion?.meaning).toBe('refund');
    expect(g.suggestion?.why).toMatch(/refund review already proposes a matching purchase/);
    // The confidence is the generator's own score, never a second ladder.
    expect(g.suggestion!.confidence).toBeLessThanOrEqual(0.9);
    expect(g.suggestion!.confidence).toBeGreaterThan(0);
    expect(refundEvidenceFor(rows.filter((t) => t.id === 'back'), run.candidates)!.rowIds).toEqual(['back']);
  });

  it('ignores a proposal the owner has already decided', () => {
    const rows = purchaseAndCredit();
    const run = generateRefundCandidates(rows, ACCOUNTS, [], { generatedAt: '2026-08-02T00:00:00Z' });
    const decided = run.candidates.map((c) => ({ ...c, status: 'dismissed' as const }));
    expect(refundEvidenceFor(rows, decided)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Loan proceeds — a new meaning, and what it must never become
// ---------------------------------------------------------------------------

describe('E5 borrowed money is neither income nor a windfall', () => {
  const withLoanAccount: PaymentAccount[] = [
    ...ACCOUNTS,
    { id: 'loan', name: 'MERIDIAN LENDING', type: 'personal_loan', openingBalance: 16000, openingDate: '2024-02-01', provider: 'other', color: '#000', isActive: true } as PaymentAccount,
  ];

  it('recognises a one-off credit from a party the owner holds a loan with', () => {
    const rows = [tx({ merchant: 'MERIDIAN LENDING', title: 'MERIDIAN LENDING', amount: 16110, date: '2024-02-05', accountId: 'chk' })];
    const g = buildMappingGroups({ transactions: rows, accounts: withLoanAccount })[0];
    expect(g.suggestion?.evidence).toBe('loan_proceeds');
    expect(g.suggestion?.meaning).toBe('loan_proceeds');
    expect(g.suggestion?.why).toMatch(/loan account you hold/);
    // Without that account in the owner's list there is no evidence and no suggestion.
    expect(buildMappingGroups({ transactions: rows, accounts: ACCOUNTS })[0].suggestion).toBeNull();
  });

  it('recognises repayments going back to the same payer afterwards', () => {
    const rows = [
      tx({ id: 'draw', merchant: 'PARAGON CREDIT', title: 'PARAGON CREDIT', amount: 16110, date: '2024-02-05', accountId: 'chk' }),
      ...Array.from({ length: 6 }, (_, i) =>
        tx({ merchant: 'PARAGON CREDIT', title: 'PARAGON CREDIT', amount: 520, type: 'expense', date: addDays('2024-03-05', i * 30), accountId: 'chk' })
      ),
    ];
    const g = groupFor(buildMappingGroups({ transactions: rows, accounts: ACCOUNTS }), 'PARAGON CREDIT');
    expect(g.suggestion?.evidence).toBe('loan_proceeds');
    expect(g.suggestion?.why).toMatch(/went back to/);
  });

  it('does not call a credit a loan when the money going back is the same size', () => {
    // A merchant that credits you $520 and that you also pay $520 a month is not a lender.
    const rows = [
      tx({ id: 'credit', merchant: 'PARAGON CREDIT', title: 'PARAGON CREDIT', amount: 1500, date: '2024-02-05', accountId: 'chk' }),
      ...Array.from({ length: 6 }, (_, i) =>
        tx({ merchant: 'PARAGON CREDIT', title: 'PARAGON CREDIT', amount: 1500, type: 'expense', date: addDays('2024-03-05', i * 30), accountId: 'chk' })
      ),
    ];
    expect(groupFor(buildMappingGroups({ transactions: rows, accounts: ACCOUNTS }), 'PARAGON CREDIT').suggestion).toBeNull();
  });

  it('loan_proceeds is a closed-set meaning that never counts as earned income', () => {
    expect(isFinancialMeaning('loan_proceeds')).toBe(true);
    expect(countsAsEarnedIncome('loan_proceeds')).toBe(false);
    expect(FINANCIAL_MEANINGS.filter(countsAsEarnedIncome)).toEqual(['earned_income']);
    // Borrowing is not a personal cost and not a cost coming back. The repayments are
    // the cost, and they are their own rows.
    expect(personalCostSign('loan_proceeds')).toBe(0);
    expect(GROUP_MEANINGS.map((m) => m.value)).toContain('loan_proceeds');
  });
});

// ---------------------------------------------------------------------------
// Honesty
// ---------------------------------------------------------------------------

describe('E6 the rules this module answers to', () => {
  it('ships no vendor list and no name list, in either owned module', () => {
    for (const file of ['src/lib/mapping-suggestions.ts', 'src/lib/mapping-evidence.ts']) {
      const source = readFileSync(join(process.cwd(), file), 'utf8');
      const upper = source.toUpperCase();
      const names = [
        'CHATGPT', 'OPENAI', 'NETFLIX', 'SPOTIFY', 'HULU', 'DISNEY', 'AMAZON', 'PRIME VIDEO',
        'APPLE', 'MICROSOFT', 'ADOBE', 'DROPBOX', 'WALMART', 'TARGET', 'COSTCO',
        'STARBUCKS', 'UBER', 'LYFT', 'VENMO', 'PAYPAL', 'CHASE', 'WELLS FARGO', 'ANTHROPIC',
        // MAP-002's own temptations: lenders, employers and tax agencies.
        'UPSTART', 'SOFI', 'LENDING CLUB', 'AFFIRM', 'KLARNA', 'PAYROLL INC',
        'IRS', 'INTERNAL REVENUE', 'FRANCHISE TAX', 'TREASURY', 'TAX REF',
      ];
      // Word boundaries, not substrings: "FIRST" contains "IRS" and a test that
      // cannot tell those apart is a test nobody trusts.
      for (const name of names) expect(upper).not.toMatch(new RegExp(`\\b${name}\\b`));
      expect(source).not.toMatch(/KNOWN_MERCHANTS|VENDOR_LIST|MERCHANT_REGISTRY|MERCHANT_CATALOGUE|SEED_MERCHANTS|AGENCY_NAMES|EMPLOYER_LIST|LENDER/);
    }
  });

  it('every suggestion carries a checkable why, a support count and a bounded confidence', () => {
    const ledgers: Transaction[][] = [
      payrollThenSweep(),
      [
        tx({ id: 'IN1', merchant: 'VESPER MOVE', title: 'VESPER MOVE', amount: 500, date: '2025-05-10', accountId: 'chk' }),
        tx({ id: 'OUT1', merchant: 'VESPER MOVE', title: 'VESPER MOVE', amount: 500, date: '2025-05-10', accountId: 'sav', type: 'expense' }),
      ],
      [
        tx({ id: 'draw', merchant: 'PARAGON CREDIT', title: 'PARAGON CREDIT', amount: 16110, date: '2024-02-05', accountId: 'chk' }),
        ...Array.from({ length: 6 }, (_, i) =>
          tx({ merchant: 'PARAGON CREDIT', title: 'PARAGON CREDIT', amount: 520, type: 'expense', date: addDays('2024-03-05', i * 30), accountId: 'chk' })
        ),
      ],
    ];
    const suggested = ledgers
      .flatMap((rows) => buildMappingGroups({ transactions: rows, accounts: ACCOUNTS }))
      .filter((g) => g.suggestion);
    expect(suggested.length).toBeGreaterThanOrEqual(3);
    for (const g of suggested) {
      const s = g.suggestion!;
      expect(s.why.trim()).not.toBe('');
      expect(s.why).not.toMatch(/\.\s/);          // ONE sentence, checkable in one read
      expect(s.why.endsWith('.')).toBe(false);
      expect(s.supportCount).toBeGreaterThan(0);
      expect(s.confidence).toBeGreaterThan(0);
      expect(s.confidence).toBeLessThanOrEqual(0.9);
    }
  });

  it('nothing auto-applies — a suggestion never touches a row or a review record', () => {
    const rows = payrollThenSweep();
    const before = JSON.stringify(rows);
    const groups = buildMappingGroups({ transactions: rows, accounts: ACCOUNTS });
    expect(groups.some((g) => g.suggestion)).toBe(true);
    expect(JSON.stringify(rows)).toBe(before);
    // A group is still an open question: it carries no decision of its own.
    for (const g of groups) expect(g).not.toHaveProperty('confirmedAt');
    // And the derived source is a proposal with no id — nothing can have been written.
    const offer = groups.find((g) => g.suggestion?.incomeSourceOffer)!.suggestion!.incomeSourceOffer!;
    expect(Object.keys(offer)).not.toContain('id');
  });

  it('says nothing when the ledger holds nothing — silence is still an answer', () => {
    const rows = [
      tx({ merchant: 'ODD ONE', title: 'ODD ONE', amount: 37, date: '2025-01-03', accountId: 'chk' }),
      tx({ merchant: 'ODD ONE', title: 'ODD ONE', amount: 900, date: '2025-02-19', accountId: 'chk' }),
      tx({ merchant: 'ODD ONE', title: 'ODD ONE', amount: 12, date: '2025-08-27', accountId: 'chk' }),
    ];
    const g = buildMappingGroups({ transactions: rows, accounts: ACCOUNTS })[0];
    expect(g.suggestion).toBeNull();
    expect(g.findings).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The primitives, directly
// ---------------------------------------------------------------------------

describe('E7 the detectors themselves', () => {
  it('needs three unique days before it will call anything a series', () => {
    const two = Array.from({ length: 2 }, (_, i) =>
      tx({ merchant: 'PAIR', title: 'PAIR', amount: 500, date: addDays('2025-01-01', i * 30) })
    );
    expect(detectPayerSeries(two)).toBeNull();
  });

  it('rejects a gap that lands in no band at all', () => {
    const rows = Array.from({ length: 4 }, (_, i) =>
      tx({ merchant: 'RANDOM', title: 'RANDOM', amount: 500, date: addDays('2025-01-01', i * 22) })
    );
    expect(detectPayerSeries(rows)).toBeNull(); // 22 days is between the biweekly and monthly bands
  });

  it('marks a scattered band as untight while still finding the series', () => {
    const rows = [30, 120, 32, 110, 31, 125].map((amount, i) =>
      tx({ merchant: 'WOBBLE', title: 'WOBBLE', amount, date: addDays('2025-01-03', i * 30) })
    );
    const series = detectPayerSeries(rows)!;
    expect(series.cadence).toBe('monthly');
    expect(series.bandTight).toBe(false);
  });

  it('a stopped series ends, an active one does not', () => {
    const rows = Array.from({ length: 5 }, (_, i) =>
      tx({ merchant: 'STEADY', title: 'STEADY', amount: 1200, date: addDays('2025-01-05', i * 30) })
    );
    const series = detectPayerSeries(rows)!;
    expect(seriesEndDate(series, addDays(series.lastDate, 10))).toBeUndefined();
    expect(seriesEndDate(series, addDays(series.lastDate, 400))).toBe(series.lastDate);
  });

  it('shared tokens are the words every row carries, and nothing else', () => {
    const rows = [
      tx({ merchant: 'ORNSTEIN LABS', title: 'ORNSTEIN LABS', description: 'ORNSTEIN LABS PAYROLL 8891' }),
      tx({ merchant: 'ORNSTEIN LABS', title: 'ORNSTEIN LABS', description: 'ORNSTEIN LABS PAYROLL 4412' }),
    ];
    const tokens = sharedTokens(rows);
    expect(tokens).toContain('ORNSTEIN');
    expect(tokens).toContain('PAYROLL');
    expect(tokens).not.toContain('8891'); // the confirmation number differs, so it is not shared
    expect(sharedTokens([rows[0], tx({ merchant: 'NOTHING ALIKE', title: 'NOTHING ALIKE', description: 'NOTHING ALIKE' })])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Loan REPAYMENT — the other half, which the answer list did not have a word for
// ---------------------------------------------------------------------------

describe('E6 paying a loan back is debt settlement, not spending', () => {
  const lender: PaymentAccount = {
    id: 'loan', name: 'PARAGON CREDIT', type: 'personal_loan', openingBalance: 16110,
    openingDate: '2024-02-05', provider: 'other', color: '#000', isActive: true,
  } as PaymentAccount;

  /** Borrow once, then pay it back monthly for far less each time. */
  const borrowThenRepay = (creditAmount = 16110, paymentAmount = 900, creditDate = '2024-02-05') => [
    tx({ id: 'draw', merchant: 'PARAGON CREDIT', title: 'PARAGON CREDIT', amount: creditAmount, date: creditDate, accountId: 'chk' }),
    ...Array.from({ length: 6 }, (_, i) =>
      tx({ id: `pay-${i}`, merchant: 'PARAGON CREDIT', title: 'PARAGON CREDIT', amount: paymentAmount, type: 'expense', date: addDays('2024-03-05', i * 30), accountId: 'chk' })
    ),
  ];

  const outflowGroup = (rows: Transaction[], accounts = ACCOUNTS): MappingGroup | undefined =>
    buildMappingGroups({
      transactions: rows, accounts,
      unpairedLegIds: rows.filter((t) => t.type === 'expense').map((t) => t.id),
    } as never).find((g) => g.direction === 'outflow' && g.label.includes('PARAGON'));

  it('reads the repayment side of a fact it already read from the other end', () => {
    const g = outflowGroup(borrowThenRepay())!;
    expect(g.suggestion?.evidence).toBe('loan_repayment');
    expect(g.suggestion?.meaning).toBe('loan_repayment');
    // The actual credit, named — not "this looks like a loan" with nothing behind it.
    expect(g.suggestion?.why).toMatch(/\$16,110\.00 arrived from "PARAGON CREDIT" on 2024-02-05/);
    expect(g.suggestion?.confidence).toBeCloseTo(0.7);
  });

  it('is more confident when the lender is also an account the owner holds', () => {
    const g = outflowGroup(borrowThenRepay(), [...ACCOUNTS, lender])!;
    expect(g.suggestion?.confidence).toBeCloseTo(0.85);
    expect(g.suggestion?.why).toMatch(/loan account you hold/);
  });

  it('does not call a merchant a lender when the credit is the size of a payment', () => {
    // $1,500 back and $1,500 a month out is a merchant relationship, not borrowing.
    expect(outflowGroup(borrowThenRepay(1500, 1500))?.suggestion).toBeNull();
  });

  it('does not call it borrowing when the credit lands mid-series', () => {
    // Same amounts, but the credit arrives AFTER the payments start — that is a refund,
    // and a refund never created the debt the payments are settling.
    expect(outflowGroup(borrowThenRepay(16110, 900, '2024-06-05'))?.suggestion?.meaning)
      .not.toBe('loan_repayment');
  });

  it('is a closed-set meaning that is neither income nor personal cost', () => {
    expect(isFinancialMeaning('loan_repayment')).toBe(true);
    expect(countsAsEarnedIncome('loan_repayment')).toBe(false);
    expect(FINANCIAL_MEANINGS.filter(countsAsEarnedIncome)).toEqual(['earned_income']);
    // Settling a debt is not consumption. The INTEREST inside it is the real cost, and
    // separating that needs the lender modelled as a `personal_loan` account.
    expect(personalCostSign('loan_repayment')).toBe(0);
    // The gap this fixes: six outflow answers, and the only debt-settlement one was
    // "a payment to one of my cards".
    expect(OUTFLOW_GROUP_MEANINGS.map((m) => m.value)).toContain('loan_repayment');
  });

  it('confirming it takes the payments out of spending AND out of the forecast', () => {
    const row = tx({ id: 'pay-0', merchant: 'PARAGON CREDIT', title: 'PARAGON CREDIT', amount: 900, type: 'expense', date: '2024-03-05', accountId: 'chk' });
    const before = interpretTransaction(row, ACCOUNTS);
    expect({ expense: before.expense, forecast: before.forecast }).toEqual({ expense: 'counted', forecast: 'counted' });

    const reviews = { 'pay-0': { transactionId: 'pay-0', state: 'confirmed', meaning: 'loan_repayment', decidedAt: '2026-08-04', reasons: [] } };
    const after = interpretTransaction(row, ACCOUNTS, { reviews } as never);
    // A closed loan must not keep projecting payments that will never happen again.
    expect({ expense: after.expense, income: after.income, forecast: after.forecast })
      .toEqual({ expense: 'excluded', income: 'excluded', forecast: 'excluded' });
  });
});
