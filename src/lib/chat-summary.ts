/**
 * buildLedgerSummary() — complete, app-computed totals over EVERY transaction.
 *
 * The chat used to receive 20 recent rows and a list of merchant names with no
 * amounts, so "what did I spend this year" was unanswerable and "is Instacart
 * groceries" got a guess from world knowledge dressed up as a fact. The fix is not
 * to ship the whole ledger into the prompt — it is cost, it is slow, and it makes
 * the model do arithmetic that prompts.ts explicitly forbids it from doing.
 *
 * Instead the app does the counting, over all rows, and sends the results. Every
 * number here is exact. Nothing is sampled. What is capped is only ever BREADTH
 * (how many merchants, how many months are listed) and every cap reports what it
 * left out, so the model can say "I only have the top 40" instead of inventing a
 * 41st.
 *
 * classifyTransaction() is the authority on expense/income/transfer (FIN-LEDGER-001),
 * so a card payment is neither income nor spending here — same as everywhere else.
 */
import { PaymentAccount, Transaction, displayCategory } from '@/types';
import { classifyTransaction } from './classify';

/** Breadth caps. Totals are never sampled — these bound the LIST length only. */
const MAX = { merchants: 40, months: 24, categories: 25, str: 60 };

export interface PeriodTotals {
  /** 'YYYY' or 'YYYY-MM' */
  period: string;
  income: number;
  spending: number;
  net: number;
  count: number;
}

export interface CategoryTotal {
  category: string;
  spending: number;
  count: number;
}

export interface MerchantTotal {
  name: string;
  spending: number;
  income: number;
  /**
   * Money that moved to/from this merchant while classified as a transfer, so it
   * counts as neither spending nor income.
   *
   * Without this, "how much did I send to X" under-reports badly wherever X's rows
   * are mostly transfers. Measured on the real export: a remittance service showed
   * $5,208.25 of spending against $120,562.36 actually sent — 23x low, and stated
   * as fact. The totals were right; the question was "sent", not "spent".
   */
  transferred: number;
  count: number;
  /** Every category this merchant's rows actually carry, most-used first. */
  categories: string[];
  firstDate: string;
  lastDate: string;
}

export interface LedgerSummary {
  span: { from: string; to: string; transactions: number };
  byYear: PeriodTotals[];
  byMonth: PeriodTotals[];
  monthsOmitted: number;
  byCategoryThisYear: CategoryTotal[];
  categoriesOmitted: number;
  topMerchants: MerchantTotal[];
  merchantsOmitted: number;
}

const clip = (s: string) => s.trim().slice(0, MAX.str);
const r2 = (n: number) => Math.round(n * 100) / 100;

/** Bucket key -> running income/spending/count, in one pass. */
type Acc = { income: number; spending: number; count: number };
const bump = (m: Map<string, Acc>, key: string, kind: 'income' | 'expense', amount: number) => {
  const a = m.get(key) ?? { income: 0, spending: 0, count: 0 };
  if (kind === 'income') a.income += amount;
  else a.spending += amount;
  a.count += 1;
  m.set(key, a);
};

const toPeriods = (m: Map<string, Acc>): PeriodTotals[] =>
  [...m.entries()]
    .sort((a, b) => (a[0] < b[0] ? 1 : -1)) // newest first
    .map(([period, a]) => ({
      period,
      income: r2(a.income),
      spending: r2(a.spending),
      net: r2(a.income - a.spending),
      count: a.count,
    }));

export function buildLedgerSummary(
  transactions: Transaction[],
  accounts: PaymentAccount[] = [],
  /** Injected so the summary is deterministic in tests. Defaults to today. */
  today: string = new Date().toISOString().slice(0, 10)
): LedgerSummary {
  if (transactions.length === 0) {
    return {
      span: { from: '', to: '', transactions: 0 },
      byYear: [], byMonth: [], monthsOmitted: 0,
      byCategoryThisYear: [], categoriesOmitted: 0,
      topMerchants: [], merchantsOmitted: 0,
    };
  }

  const thisYear = today.slice(0, 4);
  const years = new Map<string, Acc>();
  const months = new Map<string, Acc>();
  const cats = new Map<string, { spending: number; count: number }>();
  const merchants = new Map<string, {
    spending: number; income: number; transferred: number; count: number;
    cats: Map<string, number>; first: string; last: string;
  }>();

  let from = transactions[0].date.slice(0, 10);
  let to = from;

  for (const t of transactions) {
    const date = t.date.slice(0, 10);
    if (date < from) from = date;
    if (date > to) to = date;

    const kind = classifyTransaction(t, accounts);

    // Transfers move money between the owner's own accounts — they are neither
    // income nor spending, and counting them in the period totals would double
    // the ledger. Merchant totals below DO record them, separately: "how much did
    // I send to X" is a different question from "what did X cost me".
    if (kind === 'income' || kind === 'expense') {
      bump(years, date.slice(0, 4), kind, t.amount);
      bump(months, date.slice(0, 7), kind, t.amount);

      if (kind === 'expense' && date.slice(0, 4) === thisYear) {
        const label = displayCategory(t);
        const c = cats.get(label) ?? { spending: 0, count: 0 };
        c.spending += t.amount;
        c.count += 1;
        cats.set(label, c);
      }
    }

    const name = clip(t.merchant || t.title || '');
    if (!name) continue;
    const m = merchants.get(name) ?? {
      spending: 0, income: 0, transferred: 0, count: 0,
      cats: new Map<string, number>(), first: date, last: date,
    };
    if (kind === 'income') m.income += t.amount;
    else if (kind === 'expense') m.spending += t.amount;
    else m.transferred += t.amount;
    m.count += 1;
    const label = displayCategory(t);
    m.cats.set(label, (m.cats.get(label) ?? 0) + 1);
    if (date < m.first) m.first = date;
    if (date > m.last) m.last = date;
    merchants.set(name, m);
  }

  const allMonths = toPeriods(months);
  const allCats = [...cats.entries()]
    .sort((a, b) => b[1].spending - a[1].spending)
    .map(([category, c]) => ({ category, spending: r2(c.spending), count: c.count }));
  // Rank by total money moved — INCLUDING transfers, or a merchant the owner sends
  // six figures through ranks below a coffee shop and falls off the list entirely.
  const moved = (m: { spending: number; income: number; transferred: number }) =>
    m.spending + m.income + m.transferred;
  const rankedMerchants = [...merchants.entries()].sort((a, b) => moved(b[1]) - moved(a[1]));

  return {
    span: { from, to, transactions: transactions.length },
    byYear: toPeriods(years),
    byMonth: allMonths.slice(0, MAX.months),
    monthsOmitted: Math.max(0, allMonths.length - MAX.months),
    byCategoryThisYear: allCats.slice(0, MAX.categories),
    categoriesOmitted: Math.max(0, allCats.length - MAX.categories),
    topMerchants: rankedMerchants.slice(0, MAX.merchants).map(([name, m]) => ({
      name,
      spending: r2(m.spending),
      income: r2(m.income),
      transferred: r2(m.transferred),
      count: m.count,
      categories: [...m.cats.entries()].sort((a, b) => b[1] - a[1]).map(([c]) => c),
      firstDate: m.first,
      lastDate: m.last,
    })),
    merchantsOmitted: Math.max(0, rankedMerchants.length - MAX.merchants),
  };
}
