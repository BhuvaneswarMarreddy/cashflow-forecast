/**
 * Flow-graph math for the /flow page. Everything here is integer CENTS —
 * dollars exist only at the render layer. Pure functions, no React.
 */
import { PaymentAccount, Transaction } from '@/types';
import { isPositive } from './classify';

export const toCents = (n: number) => Math.round(n * 100);
export const day = (iso: string) => iso.slice(0, 10);

export const isDebtAccount = (a?: PaymentAccount) =>
  a?.type === 'credit_card' || a?.type === 'personal_loan';

export const signedRealNowCents = (a: PaymentAccount) =>
  isDebtAccount(a) ? -toCents(a.balance) : toCents(a.balance);

export const signedCents = (t: Transaction, accounts: PaymentAccount[]) =>
  (isPositive(t, accounts) ? 1 : -1) * toCents(t.amount);

/** Account balance at the END of `endDay`, rolled back from the user-entered balance. */
export function balanceAtEndOfDay(
  a: PaymentAccount, transactions: Transaction[], accounts: PaymentAccount[], endDay: string
): number {
  let later = 0;
  for (const t of transactions) {
    if (t.accountId === a.id && day(t.date) > endDay) later += signedCents(t, accounts);
  }
  return signedRealNowCents(a) - later;
}

// --- person extraction (statement shapes discovered in the real CSVs) ---
const REMITLY = /rmtly|remitly/i;
// bac\w{5,}: Chase glues a BACxxxx confirmation token straight after the name.
const ZELLE = /zelle\s+(?:payment\s+|transfer\s+)?(?:to|from)[:\s]+([a-z .'’-]+?)(?=\s+(?:conf|jpm|bac\w{5,}|for\b|\d)|;|$)/i;
const BOFA_ALT = /zelle transfer conf# \w+;\s*(.+)$/i;

export function personFrom(text: string | undefined): string | null {
  if (!text) return null;
  if (REMITLY.test(text)) return 'REMITLY';
  const m = ZELLE.exec(text) ?? BOFA_ALT.exec(text);
  if (!m) return null;
  let name = m[1]
    .replace(/\s*for\s*".*$/i, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.;'-]+$/, '')
    .trim()
    .toUpperCase();
  const parts = name.split(' ').filter(Boolean);
  if (parts.length >= 3) name = `${parts[0]} ${parts[parts.length - 1]}`;
  return name || null;
}

export const isSelfPerson = (name: string) =>
  /BHUVANESWAR|MARREDDY/.test(name) || name === 'ME';

export const displayPerson = (name: string) =>
  name === 'REMITLY'
    ? 'Sent to India (Remitly)'
    : name.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
