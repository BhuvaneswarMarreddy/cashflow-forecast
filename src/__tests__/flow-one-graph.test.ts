/**
 * #199 — Flow is the picture of the same past as Activity: one graph, one inbox.
 *
 * The lies these pin: on a phone the diagram hid behind "Show the diagram" (the page's
 * whole point, opt-in), a "detailed" choice remembered from desktop rendered the full
 * graph on 390px, and a second chart plus three tables competed with the Sankey.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const source = readFileSync(join(process.cwd(), 'src/app/flow/page.tsx'), 'utf8');

describe('Flow — one graph (#199)', () => {
  it('says what it is and links to the list', () => {
    expect(source).toContain('same cents as Activity');
    expect(source).toMatch(/href="\/history"[\s\S]{0,300}View as list/);
  });

  it('shows the diagram on a phone — no opt-in button', () => {
    expect(source).not.toContain('Show the diagram');
    expect(source).not.toContain("hidden sm:block'");
  });

  it('draws the Simple graph on a phone; Full detail is md and up', () => {
    expect(source).toContain("window.matchMedia('(max-width: 767px)').matches");
    expect(source).toMatch(/aria-label="Detail level" className="hidden md:flex/);
    expect(source).toContain("'Full detail'");
  });

  it('secondary views sit behind one segmented control, default Flow, including Pace', () => {
    expect(source).toMatch(/role="group" aria-label="Chart type"/);
    expect(source).toContain("{ key: 'pace', label: 'Pace' }");
    expect(source).toContain("return CHART_KINDS.some((c) => c.key === saved) ? (saved as ChartKind) : 'sankey';");
  });

  it('keeps every table and the projection, collapsed into one disclosure the Reconcile alert opens', () => {
    const details = source.indexOf('<details\n          open={moreOpen}');
    expect(details).toBeGreaterThan(0);
    for (const heading of ['Does it add up?', 'Between your accounts', 'Recurring payments', 'At this rate']) {
      expect([heading, source.indexOf(heading, details) > details]).toEqual([heading, true]);
    }
    expect(source).toContain('setMoreOpen(true)');
  });

  it('discloses unanchored accounts above the picture, and the projection line wears a token', () => {
    expect(source.indexOf('<UnanchoredNote accounts={accounts} />')).toBeLessThan(source.indexOf("chart === 'pace' ? ("));
    expect(source).not.toContain('#b08d3f');
  });
});
