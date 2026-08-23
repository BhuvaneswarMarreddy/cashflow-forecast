/**
 * FEEDLESS-CARD-001 (#14) — Amazon-store-card-style accounting.
 *
 * The owner's problem, verbatim: "my Amazon accounts where I don't have the
 * transactions going out of Amazon… I paid eight hundred of my money to the
 * Amazon credit card. So you should take that eight hundred as the expense
 * because I paid Amazon… I don't have to add all the balances and all
 * history. I'll start a balance from there on."
 *
 * Today a payment from checking to a card is (correctly) a TRANSFER, not
 * spend — the card's own itemized rows are the spend. For a card with NO
 * feed, that rule leaves a hole: nothing is ever counted. `feedless: true` on
 * the account makes the payment itself stand in as the expense, until the
 * card gains a feed of its own — at which point the guard must stop it from
 * double-counting alongside the real rows.
 *
 * Sanitized fixtures only — invented merchants, invented amounts.
 */
import { PaymentAccount, Transaction } from '@/types';
import { feedlessCardTargetOf, interpretTransaction, sumExpenseCents, POSTED_ONLY } from '@/lib/classify';
import { deriveAccountBalance, withDerivedBalances } from '@/lib/forecast';

const chk: PaymentAccount = {
  id: 'chk', name: 'Checking', type: 'bank_account', provider: 'chase',
  openingBalance: 5000, openingDate: '2026-01-01', color: '#111', isActive: true,
};

const feedlessCard: PaymentAccount = {
  id: 'amzn', name: 'Amazon Store Card', type: 'credit_card', provider: 'discover',
  feedless: true, openingBalance: 0, color: '#222', isActive: true,
};

const normalCard: PaymentAccount = {
  id: 'rewards', name: 'Rewards Card', type: 'credit_card', provider: 'amex',
  openingBalance: 400, openingDate: '2026-01-01', color: '#333', isActive: true,
};

const txn = (o: Partial<Transaction> & { id: string; title: string; amount: number }): Transaction => ({
  type: 'expense', category: 'other', paymentMethod: 'other', date: '2026-03-10', ...o,
});

describe('FEEDLESS-CARD-001: a payment to a feedless card is the expense', () => {
  const accounts = [chk, feedlessCard];
  const payment = txn({
    id: 'p1', title: 'DISCOVER PAYMENT ACH PMT', amount: 800, accountId: 'chk', date: '2026-03-15',
  });

  it('an $800 payment to a feedless card counts as $800 spend on the payment date', () => {
    const i = interpretTransaction(payment, accounts);
    expect(i.expense).toBe('counted');
    expect(i.financialMeaning).toBe('personal_expense');
    expect(i.transfer).toBe('none');
    expect(sumExpenseCents([payment], accounts, POSTED_ONLY)).toBe(80000); // exact cents
  });

  it('the SAME payment to a NORMAL (fed) card stays a transfer, not spend — unchanged', () => {
    const toNormalCard = txn({
      id: 'p2', title: 'AMEX EPAYMENT ACH PMT', amount: 800, accountId: 'chk', date: '2026-03-15',
    });
    const normalAccounts = [chk, normalCard];
    const i = interpretTransaction(toNormalCard, normalAccounts);
    expect(i.expense).toBe('excluded');
    expect(i.financialMeaning).toBe('card_payment');
    expect(i.transfer).toBe('card_settlement');
    expect(sumExpenseCents([toNormalCard], normalAccounts, POSTED_ONLY)).toBe(0);
  });
});

describe('FEEDLESS-CARD-001: balance anchoring — anchor minus payments, no history needed', () => {
  const anchored: PaymentAccount = { ...feedlessCard, openingBalance: 1200, openingDate: '2026-01-01' };

  it("an anchored feedless card's balance falls by each payment, with zero rows of its own", () => {
    const p1 = txn({ id: 'p1', title: 'DISCOVER PAYMENT ACH PMT', amount: 300, accountId: 'chk', date: '2026-02-01' });
    const p2 = txn({ id: 'p2', title: 'DISCOVER PAYMENT ACH PMT', amount: 200, accountId: 'chk', date: '2026-03-01' });
    const accounts = [chk, anchored];
    // owed = 1200 - 300 - 200 = 700, derived with NO rows on the card account itself.
    expect(deriveAccountBalance(anchored, [p1, p2], POSTED_ONLY, accounts)).toBe(700);
  });

  it('withDerivedBalances — the everyday path — produces the same figure', () => {
    const p1 = txn({ id: 'p1', title: 'DISCOVER PAYMENT ACH PMT', amount: 300, accountId: 'chk', date: '2026-02-01' });
    const [, card] = withDerivedBalances([chk, anchored], [p1], POSTED_ONLY);
    expect(card.currentBalance).toBe(900);
  });
});

describe('FEEDLESS-CARD-001: the double-count guard is a PER-PAYMENT predicate (#14 round 2)', () => {
  // CRITICAL-1: the guard trips per PAYMENT — once the card has a POSTED row of
  // its OWN dated ON/AFTER that specific payment — not from a single "earliest
  // row ever" floor shared by the account's whole life. A payment BEFORE the
  // card's own row is the one that gets superseded (the row proves real data now
  // covers it); a payment AFTER the card's own row has nothing covering it and
  // must keep counting. See the next describe block for why the OLD "earliest
  // row = floor forever after" version silently zeroed months with no covering
  // data at all.
  const anchored: PaymentAccount = { ...feedlessCard, openingBalance: 1000, openingDate: '2026-01-01' };
  const payment = (id: string, date: string) =>
    txn({ id, title: 'DISCOVER PAYMENT ACH PMT', amount: 100, accountId: 'chk', date });
  const itemizedRow = txn({ id: 'own1', title: 'Some Merchant', amount: 40, accountId: 'amzn', date: '2026-04-05' });

  it("a payment dated BEFORE the card's own row stops counting — the row supersedes it", () => {
    const [, card] = withDerivedBalances(
      [chk, anchored], [payment('before', '2026-04-04'), itemizedRow], POSTED_ONLY
    );
    expect(card.feedCoverageThrough).toBe('2026-04-05');
    const i = interpretTransaction(payment('before', '2026-04-04'), [chk, card]);
    expect(i.expense).toBe('excluded');
    expect(i.financialMeaning).toBe('card_payment'); // reverts to the ordinary settlement reading
    expect(i.reason).toMatch(/already has itemized rows through 2026-04-05/);
  });

  it("a payment dated ON the row's own day (inclusive boundary) also stops counting", () => {
    const [, card] = withDerivedBalances(
      [chk, anchored], [payment('same-day', '2026-04-05'), itemizedRow], POSTED_ONLY
    );
    const onBoundary = interpretTransaction(payment('same-day', '2026-04-05'), [chk, card]);
    expect(onBoundary.expense).toBe('excluded');
    expect(onBoundary.financialMeaning).toBe('card_payment');
  });

  it("a payment dated AFTER the card's own row still counts — nothing covers it", () => {
    const [, card] = withDerivedBalances(
      [chk, anchored], [payment('before', '2026-04-04'), itemizedRow], POSTED_ONLY
    );
    const after = interpretTransaction(payment('after', '2026-05-01'), [chk, card]);
    expect(after.expense).toBe('counted');
    expect(after.financialMeaning).toBe('personal_expense');
  });

  it('the guard also decides which payment moves the card balance', () => {
    const txns = [payment('before', '2026-04-04'), itemizedRow, payment('after', '2026-05-01')];
    const accounts = [chk, anchored];
    // before-payment is guarded out; itemized purchase raises owed (+40); after-payment
    // counts: owed = 1000 - 100 (after) + 40 (itemized) = 940.
    expect(deriveAccountBalance(anchored, txns, POSTED_ONLY, accounts)).toBe(940);
  });
});

describe('FEEDLESS-CARD-001: a historical statement import guards only ITS OWN period (#14 round 2)', () => {
  // The measured bug this whole round exists for: importing a January statement
  // (viewed from March) used to floor on January (the earliest row) and zero
  // EVERY later month forever — Feb, Mar, Apr, all of it — because the guard was
  // one global "earliest row" value compared the wrong way. A statement import
  // is a one-time backfill for a SPECIFIC period, not proof an ongoing feed now
  // covers every month after it.
  const anchored: PaymentAccount = { ...feedlessCard, openingBalance: 2000, openingDate: '2026-01-01' };
  const monthlyPayment = (id: string, date: string) =>
    txn({ id, title: 'DISCOVER PAYMENT ACH PMT', amount: 200, accountId: 'chk', date });
  const statementRow = (id: string, date: string, opts: Partial<Transaction> = {}) =>
    txn({ id, title: 'Some Merchant', amount: 30, accountId: 'amzn', date, ...opts });

  const payJan = monthlyPayment('payJan', '2026-01-05');
  const payFeb = monthlyPayment('payFeb', '2026-02-05');
  const payMar = monthlyPayment('payMar', '2026-03-05');
  const payApr = monthlyPayment('payApr', '2026-04-05');

  it('a January-ONLY statement import guards January only — Feb/Mar/Apr keep counting', () => {
    const janRows = [statementRow('j1', '2026-01-10'), statementRow('j2', '2026-01-28')];
    const [, card] = withDerivedBalances(
      [chk, anchored], [...janRows, payJan, payFeb, payMar, payApr], POSTED_ONLY
    );
    expect(card.feedCoverageThrough).toBe('2026-01-28');
    const accs = [chk, card];
    expect(interpretTransaction(payJan, accs).expense).toBe('excluded'); // covered by the Jan statement
    expect(interpretTransaction(payFeb, accs).expense).toBe('counted'); // #14 round 2: no longer zeroed
    expect(interpretTransaction(payMar, accs).expense).toBe('counted');
    expect(interpretTransaction(payApr, accs).expense).toBe('counted');
  });

  it('a March-ONLY statement import guards January through March — not April', () => {
    const marRows = [statementRow('m1', '2026-03-10'), statementRow('m2', '2026-03-28')];
    const [, card] = withDerivedBalances(
      [chk, anchored], [...marRows, payJan, payFeb, payMar, payApr], POSTED_ONLY
    );
    expect(card.feedCoverageThrough).toBe('2026-03-28');
    const accs = [chk, card];
    expect(interpretTransaction(payJan, accs).expense).toBe('excluded');
    expect(interpretTransaction(payFeb, accs).expense).toBe('excluded');
    expect(interpretTransaction(payMar, accs).expense).toBe('excluded');
    expect(interpretTransaction(payApr, accs).expense).toBe('counted');
  });

  it('BOTH a January and a March import together guard through the LATER (March) date', () => {
    const rows = [statementRow('j1', '2026-01-10'), statementRow('m1', '2026-03-15')];
    const [, card] = withDerivedBalances(
      [chk, anchored], [...rows, payJan, payFeb, payMar, payApr], POSTED_ONLY
    );
    expect(card.feedCoverageThrough).toBe('2026-03-15');
    const accs = [chk, card];
    expect(interpretTransaction(payJan, accs).expense).toBe('excluded');
    expect(interpretTransaction(payFeb, accs).expense).toBe('excluded');
    expect(interpretTransaction(payMar, accs).expense).toBe('excluded');
    expect(interpretTransaction(payApr, accs).expense).toBe('counted');
  });

  it('a PENDING row never trips the guard, no matter its date', () => {
    const pendingRow = statementRow('pend1', '2026-01-10', { pending: true });
    const [, card] = withDerivedBalances([chk, anchored], [pendingRow, payJan, payFeb], POSTED_ONLY);
    expect(card.feedCoverageThrough).toBeUndefined();
    const accs = [chk, card];
    expect(interpretTransaction(payJan, accs).expense).toBe('counted');
    expect(interpretTransaction(payFeb, accs).expense).toBe('counted');
  });

  it('a FUTURE-DATED row never trips the guard for earlier (already-happened) payments', () => {
    const futureRow = statementRow('future1', '2030-06-01'); // posted, but has not happened yet
    const [, card] = withDerivedBalances(
      [chk, anchored], [futureRow, payJan, payFeb, payMar], POSTED_ONLY
    );
    expect(card.feedCoverageThrough).toBeUndefined();
    const accs = [chk, card];
    expect(interpretTransaction(payJan, accs).expense).toBe('counted');
    expect(interpretTransaction(payFeb, accs).expense).toBe('counted');
    expect(interpretTransaction(payMar, accs).expense).toBe('counted');
  });
});

describe('FEEDLESS-CARD-001: attribution resolves among ALL cards first, THEN checks feedless (#14 round 2)', () => {
  const normalDiscover: PaymentAccount = {
    id: 'disc-normal', name: 'Discover It', type: 'credit_card', provider: 'discover',
    lastFourDigits: '1234', openingBalance: 300, openingDate: '2026-01-01', color: '#444', isActive: true,
  };
  const feedlessDiscover: PaymentAccount = {
    id: 'disc-feedless', name: 'Discover Store Card', type: 'credit_card', provider: 'discover',
    lastFourDigits: '5678', feedless: true, openingBalance: 500, openingDate: '2026-01-01', color: '#555', isActive: true,
  };
  const accounts = [chk, normalDiscover, feedlessDiscover];

  it("a title carrying the NORMAL card's own last four is never attributed to the feedless card", () => {
    // Measured bug: an issuer-only fallback used to win here because the resolver
    // only ever searched inside the feedless subset, so the NORMAL card's own last
    // four — the more specific evidence, and proof the payment was for THAT card —
    // never got a chance to rule the feedless card out.
    const toNormal = txn({ id: 'p1', title: 'DISCOVER PAYMENT ACH PMT 1234', amount: 500, accountId: 'chk', date: '2026-03-15' });
    expect(feedlessCardTargetOf(toNormal, accounts)).toBeUndefined();
    expect(interpretTransaction(toNormal, accounts).financialMeaning).toBe('card_payment'); // ordinary settlement
    expect(interpretTransaction(toNormal, accounts).expense).toBe('excluded');
  });

  it("a title carrying the FEEDLESS card's own last four still resolves correctly", () => {
    const toFeedless = txn({ id: 'p2', title: 'DISCOVER PAYMENT ACH PMT 5678', amount: 500, accountId: 'chk', date: '2026-03-15' });
    expect(feedlessCardTargetOf(toFeedless, accounts)?.id).toBe('disc-feedless');
    expect(interpretTransaction(toFeedless, accounts).expense).toBe('counted');
  });

  it('the two payments together are $500 of spend, not $1,000', () => {
    const toNormal = txn({ id: 'p1', title: 'DISCOVER PAYMENT ACH PMT 1234', amount: 500, accountId: 'chk', date: '2026-03-15' });
    const toFeedless = txn({ id: 'p2', title: 'DISCOVER PAYMENT ACH PMT 5678', amount: 500, accountId: 'chk', date: '2026-03-15' });
    expect(sumExpenseCents([toNormal, toFeedless], accounts, POSTED_ONLY)).toBe(50_000); // exact cents — $500, not $1,000
  });

  it('two feedless cards of the same issuer with no digits in the title is a refused ambiguity, not a guess', () => {
    const secondFeedless: PaymentAccount = {
      id: 'disc-feedless-2', name: 'Discover Rewards', type: 'credit_card', provider: 'discover',
      feedless: true, openingBalance: 0, color: '#666', isActive: true,
    };
    const noDigitsAccounts = [chk, { ...feedlessDiscover, lastFourDigits: undefined }, secondFeedless];
    const ambiguous = txn({ id: 'p3', title: 'DISCOVER PAYMENT ACH PMT', amount: 500, accountId: 'chk', date: '2026-03-15' });
    expect(feedlessCardTargetOf(ambiguous, noDigitsAccounts)).toBeUndefined();
  });
});

describe('FEEDLESS-CARD-001: an unanchored feedless card clamps at zero, never negative (CRITICAL-3)', () => {
  // A feedless card's balance only ever moves DOWN (payments reduce owed; there is
  // no feed to ever raise it), so an unanchored account — opening $0 by construction
  // (#83) — goes negative the moment any payment is recorded. A negative "owed"
  // would subtract from every other card's debt in Cards-owed and inflate net
  // worth. accounts/page.tsx refuses to SAVE a feedless card with no starting
  // balance; this is the defensive floor for every account that predates that
  // guard or reaches this state some other way.
  const unanchored: PaymentAccount = { ...feedlessCard, openingBalance: 0 }; // no openingDate

  it('a payment on an unanchored feedless card does not push the derived balance negative', () => {
    const payment = txn({ id: 'p1', title: 'DISCOVER PAYMENT ACH PMT', amount: 800, accountId: 'chk', date: '2026-03-15' });
    const accounts = [chk, unanchored];
    expect(deriveAccountBalance(unanchored, [payment], POSTED_ONLY, accounts)).toBe(0); // clamped, not -800
  });

  it('withDerivedBalances agrees: currentBalance is clamped, not negative', () => {
    const payment = txn({ id: 'p1', title: 'DISCOVER PAYMENT ACH PMT', amount: 800, accountId: 'chk', date: '2026-03-15' });
    const [, card] = withDerivedBalances([chk, unanchored], [payment], POSTED_ONLY);
    expect(card.currentBalance).toBe(0);
  });
});

describe('FEEDLESS-CARD-001: regression — a user with no feedless accounts is unaffected', () => {
  const accounts = [chk, normalCard];
  const purchase = txn({ id: 'x1', title: 'Groceries', amount: 60, accountId: 'rewards', category: 'food' });
  const cardLeg = txn({
    id: 'x2', title: 'AUTOPAY PAYMENT - THANK YOU', amount: 250, type: 'income', accountId: 'rewards', date: '2026-03-20',
  });
  const bankLeg = txn({ id: 'x3', title: 'AMEX EPAYMENT ACH PMT', amount: 250, accountId: 'chk', date: '2026-03-20' });

  it('spend totals, classification and balances are exactly what they were before #14', () => {
    expect(sumExpenseCents([purchase, cardLeg, bankLeg], accounts, POSTED_ONLY)).toBe(6000); // exact cents
    expect(interpretTransaction(bankLeg, accounts).financialMeaning).toBe('card_payment');
    expect(interpretTransaction(bankLeg, accounts).transfer).toBe('card_settlement');
    expect(deriveAccountBalance(normalCard, [purchase, cardLeg], POSTED_ONLY, accounts)).toBeCloseTo(400 + 60 - 250, 2);
  });
});
