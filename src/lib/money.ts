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
