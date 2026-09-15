/**
 * #198 — Forecast answers only "Will I be OK?": Plan and Month.
 *
 * The lies these pin: a third "Bills" tab and a "Timeline" tab beside a nine-panel
 * "More tools" drawer (a magazine, not an answer); and a "Money lasts" card that
 * printed `{runwayMonths} mo` even when no spending had been measured, a number
 * standing in for "unknown".
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const source = readFileSync(join(process.cwd(), 'src/app/forecast/page.tsx'), 'utf8');
const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '');
const at = (needle: string) => {
  const i = code.indexOf(needle);
  expect([needle, i >= 0]).toEqual([needle, true]);
  return i;
};

describe('Forecast is Plan + Month (#198)', () => {
  it('has exactly two tabs, Plan and Month', () => {
    expect(code).toContain("[['plan', 'Plan'], ['month', 'Month']]");
    expect(code).not.toMatch(/'Timeline'|'Cashflow' :|: 'Bills'/);
  });

  it('keeps every old address working: ?tab=cashflow is Month, ?tab=bills is the bills editor', () => {
    expect(code).toContain("t === 'cashflow' ? 'month' : t === 'bills' ? 'bills' : 'plan'");
    expect(code).toContain("switchView('bills')");
    expect(code).toContain('Edit bills');
  });

  it('puts "Can I afford this?" directly under the one chart', () => {
    const chart = at('<ForecastChart');
    const decision = at('<DecisionCheckPanel');
    expect(decision).toBeGreaterThan(chart);
    const between = code.slice(chart + '<ForecastChart'.length, decision);
    expect(between).not.toMatch(/<[A-Z][A-Za-z]+/);
  });

  it('collapses every other panel into one Assumptions disclosure, after Outflows', () => {
    const outflows = at('Outflows');
    const details = at('<details');
    expect(details).toBeGreaterThan(outflows);
    for (const panel of ['<AssumptionsPanel', '<EmergencyFundPanel', '<SavingsGoalsPanel', '<BudgetStatusPanel', '<AIInsightsPanel', '<AIQuestionPanel', '<ForecastTimeline', '<RunwayCalculator']) {
      expect([panel, at(panel) > details]).toEqual([panel, true]);
    }
    expect(code.match(/<details/g)).toHaveLength(1);
  });

  it('never prints a runway number when none was measured', () => {
    expect(code).not.toMatch(/runwayMonths\}\s*mo/);
    expect(code).toMatch(/runway\.hasBurn \?/);
    expect(code).toContain("Runway isn&apos;t measured yet");
  });

  it('sits on the reading measure with theme tokens only', () => {
    expect(code).toContain('max-w-content');
    expect(code).not.toContain('max-w-7xl');
    expect(code).not.toMatch(/\b(?:text|bg|border)-(?:emerald|green|red|amber)-\d{3}\b/);
  });
});
