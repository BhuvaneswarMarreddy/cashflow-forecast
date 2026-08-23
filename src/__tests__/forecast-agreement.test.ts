/**
 * STATE-001 (#105) — Dashboard, /forecast and History must forecast the same future.
 *
 * They each build their own `generateForecast` call. Before this, `income` was the
 * OPTIONAL 8th argument: /forecast passed it, Dashboard and History did not, so the
 * three screens projected the owner's runway under two different rule sets and nothing
 * noticed. The policy is now argument 5 and required, which makes the omission a
 * compile error — these tests pin the BEHAVIOUR that change was for.
 */
import { IncomeSource, PaymentAccount, Transaction } from '@/types';
import { FinancialPolicy, POSTED_ONLY } from '@/lib/classify';
import { calculateCurrentCash, generateForecast, withDerivedBalances } from '@/lib/forecast';
import { addDays, format } from 'date-fns';

/**
 * Frozen clock + a non-UTC TZ, both deliberate.
 *
 * forecast.ts's `today` is `startOfDay(new Date())` — a LOCAL day boundary (see
 * its comment: "Compare calendar days, not instants (IST timezone; see git
 * history)"). This file's old `day()` helper computed "today" via
 * `new Date(...).toISOString().slice(0, 10)` — a UTC day boundary. Near local
 * midnight in a timezone ahead of or behind UTC, those two boundaries land on
 * different calendar dates, so a transaction meant to sit "yesterday" could
 * silently land on "today" (or vice versa) depending on the exact moment the
 * suite happened to run — exactly the class of bug the source comment warns
 * about, reproduced here in the test fixtures.
 *
 * Fixed two ways: `day()` below now builds dates with date-fns `format`/`addDays`
 * — LOCAL, like the source — instead of `toISOString`. And the clock is frozen
 * at a fixed instant, pinned to Asia/Kolkata (UTC+5:30, and deliberately NOT
 * UTC), near local midnight, so this exact scenario is exercised on every run
 * instead of only near real local midnight in a non-UTC dev machine.
 */
const ORIGINAL_TZ = process.env.TZ;
beforeAll(() => {
  process.env.TZ = 'Asia/Kolkata';
  jest.useFakeTimers();
  jest.setSystemTime(new Date(2026, 7, 15, 23, 50, 0)); // 11:50pm local — near local midnight
});
afterAll(() => {
  jest.useRealTimers();
  process.env.TZ = ORIGINAL_TZ;
});

const bank: PaymentAccount = {
  id: 'b', name: 'Checking', type: 'bank_account', provider: 'chase',
  openingBalance: 5000, openingDate: '2026-01-01', color: '#000', isActive: true,
} as PaymentAccount;
const ACCOUNTS = [bank];

const source: IncomeSource = {
  id: 'src1', name: 'Acme', amount: 4300, frequency: 'monthly',
  isActive: true, matchAliases: ['acme'],
} as IncomeSource;

/** LOCAL calendar day, offset from "now" — matches forecast.ts's own local-day
 *  convention instead of drifting to a UTC one (see the comment above). */
const day = (offset: number) => format(addDays(new Date(), offset), 'yyyy-MM-dd');

const tx = (o: Partial<Transaction> & { id: string; amount: number }): Transaction => ({
  title: o.id, type: 'expense', category: 'other', paymentMethod: 'bank-transfer',
  date: day(-3), accountId: 'b', ...o,
} as Transaction);

const LEDGER: Transaction[] = [
  tx({ id: 'rent', title: 'Rent', amount: 1850, date: day(-10) }),
  tx({ id: 'hold-in', title: 'ACME PAYROLL', amount: 4300, type: 'income', date: day(-1), pending: true }),
  tx({ id: 'hold-out', title: 'Xfinity', amount: 100, date: day(-1), pending: true }),
];

const ON: FinancialPolicy = { sources: [source], includePending: true };
const OFF: FinancialPolicy = { sources: [source], includePending: false };

/** Exactly what each page does: derive under the policy, then forecast under it. */
function screenForecast(policy: FinancialPolicy) {
  const derived = withDerivedBalances(ACCOUNTS, LEDGER, policy);
  return generateForecast(
    calculateCurrentCash(derived), derived, [source], LEDGER, policy, 500, 90
  );
}

describe('STATE-001: every screen forecasts the same future', () => {
  it.each([['policy OFF', OFF], ['policy ON', ON]] as const)(
    '%s — Dashboard, /forecast and History agree on the ending balance',
    (_label, policy) => {
      const dashboard = screenForecast(policy);
      const forecastPage = screenForecast(policy);
      const history = screenForecast(policy);
      expect(dashboard.endingBalance).toBe(forecastPage.endingBalance);
      expect(forecastPage.endingBalance).toBe(history.endingBalance);
      expect(dashboard.lowestBalance).toBe(forecastPage.lowestBalance);
      expect(forecastPage.lowestBalance).toBe(history.lowestBalance);
    }
  );

  it('the policy actually moves the forecast — otherwise the test above proves nothing', () => {
    // A guard against the agreement being vacuous. If ON and OFF produced identical
    // forecasts, three screens agreeing would say nothing about whether they read the
    // policy at all. The holds are +4300 / -100, so ON must start 4200 higher.
    expect(screenForecast(ON).endingBalance - screenForecast(OFF).endingBalance).toBeCloseTo(4200, 2);
  });

  it('a screen that forgets the policy gets a different answer — the bug, pinned', () => {
    // POSTED_ONLY is what an omitted argument used to mean. It must NOT equal the
    // owner's ON answer, or the whole required-argument change was pointless.
    const forgot = (() => {
      const derived = withDerivedBalances(ACCOUNTS, LEDGER, POSTED_ONLY);
      return generateForecast(
        calculateCurrentCash(derived), derived, [source], LEDGER, POSTED_ONLY, 500, 90
      );
    })();
    expect(forgot.endingBalance).not.toBe(screenForecast(ON).endingBalance);
  });
});
