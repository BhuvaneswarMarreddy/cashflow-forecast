/**
 * monthlyAverages() — the "Monthly Income" / suggested-budget figure.
 *
 * FIN-INCOME-001 replaced the rule this file used to pin. It preferred rows whose
 * `sourceCategory` was the literal 'Paychecks' and otherwise summed EVERY
 * income-classified row, so refunds, Zelle credits and one-off deposits inflated
 * income. Income now comes from APPROVED SOURCES only.
 */
import { IncomeSource, PaymentAccount, Transaction } from '@/types';
import { monthlyAverages } from '@/lib/forecast';

const acct = (o: Partial<PaymentAccount> & { id: string }): PaymentAccount => ({
  name: o.id, type: 'bank_account', provider: 'chase', openingBalance: 0, openingDate: '2000-01-01',
  color: '#000', isActive: true, ...o,
} as PaymentAccount);
const tx = (o: Partial<Transaction> & { id: string; amount: number; date: string }): Transaction => ({
  title: o.id, type: 'expense', category: 'other', paymentMethod: 'bank-transfer', ...o,
} as Transaction);

const EMPLOYER: IncomeSource = {
  id: 'src1', name: 'Larkspur Studio', amount: 4000, frequency: 'monthly', isActive: true,
};

// Frozen clock: monthlyAverages() windows off `new Date()`, and this fixture's
// month-back math depended on real wall-clock time — non-deterministic near a
// month boundary. Pinned so every run sees the same "now".
const FROZEN_NOW = new Date(2026, 7, 15, 12, 0, 0);
beforeAll(() => {
  jest.useFakeTimers();
  jest.setSystemTime(FROZEN_NOW);
});
afterAll(() => {
  jest.useRealTimers();
});

const now = FROZEN_NOW;
const m = (back: number) =>
  new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - back, 15)).toISOString().slice(0, 10);

/**
 * The divisor. A five-persona review caught this from the outside: Runway showed
 * "Monthly Expenses $1,060" for a household whose rent alone is $1,850/mo, and
 * every reviewer independently concluded the app could not count.
 *
 * The cause was dividing by the WINDOW rather than by the months actually
 * observed. A user with ten weeks of history had their spending divided by six,
 * understating burn ~2.3× — and because runway is cash ÷ burn, overstating
 * runway by the same factor. The error ran in the direction that tells someone
 * they have more cushion than they do.
 *
 * The distinction that makes this correct: a month with no rows because nothing
 * happened is a real zero and must count. A month before the user's history
 * begins is not an observation of zero — it is absence of data, and averaging
 * over it invents frugality that was never measured.
 */
describe('monthlyAverages — the divisor is months observed, not the window', () => {
  const A = [acct({ id: 'b' })];

  it('divides by the months the user was actually present for', () => {
    // Ten weeks of history, asked for a 6-month window. Spending $1,000/mo.
    const txns = [
      tx({ id: 'e1', amount: 1000, type: 'expense', accountId: 'b', date: m(1) }),
      tx({ id: 'e2', amount: 1000, type: 'expense', accountId: 'b', date: m(2) }),
    ];
    // $2,000 over the two months that exist — NOT $2,000 ÷ 6 = $333.
    expect(monthlyAverages(txns, A, 6, { sources: [EMPLOYER] }).spending).toBe(1000);
  });

  it('still counts a genuinely quiet month once the user is established', () => {
    // Present since month 4, but spent nothing in months 2 and 3. Those are real
    // zeros and must drag the average down — the user WAS there.
    const txns = [
      tx({ id: 'e1', amount: 900, type: 'expense', accountId: 'b', date: m(1) }),
      tx({ id: 'e4', amount: 300, type: 'expense', accountId: 'b', date: m(4) }),
    ];
    expect(monthlyAverages(txns, A, 6, { sources: [EMPLOYER] }).spending).toBe(300); // 1200 / 4
  });

  it('never divides by zero when the window holds nothing', () => {
    expect(monthlyAverages([], A, 6, { sources: [EMPLOYER] })).toEqual({ income: 0, spending: 0 });
  });

  it('a single month of history reports that month, not a sixth of it', () => {
    const txns = [tx({ id: 'e1', amount: 2400, type: 'expense', accountId: 'b', date: m(1) })];
    expect(monthlyAverages(txns, A, 6, { sources: [EMPLOYER] }).spending).toBe(2400);
  });

  it('a transfer-only month still counts as observed', () => {
    // The month is not silent — money moved, it just was not spending. Ignoring
    // it would re-introduce the same over-estimate through a side door.
    const txns = [
      tx({ id: 'e1', amount: 800, type: 'expense', accountId: 'b', date: m(1) }),
      tx({ id: 'x', amount: 500, type: 'transfer', transferDirection: 'out', accountId: 'b', date: m(2) }),
    ];
    expect(monthlyAverages(txns, A, 6, { sources: [EMPLOYER] }).spending).toBe(400); // 800 / 2
  });

  it('caps at the requested window however long the history runs', () => {
    const txns = [
      tx({ id: 'e1', amount: 300, type: 'expense', accountId: 'b', date: m(1) }),
      tx({ id: 'e9', amount: 300, type: 'expense', accountId: 'b', date: m(9) }), // outside a 3-window
    ];
    expect(monthlyAverages(txns, A, 3, { sources: [EMPLOYER] }).spending).toBe(300); // 300 / 1
  });
});

describe('monthlyAverages', () => {
  it('averages EARNED income and spending over the last N full months, ignoring transfers & this month', () => {
    const A = [acct({ id: 'b' })];
    const txns = [
      tx({ id: 'i1', title: 'LARKSPUR STUDIO PAYROLL', amount: 3000, type: 'income', accountId: 'b', date: m(1) }),
      tx({ id: 'i2', title: 'LARKSPUR STUDIO PAYROLL', amount: 3000, type: 'income', accountId: 'b', date: m(2) }),
      tx({ id: 'e1', amount: 1000, type: 'expense', accountId: 'b', date: m(1) }),
      tx({ id: 'e2', amount: 500, type: 'expense', accountId: 'b', date: m(2) }),
      tx({ id: 'xfer', amount: 999, type: 'transfer', transferDirection: 'out', accountId: 'b', date: m(1) }), // ignored
      tx({ id: 'now', title: 'LARKSPUR STUDIO PAYROLL', amount: 9999, type: 'income', accountId: 'b', date: m(0) }), // current month excluded
    ];
    const r = monthlyAverages(txns, A, 3, { sources: [EMPLOYER] });
    // Divided by 2, not 3. This fixture's history is two months long; the third
    // month of the window predates it, so it is missing data rather than a month
    // in which nothing was spent. The previous expectations here (6000/3 and
    // 1500/3) pinned the defect described above — averaging over a month the
    // user was never present for, which understates burn and inflates runway.
    expect(r.income).toBe(Math.round(6000 / 2));   // 3000
    expect(r.spending).toBe(Math.round(1500 / 2)); // 750
  });

  it('counts ONLY what an approved source explains — no provider category involved', () => {
    const A = [acct({ id: 'b' })];
    const txns = [
      // The importer sent no category at all on the real paychecks...
      tx({ id: 'p1', title: 'ACH CREDIT LARKSPUR STUDIO', amount: 4000, type: 'income', accountId: 'b', date: m(1) }),
      tx({ id: 'p2', title: 'ACH CREDIT LARKSPUR STUDIO', amount: 4000, type: 'income', accountId: 'b', date: m(2) }),
      // ...and DID tag these, which used to be enough to make them income.
      tx({ id: 'zelle', title: 'ZELLE FROM ROWAN ASHDOWN', amount: 5000, type: 'income', accountId: 'b', date: m(1), sourceCategory: 'Paychecks' }),
      tx({ id: 'refund', title: 'AB-4471 CREDIT', amount: 200, type: 'income', accountId: 'b', date: m(2), sourceCategory: 'Paychecks' }),
    ];
    expect(monthlyAverages(txns, A, 2, { sources: [EMPLOYER] }).income).toBe(4000);
  });

  it('claims NO income at all when no approved source is configured', () => {
    const A = [acct({ id: 'b' })];
    const txns = [
      tx({ id: 'z1', title: 'ZELLE FROM ROWAN ASHDOWN', amount: 5000, type: 'income', accountId: 'b', date: m(1) }),
      tx({ id: 'z2', title: 'DEPOSIT', amount: 5000, type: 'income', accountId: 'b', date: m(2), sourceCategory: 'Paychecks' }),
      tx({ id: 'e1', amount: 600, type: 'expense', accountId: 'b', date: m(1) }),
    ];
    const r = monthlyAverages(txns, A, 2, { sources: [] });
    expect(r.income).toBe(0);
    expect(r.spending).toBe(300); // spending is unaffected
  });

  it('a PAUSED source stops counting without deleting its history', () => {
    const A = [acct({ id: 'b' })];
    const txns = [tx({ id: 'p1', title: 'ACH CREDIT LARKSPUR STUDIO', amount: 4000, type: 'income', accountId: 'b', date: m(1) })];
    expect(monthlyAverages(txns, A, 1, { sources: [EMPLOYER] }).income).toBe(4000);
    expect(monthlyAverages(txns, A, 1, { sources: [{ ...EMPLOYER, isActive: false }] }).income).toBe(0);
  });
});

/**
 * The SAME bug at the other end of the window.
 *
 * The divisor above was fixed for a truncated START — history shorter than the
 * window. `latest` was still taken from the window rather than from what was
 * observed, so a truncated END behaved exactly the way the start used to: months
 * after a bank feed dies are counted as real zero-spend months.
 *
 * That is not a quiet month, it is absence of data — the distinction this file
 * already draws. And it runs in the flattering direction, the one the comment
 * above calls out: burn understated, runway overstated, worsening every month
 * the feed stays dead. A Plaid item needing re-auth is the most common event in
 * this product's life.
 *
 * Trade-off, deliberately taken: a genuinely spend-free most-recent month now
 * shortens the divisor and overstates burn slightly. That errs toward a SHORTER
 * runway. Given a real ledger essentially always has some row in the latest
 * month, and given the documented worst failure here is telling someone they
 * have more cushion than they do, that is the correct direction.
 */
describe('monthlyAverages — a dead feed is missing data, not frugality', () => {
  const A = [acct({ id: 'b' })];

  it('does not average over months the feed stopped reporting', () => {
    // Present months 6..4 at $1,200/mo, then the feed dies. Months 3..1 are
    // silent because nothing arrived, not because nothing was spent.
    const txns = [
      tx({ id: 'e6', amount: 1200, type: 'expense', accountId: 'b', date: m(6) }),
      tx({ id: 'e5', amount: 1200, type: 'expense', accountId: 'b', date: m(5) }),
      tx({ id: 'e4', amount: 1200, type: 'expense', accountId: 'b', date: m(4) }),
    ];
    // $3,600 over the three months actually observed — not ÷ 6, which would
    // report $600 and double the runway built on it.
    expect(monthlyAverages(txns, A, 6, { sources: [EMPLOYER] }).spending).toBe(1200);
  });

  it('still counts quiet months that sit BETWEEN observations', () => {
    // The start-truncation rule must survive: months 3 and 2 are real zeros,
    // because the user was demonstrably present on either side of them.
    const txns = [
      tx({ id: 'e4', amount: 800, type: 'expense', accountId: 'b', date: m(4) }),
      tx({ id: 'e1', amount: 800, type: 'expense', accountId: 'b', date: m(1) }),
    ];
    expect(monthlyAverages(txns, A, 6, { sources: [EMPLOYER] }).spending).toBe(400); // 1600 / 4
  });
});
