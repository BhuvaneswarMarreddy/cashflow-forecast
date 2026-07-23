/**
 * Audit replay: the real Monarch CSVs through the flow engine, asserted against
 * independently-verified ground truth (CSV_GROUND_TRUTH.md + the design spec).
 * Skips (does not fail) when the CSV folder is absent, so CI without data stays green.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as XLSX from 'xlsx';
import { Transaction, PaymentAccount } from '@/types';
import { buildFlowGraph, detectRecurring, toCents } from '@/lib/flows';

const DIR = path.join(process.cwd(), 'transactionsbyaccount');
const maybe = fs.existsSync(DIR) ? describe : describe.skip;

// Real user-entered balances, 2026-07-23 (Monarch). Frozen audit inputs.
const ACCOUNTS: Array<[string, PaymentAccount['type'], number]> = [
  ['TOTAL CHECKING (...7535)', 'bank_account', 829.60],
  ['Adv SafeBalance Banking (...2126)', 'bank_account', 1430.93],
  ['Advantage Savings (...2139)', 'bank_account', 45.52],
  ['CHASE SAVINGS (...2591)', 'bank_account', 2600.97],
  ['Customized Cash Rewards Visa Signature (...3572)', 'credit_card', 2656.09],
  ['Blue Cash Preferred® (...1001)', 'credit_card', 507.96],
  ['Amazon Store Card (...3282)', 'credit_card', 3308.57],
  ['Apple Card', 'credit_card', 2068.93],
  ['Discover it Card (...4363)', 'credit_card', 6.85],
];

function load(): { transactions: Transaction[]; accounts: PaymentAccount[] } {
  const accounts: PaymentAccount[] = ACCOUNTS.map(([name, type, balance], i) => ({
    id: `a${i}`, name, type, balance,
    provider: 'other', color: '#000', isActive: true,
  } as PaymentAccount));
  const idByName = new Map(accounts.map((a) => [a.name, a.id]));
  const transactions: Transaction[] = [];
  for (const f of fs.readdirSync(DIR).filter((x) => x.endsWith('.csv'))) {
    // read as UTF-8 string — buffer mode mangles '®' in "Blue Cash Preferred®"
    const wb = XLSX.read(fs.readFileSync(path.join(DIR, f), 'utf8'), { type: 'string', raw: true });
    const rows = XLSX.utils.sheet_to_json<Record<string, string>>(wb.Sheets[wb.SheetNames[0]]);
    for (const [i, r] of rows.entries()) {
      const amount = parseFloat(String(r['Amount']));
      const isTransfer = r['Category'] === 'Transfer' || r['Category'] === 'Credit Card Payment';
      transactions.push({
        id: `${f}:${i}`,
        title: String(r['Merchant'] ?? ''),
        merchant: String(r['Merchant'] ?? ''),
        description: String(r['Original Statement'] ?? ''),
        sourceCategory: String(r['Category'] ?? ''),
        amount: Math.abs(amount),
        type: isTransfer ? 'transfer' : amount < 0 ? 'expense' : 'income',
        transferDirection: isTransfer ? (amount < 0 ? 'out' : 'in') : undefined,
        category: 'other', paymentMethod: 'other',
        date: String(r['Date']),
        accountId: idByName.get(String(r['Account'])),
      } as Transaction);
    }
  }
  return { transactions, accounts };
}

maybe('audit replay over the real CSVs', () => {
  const { transactions, accounts } = load();
  const g = buildFlowGraph(transactions, accounts);
  const recon = (name: string) => g.reconciliation.find((r) => r.name === name)!;

  it('loaded the full export', () => {
    expect(transactions).toHaveLength(2913);
    expect(transactions.filter((t) => !t.accountId)).toHaveLength(0);
  });

  it('reconciles every account to the audited implied opening, to the cent', () => {
    const expected: Array<[string, number, string]> = [
      ['Adv SafeBalance Banking (...2126)', -483295, 'missing-rows'],
      ['TOTAL CHECKING (...7535)', -383000, 'missing-rows'],
      ['Customized Cash Rewards Visa Signature (...3572)', 211731, 'missing-rows'],
      ['CHASE SAVINGS (...2591)', 210000, 'opening'],
      ['Advantage Savings (...2139)', 420, 'opening'],
      ['Blue Cash Preferred® (...1001)', -154120, 'pre-export-debt'],
      ['Amazon Store Card (...3282)', -216870, 'pre-export-debt'],
      ['Apple Card', -188530, 'pre-export-debt'],
      ['Discover it Card (...4363)', -1067, 'pre-export-debt'],
    ];
    for (const [name, opening, verdict] of expected) {
      expect({ name, opening: recon(name).openingCents, verdict: recon(name).verdict })
        .toEqual({ name, opening, verdict });
    }
  });

  it('ties the closing total to net worth −$3,641.38', () => {
    const total = g.reconciliation.reduce((s, r) => s + r.closingCents, 0);
    expect(total).toBe(-364138);
  });

  it('conserves every cent globally', () => {
    const inBy = new Map<string, number>(), outBy = new Map<string, number>();
    for (const l of g.links) {
      inBy.set(l.target, (inBy.get(l.target) ?? 0) + l.cents);
      outBy.set(l.source, (outBy.get(l.source) ?? 0) + l.cents);
    }
    for (const n of g.nodes) {
      const i = inBy.get(n.id) ?? 0, o = outBy.get(n.id) ?? 0;
      if (i > 0 && o > 0) expect(i).toBe(o);
    }
  });

  it('finds the audited people totals (±$1)', () => {
    const linkSum = (id: string, side: 'source' | 'target') =>
      g.links.filter((l) => l[side] === id).reduce((s, l) => s + l.cents, 0);
    const remitly = linkSum('person-out:REMITLY', 'target');
    expect(Math.abs(remitly - toCents(120562.36))).toBeLessThanOrEqual(100);
    const sridevi = linkSum('person-out:SRIDEVI GOGINENI', 'target');
    expect(Math.abs(sridevi - toCents(18612))).toBeLessThanOrEqual(100);
  });

  it('reproduces the audited recurring anchors', () => {
    const items = detectRecurring(transactions, accounts, '2026-07-22');
    const by = new Map(items.map((i) => [i.merchant, i]));
    expect(by.get('UPSTART')).toMatchObject({ cadence: 'monthly', medianCents: 90000, occurrences: 20, active: false });
    expect(by.get('VERIZON')).toMatchObject({ cadence: 'monthly', medianCents: 49994, occurrences: 19, active: true });
    expect(by.get('COMCAST')).toMatchObject({ cadence: 'monthly', active: true });
    expect(by.has('QUIKTRIP')).toBe(false);
    expect(by.has('FEDERAL WITHHOLDING')).toBe(false);
  });
});
