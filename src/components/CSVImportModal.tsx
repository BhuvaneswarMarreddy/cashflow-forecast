'use client';

import React, { useState, useRef, useMemo } from 'react';
import { X, Upload, FileText, AlertCircle, CheckCircle, Download, HelpCircle, CreditCard, Building2, Link2, Plus } from 'lucide-react';
import * as XLSX from 'xlsx';
import { format as formatDate } from 'date-fns';
import { useTransactions } from '@/context/TransactionContext';
import { useUserProfile } from '@/context/UserProfileContext';
import { TransactionType, TransferDirection, ExpenseCategory, PaymentMethod, AccountType, EXPENSE_CATEGORIES, PaymentAccount, getMerchantColor } from '@/types';

// Sentinel account-map value meaning "create a new account for this CSV label".
const CREATE_ACCOUNT = '__create__';

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
  return { name, type, provider, balance: 0, lastFourDigits, color: getMerchantColor(csvName), isActive: true };
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

interface ParsedTransaction {
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
export function isOutflow(format: string, signedAmount: number): boolean {
  const chargesArePositive = format === 'amex' || format === 'discover';
  return chargesArePositive ? signedAmount > 0 : signedAmount < 0;
}

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
  { name: 'Generic', columns: ['Date', 'Description', 'Amount', 'Category'] },
];

export default function CSVImportModal({ isOpen, onClose }: CSVImportModalProps) {
  const { addBulkTransactions, transactions } = useTransactions();
  const { profile, addPaymentAccounts } = useUserProfile();
  const fileInputRef = useRef<HTMLInputElement>(null);
  
  const [file, setFile] = useState<File | null>(null);
  const [parsedData, setParsedData] = useState<ParsedTransaction[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [importSuccess, setImportSuccess] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [selectedAccountId, setSelectedAccountId] = useState<string>('');
  const [detectedAccountName, setDetectedAccountName] = useState<string>('');
  // Maps each distinct CSV "Account" string to an existing account id, the CREATE_ACCOUNT
  // sentinel (auto-create one), or '' (import unlinked).
  const [accountMap, setAccountMap] = useState<Record<string, string>>({});
  // Per-label type for accounts about to be created; seeded by inference, user-overridable.
  const [createTypes, setCreateTypes] = useState<Record<string, AccountType>>({});
  const [skippedCount, setSkippedCount] = useState(0);
  const [importedCount, setImportedCount] = useState(0);
  const [savedToCloud, setSavedToCloud] = useState(true);

  // Distinct account names present in the file (empty for single-account exports).
  const csvAccounts = useMemo(
    () => [...new Set(parsedData.map(t => t.csvAccount).filter(Boolean))],
    [parsedData]
  );

  /**
   * Matches one CSV account label such as "USAA SECURE MAIN CHECKING (...4156)"
   * against the user's accounts. Last-four wins because it survives renames.
   */
  const matchAccountByName = (csvName: string): PaymentAccount | null => {
    if (!profile?.paymentAccounts) return null;
    const lower = csvName.toLowerCase();
    return (
      profile.paymentAccounts.find(a => a.lastFourDigits && lower.includes(a.lastFourDigits)) ||
      profile.paymentAccounts.find(a => lower.includes(a.name.toLowerCase())) ||
      profile.paymentAccounts.find(a => a.provider && lower.includes(a.provider.toLowerCase())) ||
      null
    );
  };

  // Try to match an account from the filename, e.g. "amex_activity_2024.csv".
  const detectAccount = (filename: string): PaymentAccount | null => {
    if (!profile?.paymentAccounts) return null;

    const filenameLC = filename.toLowerCase();

    for (const account of profile.paymentAccounts) {
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

      // Common aliases banks use in their download filenames.
      const bankPatterns: { [key: string]: string[] } = {
        'chase': ['chase', 'jpm'],
        'amex': ['amex', 'american express'],
        'discover': ['discover'],
        'capital_one': ['capital one', 'capitalone'],
        'visa': ['visa'],
        'mastercard': ['mastercard', 'mc'],
        'bank_of_america': ['bank of america', 'boa', 'bofa'],
      };

      const patterns = bankPatterns[account.provider] || [];
      if (patterns.some(p => filenameLC.includes(p))) {
        return account;
      }
    }

    return null;
  };

  // Category mapping from common bank categories
  const mapCategory = (category: string): ExpenseCategory => {
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
  };

  // Detect which format the CSV is in
  const detectFormat = (headers: string[]): string => {
    const headerStr = headers.join(',').toLowerCase();
    
    if (headerStr.includes('principal') && headerStr.includes('interest') && headerStr.includes('balance')) {
      return 'upstart';
    }
    if (headerStr.includes('trans. date') || headerStr.includes('trans date')) {
      return 'discover';
    }
    if (headerStr.includes('card no') || headerStr.includes('debit') && headerStr.includes('credit')) {
      return 'capital_one';
    }
    if (headerStr.includes('post date') && headerStr.includes('transaction date')) {
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
  };

  const parseCSV = (content: string): ParsedTransaction[] => {
    // xlsx (already a dependency) is a real RFC4180 reader. The previous hand-rolled
    // split('\n') + quote toggler mangled every Monarch export containing a comma in a
    // merchant name, an escaped quote, or a newline inside a Notes field — the last of
    // which silently imported a $0 ghost row AND dropped the real amount.
    const rows = XLSX.utils.sheet_to_json<string[]>(
      XLSX.read(content, { type: 'string', raw: true, codepage: 65001 }).Sheets.Sheet1,
      { header: 1, defval: '', blankrows: false }
    );
    if (rows.length < 2) return [];

    const headers = rows[0].map(h => String(h ?? '').trim().replace(/^﻿/, '').toLowerCase());
    const transactions: ParsedTransaction[] = [];

    // Detect format
    const format = detectFormat(headers);

    // Check for required columns (flexible based on format)
    const hasAmount = headers.some(h => h.includes('amount') || h.includes('debit') || h.includes('credit') || h.includes('principal'));
    const hasDate = headers.some(h => h.includes('date'));
    
    if (!hasAmount && !hasDate) {
      setError('CSV must have Date and Amount columns');
      return [];
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

    return transactions;
  };
  
  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const selectedFile = e.target.files?.[0];
    if (!selectedFile) return;

    if (!selectedFile.name.endsWith('.csv')) {
      setError('Please select a CSV file');
      return;
    }

    setFile(selectedFile);
    setError(null);
    setImportSuccess(false);
    setDetectedAccountName('');

    const reader = new FileReader();
    reader.onload = (event) => {
      const content = event.target?.result as string;
      const parsed = parseCSV(content);
      setParsedData(parsed);

      // The filename is a real signal ("amex_activity_2024.csv") and is often the ONLY
      // one: Amex's "Account #" column holds an opaque "-42003" that matches nothing.
      // So it is always consulted, and used as the fallback for any CSV account label
      // we could not resolve on its own.
      const fromFilename = detectAccount(selectedFile.name);

      const labels = [...new Set(parsed.map(t => t.csvAccount).filter(Boolean))];
      const seeded: Record<string, string> = {};
      const types: Record<string, AccountType> = {};
      for (const name of labels) {
        // The filename only stands in when the file describes ONE account. In a
        // multi-account Monarch export it would silently attribute an unrecognised
        // label (say "Vanguard Brokerage") to whatever the filename hinted at.
        const match = matchAccountByName(name) || (labels.length === 1 ? fromFilename : null);
        // Default to auto-creating the account rather than importing it unlinked —
        // "just give the CSV" is the whole point.
        seeded[name] = match ? match.id : CREATE_ACCOUNT;
        types[name] = inferAccountType(name);
      }
      setAccountMap(seeded);
      setCreateTypes(types);

      if (fromFilename) {
        setDetectedAccountName(fromFilename.name);
        // Single-account exports (Chase, Discover, ...) carry no Account column at all.
        if (!parsed.some(t => t.csvAccount)) setSelectedAccountId(fromFilename.id);
      }
    };
    reader.readAsText(selectedFile);
  };

  const handleImport = async () => {
    const validTransactions = parsedData.filter(t => t.isValid);
    if (validTransactions.length === 0) {
      setError('No valid transactions to import');
      return;
    }

    // Rows already imported are skipped rather than rewritten, so a category the user
    // corrected by hand survives every future import of the same Monarch export.
    const alreadyImported = new Set(transactions.map(t => t.id));
    const fresh = validTransactions.filter(t => !alreadyImported.has(t.id));
    if (fresh.length === 0) {
      setError(`All ${validTransactions.length} transactions were already imported.`);
      return;
    }

    setIsLoading(true);
    setError(null);

    try {
      // 1. Auto-create the accounts the user left on "create". One batch call so all
      //    survive (a per-account loop over addPaymentAccount would lose all but one).
      const toCreate = csvAccounts.filter(n => accountMap[n] === CREATE_ACCOUNT);
      const created: Record<string, PaymentAccount> = {};
      if (toCreate.length > 0) {
        const specs = toCreate.map(n => {
          const spec = inferAccountFromCsv(n);
          return { ...spec, type: createTypes[n] ?? spec.type };
        });
        const ids = await addPaymentAccounts(specs);
        toCreate.forEach((n, i) => { created[n] = { ...specs[i], id: ids[i] }; });
      }

      // Resolve a CSV label to its account: freshly created, existing, or none.
      const resolve = (csvName: string): PaymentAccount | undefined => {
        if (created[csvName]) return created[csvName];
        const id = csvName ? accountMap[csvName] : selectedAccountId;
        if (!id || id === CREATE_ACCOUNT) return undefined;
        return profile?.paymentAccounts?.find(a => a.id === id);
      };

      const transactionsToAdd = fresh.map(t => {
        const account = resolve(t.csvAccount);
        return {
          id: t.id,
          title: t.title,
          amount: t.amount,
          type: t.type,
          transferDirection: t.transferDirection,
          category: t.category,
          sourceCategory: t.sourceCategory,
          paymentMethod: account?.provider || t.paymentMethod,
          date: t.date,
          // Undefined rather than '' / false: the write merges, so only fields the CSV
          // genuinely carries should overwrite what is already stored.
          description: t.description || undefined,
          merchant: t.merchant,
          accountId: account?.id,
        };
      });

      const result = await addBulkTransactions(transactionsToAdd);
      setSkippedCount(validTransactions.length - fresh.length);
      setImportedCount(fresh.length);
      // Never claim a clean import when the rows only reached this browser.
      setSavedToCloud(result?.persisted ?? false);
      setImportSuccess(true);

      // Reset after 2 seconds
      setTimeout(() => {
        onClose();
        setFile(null);
        setParsedData([]);
        setImportSuccess(false);
        setSelectedAccountId('');
        setDetectedAccountName('');
      }, 2000);
    } catch (err) {
      setError('Failed to import transactions');
      console.error(err);
    } finally {
      setIsLoading(false);
    }
  };

  const handleDownloadTemplate = () => {
    const template = 'Date,Description,Amount,Category,Notes\n2024-01-15,Grocery Store,-85.50,Food,Weekly groceries\n2024-01-14,Paycheck,3500.00,Income,Monthly salary\n2024-01-13,Electric Bill,-125.00,Utilities,January bill';
    const blob = new Blob([template], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'transaction_template.csv';
    a.click();
    URL.revokeObjectURL(url);
  };

  if (!isOpen) return null;

  const validCount = parsedData.filter(t => t.isValid).length;
  const invalidCount = parsedData.filter(t => !t.isValid).length;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content max-w-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex justify-between items-center mb-6">
          <h2 className="text-2xl font-bold text-[var(--foreground)]">Import Transactions</h2>
          <button
            onClick={onClose}
            className="p-2 rounded-xl text-[var(--foreground-secondary)] hover:bg-[var(--background-tertiary)] transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Help Section */}
        <div className="mb-6">
          <button
            onClick={() => setShowHelp(!showHelp)}
            className="flex items-center gap-2 text-sm text-[var(--accent-primary)] hover:underline"
          >
            <HelpCircle className="w-4 h-4" />
            {showHelp ? 'Hide help' : 'How to export from Monarch or other apps'}
          </button>
          
          {showHelp && (
            <div className="mt-3 p-4 rounded-lg bg-[var(--background-tertiary)] text-sm text-[var(--foreground-secondary)]">
              <p className="font-medium text-[var(--foreground)] mb-2">Supported formats:</p>
              <ul className="list-disc list-inside space-y-1 mb-3">
                <li><strong>Monarch:</strong> Settings → Export Data → Transactions CSV</li>
                <li><strong>Mint:</strong> Transactions → Export → CSV</li>
                <li><strong>Chase:</strong> Account → Download → CSV</li>
                <li><strong>Capital One:</strong> Transactions → Download → CSV</li>
                <li><strong>American Express:</strong> Statements → Download → CSV</li>
                <li><strong>Discover:</strong> Statements → Download CSV</li>
                <li><strong>Bank of America:</strong> Activity → Download</li>
                <li><strong>Upstart Loans:</strong> Payment History → Download</li>
                <li><strong>SoFi/Other Loans:</strong> Transaction History → Export</li>
              </ul>
              <p className="text-xs text-[var(--foreground-muted)]">
                We auto-detect most CSV formats including loan statements. Your file should have at least Date and Amount columns.
              </p>
            </div>
          )}
        </div>

        {/* File Upload */}
        {!file && !importSuccess && (
          <div 
            className="border-2 border-dashed border-[var(--border-color)] rounded-xl p-8 text-center hover:border-[var(--accent-primary)] transition-colors cursor-pointer"
            onClick={() => fileInputRef.current?.click()}
          >
            <Upload className="w-12 h-12 mx-auto mb-4 text-[var(--foreground-muted)]" />
            <p className="text-lg font-medium text-[var(--foreground)] mb-2">
              Drop your CSV file here
            </p>
            <p className="text-sm text-[var(--foreground-muted)] mb-4">
              or click to browse
            </p>
            <input
              ref={fileInputRef}
              type="file"
              accept=".csv"
              onChange={handleFileSelect}
              className="hidden"
            />
            <button
              onClick={(e) => {
                e.stopPropagation();
                handleDownloadTemplate();
              }}
              className="text-sm text-[var(--accent-primary)] hover:underline flex items-center gap-1 mx-auto"
            >
              <Download className="w-4 h-4" />
              Download template CSV
            </button>
          </div>
        )}

        {/* Import Success */}
        {importSuccess && (
          <div className="text-center py-8">
            <CheckCircle className="w-16 h-16 mx-auto mb-4 text-emerald-500" />
            <p className="text-xl font-semibold text-[var(--foreground)]">
              Successfully imported {importedCount} transactions
            </p>
            {skippedCount > 0 && (
              <p className="text-sm text-[var(--foreground-muted)] mt-2">
                {skippedCount} were already imported and were left untouched.
              </p>
            )}
            {!savedToCloud && (
              <p className="text-sm text-amber-500 mt-2">
                Saved on this device only — the cloud sync failed. They will upload when
                the connection recovers, but do not clear your browser data before then.
              </p>
            )}
          </div>
        )}

        {/* Parsed Data Preview */}
        {file && parsedData.length > 0 && !importSuccess && (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <FileText className="w-5 h-5 text-[var(--accent-primary)]" />
                <span className="font-medium text-[var(--foreground)]">{file.name}</span>
              </div>
              <button
                onClick={() => {
                  setFile(null);
                  setParsedData([]);
                }}
                className="text-sm text-[var(--foreground-muted)] hover:text-[var(--foreground)]"
              >
                Change file
              </button>
            </div>

            {/* Stats */}
            <div className="grid grid-cols-3 gap-4">
              <div className="p-3 rounded-lg bg-[var(--background-tertiary)]">
                <p className="text-xs text-[var(--foreground-muted)]">Total Found</p>
                <p className="text-lg font-bold text-[var(--foreground)]">{parsedData.length}</p>
              </div>
              <div className="p-3 rounded-lg bg-emerald-500/10">
                <p className="text-xs text-emerald-500">Valid</p>
                <p className="text-lg font-bold text-emerald-500">{validCount}</p>
              </div>
              {invalidCount > 0 && (
                <div className="p-3 rounded-lg bg-amber-500/10">
                  <p className="text-xs text-amber-500">Invalid</p>
                  <p className="text-lg font-bold text-amber-500">{invalidCount}</p>
                </div>
              )}
            </div>

            {/* Account Linking — one picker per account found in the file. Each label
                defaults to "Create" so importing a file also creates its account
                (typed from the name); the user can relink or unlink any of them. */}
            {(csvAccounts.length > 0 || (profile?.paymentAccounts?.length ?? 0) > 0) && (
              <div className="p-4 rounded-lg bg-[var(--background-tertiary)] border border-[var(--border-color)] space-y-4">
                <div className="flex items-center gap-2">
                  <Link2 className="w-4 h-4 text-[var(--accent-primary)]" />
                  <span className="font-medium text-[var(--foreground)]">Accounts</span>
                </div>

                {(csvAccounts.length > 0 ? csvAccounts : ['']).map((csvName) => {
                  const current = csvName ? accountMap[csvName] : selectedAccountId;
                  const choose = (id: string) =>
                    csvName
                      ? setAccountMap((m) => ({ ...m, [csvName]: id }))
                      : setSelectedAccountId(id);
                  const isCreating = csvName !== '' && current === CREATE_ACCOUNT;
                  const preview = csvName ? inferAccountFromCsv(csvName) : null;
                  const createType = createTypes[csvName] ?? preview?.type ?? 'bank_account';
                  return (
                    <div key={csvName || '__single__'}>
                      <p className="text-sm text-[var(--foreground-secondary)] mb-2">
                        {csvName || 'All transactions in this file'}
                        <span className="text-[var(--foreground-muted)]">
                          {' '}({csvName
                            ? parsedData.filter(t => t.csvAccount === csvName).length
                            : validCount} rows)
                        </span>
                      </p>
                      <div className="flex flex-wrap gap-2">
                        {csvName !== '' && (
                          <button
                            onClick={() => choose(CREATE_ACCOUNT)}
                            className={`px-3 py-2 rounded-lg text-sm font-medium transition-all flex items-center gap-1.5 ${
                              isCreating
                                ? 'bg-[var(--accent-primary)] text-white'
                                : 'bg-[var(--background-secondary)] text-[var(--foreground-secondary)] border border-[var(--border-color)]'
                            }`}
                          >
                            <Plus className="w-4 h-4" />
                            Create{preview?.lastFourDigits ? ` ••${preview.lastFourDigits}` : ''}
                          </button>
                        )}
                        {(profile?.paymentAccounts ?? []).map((account) => (
                          <button
                            key={account.id}
                            onClick={() => choose(account.id)}
                            className={`px-3 py-2 rounded-lg text-sm font-medium transition-all flex items-center gap-2 ${
                              current === account.id ? 'text-white' : 'text-[var(--foreground-secondary)] border'
                            }`}
                            style={{
                              backgroundColor: current === account.id ? account.color : 'var(--background-secondary)',
                              borderColor: current !== account.id ? account.color : 'transparent',
                            }}
                          >
                            <CreditCard className="w-4 h-4" />
                            {account.name}
                            {account.lastFourDigits && <span className="opacity-70">••{account.lastFourDigits}</span>}
                          </button>
                        ))}
                        <button
                          onClick={() => choose('')}
                          className={`px-3 py-2 rounded-lg text-sm font-medium transition-all ${
                            current === ''
                              ? 'bg-[var(--accent-primary)] text-white'
                              : 'bg-[var(--background-secondary)] text-[var(--foreground-secondary)] border border-[var(--border-color)]'
                          }`}
                        >
                          No Link
                        </button>
                      </div>

                      {/* Type toggle for the account being created — the one thing the
                          CSV can't tell us for sure, and the one that decides whether a
                          payment counts as debt-reduction or income. */}
                      {isCreating && (
                        <div className="flex items-center gap-2 mt-2">
                          <span className="text-xs text-[var(--foreground-muted)]">Create as</span>
                          {([['bank_account', 'Bank', Building2], ['credit_card', 'Credit card', CreditCard]] as const).map(
                            ([t, label, Icon]) => (
                              <button
                                key={t}
                                onClick={() => setCreateTypes((m) => ({ ...m, [csvName]: t }))}
                                className={`px-2.5 py-1 rounded-lg text-xs font-medium flex items-center gap-1.5 transition-all ${
                                  createType === t
                                    ? 'bg-[var(--accent-primary)] text-white'
                                    : 'bg-[var(--background-secondary)] text-[var(--foreground-secondary)] border border-[var(--border-color)]'
                                }`}
                              >
                                <Icon className="w-3.5 h-3.5" />
                                {label}
                              </button>
                            )
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}

                {/* No-Link is the risky choice: without an account, a card payment can't
                    be told apart from real income. */}
                {csvAccounts.some(n => accountMap[n] === '') && (
                  <p className="text-xs text-amber-500">
                    {parsedData.filter(t => t.csvAccount && accountMap[t.csvAccount] === '').length} transactions
                    are set to No Link and will import unlinked; card payments among them can't be recognised.
                  </p>
                )}
              </div>
            )}

            {/* Preview */}
            <div className="max-h-[300px] overflow-y-auto rounded-lg border border-[var(--border-color)]">
              <table className="w-full text-sm">
                <thead className="bg-[var(--background-tertiary)] sticky top-0">
                  <tr>
                    <th className="text-left p-3 text-[var(--foreground-muted)]">Date</th>
                    <th className="text-left p-3 text-[var(--foreground-muted)]">Description</th>
                    <th className="text-right p-3 text-[var(--foreground-muted)]">Amount</th>
                    <th className="text-left p-3 text-[var(--foreground-muted)]">Type</th>
                  </tr>
                </thead>
                <tbody>
                  {parsedData.slice(0, 20).map((t, i) => (
                    <tr 
                      key={i} 
                      className={`border-t border-[var(--border-color)] ${!t.isValid ? 'bg-red-500/10' : ''}`}
                    >
                      <td className="p-3 text-[var(--foreground-secondary)]">
                        {new Date(t.date).toLocaleDateString()}
                      </td>
                      <td className="p-3 text-[var(--foreground)]">{t.title}</td>
                      {/* 3-way: a binary ternary would render every transfer as an
                          outgoing expense, including the receiving leg. */}
                      <td className={`p-3 text-right font-medium ${
                        t.type === 'income' || t.transferDirection === 'in'
                          ? 'text-emerald-500'
                          : 'text-[var(--foreground)]'
                      }`}>
                        {t.type === 'income' || t.transferDirection === 'in' ? '+' : '-'}${t.amount.toFixed(2)}
                      </td>
                      <td className="p-3">
                        <span className={`text-xs px-2 py-1 rounded-full ${t.type === 'income' ? 'bg-emerald-500/20 text-emerald-500' : t.type === 'transfer' ? 'bg-blue-500/20 text-blue-400' : 'bg-[var(--background-tertiary)] text-[var(--foreground-secondary)]'}`}>
                          {t.type}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {parsedData.length > 20 && (
                <p className="text-center py-2 text-sm text-[var(--foreground-muted)]">
                  +{parsedData.length - 20} more transactions...
                </p>
              )}
            </div>

            {/* Error */}
            {error && (
              <div className="p-3 rounded-lg bg-red-500/10 border border-red-500/30 flex items-center gap-2">
                <AlertCircle className="w-4 h-4 text-red-500" />
                <span className="text-sm text-red-400">{error}</span>
              </div>
            )}

            {/* Import Button */}
            <button
              onClick={handleImport}
              disabled={isLoading || validCount === 0}
              className="btn-primary w-full disabled:opacity-50 flex items-center justify-center gap-2"
            >
              {isLoading ? (
                <>
                  <div className="w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin" />
                  Importing...
                </>
              ) : (
                <>
                  <Upload className="w-4 h-4" />
                  Import {validCount} Transactions
                </>
              )}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

