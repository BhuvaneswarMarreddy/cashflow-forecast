/**
 * UI-112 — the Home screen's SHAPE contract, pinned so the next edit cannot
 * quietly reintroduce what the audit removed.
 *
 * Home was the screen the owner actually looks at, and it had drifted furthest:
 * money amounts wearing --accent-danger/--accent-success instead of the semantic
 * money tokens, per-card brand hues injected through inline `style`, a hardcoded
 * #16181c, five different radii, and a full-width layout that pushed a row's
 * merchant and its amount a foot apart on desktop.
 *
 * These assertions read the SOURCE, which is legitimate here because every rule
 * below is about which token a value comes from — something only the source can
 * answer. The rendered result is checked separately by the screenshot pass.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const source = readFileSync(join(root, 'src/app/dashboard/page.tsx'), 'utf8');
const css = readFileSync(join(root, 'src/app/globals.css'), 'utf8');

/** Source with block and line comments removed — rules describe code, not prose. */
const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('UI-112 Home — colour comes only from tokens', () => {
  test('no hardcoded hex anywhere in the markup', () => {
    // `bg-[#16181c]` on the segmented control was the last one: a near-black that
    // did not track the theme, so it stayed near-black on paper.
    expect(code.match(/#[0-9a-fA-F]{3,8}\b/g)).toBeNull();
  });

  test('money wears the semantic money tokens, never the generic accents', () => {
    // --accent-danger/--accent-success still exist for non-money states; using
    // them for amounts is how the list drifted off the validated palette.
    expect(code).not.toContain('--accent-danger');
    expect(code).not.toContain('--accent-success');
    expect(code).toContain('--money-out');
    expect(code).toContain('--money-in');
  });

  test('no per-entity colour is injected through inline style', () => {
    // `style={{ color: paymentMethod?.color }}` and `backgroundColor: bill.color`
    // put six brand hues on a screen budgeted for four.
    expect(code).not.toMatch(/style=\{\{[^}]*[Cc]olor:/);
  });

  test('no gradient utilities — the palette is flat', () => {
    expect(code).not.toMatch(/bg-gradient-to-/);
  });
});

describe('UI-112 Home — one radius scale', () => {
  test('the three radii are declared where Tailwind can actually see them', () => {
    // In a plain :root these are stripped: Tailwind owns --radius-* and
    // --container-*, the utility still compiles, var() resolves to nothing, and
    // every corner silently goes square. @theme is what makes them real.
    const theme = css.slice(css.indexOf('@theme {'));
    for (const token of ['--radius-control', '--radius-card', '--radius-pill', '--container-content']) {
      expect(theme).toContain(token);
    }
  });

  test('markup uses only the three named radii', () => {
    const rogue = code.match(/\brounded-(?:sm|md|lg|xl|2xl|3xl|none)\b/g);
    expect(rogue).toBeNull();
  });

  test('rounded-full is spelled rounded-pill so the scale has one name per step', () => {
    expect(code).not.toMatch(/\brounded-full\b/);
  });
});

describe('UI-112 Home — layout', () => {
  test('content stops at the reading measure instead of stretching to the viewport', () => {
    expect(code).toContain('max-w-content');
    expect(code).not.toMatch(/max-w-7xl/);
  });

  test('raw bank descriptions are put through the display formatter', () => {
    // Rendering the feed verbatim gave the owner a column of shouting capitals.
    expect(code).toContain('displayName(txn.title)');
  });

  test('the full description survives in a title attribute', () => {
    // A reference blob is the only handle on a mystery charge; truncating it in
    // the DOM as well as on screen would lose it.
    expect(code).toMatch(/title=\{txn\.title\}/);
  });
});

describe('UI-112 Home — the hero tells the truth', () => {
  test('renders nothing rather than inventing a runway with no burn measured', () => {
    expect(code).toContain('home.hasBurn');
  });

  test('discloses how many accounts the number is counting', () => {
    // The hero stated a hard figure while several banks were unlinked, and never
    // said what it had counted.
    expect(code).toMatch(/Counting \{derivedAccounts\.length\}|derivedAccounts\.length\} linked account/);
  });

  test('leads with the readable runway unit, not a raw decimal of a month', () => {
    expect(code).toContain('runwayLabel(home)');
  });

  test('names the next reachable goal, not just a completion percentage', () => {
    expect(code).toContain('home.amountToNextMonth');
  });
});
