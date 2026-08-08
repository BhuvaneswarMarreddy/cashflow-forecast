/**
 * #102 — the policy must REACH the screens, not merely exist.
 *
 * Why this file exists, stated plainly so it is not deleted as redundant:
 *
 * #89 shipped a "cross-surface consistency" suite that passed while the app was wrong.
 * Every case called the library directly — `withDerivedBalances(accounts, rows, policy)`
 * — and proved the library honours a policy it is handed. Nothing checked that the PAGES
 * handed it one. Six of seven call sites did not, so the owner turned the setting on and
 * Dashboard, Forecast, History, Flow's gross view, the export and the AI context all
 * ignored it. Green tests, broken product.
 *
 * The lesson generalises: a test that exercises a function proves the function. Only a
 * test that reads the CALLERS proves the wiring.
 *
 * Most of this is now enforced by the compiler — the policy is a required argument on
 * every money function, so an omission fails `tsc`. These scans cover what types cannot:
 * the arguments that are still optional (an options bag), and the case where someone
 * passes a fresh empty object instead of the owner's real policy.
 */
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

const APP = join(process.cwd(), 'src', 'app');

function pageFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = join(dir, e.name);
    if (e.isDirectory()) return e.name === '_fixture' || e.name === 'dev' ? [] : pageFiles(full);
    return e.name === 'page.tsx' ? [full] : [];
  });
}

/**
 * Comments out. These files DOCUMENT the very functions being scanned — history/page.tsx
 * has a paragraph explaining `monthlyAverages()` — and a prose mention is not a call site.
 */
const stripComments = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

const pages = pageFiles(APP).map((f) => ({
  path: f.replace(process.cwd() + '/', ''),
  src: stripComments(readFileSync(f, 'utf8')),
}));

/**
 * Functions whose result IS a figure the owner reads as their financial position.
 * `calculateCurrentCash` is absent on purpose: it takes ALREADY-DERIVED accounts, so it
 * inherits whatever policy `withDerivedBalances` applied and has none of its own.
 */
const MONEY_CALLS = ['withDerivedBalances', 'sumIncomeCents', 'sumExpenseCents', 'monthlyAverages'];

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

describe('#102: every money CALL SITE is handed the owner policy', () => {
  // Deliberately per-CALL, not per-file. The first version of this test asserted the
  // file merely mentioned `incomeContext` somewhere — and passed on the broken code,
  // because Dashboard already used it for monthlyAverages while calling
  // withDerivedBalances without it. A test that cannot fail is worse than no test.
  const sites = pages.flatMap((p) =>
    MONEY_CALLS.flatMap((fn) => callArgs(p.src, fn).map((args, n) => [`${p.path} ${fn}#${n + 1}`, args]))
  );

  it('finds call sites at all (guards against a vacuous zero-site scan)', () => {
    expect(sites.length).toBeGreaterThanOrEqual(6);
  });

  it.each(sites)('%s receives incomeContext or an explicit POSTED_ONLY', (_label, args) => {
    expect(args as string).toMatch(/incomeContext|POSTED_ONLY/);
  });
});

describe('#102: buildFlowGraph is never called without the policy', () => {
  // Its policy rides an OPTIONS BAG, so the compiler cannot require it. `{}` is a valid
  // FlowOptions and silently means posted-only — which is exactly how the "Show gross"
  // toggle reverted Flow to a different answer from the rest of the app.
  const callers = pages.filter((p) => p.src.includes('buildFlowGraph('));

  it('has callers to check', () => {
    expect(callers.length).toBeGreaterThan(0);
  });

  it.each(callers.map((p) => [p.path, p]))('%s passes income in every options bag', (_path, page) => {
    const src = (page as { src: string }).src;
    // Every options object handed to buildFlowGraph must name `income`. A bare `{}`
    // fails here, which is the regression this test was written for.
    const calls = src.split('buildFlowGraph(').slice(1);
    for (const call of calls) {
      const head = call.slice(0, 400);
      expect(head).toMatch(/income:/);
      expect(head).not.toMatch(/,\s*\{\s*\}\s*\)/);
    }
  });
});
