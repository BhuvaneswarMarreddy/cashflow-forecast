/**
 * UI-100 shipped a theme-aware `src/app/icon.svg` — and the browser never loaded
 * it. An explicit `metadata.icons` list in layout.tsx overrides Next's file
 * convention, so the tab kept rendering hand-maintained PNGs from a previous
 * release with opaque WHITE corners (measured: corner pixel [255,255,255,255]),
 * which is the exact defect the redesign was meant to kill.
 *
 * The old guard asserted things about icon.svg's source text. That file is not
 * what reaches the browser, so the guard passed while the bug shipped. These
 * tests read the BYTES that are actually served instead.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';

const root = process.cwd();
const layout = readFileSync(join(root, 'src/app/layout.tsx'), 'utf8');

/** Every raster the browser may paint into a tab, bookmark bar, or home screen. */
function shippedRasters(): string[] {
  const faviconDir = join(root, 'public/favicons');
  const favicons = readdirSync(faviconDir)
    .filter((f) => f.endsWith('.png'))
    .map((f) => join(faviconDir, f));

  const logoDir = join(root, 'public/logos');
  const logos = readdirSync(logoDir)
    .filter((f) => /^icon-\d+x\d+\.png$/.test(f))
    .map((f) => join(logoDir, f));

  return [...favicons, ...logos];
}

async function cornerPixel(file: string): Promise<[number, number, number, number]> {
  const { data } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return [data[0], data[1], data[2], data[3]]; // top-left pixel
}

describe('the favicon the browser actually loads', () => {
  test.each(shippedRasters().map((f) => [f.replace(`${root}/`, ''), f]))(
    '%s has no white corner box',
    async (_label, file) => {
      const [r, g, b, a] = await cornerPixel(file);
      const isWhite = a > 0 && r > 240 && g > 240 && b > 240;
      expect(isWhite).toBe(false);
    }
  );

  test.each(shippedRasters().map((f) => [f.replace(`${root}/`, ''), f]))(
    '%s corner is the Midnight ground, fully opaque',
    async (_label, file) => {
      const [r, g, b, a] = await cornerPixel(file);
      // #101014 — the same ground the SVG paints on a dark tab bar. Opaque, so
      // no host background can bleed through the rounded corner.
      expect([r, g, b]).toEqual([16, 16, 20]);
      expect(a).toBe(255);
    }
  );

  test('the theme-aware SVG is actually referenced, not just present on disk', () => {
    // The original defect in one line: icon.svg existed, was tested, and was
    // never linked. Presence is not shipping.
    expect(layout).toContain('/icon.svg');
  });

  test('a raster fallback is still offered for browsers without SVG favicons', () => {
    expect(layout).toContain('/favicon.ico');
  });

  test('layout.tsx does not hand-maintain a versioned PNG list', () => {
    // This list is what silently overrode icon.svg and went stale. The file
    // convention (src/app/icon.svg + src/app/favicon.ico) is self-updating.
    expect(layout).not.toMatch(/favicons\/favicon-\d+x\d+\.png/);
  });

  test('browser chrome is painted with the shipped palette, not the retired one', () => {
    expect(layout).toContain('#101014'); // Midnight ground
    expect(layout).toContain('#FAF7EF'); // Paper ground
    expect(layout).not.toContain('#14161a'); // retired Ink
    expect(layout).not.toContain('#f6f3ec'); // retired Paper
  });
});
