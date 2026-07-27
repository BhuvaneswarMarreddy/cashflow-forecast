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
});
