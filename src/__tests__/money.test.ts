import { formatMoney, formatMoneyCents } from '@/lib/money';

describe('formatMoney', () => {
  it('formats USD with no decimals by default (matches existing app look)', () => {
    expect(formatMoney(1234.56)).toBe('$1,235');
    expect(formatMoney(-500)).toBe('-$500');
  });

  it('formats INR with the rupee symbol and en-IN lakh grouping', () => {
    expect(formatMoney(100000, 'INR')).toBe('₹1,00,000');
  });

  it('cents variant keeps 2 decimals', () => {
    expect(formatMoneyCents(123456)).toBe('$1,234.56');
    expect(formatMoneyCents(123456, 'INR')).toBe('₹1,234.56');
  });

  // #29 regression guard: Navbar/dashboard used formatMoney(Math.abs(x)) with
  // red-vs-green as the only carrier of sign — negative money read as positive.
  // The fix passes raw values through, so the minus MUST survive formatting.
  it('negative amounts carry a visible minus at 2 decimals (#29)', () => {
    expect(formatMoney(-412, 'USD', 2)).toBe('-$412.00');
    expect(formatMoney(-2145, 'USD', 2)).toBe('-$2,145.00');
  });
});
