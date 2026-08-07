/**
 * UI-100 — the design-system foundation is a CONTRACT, pinned here so a future
 * edit can't quietly reintroduce the rainbow. The validated palette (see
 * DESIGN-IS-2026-08-07/ and the pitch) is machine-checked for colorblind
 * separation; these hexes are load-bearing, not aesthetic preferences.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const css = readFileSync(join(process.cwd(), 'src/app/globals.css'), 'utf8');
const icon = readFileSync(join(process.cwd(), 'src/app/icon.svg'), 'utf8');

describe('UI-100 design tokens', () => {
  test('Midnight Ledger dark neutrals are the ground', () => {
    expect(css).toContain('#101014'); // background
    expect(css).toContain('#1A1A20'); // card
    expect(css).toContain('#F2EFE6'); // ink
  });

  test('Paper & Gold light neutrals are the ground', () => {
    expect(css).toContain('#FAF7EF'); // paper
    expect(css).toContain('#F0EBDD'); // tertiary
  });

  test('semantic money tokens exist — teal in, red out, gold progress', () => {
    for (const token of ['--money-in', '--money-out', '--progress']) {
      expect(css).toContain(token);
    }
    expect(css).toContain('#1FA2A8'); // dark teal (validated)
    expect(css).toContain('#E5484D'); // dark red (validated)
    expect(css).toContain('#00987F'); // light teal (validated)
  });

  test('chart mark tokens exist and use the validated trio', () => {
    for (const token of ['--chart-progress', '--chart-in', '--chart-out']) {
      expect(css).toContain(token);
    }
    expect(css.toLowerCase()).toContain('#c98500'); // dark chart gold (validated)
    expect(css.toLowerCase()).toContain('#eda100'); // light chart gold (validated)
  });

  test('the old green/red pair (deutan ΔE 2.4 — colorblind-unsafe) is gone', () => {
    expect(css).not.toContain('#34d399');
    expect(css).not.toContain('#f87171');
    expect(css).not.toContain('#157f5f');
    expect(css).not.toContain('#cf3a41');
  });

  test('display serif stack exists for hero numbers', () => {
    expect(css).toContain('--font-display');
    expect(css).toMatch(/Iowan Old Style|Palatino/);
  });
});

describe('UI-100 favicon', () => {
  test('icon paints its own full-bleed ground — no transparent corners', () => {
    expect(icon).toContain('<rect'); // background rect, not a floating coin
  });
  test('icon is theme-aware via an embedded media query', () => {
    expect(icon).toContain('prefers-color-scheme');
  });
});
