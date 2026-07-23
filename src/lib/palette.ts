// Shared chart palette. CAT_COLORS order is load-bearing (fixed assignment).
export const CAT_COLORS = ['#7c3aed', '#06b6d4', '#f59e0b', '#ec4899', '#8b5cf6', '#14b8a6', '#f97316', '#6366f1'];

export type FlowColorKey =
  | 'source' | 'bank' | 'card' | 'loan' | 'person' | 'category' | 'hub' | 'stub' | 'warning';

// One hue per node KIND, assigned fixed — never cycled. The six identity hues pass
// the dataviz CVD validator in BOTH modes (light+dark, all checks). hub/stub is a
// deliberate neutral (de-emphasis role, not an identity slot) and 'warning' is the
// reserved status red — both always render with a visible text label / ⚠ glyph.
export const FLOW_COLORS: Record<FlowColorKey, string> = {
  source: '#0d9488',
  bank: '#2563eb',
  card: '#d97706',
  person: '#db2777',
  loan: '#7c3aed',
  category: '#65a30d',
  hub: '#64748b',
  stub: '#64748b',
  warning: '#dc2626',
};
