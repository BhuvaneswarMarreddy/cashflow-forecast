/**
 * The one money formatter (D2: honor profile.currency). USD keeps the app's
 * existing look ($1,234); INR renders ₹ with en-IN grouping (₹1,00,000).
 */
export function formatMoney(n: number, currency: string = 'USD', fractionDigits: 0 | 2 = 0): string {
  return new Intl.NumberFormat(currency === 'INR' ? 'en-IN' : 'en-US', {
    style: 'currency',
    currency,
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  }).format(n);
}

/** Integer-cents variant (flow engine, AccountDetailModal). Always 2 decimals. */
export const formatMoneyCents = (cents: number, currency: string = 'USD') =>
  formatMoney(cents / 100, currency, 2);

/**
 * One month of income from a set of sources — THE income-frequency math, in one
 * place. This formula was once hand-copied on five pages and drifted: biweekly is
 * 26 paychecks a year, not 24, and the naive *2 understated a $4,340 paycheck by
 * ~$723/month while the AI panels reasoned from a different figure than the tile.
 * Callers pass ACTIVE sources only — a paused source is not money arriving.
 */
export const monthlyIncomeOf = (
  sources: ReadonlyArray<{ amount: number; frequency: 'weekly' | 'biweekly' | 'monthly' | 'yearly' }>
): number =>
  sources.reduce((sum, s) =>
    sum + (s.frequency === 'yearly' ? s.amount / 12
      : s.frequency === 'biweekly' ? (s.amount * 26) / 12
      : s.frequency === 'weekly' ? (s.amount * 52) / 12
      : s.amount), 0);
