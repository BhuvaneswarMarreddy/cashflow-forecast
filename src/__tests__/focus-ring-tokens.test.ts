/**
 * UI spec colour roles: focus rings come from the theme token, never a literal.
 *
 * The lie this pins: `.input-field` and `.select-field` drew their focus ring in
 * rgba(201,162,78) — the retired gold — so on Paper and on Midnight the ring was a
 * third, off-palette colour that tracked neither theme.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const css = readFileSync(join(process.cwd(), 'src/app/globals.css'), 'utf8');

/** Every rule whose selector has a :focus state and that draws a ring. */
const focusRings = [...css.matchAll(/([^{}]*:focus(?:-visible|-within)?[^{}]*)\{([^}]*)\}/g)]
  .map(([, selector, body]) => ({ selector: selector.trim(), body }))
  .filter(({ body }) => /box-shadow|outline|border-color/.test(body));

describe('focus rings', () => {
  it('exist (the parser still finds them)', () => {
    expect(focusRings.length).toBeGreaterThanOrEqual(3);
  });

  it('never hardcode a colour', () => {
    const literal = focusRings.filter(({ body }) => /#[0-9a-f]{3,8}\b|rgba?\(/i.test(body));
    expect(literal.map((r) => r.selector)).toEqual([]);
  });

  it('draw box-shadow rings as a mix of --accent-primary', () => {
    for (const { selector, body } of focusRings.filter((r) => /box-shadow/.test(r.body))) {
      expect([selector, /color-mix\(in srgb, var\(--accent-primary\) 25%, transparent\)/.test(body)]).toEqual([selector, true]);
    }
  });
});
