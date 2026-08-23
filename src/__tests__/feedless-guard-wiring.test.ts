/**
 * CRITICAL-4 (#14 round 2) — the feedless double-count guard's coverage
 * (`feedCoveredPeriods`) is attached IN MEMORY by withDerivedBalances(); it is
 * never on `profile.paymentAccounts`. A call site that hands the raw profile
 * accounts straight to a classify/forecast function therefore has a permanently
 * inert guard — measured: two screens on the same ledger disagreeing 2.3x on the
 * same month, because one derived first and one did not.
 *
 * IMPORTANT-3 (#14 round 3): round 2's version of this test asserted the NAME of
 * the variable a call site passed (`args).not.toMatch(/profile\??\.paymentAccounts/)`)
 * plus that the literal string `withDerivedBalances` appeared SOMEWHERE in the
 * file (true forever, just from the import line). Measured: replacing a memo's
 * body with `() => (profile?.paymentAccounts || [])` while keeping its name
 * (`derivedAccounts`) — the exact regression this file exists to catch — left
 * both checks green. This version proves the CALLER: every guard-sensitive call's
 * account argument must be an identifier whose OWN declaration's initializer
 * actually calls `withDerivedBalances(`, not just share a name with one.
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

/**
 * Every `const NAME = <initializer>;` top-level-statement declaration in `src`
 * (brace/paren/bracket-matched, so a multi-line `useMemo(() => ..., [...])`
 * initializer stays intact). Good enough for this codebase's straight-line
 * hook-declaration style — no destructuring target is a match, which is fine:
 * we only care about the plain `const NAME = ...` shape these files actually use.
 */
function declarations(src: string): { name: string; init: string }[] {
  const out: { name: string; init: string }[] = [];
  const re = /const\s+([A-Za-z_$][\w$]*)\s*=\s*/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    let depth = 0, i = re.lastIndex, end = -1;
    for (; i < src.length; i++) {
      const c = src[i];
      if (c === '(' || c === '[' || c === '{') depth++;
      else if (c === ')' || c === ']' || c === '}') depth--;
      else if (c === ';' && depth === 0) { end = i; break; }
    }
    if (end === -1) continue;
    out.push({ name: m[1], init: src.slice(re.lastIndex, end) });
  }
  return out;
}

const GUARD_SENSITIVE_CALLS = [
  'interpretTransaction', 'classifyTransaction', 'isPositive',
  'sumIncomeCents', 'sumExpenseCents', 'monthlyAverages',
];

describe('CRITICAL-4/IMPORTANT-3: history/InsightsTab/CashflowTab never hand the RAW profile accounts to a classify/forecast call', () => {
  const files = FILES.map((path) => ({ path, src: readFileSync(path, 'utf8') }));

  it.each(files.map((f) => [f.path, f]))('%s derives accounts before every guard-sensitive call, and PROVABLY so', (_path, file) => {
    const { path, src } = file as { path: string; src: string };

    // The identifiers this file ACTUALLY derives — i.e. whose own initializer
    // calls withDerivedBalances(...). Not "the string appears in the file"
    // (true forever, from the import) and not "shares a name with" one.
    const derivedIdentifiers = new Set(
      declarations(src).filter((d) => d.init.includes('withDerivedBalances(')).map((d) => d.name)
    );
    expect(derivedIdentifiers.size).toBeGreaterThan(0);

    // Filters out bare `fn()` matches — every REAL call site here always passes
    // at least a transaction/account argument, so an empty capture is `callArgs`
    // matching a prose mention like "monthlyAverages() uses the last 6 months"
    // in a comment, not code.
    const sites = GUARD_SENSITIVE_CALLS.flatMap((fn) => callArgs(src, fn)).filter((a) => a.trim() !== '');
    expect(sites.length).toBeGreaterThan(0);
    for (const args of sites) {
      expect(args).not.toMatch(/profile\??\.paymentAccounts/);
      // IMPORTANT-3: at least one argument must be a PROVEN-derived identifier —
      // catches a memo whose body was swapped for `profile?.paymentAccounts`
      // while its variable name (and the file's `withDerivedBalances` import)
      // stayed put.
      const usesDerived = [...derivedIdentifiers].some((name) => new RegExp(`\\b${name}\\b`).test(args));
      expect(usesDerived).toBe(true);
    }
  });
});
