/**
 * Activity rows — which token a value comes from, and what a transfer looks like.
 * Source assertions, like home-screen-contract: only the source can say where a colour
 * comes from. Layout is checked in e2e/activity.spec.ts.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const source = readFileSync(join(process.cwd(), 'src/app/history/page.tsx'), 'utf8');
const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('Activity rows', () => {
  it('money wears the money tokens, not Tailwind greens and reds', () => {
    expect(code).not.toMatch(/\b(?:text|bg)-(?:emerald|green|red)-\d{3}\b/);
    expect(code).toContain('text-[var(--money-in)]');
    expect(code).toContain('text-[var(--money-out)]');
  });

  it('no per-merchant or per-account brand colour on a row', () => {
    expect(code).not.toContain('getMerchantColor');
    expect(code).not.toMatch(/style=\{\{[^}]*[Cc]olor/);
  });

  it('a transfer is muted and labelled, never painted as spend (invariant 5)', () => {
    expect(code).toContain("classifyTransaction(txn, derivedAccounts) === 'transfer'");
    expect(code).toMatch(/txn\.pending \|\| isTransfer\s*\?\s*'text-\[var\(--foreground-muted\)\]'/);
  });

  it('phones get one actions button per row; the paired-delete sheet is still reachable', () => {
    expect(code).toContain('More actions for ${txn.title}');
    expect(code).toContain('ariaLabel="Transaction actions"');
    expect(code).toContain('setDeleteConfirm(id)');
    expect(code).toContain('ariaLabel="Delete a paired transfer"');
  });
});
