/**
 * CRITICAL-4 (#14 round 2) — the feedless double-count guard's boundary
 * (`feedCoverageThrough`) is attached IN MEMORY by withDerivedBalances(); it is
 * never on `profile.paymentAccounts`. A call site that hands the raw profile
 * accounts straight to a classify/forecast function therefore has a permanently
 * inert guard — measured: two screens on the same ledger disagreeing 2.3x on the
 * same month, because one derived first and one did not.
 *
 * Same lesson as policy-wiring.test.ts: a test that exercises the library proves
 * the library, not the caller. This reads the three call sites the review named.
 */
import { readFileSync } from 'fs';

const FILES = [
  'src/app/history/page.tsx',
  'src/components/InsightsTab.tsx',
  'src/components/CashflowTab.tsx',
];

/** Every argument list for `fn(` in `src`, brace-matched so nested calls stay intact. */
function callArgs(src: string, fn: string): string[] {
  const out: string[] = [];
  let i = 0;
  for (;;) {
    const at = src.indexOf(fn + '(', i);
    if (at === -1) return out;
    let j = at + fn.length, depth = 0, end = -1;
    for (; j < src.length; j++) {
      const c = src[j];
      if (c === '(' || c === '[' || c === '{') depth++;
      else if (c === ')' || c === ']' || c === '}') { depth--; if (depth === 0) { end = j; break; } }
    }
    if (end === -1) return out;
    out.push(src.slice(at + fn.length + 1, end));
    i = end + 1;
  }
}

const GUARD_SENSITIVE_CALLS = [
  'interpretTransaction', 'classifyTransaction', 'isPositive',
  'sumIncomeCents', 'sumExpenseCents', 'monthlyAverages',
];

describe('CRITICAL-4: history/InsightsTab/CashflowTab never hand the RAW profile accounts to a classify/forecast call', () => {
  const files = FILES.map((path) => ({ path, src: readFileSync(path, 'utf8') }));

  it.each(files.map((f) => [f.path, f]))('%s derives accounts before every guard-sensitive call', (_path, file) => {
    const { path, src } = file as { path: string; src: string };
    expect(src).toContain('withDerivedBalances');
    const sites = GUARD_SENSITIVE_CALLS.flatMap((fn) => callArgs(src, fn));
    expect(sites.length).toBeGreaterThan(0);
    for (const args of sites) {
      expect(args).not.toMatch(/profile\??\.paymentAccounts/);
    }
  });
});
