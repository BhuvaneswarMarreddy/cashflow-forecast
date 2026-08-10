/**
 * #41 — `xlsx` must stay out of the eager path.
 *
 * It is ~400KB and nothing renders it: it is needed when someone clicks Import or
 * Export, and at no other moment. Two static imports were enough to put it in the
 * first load of History (2,424KB) and Settings (1,972KB).
 *
 * Measured before/after by summing every chunk referenced by each prerendered HTML:
 *   history   2,424KB -> 2,003KB   (-421)
 *   settings  1,972KB -> 1,528KB   (-444)
 *
 * A static import is one autocomplete away from coming back, and nothing else would
 * notice, so it is pinned here rather than left to review.
 */
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : /\.tsx?$/.test(name) ? [p] : [];
  });

const appFiles = walk('src').filter((f) => !f.includes('__tests__'));

/**
 * The two modules that ARE the lazy boundary. They import `xlsx` at the top level on
 * purpose — that is the point, the weight lives behind them and arrives only when one
 * of them is pulled in. Anything else importing xlsx has re-attached it to the eager
 * graph, which is the regression this file exists to catch.
 */
const LAZY_BOUNDARY = [
  'src/components/CSVImportModal.tsx',
  'src/lib/export-xlsx.ts',
  // The parser extracted out of CSVImportModal so the Cloud Function can share
  // it. Safe only because nothing EAGER reaches it — pinned by the third test
  // below, which is what keeps this entry from being a hole in the rule.
  'src/lib/csv-import.ts',
];
const norm = (f: string) => f.split(/[\\/]/).join('/');

describe('xlsx stays lazy', () => {
  it('is statically imported only by the modules that are themselves lazy-loaded', () => {
    const offenders = appFiles.filter((f) => {
      if (LAZY_BOUNDARY.includes(norm(f))) return false;
      const src = readFileSync(f, 'utf8');
      // `await import('xlsx')` is fine — a top-level `import ... from` is not.
      return /^\s*import\s[^\n]*\sfrom\s+['"]xlsx['"]/m.test(src);
    });
    expect(offenders).toEqual([]);
  });

  /**
   * `csv-import.ts` carries the 400KB xlsx dependency. It is allowed to, because
   * the only thing that imports it is the lazily-loaded modal. The moment an
   * eagerly-rendered screen imports the parser directly, the weight is back and
   * the allowlist entry above would have hidden it.
   */
  it('keeps the shared CSV parser reachable only from the lazy boundary', () => {
    const offenders = appFiles.filter((f) => {
      if (LAZY_BOUNDARY.includes(norm(f))) return false;
      const src = readFileSync(f, 'utf8');
      return /^\s*import\s[^\n]*\sfrom\s+['"]@\/lib\/csv-import['"]/m.test(src);
    });
    expect(offenders).toEqual([]);
  });

  it('reaches export-xlsx only through a dynamic import', () => {
    const offenders = appFiles.filter((f) => {
      const src = readFileSync(f, 'utf8');
      return /^\s*import\s[^\n]*\sfrom\s+['"]@\/lib\/export-xlsx['"]/m.test(src);
    });
    expect(offenders).toEqual([]);
  });

  it('loads CSVImportModal through next/dynamic, not a static import', () => {
    const src = readFileSync(join('src', 'app', 'history', 'page.tsx'), 'utf8');
    expect(src).toMatch(/dynamic\(\s*\(\)\s*=>\s*import\(['"]@\/components\/CSVImportModal['"]\)/);
    expect(src).not.toMatch(/^\s*import\s+CSVImportModal\s+from/m);
  });
});
