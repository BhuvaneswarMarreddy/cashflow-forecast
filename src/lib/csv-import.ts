/**
 * The CSV importer's parsing layer — pure, and shared.
 *
 * Extracted out of `CSVImportModal.tsx` so that the browser and the
 * `importCsv` Cloud Function run the SAME parser. A second implementation for
 * the mobile client would mean two ledgers built from one file, and the sign
 * conventions alone (Amex and Discover post charges POSITIVE, the opposite of
 * Monarch, Chase and Mint) are not something to get right twice.
 *
 * Nothing here touches React, Firestore or component state. `parseCsv` returns
 * its fatal error rather than setting one, because a Cloud Function has no
 * state to set.
 *
 * `CSV_GROUND_TRUTH.md` pins the behaviour of this file. If a number in there
 * moves, this is the code that moved it.
 */
import * as XLSX from 'xlsx';
import { format as formatDate } from 'date-fns';

import {
  TransactionType,
  TransferDirection,
  ExpenseCategory,
  PaymentMethod,
  AccountType,
  PaymentAccount,
  getMerchantColor,
} from '@/types';

/** Sentinel account-map value meaning "create a new account for this CSV label". */
export const CREATE_ACCOUNT = '__create__';

/**
 * The spec's enrichment source. Every file that comes through the importer is
 * the manual CSV path regardless of which bank exported it — the distinction
 * that matters downstream is "carries categories" vs "raw bank feed".
 */
export const CSV_SOURCE = 'monarch';

export interface ParsedTransaction {
  id: string; // deterministic — see importKey()
  date: string;
  title: string;
  amount: number;
  type: TransactionType;
  transferDirection?: TransferDirection;
  category: ExpenseCategory;
  sourceCategory?: string;
  paymentMethod: PaymentMethod;
  description?: string;
  merchant?: string; // Store/merchant name
  csvAccount: string; // raw Account cell, e.g. "USAA SECURE MAIN CHECKING (...4156)"
  isValid: boolean;
  errors: string[];
}


export interface ParseResult {
  rows: ParsedTransaction[];
  /** Set only when the file is unusable; `rows` is empty when it is. */
  error: string | null;
}

/**
 * Builds a PaymentAccount from a CSV "Account" label like
 * "Customized Cash Rewards Visa Signature (...3572)". Type matters most: a bank
 * account is cash and a card is debt, and the forecast and the "a card payment is
 * not income" rule both hinge on it. Balance is 0 — the CSV has no balance column,
 * so the user sets it once to unlock forecasts.
 */
export function inferAccountFromCsv(csvName: string): Omit<PaymentAccount, 'id'> {
  const lower = csvName.toLowerCase();
  const lastFourDigits = csvName.match(/(\d{4})\D*$/)?.[1];
  const name = csvName.replace(/\s*\(\.*\d{4}\)\s*$/, '').trim() || csvName;
  const type = inferAccountType(csvName);
  const provider: PaymentMethod =
    /visa/.test(lower) ? 'visa' :
    /master/.test(lower) ? 'mastercard' :
    /amex|american express|blue cash/.test(lower) ? 'amex' :
    /discover/.test(lower) ? 'discover' :
    /apple/.test(lower) ? 'apple' :
    /chase/.test(lower) ? 'chase' :
    type === 'credit_card' ? 'other' : 'bank-transfer';
  // #83: NO openingDate. Nobody told us this account's balance, so there is no anchor —
  // stamping today's date would exclude every row in the file being imported.
  return { name, type, provider, openingBalance: 0, lastFourDigits, color: getMerchantColor(csvName), isActive: true };
}

export function inferAccountType(csvName: string): AccountType {
  const lower = csvName.toLowerCase();
  // Bank wins first: "Customized Cash Rewards Visa" must not beat "...Checking".
  if (/checking|savings|banking|debit/.test(lower)) return 'bank_account';
  if (/card|visa|mastercard|amex|american express|discover|credit|rewards|preferred|signature|blue cash/.test(lower)) return 'credit_card';
  return 'bank_account';
}

interface CSVImportModalProps {
  isOpen: boolean;
  onClose: () => void;
}


/**
 * Stable identity for an imported row, used directly as the Firestore document id so
 * that re-importing Monarch's cumulative export overwrites rather than duplicates.
 *
 * Deliberately excludes type/category/title: those are the output of the heuristics
 * below, so keying on them would re-import the world as duplicates every time a rule
 * changes. `occurrence` separates genuinely identical rows (two $3.50 coffees, same
 * merchant, same day) — it is content-keyed, not position-keyed, so it stays stable
 * across overlapping exports.
 */
export function importKey(
  dateKey: string,
  signedAmount: number,
  account: string,
  statement: string,
  occurrence: number
): string {
  const material = [
    dateKey,
    signedAmount.toFixed(2), // 85.5 and 85.50 must not diverge
    // Last four digits survive an account rename or a re-link; the full display name
    // does not, and a rename would otherwise re-key the user's entire history.
    // ponytail: last-4 could collide across institutions; add the first token if it bites.
    account.match(/(\d{4})\D*$/)?.[1] ?? account.trim().toLowerCase(),
    statement.trim().toLowerCase().replace(/\s+/g, ' '),
    occurrence,
  ].join('|');
  // encodeURIComponent escapes '/', which is the only character Firestore forbids in a
  // document id. Bijective, so unlike a hash it has no collision probability at all.
  return `imp_${encodeURIComponent(material)}`;
}

/**
 * Whether a source category names internal movement between the user's own accounts.
 * Monarch writes exactly "Transfer" or "Credit Card Payment"; matching is exact so
 * that "Transfer Fee", a genuine expense, is not swallowed.
 */
export function isTransferCategory(category: string): boolean {
  const lower = category.trim().toLowerCase();
  return lower === 'transfer' || lower === 'credit card payment';
}

/**
 * Whether a signed CSV amount represents money LEAVING the account.
 *
 * Amex and Discover export charges as positive and payments as negative — the
 * opposite of Monarch, Chase, Mint and everyone else. Assuming one universal
 * convention books an entire card statement as income.
 */
/**
 * Which bank/issuer wrote this file. ONE definition, exported so the tests
 * exercise the real rules — a private copy in the test file drifted from this
 * one the moment a new issuer was added.
 */
export function detectFormat(headers: string[]): string {
  const headerStr = headers.join(',').toLowerCase();
  
  // Apple's export is identified by two headers nobody else writes together.
  if (headerStr.includes('clearing date') || headerStr.includes('amount (usd)')) {
    return 'apple';
  }
  if (headerStr.includes('principal') && headerStr.includes('interest') && headerStr.includes('balance')) {
    return 'upstart';
  }
  // Debit+Credit columns before the date rules: Capital One writes them and
  // Discover never does, so this is the stronger signal. Checked second, a
  // Capital One export whose first column reads "Trans. Date" was read as
  // Discover — and Discover's parser has no debit/credit pair to read.
  if (headerStr.includes('card no') || (headerStr.includes('debit') && headerStr.includes('credit'))) {
    return 'capital_one';
  }
  if (headerStr.includes('trans. date') || headerStr.includes('trans date')) {
    return 'discover';
  }
  // "Post Date" and "Posted Date" are both Chase, depending on the product; the
  // second spelling used to fall through to the generic reader.
  if ((headerStr.includes('post date') || headerStr.includes('posted date'))
      && headerStr.includes('transaction date')) {
    return 'chase';
  }
  if (headerStr.includes('appears on your statement')) {
    return 'amex';
  }
  if (headerStr.includes('reference number') && headerStr.includes('payee')) {
    return 'bofa';
  }
  if (headerStr.includes('merchant') && headerStr.includes('account')) {
    return 'monarch';
  }
  if (headerStr.includes('original description')) {
    return 'mint';
  }
  return 'generic';
}

export function isOutflow(format: string, signedAmount: number): boolean {
  const chargesArePositive = CHARGES_POSITIVE.has(format);
  return chargesArePositive ? signedAmount > 0 : signedAmount < 0;
}

/**
 * Card issuers that export a PURCHASE as a positive number and a payment as a
 * negative one — the opposite of Monarch, Chase, Mint and every bank export.
 * Apple Card and Synchrony (Amazon Store Card) follow the card convention, so
 * they belong here; getting this wrong books a whole statement as income.
 */
const CHARGES_POSITIVE = new Set(['amex', 'discover', 'apple', 'synchrony']);

/** Parses a money cell without trusting it. Returns null when the cell is not money. */
export function parseAmount(raw: string): number | null {
  const cleaned = raw
    .replace(/[−–—]/g, '-') // unicode minus / en / em dash
    .replace(/[^\d.\-()]/g, ''); // strip $, €, thousands separators, spaces
  if (!cleaned || !/\d/.test(cleaned)) return null;
  const negative = /^\(.*\)$/.test(cleaned) || cleaned.includes('-'); // (58.12) is accounting for -58.12
  // Number() not parseFloat(): parseFloat('12abc') silently returns 12.
  const value = Number(cleaned.replace(/[()\-]/g, ''));
  if (!Number.isFinite(value)) return null;
  return negative ? -value : value;
}

// Common CSV formats from different banks/apps
const SUPPORTED_FORMATS = [
  { name: 'Monarch', columns: ['Date', 'Merchant', 'Category', 'Account', 'Amount', 'Notes'] },
  { name: 'Mint', columns: ['Date', 'Description', 'Original Description', 'Amount', 'Transaction Type', 'Category', 'Account Name'] },
  { name: 'Upstart', columns: ['Date', 'Description', 'Amount', 'Principal', 'Interest', 'Balance'] },
  { name: 'Chase', columns: ['Transaction Date', 'Post Date', 'Description', 'Category', 'Type', 'Amount'] },
  { name: 'Capital One', columns: ['Transaction Date', 'Posted Date', 'Card No.', 'Description', 'Category', 'Debit', 'Credit'] },
  { name: 'American Express', columns: ['Date', 'Description', 'Amount', 'Extended Details', 'Appears On Your Statement As'] },
  { name: 'Bank of America', columns: ['Posted Date', 'Reference Number', 'Payee', 'Address', 'Amount'] },
  { name: 'Discover', columns: ['Trans. Date', 'Post Date', 'Description', 'Amount', 'Category'] },
  // Wallet -> Card Balance -> Statements -> Export Transactions. The ONLY machine
  // -readable export Apple offers; no aggregator on earth reaches this card.
  { name: 'Apple Card', columns: ['Transaction Date', 'Clearing Date', 'Description', 'Merchant', 'Category', 'Type', 'Amount (USD)'] },
  // Synchrony issues the Amazon Store Card; its Plaid integration is unreliable,
  // so the downloaded activity file is the dependable path.
  { name: 'Synchrony / Amazon Store Card', columns: ['Date', 'Description', 'Type', 'Amount'] },
  { name: 'Generic', columns: ['Date', 'Description', 'Amount', 'Category'] },
];

  function mapCategory(category: string): ExpenseCategory {
    const lower = category.toLowerCase();
    if (lower.includes('food') || lower.includes('restaurant') || lower.includes('dining') || lower.includes('groceries')) return 'food';
    if (lower.includes('transport') || lower.includes('uber') || lower.includes('lyft') || lower.includes('gas') || lower.includes('fuel')) return 'transportation';
    if (lower.includes('entertainment') || lower.includes('movie') || lower.includes('netflix') || lower.includes('spotify')) return 'entertainment';
    if (lower.includes('shopping') || lower.includes('amazon') || lower.includes('retail')) return 'shopping';
    if (lower.includes('health') || lower.includes('medical') || lower.includes('pharmacy') || lower.includes('doctor')) return 'healthcare';
    if (lower.includes('utility') || lower.includes('electric') || lower.includes('water') || lower.includes('internet') || lower.includes('phone')) return 'utilities';
    if (lower.includes('rent') || lower.includes('mortgage') || lower.includes('housing')) return 'rent';
    if (lower.includes('insurance')) return 'insurance';
    if (lower.includes('subscription') || lower.includes('membership')) return 'subscriptions';
    if (lower.includes('travel') || lower.includes('hotel') || lower.includes('flight') || lower.includes('airbnb')) return 'travel';
    if (lower.includes('education') || lower.includes('tuition') || lower.includes('book')) return 'education';
    if (lower.includes('invest') || lower.includes('saving')) return 'investments';
    // Gift, personal, pet, tax, income mapped to 'other' as they're not in ExpenseCategory
    return 'other';
  }

  export function parseCsv(content: string): ParseResult {
  // xlsx (already a dependency) is a real RFC4180 reader. The previous hand-rolled
  // split('\n') + quote toggler mangled every Monarch export containing a comma in a
  // merchant name, an escaped quote, or a newline inside a Notes field — the last of
  // which silently imported a $0 ghost row AND dropped the real amount.
  const rows = XLSX.utils.sheet_to_json<string[]>(
    XLSX.read(content, { type: 'string', raw: true, codepage: 65001 }).Sheets.Sheet1,
    { header: 1, defval: '', blankrows: false }
  );
  if (rows.length < 2) return { rows: [], error: null };

  const headers = rows[0].map(h => String(h ?? '').trim().replace(/^﻿/, '').toLowerCase());
  const transactions: ParsedTransaction[] = [];

  // Detect format
  const format = detectFormat(headers);

  // Check for required columns (flexible based on format)
  const hasAmount = headers.some(h => h.includes('amount') || h.includes('debit') || h.includes('credit') || h.includes('principal'));
  const hasDate = headers.some(h => h.includes('date'));
  
  if (!hasAmount && !hasDate) {
    // Returned, not thrown, and not written to component state: this module
    // is shared with a Cloud Function that has no React to set state on.
    return { rows: [], error: 'CSV must have Date and Amount columns' };
  }
  
  // Find column indices with format-aware logic
  let dateIdx = headers.findIndex(h => h.includes('transaction date') || h.includes('trans. date') || h.includes('trans date'));
  if (dateIdx === -1) dateIdx = headers.findIndex(h => h.includes('posted date') || h.includes('post date'));
  if (dateIdx === -1) dateIdx = headers.findIndex(h => h.includes('date'));
  
  let amountIdx = headers.findIndex(h => h === 'amount' || h.includes('amount'));
  const debitIdx = headers.findIndex(h => h.includes('debit'));
  const creditIdx = headers.findIndex(h => h.includes('credit'));
  const principalIdx = headers.findIndex(h => h.includes('principal'));
  const interestIdx = headers.findIndex(h => h.includes('interest'));
  const balanceIdx = headers.findIndex(h => h === 'balance' || h.includes('balance'));
  
  // Monarch exports every account in ONE file, so this column is the difference
  // between correct per-account attribution and collapsing everything onto one card.
  const accountIdx = headers.findIndex(h => h.includes('account'));
  const stmtIdx = headers.findIndex(h => h.includes('original statement') || h.includes('original description'));

  let descIdx = headers.findIndex(h => h.includes('description') || h.includes('payee'));
  // Resolved after accountIdx so Mint's "Account Name" column can't become the title.
  if (descIdx === -1) descIdx = headers.findIndex((h, i) => i !== accountIdx && h.includes('name'));

  const merchantIdx = headers.findIndex(h => h === 'merchant' || h.includes('merchant'));
  const categoryIdx = headers.findIndex(h => h.includes('category'));
  const notesIdx = headers.findIndex(h => h.includes('notes') || h.includes('memo') || h.includes('extended details'));
  const typeIdx = headers.findIndex(h => h === 'type' || h.includes('type'));
  
  // Counts byte-identical rows so two genuinely separate $3.50 coffees on the same
  // day at the same merchant get distinct ids instead of collapsing into one.
  const seen = new Map<string, number>();

  for (let i = 1; i < rows.length; i++) {
    const values = rows[i].map(v => String(v ?? '').trim());
    if (values.length < 2) continue;

    const errors: string[] = [];

    // Parse date
    const dateStr = values[dateIdx] || '';
    let parsedDate: Date | null = null;

    // Try different date formats
    const datePatterns = [
      /(\d{4})-(\d{2})-(\d{2})/, // YYYY-MM-DD
      /(\d{2})\/(\d{2})\/(\d{4})/, // MM/DD/YYYY
      /(\d{2})-(\d{2})-(\d{4})/, // MM-DD-YYYY
      /(\d{1,2})\/(\d{1,2})\/(\d{2,4})/, // M/D/YY or M/D/YYYY
    ];

    for (const datePattern of datePatterns) {
      const match = dateStr.match(datePattern);
      if (match) {
        let y: number, m: number, d: number;
        if (datePattern.source.startsWith('(\\d{4})')) {
          [y, m, d] = [parseInt(match[1]), parseInt(match[2]), parseInt(match[3])];
        } else {
          y = match[3].length === 2 ? 2000 + parseInt(match[3]) : parseInt(match[3]);
          [m, d] = [parseInt(match[1]), parseInt(match[2])];
        }
        const candidate = new Date(y, m - 1, d);
        // new Date(2024, 0, 32) silently rolls into February, and a day-first
        // "15/01/2024" rolled 14 months into the future as a valid-looking row.
        if (candidate.getMonth() === m - 1 && candidate.getDate() === d) {
          parsedDate = candidate;
        }
        break;
      }
    }

    if (!parsedDate || isNaN(parsedDate.getTime())) {
      errors.push('Invalid date format');
    }

    // Parse amount. `signedAmount` keeps the CSV's own sign because it is both the
    // income/expense signal and part of the row's identity; `amount` stays unsigned
    // because every aggregate in the app assumes that.
    let signedAmount: number | null = null;
    let type: TransactionType = 'expense';

    if (format === 'upstart' && principalIdx >= 0) {
      // Upstart loan format: Principal + Interest = payment amount
      const principal = parseAmount(values[principalIdx] || '') ?? 0;
      const interest = parseAmount(values[interestIdx] || '') ?? 0;
      signedAmount = -(Math.abs(principal) + Math.abs(interest));
      type = 'expense'; // Loan payments are expenses
    } else if (format === 'capital_one' && (debitIdx >= 0 || creditIdx >= 0)) {
      // Capital One: separate Debit/Credit columns, no single signed cell
      const debit = parseAmount(values[debitIdx] || '') ?? 0;
      const credit = parseAmount(values[creditIdx] || '') ?? 0;
      signedAmount = credit > 0 ? credit : -Math.abs(debit);
      type = credit > 0 ? 'income' : 'expense';
    } else {
      signedAmount = parseAmount(values[amountIdx] || '');

      if (signedAmount !== null) {
        // The sign is the primary signal. The old test was `amountStr.startsWith('+')`,
        // and no bank CSV ever writes a leading '+', so every refund and interest
        // credit imported as a *second* expense instead of cancelling one.
        const outflow = isOutflow(format, signedAmount);
        // Normalise to one convention (negative = money left the account) so that
        // importKey and transferDirection below mean the same thing for every issuer.
        signedAmount = outflow ? -Math.abs(signedAmount) : Math.abs(signedAmount);
        type = outflow ? 'expense' : 'income';
      }

      // A Type column REFINES the sign, it never replaces it: an unrecognised value
      // like Chase's "DSLIP" previously left a $2,500 deposit typed as an expense.
      if (typeIdx >= 0) {
        const typeStr = (values[typeIdx] || '').toLowerCase();
        if (typeStr.includes('income') || typeStr.includes('credit') || typeStr.includes('deposit') ||
            typeStr.includes('payment') || typeStr.includes('return') || typeStr.includes('refund')) {
          type = 'income';
        } else if (typeStr.includes('debit') || typeStr.includes('sale') || typeStr.includes('withdrawal')) {
          type = 'expense';
        }
        // 'adjustment' is deliberately absent — it is sign-ambiguous.

        // Re-apply the sign from the refined type. Mint exports UNSIGNED amounts and
        // puts the direction in this column, so without this the sign-derived fields
        // (transferDirection, the row id) keep the wrong sign and an outgoing Mint
        // transfer renders as a green inflow everywhere.
        if (signedAmount !== null) {
          signedAmount = type === 'expense' ? -Math.abs(signedAmount) : Math.abs(signedAmount);
        }
      }
    }

    if (signedAmount === null) {
      errors.push('Invalid amount');
      signedAmount = 0;
    }
    // A $0.00 row carries no information and would otherwise import as income.
    if (signedAmount === 0) {
      errors.push('Zero amount');
    }
    const amount = Math.abs(signedAmount);

    // Raw cells, captured BEFORE any derivation. The row's identity is built from
    // these, so a change to the merchant regexes below can never re-key the history.
    const csvAccount = accountIdx >= 0 ? values[accountIdx] || '' : '';
    const rawStatement = (stmtIdx >= 0 ? values[stmtIdx] : values[descIdx]) || '';

    // Get merchant (from dedicated column or fallback to description)
    let merchant = merchantIdx >= 0 ? values[merchantIdx] : '';

    // Get description/title
    let title = values[descIdx] || '';

    // NOTE: the old code forced type='income' for any title containing "payment",
    // with no account check. On an unmapped card export that booked every monthly
    // payment as real income. The CSV's own sign already says which way the money
    // moved, so it is the only signal used here; whether a payment is an internal
    // transfer is decided by classifyTransaction() once the account is known.

    // Special handling for loan formats
    if (format === 'upstart') {
      title = title || 'Upstart Loan Payment';
      merchant = 'Upstart';
    }
    
    // If no title but have merchant, use merchant as title
    if (!title && merchant) {
      title = merchant;
    } else if (!title) {
      title = `Transaction ${i}`;
    }
    
    // If no dedicated merchant column, try to extract from title
    if (!merchant && title) {
      // Common merchant patterns - expanded list
      const merchantPatterns = [
        /^(Amazon|Walmart|Target|Costco|Starbucks|McDonald's|Home Depot|Chipotle|Netflix|Uber|Lyft|DoorDash|Whole Foods|Shell|Chevron)/i,
        /^(Upstart|SoFi|LendingClub|Prosper|Marcus|Discover|Chase|Capital One|American Express|Amex|Bank of America)/i,
        /^(Venmo|PayPal|Cash App|Zelle|Apple|Google|Microsoft|Spotify|Hulu|Disney)/i,
        /(UPSTART|SOFI|LENDING|LOAN|PAYMENT)/i,
      ];
      for (const pattern of merchantPatterns) {
        const match = title.match(pattern);
        if (match) {
          merchant = match[1];
          break;
        }
      }
    }
    
    // Get category
    const categoryStr = values[categoryIdx] || '';
    let category = mapCategory(categoryStr || title);

    // Auto-detect loan payments
    const lowerTitle = title.toLowerCase();
    if (lowerTitle.includes('loan') || lowerTitle.includes('upstart') || lowerTitle.includes('sofi') ||
        lowerTitle.includes('lending') || format === 'upstart') {
      category = 'other'; // Loan payments
      type = 'expense';
    }

    // Check if this looks like income based on category
    const lowerCategory = categoryStr.trim().toLowerCase();
    if (lowerCategory.includes('income') || lowerCategory.includes('salary') || lowerCategory.includes('paycheck')) {
      type = 'income';
    }

    // Monarch already knows which rows are internal movement and says so in its own
    // Category column. Using that beats guessing from a merchant string, and it is
    // the last word here because the overrides above are last-write-wins.
    let transferDirection: TransferDirection | undefined;
    if (isTransferCategory(categoryStr)) {
      type = 'transfer';
      transferDirection = signedAmount < 0 ? 'out' : 'in';
    }

    // Get notes/description
    const description = values[notesIdx] || '';

    const dateKey = parsedDate ? formatDate(parsedDate, 'yyyy-MM-dd') : '';
    // Counted on the SAME normalised material the id uses. Keying the counter on the
    // raw cells instead let two rows differing only by case, whitespace, or a shared
    // last-4 both take occurrence 0 and then collapse onto one document id.
    const base = importKey(dateKey, signedAmount, csvAccount, rawStatement, 0);
    const occurrence = seen.get(base) ?? 0;
    seen.set(base, occurrence + 1);

    transactions.push({
      id: importKey(dateKey, signedAmount, csvAccount, rawStatement, occurrence),
      // LOCAL midnight, matching what every consumer does: calendar, history grouping
      // and the dashboard month filter all read this back with local-time date math,
      // so a UTC-midnight string put US users' 1st-of-month rows in the prior month.
      date: parsedDate ? parsedDate.toISOString() : '',
      title,
      amount,
      type,
      transferDirection,
      category,
      // The source's own label, kept verbatim so nothing gets flattened into "Other".
      sourceCategory: categoryStr.trim() || undefined,
      paymentMethod: 'chase', // Default, user can change
      description,
      merchant: merchant || undefined, // Include merchant if found
      csvAccount,
      isValid: errors.length === 0,
      errors,
    });
  }

  return { rows: transactions, error: null };
}

/**
 * Matches one CSV account label such as "USAA SECURE MAIN CHECKING (...4156)"
 * against the owner's accounts. Last-four wins because it survives renames.
 */
export function matchAccountByName(
  csvName: string,
  accounts: readonly PaymentAccount[]
): PaymentAccount | null {
  const lower = csvName.toLowerCase();
  return (
    accounts.find(a => a.lastFourDigits && lower.includes(a.lastFourDigits)) ||
    accounts.find(a => lower.includes(a.name.toLowerCase())) ||
    accounts.find(a => a.provider && lower.includes(a.provider.toLowerCase())) ||
    null
  );
}

/** Common aliases banks use in their download filenames. */
const BANK_PATTERNS: Record<string, string[]> = {
  chase: ['chase', 'jpm'],
  amex: ['amex', 'american express'],
  discover: ['discover'],
  capital_one: ['capital one', 'capitalone'],
  visa: ['visa'],
  mastercard: ['mastercard', 'mc'],
  bank_of_america: ['bank of america', 'boa', 'bofa'],
};

/**
 * Matches an account from the filename, e.g. "amex_activity_2024.csv".
 *
 * Often the ONLY signal: Amex's "Account #" column holds an opaque "-42003"
 * that matches nothing.
 */
export function detectAccountFromFilename(
  filename: string,
  accounts: readonly PaymentAccount[]
): PaymentAccount | null {
  const filenameLC = filename.toLowerCase();

  for (const account of accounts) {
    const accountNameLC = account.name.toLowerCase();
    const providerLC = account.provider?.toLowerCase() || '';

    // providerLC guarded: ''.includes() is always true, so an account with no
    // provider would otherwise match every filename ever uploaded.
    if (filenameLC.includes(accountNameLC) || (providerLC && filenameLC.includes(providerLC))) {
      return account;
    }
    if (account.lastFourDigits && filenameLC.includes(account.lastFourDigits)) {
      return account;
    }
    if ((BANK_PATTERNS[account.provider] || []).some(p => filenameLC.includes(p))) {
      return account;
    }
  }
  return null;
}
