/**
 * UI-113 — the radius scale is a contract, and it now holds app-wide.
 *
 * The audit measured 1,824 corners off the three-step scale across 15 surfaces:
 * Tailwind's 4/6/8/12/16/24px steps applied by feel, so a chip and the card
 * holding it disagreed on nearly every screen. The redesign declared 10/16/999
 * and only Home had adopted it.
 *
 * These assertions are on source because the rule is "which name was used".
 * That the names resolve to the right pixels is checked by measurement —
 * scripts/ui-audit.mjs `off-scale-radius`, 1,824 → 0.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();

function tsxFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) tsxFiles(full, acc);
    else if (entry.endsWith('.tsx')) acc.push(full);
  }
  return acc;
}

const files = tsxFiles(join(root, 'src'));

const ALLOWED = new Set(['control', 'card', 'pill']);

/**
 * Every `rounded…` token in a file, judged by its LAST segment — so
 * `rounded-t-card` and `sm:rounded-card` pass while `rounded-t-2xl` and a bare
 * `rounded` do not.
 *
 * A single pattern with an optional side group cannot do this: it backtracks
 * the side to empty and then reads `-t-card` as "not one of ours", which is how
 * the first version of this test flagged an on-contract class.
 */
function offScaleTokens(source: string): string[] {
  const tokens = source.match(/\brounded(?:-[a-z0-9]+)*/g) || [];
  return tokens.filter((t) => !ALLOWED.has(t.split('-').pop()!));
}

describe('UI-113 radius contract', () => {
  test('no component uses a Tailwind radius step', () => {
    const offenders = files
      .map((f) => ({ file: f.replace(`${root}/`, ''), tokens: offScaleTokens(readFileSync(f, 'utf8')) }))
      .filter((r) => r.tokens.length > 0);
    expect(offenders).toEqual([]);
  });

  test('the three names are the only radii declared in globals.css', () => {
    const css = readFileSync(join(root, 'src/app/globals.css'), 'utf8');
    const declared = css.match(/border-radius:\s*([^;]+);/g) || [];
    const rogue = declared.filter((d) => {
      // 50% is a real circle (avatars, dots) and is not a corner radius.
      if (d.includes('50%')) return false;
      return !d.includes('var(--radius-');
    });
    expect(rogue).toEqual([]);
  });

  test('the scale itself is still three steps and no more', () => {
    const css = readFileSync(join(root, 'src/app/globals.css'), 'utf8');
    const theme = css.slice(css.indexOf('@theme {'), css.indexOf('}', css.indexOf('@theme {')));
    const radii = theme.match(/--radius-[a-z]+/g) || [];
    expect(new Set(radii)).toEqual(new Set(['--radius-control', '--radius-card', '--radius-pill']));
  });
});
