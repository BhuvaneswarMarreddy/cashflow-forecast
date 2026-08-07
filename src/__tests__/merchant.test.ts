import { displayName } from '@/lib/merchant';

describe('displayName', () => {
  test('stops raw bank feeds from shouting', () => {
    expect(displayName('KEEP THE CHANGE CREDIT FROM ACCT2126')).toBe(
      'Keep The Change Credit From Acct2126'
    );
  });

  test('leaves text a human wrote completely alone', () => {
    expect(displayName('Royal Biryani')).toBe('Royal Biryani');
    expect(displayName('On Inc')).toBe('On Inc');
    expect(displayName('Cinemark Theatres')).toBe('Cinemark Theatres');
  });

  test('keeps reference numbers and dates verbatim — they are the only ID there is', () => {
    expect(displayName('PURCHASE 08/06 2C8MUM4AIHQ0CZN +XXXXX249889 WY')).toBe(
      'Purchase 08/06 2C8MUM4AIHQ0CZN +XXXXX249889 WY'
    );
  });

  test('preserves acronyms and state codes rather than making them look like typos', () => {
    expect(displayName('ACH DEBIT FROM BOFA WY')).toBe('ACH Debit From Bofa WY');
  });

  test('collapses stray whitespace', () => {
    expect(displayName('  VERIZON   WIRELESS  ')).toBe('Verizon Wireless');
  });

  test('survives missing input', () => {
    expect(displayName(undefined)).toBe('');
    expect(displayName(null)).toBe('');
    expect(displayName('')).toBe('');
  });

  test('a short all-caps name is left alone rather than mangled', () => {
    expect(displayName('IKEA')).toBe('Ikea');
    expect(displayName('HEB')).toBe('HEB'); // no vowel, ≤3 chars: an acronym
  });
});
