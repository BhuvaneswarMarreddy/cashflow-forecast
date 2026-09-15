/**
 * #200 — Accounts answers "what do I own and owe?": connect first, two numbers, the
 * list as a map, tools under it.
 *
 * The lies these pin: five headline cards led by a Net Worth that summed unanchored
 * net-movement figures as if they were balances; an unanchored account's row printing
 * that net movement in balance-red/green; per-account brand colours; budgets and the
 * debt planner as peer tabs above the list.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const source = readFileSync(join(process.cwd(), 'src/app/accounts/page.tsx'), 'utf8');
const code = source.replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const pos = (needle: string) => {
  const i = code.indexOf(needle);
  expect([needle, i >= 0]).toEqual([needle, true]);
  return i;
};

describe('Accounts — connect first (#200)', () => {
  it('leads with Connect bank and Import CSV, and says which accounts must be imported', () => {
    expect(pos('Connect bank')).toBeLessThan(pos('Import CSV'));
    expect(code).toContain('Apple Card and Indian accounts (NRE, NRO, FDs) can&apos;t be connected. Use Import CSV for those.');
  });

  it('shows two numbers, Cash and Debt, each disclosing only its own accounts; no Net Worth', () => {
    expect(code).not.toContain('Net Worth');
    expect(code).toContain('<UnanchoredNote accounts={derivedAccounts.filter(isCashAccount)} />');
    expect(code).toContain('<UnanchoredNote accounts={derivedAccounts.filter(isDebtAccount)} />');
    expect(code).toContain('None linked');
  });

  it('groups the list Cash | Credit | Investments | Other, and every account lands in exactly one group', () => {
    expect(code).toContain("{ key: 'cash', label: 'Cash', accounts: derivedAccounts.filter(isCashAccount) }");
    expect(code).toContain("{ key: 'credit', label: 'Credit', accounts: derivedAccounts.filter((a) => a.type === 'credit_card') }");
    // #182: a brokerage is its own group, never Cash and never lumped into Other.
    expect(code).toContain("{ key: 'investments', label: 'Investments', accounts: derivedAccounts.filter(isInvestmentAccount) }");
    expect(code).toContain("{ key: 'other', label: 'Other', accounts: derivedAccounts.filter((a) => !isCashAccount(a) && !isInvestmentAccount(a) && a.type !== 'credit_card') }");
  });

  it('an unanchored row says "Not anchored" instead of printing net movement as a balance', () => {
    expect(code).toMatch(/isUnanchored\(account\) \? \(\s*<p[^>]*>Not anchored<\/p>/);
  });

  it('no per-account brand colour on a row', () => {
    expect(code).not.toContain('borderLeftColor: account.color');
    expect(code).not.toContain('`${account.color}20`');
    expect(code).not.toMatch(/\b(?:text|bg|border)-(?:amber|emerald|green|red)-\d{3}\b/);
  });

  it('tools (income, bills, budget, debt plan, diagnostics) sit under the list, never above it', () => {
    const list = pos('id="accounts-heading"');
    for (const tool of ['id="tools-heading"', '<SubscriptionsPanel', '<DebtPlannerPanel', '<BudgetSettingsPanel', '<AccountsDiagnostics', 'Monthly Income', 'Monthly Budget']) {
      expect([tool, pos(tool) > list]).toEqual([tool, true]);
    }
  });
});
