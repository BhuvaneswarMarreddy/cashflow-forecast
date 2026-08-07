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

/** All four corners — a mask can go wrong on one corner and look fine on another. */
async function cornerPixels(file: string): Promise<[number, number, number, number][]> {
  const { data, info } = await sharp(file)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const { width: w, height: h, channels: c } = info;
  const at = (x: number, y: number): [number, number, number, number] => {
    const i = (y * w + x) * c;
    return [data[i], data[i + 1], data[i + 2], data[i + 3]];
  };
  return [at(0, 0), at(w - 1, 0), at(0, h - 1), at(w - 1, h - 1)];
}

describe('the favicon the browser actually loads', () => {
  test.each(shippedRasters().map((f) => [f.replace(`${root}/`, ''), f]))(
    '%s has no white corner box',
    async (_label, file) => {
      const white = (await cornerPixels(file)).filter(
        ([r, g, b, a]) => a > 0 && r > 240 && g > 240 && b > 240
      );
      expect(white).toEqual([]);
    }
  );

  test.each(shippedRasters().map((f) => [f.replace(`${root}/`, ''), f]))(
    '%s corners are all the Midnight ground, fully opaque',
    async (_label, file) => {
      // #101014 — the same ground the SVG paints on a dark tab bar. Opaque, so
      // no host background can bleed through a rounded corner.
      const ink: [number, number, number, number] = [16, 16, 20, 255];
      expect(await cornerPixels(file)).toEqual([ink, ink, ink, ink]);
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
