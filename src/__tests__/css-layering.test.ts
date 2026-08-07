/**
 * Unlayered CSS beats every layered rule regardless of specificity, and Tailwind
 * ships its utilities in `@layer utilities`. So any component class declared
 * outside a layer silently defeats the utilities the markup combines it with —
 * the class list compiles, the utility applies nothing, and nothing errors.
 *
 * That is how `className="input-field pl-[3.5rem]"` rendered with 14px of left
 * padding and put the `$` icon on top of the value, in 36 inputs across 8 files.
 * It survived review twice because the markup is correct; only the cascade is
 * wrong, and only at paint time.
 *
 * The previous attempt to fix it hand-wrote `.input-field.pl-12` overrides,
 * which is why the login form looked right and every field using any other
 * padding value did not — and why the mobile block needed the same patch again.
 *
 * Measured by scripts/ui-audit.mjs (`input-overlap`: 8 → 0).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Comments are prose about the rules, not rules. Without stripping them, this
// file's own explanation of the bug counts as the bug.
const css = readFileSync(join(process.cwd(), 'src/app/globals.css'), 'utf8').replace(
  /\/\*[\s\S]*?\*\//g,
  ''
);

/** Splits the sheet into what sits inside `@layer components` and what does not. */
function splitByComponentLayer(source: string): { inside: string; outside: string } {
  const re = /@layer\s+components\s*\{/g;
  const inside: string[] = [];
  const outside: string[] = [];
  let cursor = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source))) {
    outside.push(source.slice(cursor, m.index));
    let depth = 1;
    let i = m.index + m[0].length;
    const start = i;
    while (i < source.length && depth > 0) {
      if (source[i] === '{') depth++;
      else if (source[i] === '}') depth--;
      i++;
    }
    inside.push(source.slice(start, i - 1));
    cursor = i;
    re.lastIndex = i;
  }
  outside.push(source.slice(cursor));
  return { inside: inside.join('\n'), outside: outside.join('\n') };
}

const { inside: layered, outside: unlayered } = splitByComponentLayer(css);

describe('component classes that markup overrides with utilities are layered', () => {
  test('there is at least one @layer components block', () => {
    expect(layered.length).toBeGreaterThan(0);
  });

  test.each([
    ['.input-field base', /^\s*\.input-field\s*\{/m],
    ['.input-field responsive override', /\.input-field,\s*\n\s*\.select-field\s*\{/],
    ['.select-field base', /^\s*\.select-field\s*\{/m],
  ])('%s is inside @layer components, not floating unlayered', (_label, pattern) => {
    expect(layered).toMatch(pattern); // present in the layer…
    expect(unlayered).not.toMatch(pattern); // …and nowhere outside it
  });

  test('no hand-written per-utility padding overrides remain', () => {
    // `.input-field.pl-12 { padding-left: … }` patches one Tailwind value and
    // leaves every other one broken. Layering makes them all work; these must
    // not creep back in as a "fix" for the next reported field.
    expect(css).not.toMatch(/\.(input|select)-field\.(pl|pr|px|py|p)-\d/);
  });

  test('the responsive block sets padding longhands, not the shorthand', () => {
    // `padding: 12px 14px` inside a layer is still a shorthand: it resets all
    // four sides, so a same-layer horizontal utility can lose to source order.
    // Longhands keep the vertical rhythm without touching the horizontal axis.
    const mobile = layered.match(/\.input-field,\s*\n\s*\.select-field\s*\{[^}]*\}/);
    expect(mobile).not.toBeNull();
    expect(mobile![0]).not.toMatch(/^\s*padding:/m);
    expect(mobile![0]).toMatch(/padding-block/);
  });
});
