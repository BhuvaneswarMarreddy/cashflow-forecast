/**
 * FIN-REFUND-001 §11.1 — card-credit classification (D1–D14).
 *
 * THE OWNER'S RULE, MECHANISED: a credit-card credit is NEVER automatically earned
 * income. D1 proves it as a property of a total function rather than a policy
 * sentence — there is no branch to forget.
 *
 * Sanitized fixtures only — invented merchants, invented amounts, invented ids.
 */

import { PaymentAccount, Transaction, FinancialMeaning } from '@/types';
import { interpretTransaction, isReward, sumIncomeCents, LedgerMeaning } from '@/lib/classify';
import { CARD_CREDIT_KINDS, TransactionLink } from '@/lib/relations';
import {
  CARD_CREDIT_TO_INFLOW_MEANING,
  PERMITTED_KINDS_BY_LEDGER_MEANING,
  classifyCardCredit,
  rewardKind,
} from '@/lib/card-credit';
import { generateRefundCandidates } from '@/lib/refunds';
import { clearEvents, recentEvents } from '@/lib/obs/events';

const accounts: PaymentAccount[] = [
  {
    id: 'demo-chk', name: 'Demo Everyday Checking', type: 'bank_account', provider: 'chase',
    openingBalance: 5000, openingDate: '2000-01-01', color: '#111', isActive: true,
  },
  {
    id: 'demo-card-9021', name: 'Demo Rewards Card', type: 'credit_card', provider: 'amex',
    lastFourDigits: '9021', creditLimit: 5000,
    openingBalance: 0, openingDate: '2000-01-01', color: '#222', isActive: true,
  },
];

const tx = (o: Partial<Transaction> & { id: string; title: string; amount: number }): Transaction => ({
  type: 'expense', category: 'other', paymentMethod: 'other', date: '2026-07-20',
  sources: ['simplefin'], ...o,
});

const link = (o: Partial<TransactionLink> & Pick<TransactionLink, 'linkType' | 'sourceTransactionId' | 'targetTransactionId' | 'allocatedAmountCents' | 'status'>): TransactionLink => ({
  id: `${o.linkType}~${o.sourceTransactionId}~${o.targetTransactionId}`,
  algorithmVersion: 'refund-match-v1',
  createdAt: '2026-07-31T00:00:00.000Z',
  updatedAt: '2026-07-31T00:00:00.000Z',
  ...(o.status === 'confirmed' || o.status === 'provisional' ? { confirmedAt: '2026-07-31T00:00:00.000Z' } : {}),
  ...o,
});

// --- the fixture credits -----------------------------------------------------
const PURCHASE = tx({
  id: 'demo-purchase-a', title: 'Demo Amazon Lens', merchant: 'DEMO AMAZON',
  amount: 1100, category: 'shopping', accountId: 'demo-card-9021', date: '2026-07-12',
});
const CARD_PAYMENT_CARD_LEG = tx({
  id: 'demo-pay-card', title: 'AUTOPAY PAYMENT - THANK YOU', amount: 300,
  type: 'income', accountId: 'demo-card-9021', date: '2026-07-18',
});
const CARD_PAYMENT_BANK_LEG = tx({
  id: 'demo-pay-bank', title: 'AMEX EPAYMENT ACH PMT', amount: 300,
  type: 'expense', accountId: 'demo-chk', date: '2026-07-18',
});
const REFUND_CREDIT = tx({
  id: 'demo-refund-a', title: 'Demo Amazon Refund', merchant: 'DEMO AMAZON', amount: 1100,
  type: 'income', accountId: 'demo-card-9021', date: '2026-07-22',
});
const CASHBACK = tx({
  id: 'demo-cashback', title: 'Cashback Reward Redemption', amount: 12.5,
  type: 'income', accountId: 'demo-card-9021', date: '2026-07-19',
});
const STATEMENT_CREDIT = tx({
  id: 'demo-statement-credit', title: 'Annual Statement Credit', amount: 10,
  type: 'income', accountId: 'demo-card-9021', date: '2026-07-19',
});
const PROMO_CREDIT = tx({
  id: 'demo-promo', title: 'Welcome Bonus Promotional Credit', amount: 20,
  type: 'income', accountId: 'demo-card-9021', date: '2026-07-19',
});
// Larger than every purchase at this merchant and than every reachable combination —
// §4.3's "generates unknown_card_credit, not a forced over-allocation".
const UNKNOWN_CREDIT = tx({
  id: 'demo-unknown-credit', title: 'AB-4471 CREDIT', merchant: 'DEMO FERNVALE', amount: 500,
  type: 'income', accountId: 'demo-card-9021', date: '2026-07-19',
});
const CHARGEBACK_CREDIT = tx({
  id: 'demo-chargeback', title: 'Provisional Credit Case 5512', amount: 250,
  type: 'income', accountId: 'demo-card-9021', date: '2026-07-25',
});
const DISPUTED_PURCHASE = tx({
  id: 'demo-disputed', title: 'Demo Fernvale Outfitters', merchant: 'DEMO FERNVALE', amount: 250,
  category: 'shopping', accountId: 'demo-card-9021', date: '2026-07-05',
});
const MANUAL_CREDIT = tx({
  id: 'demo-manual', title: 'Correction', amount: 30,
  type: 'income', accountId: 'demo-card-9021', date: '2026-07-19', sources: ['manual'],
});

describe('D1 — earned_income is not in the range of CARD_CREDIT_TO_INFLOW_MEANING', () => {
  it('maps all ten kinds and never to earned_income', () => {
    // Enumerating the map is the proof: a total function whose range excludes
    // earned_income cannot be bypassed by a branch someone forgets to write.
    expect(Object.keys(CARD_CREDIT_TO_INFLOW_MEANING).sort()).toEqual([...CARD_CREDIT_KINDS].sort());
    const range = Object.values(CARD_CREDIT_TO_INFLOW_MEANING);
    expect(range).toHaveLength(10);
    expect(range).not.toContain('earned_income');
    for (const kind of CARD_CREDIT_KINDS) {
      expect(CARD_CREDIT_TO_INFLOW_MEANING[kind]).not.toBe('earned_income' as FinancialMeaning);
    }
  });

  it('projects onto exactly the meanings §3.3 specifies', () => {
    expect(CARD_CREDIT_TO_INFLOW_MEANING).toEqual({
      card_payment: 'internal_transfer',
      merchant_refund: 'refund',
      partial_refund: 'refund',
      charge_reversal: 'refund',
      chargeback_credit: 'refund',
      statement_credit: 'other_non_income_credit',
      cashback_reward: 'other_non_income_credit',
      promotional_credit: 'other_non_income_credit',
      manual_adjustment: 'other_non_income_credit',
      unknown_card_credit: 'unknown_inflow',
    });
  });
});

describe('D2 — every kind is consistent with interpretTransaction().meaning', () => {
  const cases: Array<[LedgerMeaning, Transaction]> = [
    ['card_payment', CARD_PAYMENT_CARD_LEG],
    ['reward', CASHBACK],
    ['refund', REFUND_CREDIT],
    ['income_candidate', UNKNOWN_CREDIT],
  ];

  it.each(cases)('a %s row resolves to a permitted kind', (meaning, row) => {
    expect(interpretTransaction(row, accounts).meaning).toBe(meaning);
    const { kind } = classifyCardCredit(row, { accounts, transactions: [row, CARD_PAYMENT_BANK_LEG] });
    expect(PERMITTED_KINDS_BY_LEDGER_MEANING[meaning]).toContain(kind);
  });

  it('income_candidate permits all ten — it is the ambiguous case the ladder exists to resolve', () => {
    expect([...PERMITTED_KINDS_BY_LEDGER_MEANING.income_candidate].sort()).toEqual([...CARD_CREDIT_KINDS].sort());
  });

  it('spending and internal_transfer are not card credits', () => {
    expect(PERMITTED_KINDS_BY_LEDGER_MEANING.spending).toEqual([]);
    expect(PERMITTED_KINDS_BY_LEDGER_MEANING.internal_transfer).toEqual([]);
  });
});

describe('D3 — the rung-5 sub-split is total over isReward(), and empty outside it', () => {
  it.each([
    [STATEMENT_CREDIT, 'statement_credit'],
    [PROMO_CREDIT, 'promotional_credit'],
    [CASHBACK, 'cashback_reward'],
  ])('splits %#', (row, expected) => {
    expect(isReward(row as Transaction)).toBe(true);
    expect(rewardKind(row as Transaction)).toBe(expected);
  });

  it('returns null for every isReward()-false row — the split can never widen the gate', () => {
    for (const row of [PURCHASE, UNKNOWN_CREDIT, REFUND_CREDIT, MANUAL_CREDIT]) {
      expect(isReward(row)).toBe(false);
      expect(rewardKind(row)).toBeNull();
    }
  });
});

// --- D4–D9: not one of these is income --------------------------------------
describe('no card credit is earned income', () => {
  const notIncome = (row: Transaction, links: TransactionLink[] = []) => {
    const kind = classifyCardCredit(row, { accounts, links, transactions: [row, CARD_PAYMENT_BANK_LEG] }).kind;
    return {
      kind,
      meaning: CARD_CREDIT_TO_INFLOW_MEANING[kind],
      incomeCents: sumIncomeCents([row], accounts, { sources: [] }),
      treatment: interpretTransaction(row, accounts).income,
    };
  };

  it('D4 — a card payment is not income', () => {
    const r = notIncome(CARD_PAYMENT_CARD_LEG);
    expect(r.kind).toBe('card_payment');
    expect(r.meaning).toBe('internal_transfer');
    expect(r.incomeCents).toBe(0);
    expect(r.treatment).toBe('excluded');
  });

  it('D5 — a card refund is not income', () => {
    const links = [link({
      linkType: 'refund_of', sourceTransactionId: REFUND_CREDIT.id,
      targetTransactionId: PURCHASE.id, allocatedAmountCents: 110000, status: 'confirmed',
    })];
    const r = notIncome(REFUND_CREDIT, links);
    expect(r.kind).toBe('merchant_refund');
    expect(r.meaning).toBe('refund');
    expect(r.incomeCents).toBe(0);
  });

  it('D6 — cashback is not income', () => {
    const r = notIncome(CASHBACK);
    expect(r.kind).toBe('cashback_reward');
    expect(r.meaning).toBe('other_non_income_credit');
    expect(r.incomeCents).toBe(0);
  });

  it('D7 — a statement credit is not income', () => {
    const r = notIncome(STATEMENT_CREDIT);
    expect(r.kind).toBe('statement_credit');
    expect(r.meaning).toBe('other_non_income_credit');
    expect(r.incomeCents).toBe(0);
  });

  it('D8 — an unknown card credit is not income, and it surfaces as a candidate', () => {
    const r = notIncome(UNKNOWN_CREDIT);
    expect(r.kind).toBe('unknown_card_credit');
    expect(r.meaning).toBe('unknown_inflow');
    expect(r.incomeCents).toBe(0);

    // It does not sit silently in a total: with nothing to match it, it is queued.
    const run = generateRefundCandidates([UNKNOWN_CREDIT, PURCHASE, DISPUTED_PURCHASE], accounts, []);
    expect(run.candidates.some((c) => c.candidateType === 'unknown_card_credit')).toBe(true);
  });

  it('D9 — a chargeback credit is not income, and its link is provisional', () => {
    const links = [link({
      linkType: 'chargeback_for', sourceTransactionId: CHARGEBACK_CREDIT.id,
      targetTransactionId: DISPUTED_PURCHASE.id, allocatedAmountCents: 25000, status: 'provisional',
    })];
    const r = notIncome(CHARGEBACK_CREDIT, links);
    expect(r.kind).toBe('chargeback_credit');
    expect(r.meaning).toBe('refund');
    expect(r.incomeCents).toBe(0);
    expect(links[0].status).toBe('provisional');
  });
});

describe('D10 — card-payment pairing takes precedence over refund matching', () => {
  // A $300.00 card credit that happens to equal a $300.00 purchase from last week is
  // a settlement, not a refund. Rung 1 fires before rung 2 ever looks.
  const COINCIDENT_PURCHASE = tx({
    id: 'demo-coincident', title: 'Demo Fernvale Outfitters', merchant: 'DEMO FERNVALE',
    amount: 300, category: 'shopping', accountId: 'demo-card-9021', date: '2026-07-11',
  });
  const ledger = [COINCIDENT_PURCHASE, CARD_PAYMENT_CARD_LEG, CARD_PAYMENT_BANK_LEG];

  it('resolves to card_payment at rung 1', () => {
    const r = classifyCardCredit(CARD_PAYMENT_CARD_LEG, { accounts, transactions: ledger });
    expect(r.kind).toBe('card_payment');
    expect(r.rung).toBe(1);
  });

  it('generates no refund candidate for the settlement', () => {
    const run = generateRefundCandidates(ledger, accounts, []);
    const touching = run.candidates.filter((c) => c.transactionIds.includes(CARD_PAYMENT_CARD_LEG.id));
    expect(touching).toEqual([]);
  });
});

describe('D11 — FIN-LEDGER-001 is not regressed', () => {
  it('a purchase titled "PAYMENT PROCESSING SOLUTIONS LLC" is still spending', () => {
    const p = tx({
      id: 'demo-payment-merchant', title: 'PAYMENT PROCESSING SOLUTIONS LLC', amount: 63.75,
      category: 'shopping', accountId: 'demo-card-9021',
    });
    const i = interpretTransaction(p, accounts);
    expect(i.meaning).toBe('spending');
    expect(i.expense).toBe('counted');
    expect(i.direction).toBe('outflow');
    // It is an outflow, so it is not a card credit at all and reduces nothing.
    const run = generateRefundCandidates([p], accounts, []);
    expect(run.candidates).toEqual([]);
  });
});

describe('D12 — rungs 2–4 require a CONFIRMED link', () => {
  it('a suggested refund link leaves the kind at unknown_card_credit', () => {
    const suggested = [link({
      linkType: 'refund_of', sourceTransactionId: UNKNOWN_CREDIT.id,
      targetTransactionId: PURCHASE.id, allocatedAmountCents: 8800, status: 'suggested',
    })];
    expect(classifyCardCredit(UNKNOWN_CREDIT, { accounts, links: suggested }).kind).toBe('unknown_card_credit');
  });

  it('confirming the same link moves it to merchant_refund', () => {
    const confirmed = [link({
      linkType: 'refund_of', sourceTransactionId: UNKNOWN_CREDIT.id,
      targetTransactionId: PURCHASE.id, allocatedAmountCents: 8800, status: 'confirmed',
    })];
    expect(classifyCardCredit(UNKNOWN_CREDIT, { accounts, links: confirmed }).kind).toBe('merchant_refund');
  });
});

describe('D13 — the ladder is ordered, rung by rung', () => {
  const refundLink = link({
    linkType: 'refund_of', sourceTransactionId: CARD_PAYMENT_CARD_LEG.id,
    targetTransactionId: PURCHASE.id, allocatedAmountCents: 30000, status: 'confirmed',
  });
  const reversalLink = link({
    linkType: 'reversal_of', sourceTransactionId: UNKNOWN_CREDIT.id,
    targetTransactionId: PURCHASE.id, allocatedAmountCents: 8800, status: 'confirmed',
  });
  const chargebackLink = link({
    linkType: 'chargeback_for', sourceTransactionId: UNKNOWN_CREDIT.id,
    targetTransactionId: DISPUTED_PURCHASE.id, allocatedAmountCents: 8800, status: 'provisional',
  });

  it('rung 1 beats rung 2 — a settlement with a confirmed refund link is still a card payment', () => {
    const r = classifyCardCredit(CARD_PAYMENT_CARD_LEG, {
      accounts, links: [refundLink], transactions: [CARD_PAYMENT_CARD_LEG, CARD_PAYMENT_BANK_LEG],
    });
    expect(r.kind).toBe('card_payment');
    expect(r.rung).toBe(1);
  });

  it('rung 2 beats rung 3 and rung 4', () => {
    const refundOfUnknown = link({
      linkType: 'refund_of', sourceTransactionId: UNKNOWN_CREDIT.id,
      targetTransactionId: PURCHASE.id, allocatedAmountCents: 8800, status: 'confirmed',
    });
    const r = classifyCardCredit(UNKNOWN_CREDIT, {
      accounts, links: [chargebackLink, reversalLink, refundOfUnknown],
    });
    expect(r.kind).toBe('merchant_refund');
    expect(r.rung).toBe(2);
  });

  it('rung 3 beats rung 4', () => {
    const r = classifyCardCredit(UNKNOWN_CREDIT, { accounts, links: [chargebackLink, reversalLink] });
    expect(r.kind).toBe('charge_reversal');
    expect(r.rung).toBe(3);
  });

  it('rung 4 beats rung 5 — a disputed credit whose text says "reward" is still a chargeback', () => {
    const rewardWordedCredit = tx({
      id: 'demo-cb-reward', title: 'Provisional Credit Rewards Case', amount: 250,
      type: 'income', accountId: 'demo-card-9021', date: '2026-07-25',
    });
    const cb = link({
      linkType: 'chargeback_for', sourceTransactionId: rewardWordedCredit.id,
      targetTransactionId: DISPUTED_PURCHASE.id, allocatedAmountCents: 25000, status: 'provisional',
    });
    expect(isReward(rewardWordedCredit)).toBe(true);
    const r = classifyCardCredit(rewardWordedCredit, { accounts, links: [cb] });
    expect(r.kind).toBe('chargeback_credit');
    expect(r.rung).toBe(4);
  });

  it('rung 5 beats rung 6 — a hand-entered cashback row is still a reward', () => {
    const manualCashback = tx({
      id: 'demo-manual-cashback', title: 'Cashback Redemption', amount: 12.5,
      type: 'income', accountId: 'demo-card-9021', sources: ['manual'],
    });
    const r = classifyCardCredit(manualCashback, { accounts });
    expect(r.kind).toBe('cashback_reward');
    expect(r.rung).toBe(5);
  });

  it('rung 6 beats rung 7', () => {
    const r = classifyCardCredit(MANUAL_CREDIT, { accounts });
    expect(r.kind).toBe('manual_adjustment');
    expect(r.rung).toBe(6);
  });

  it('rung 7 is the honest default, and it is emitted with safe properties only', () => {
    clearEvents();
    const r = classifyCardCredit(UNKNOWN_CREDIT, { accounts });
    expect(r.kind).toBe('unknown_card_credit');
    expect(r.rung).toBe(7);

    const event = recentEvents().find((e) => e.eventName === 'CardCredit.Classified');
    expect(event).toBeDefined();
    expect(event?.metadata).toEqual({
      cardCreditKind: 'unknown_card_credit', rung: 7, confidence: expect.any(Number),
    });
    // Never the description, the merchant or the amount. (Asserted on metadata, not
    // on the whole event: traceId/sessionId are random hex and would make a substring
    // check over the envelope flaky rather than meaningful.)
    const serialised = JSON.stringify(event?.metadata);
    expect(serialised).not.toContain('AB-4471');
    expect(serialised).not.toContain('500');
    expect(event?.component).toBe('RecoveryRefunds');
  });
});

describe('D14 — a manual row resolves to manual_adjustment, not unknown_card_credit', () => {
  it('a row whose sources name no provider is a manual adjustment', () => {
    expect(classifyCardCredit(MANUAL_CREDIT, { accounts }).kind).toBe('manual_adjustment');
  });

  it('a row the owner re-typed the amount on is a manual adjustment', () => {
    const edited = tx({
      id: 'demo-edited', title: 'AB-9902 CREDIT', amount: 44, type: 'income',
      accountId: 'demo-card-9021', sources: ['simplefin'], userEdited: { amount: true },
    });
    expect(classifyCardCredit(edited, { accounts }).kind).toBe('manual_adjustment');
  });

  it('a provider row with no manual signal stays unknown_card_credit', () => {
    expect(classifyCardCredit(UNKNOWN_CREDIT, { accounts }).kind).toBe('unknown_card_credit');
  });
});
