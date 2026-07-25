// Shared chart palette — Ink & Gold theme. Both sets are gold-anchored and
// pass the dataviz CVD validator (adjacent-pair separation, light + dark).

// Categorical fixed-order set for category breakdowns. Gold is the hero; the
// remaining hues are harmonious and adjacent-CVD-distinct. Assigned in order,
// never cycled. Validated: node scripts/validate_palette.js in both modes.
export const CAT_COLORS = ['#b08d3f', '#0d9488', '#b45309', '#7c3aed', '#4d7c0f', '#0369a1', '#be185d', '#0891b2'];

export type FlowColorKey =
  | 'source' | 'bank' | 'card' | 'loan' | 'person' | 'category' | 'hub' | 'stub' | 'warning';

// One hue per node KIND, assigned fixed — never cycled. Gold is the brand hero
// (banks); every other identity hue is kept clearly off-gold so no two kinds
// collide. hub/stub are a deliberate neutral (de-emphasis, not an identity slot);
// 'warning' is the reserved status red — both always carry a visible text label.
export const FLOW_COLORS: Record<FlowColorKey, string> = {
  source: '#0d9488',
  bank: '#b08d3f',
  card: '#be185d',
  loan: '#7c3aed',
  person: '#0369a1',
  category: '#4d7c0f',
  hub: '#64748b',
  stub: '#64748b',
  warning: '#dc2626',
};
