'use client';

import React, { useState, useRef } from 'react';
import { X, Upload, FileText, AlertCircle, CheckCircle, Download, HelpCircle, CreditCard, Link2 } from 'lucide-react';
import { useTransactions } from '@/context/TransactionContext';
import { useUserProfile } from '@/context/UserProfileContext';
import { Transaction, ExpenseCategory, PaymentMethod, EXPENSE_CATEGORIES, PaymentAccount } from '@/types';

interface CSVImportModalProps {
  isOpen: boolean;
  onClose: () => void;
}

interface ParsedTransaction {
  date: string;
  title: string;
  amount: number;
  type: 'income' | 'expense';
  category: ExpenseCategory;
  paymentMethod: PaymentMethod;
  description?: string;
  merchant?: string; // Store/merchant name
  accountId?: string; // Linked account ID
  isValid: boolean;
  errors: string[];
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
  const { addBulkTransactions } = useTransactions();
  const { profile } = useUserProfile();
  const fileInputRef = useRef<HTMLInputElement>(null);
  
  const [file, setFile] = useState<File | null>(null);
  const [parsedData, setParsedData] = useState<ParsedTransaction[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [importSuccess, setImportSuccess] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [selectedAccountId, setSelectedAccountId] = useState<string>('');
  const [detectedAccountName, setDetectedAccountName] = useState<string>('');

  // Try to match account from filename or CSV headers
  const detectAccount = (filename: string, headers: string[]): PaymentAccount | null => {
    if (!profile?.paymentAccounts) return null;
    
    const filenameLC = filename.toLowerCase();
    const headersLC = headers.join(' ').toLowerCase();
    
    for (const account of profile.paymentAccounts) {
      const accountNameLC = account.name.toLowerCase();
      const providerLC = account.provider?.toLowerCase() || '';
      
      // Check filename
      if (filenameLC.includes(accountNameLC) || filenameLC.includes(providerLC)) {
        return account;
      }
      
      // Check for last 4 digits in filename
      if (account.lastFourDigits && filenameLC.includes(account.lastFourDigits)) {
        return account;
      }
      
      // Check headers for account name
      if (headersLC.includes(accountNameLC) || headersLC.includes(providerLC)) {
        return account;
      }
      
      // Check for common bank name patterns
      const bankPatterns: { [key: string]: string[] } = {
        'chase': ['chase', 'jpm'],
        'amex': ['amex', 'american express'],
        'discover': ['discover'],
        'capital_one': ['capital one', 'capitalone'],
        'visa': ['visa'],
        'mastercard': ['mastercard', 'mc'],
        'bank_of_america': ['bank of america', 'boa', 'bofa'],
      };
      
      for (const [provider, patterns] of Object.entries(bankPatterns)) {
        if (account.provider === provider) {
          for (const pattern of patterns) {
            if (filenameLC.includes(pattern) || headersLC.includes(pattern)) {
              return account;
            }
          }
        }
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
    const lines = content.split('\n').filter(line => line.trim());
    if (lines.length < 2) return [];
    
    const headers = lines[0].split(',').map(h => h.trim().replace(/"/g, '').toLowerCase());
    const transactions: ParsedTransaction[] = [];
    
    // Detect format
    const format = detectFormat(headers);
    console.log('Detected CSV format:', format);
    
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
    
    let descIdx = headers.findIndex(h => h.includes('description') || h.includes('payee'));
    if (descIdx === -1) descIdx = headers.findIndex(h => h.includes('name'));
    
    const merchantIdx = headers.findIndex(h => h === 'merchant' || h.includes('merchant'));
    const categoryIdx = headers.findIndex(h => h.includes('category'));
    const notesIdx = headers.findIndex(h => h.includes('notes') || h.includes('memo') || h.includes('extended details'));
    const typeIdx = headers.findIndex(h => h === 'type' || h.includes('type'));
    
    for (let i = 1; i < lines.length; i++) {
      const values = parseCSVLine(lines[i]);
      if (values.length < 2) continue;
      
      const errors: string[] = [];
      
      // Parse date
      let dateStr = values[dateIdx]?.replace(/"/g, '').trim() || '';
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
          if (datePattern.source.startsWith('(\\d{4})')) {
            parsedDate = new Date(parseInt(match[1]), parseInt(match[2]) - 1, parseInt(match[3]));
          } else {
            const year = match[3].length === 2 ? 2000 + parseInt(match[3]) : parseInt(match[3]);
            parsedDate = new Date(year, parseInt(match[1]) - 1, parseInt(match[2]));
          }
          break;
        }
      }
      
      if (!parsedDate || isNaN(parsedDate.getTime())) {
        errors.push('Invalid date format');
      }
      
      // Parse amount - handle different formats
      let amount = 0;
      let type: 'income' | 'expense' = 'expense';
      
      if (format === 'upstart' && principalIdx >= 0) {
        // Upstart loan format: Principal + Interest = payment amount
        const principal = parseFloat(values[principalIdx]?.replace(/"/g, '').replace(/[$,]/g, '').trim() || '0');
        const interest = parseFloat(values[interestIdx]?.replace(/"/g, '').replace(/[$,]/g, '').trim() || '0');
        amount = Math.abs(principal) + Math.abs(interest);
        type = 'expense'; // Loan payments are expenses
      } else if (format === 'capital_one' && (debitIdx >= 0 || creditIdx >= 0)) {
        // Capital One: separate Debit/Credit columns
        const debit = parseFloat(values[debitIdx]?.replace(/"/g, '').replace(/[$,]/g, '').trim() || '0');
        const credit = parseFloat(values[creditIdx]?.replace(/"/g, '').replace(/[$,]/g, '').trim() || '0');
        
        if (credit > 0) {
          amount = credit;
          type = 'income'; // Credits/payments
        } else {
          amount = Math.abs(debit);
          type = 'expense';
        }
      } else {
        // Standard amount column
        let amountStr = values[amountIdx]?.replace(/"/g, '').replace(/[$,]/g, '').trim() || '0';
        amount = parseFloat(amountStr);
        
        // Determine type based on sign or type column
        if (typeIdx >= 0) {
          const typeStr = values[typeIdx]?.toLowerCase() || '';
          if (typeStr.includes('income') || typeStr.includes('credit') || typeStr.includes('deposit') || typeStr.includes('payment')) {
            type = 'income';
          }
        } else if (amount > 0) {
          // Positive might be income in some formats
          type = amountStr.startsWith('+') ? 'income' : 'expense';
        }
        
        // Handle negative amounts - will check for payments after title is read
        if (amount < 0) {
          amount = Math.abs(amount);
          type = 'expense'; // Default, will be updated below if it's a payment
        }
      }
      
      if (isNaN(amount)) {
        errors.push('Invalid amount');
        amount = 0;
      }
      
      // Get merchant (from dedicated column or fallback to description)
      let merchant = merchantIdx >= 0 ? values[merchantIdx]?.replace(/"/g, '').trim() : '';
      
      // Get description/title
      let title = values[descIdx]?.replace(/"/g, '').trim() || '';
      
      // Now check if this is income or expense based on transaction description
      const titleLower = title.toLowerCase();
      
      // Payments and credits to credit cards should be 'income' (reduces balance)
      const paymentKeywords = ['payment', 'autopay', 'auto pay', 'statement credit'];
      const isPayment = paymentKeywords.some(kw => titleLower.includes(kw));
      
      // Transfers: "transfer from" = money coming IN, "transfer to" = money going OUT
      const isTransferIn = titleLower.includes('transfer from') || titleLower.includes('online transfer from');
      const isTransferOut = titleLower.includes('transfer to') || titleLower.includes('online transfer to');
      
      // Deposits are income
      const isDeposit = titleLower.includes('deposit') || titleLower.includes('direct dep');
      
      // Set type based on transaction nature
      if (isPayment || isTransferIn || isDeposit) {
        type = 'income';
      } else if (isTransferOut) {
        type = 'expense';
      }
      
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
      const categoryStr = values[categoryIdx]?.replace(/"/g, '').trim() || '';
      let category = mapCategory(categoryStr || title);
      
      // Auto-detect loan payments
      const lowerTitle = title.toLowerCase();
      if (lowerTitle.includes('loan') || lowerTitle.includes('upstart') || lowerTitle.includes('sofi') || 
          lowerTitle.includes('lending') || format === 'upstart') {
        category = 'other'; // Loan payments
        type = 'expense';
      }
      
      // Check if this looks like income based on category
      const lowerCategory = categoryStr.toLowerCase();
      if (lowerCategory.includes('income') || lowerCategory.includes('salary') || lowerCategory.includes('paycheck')) {
        type = 'income';
      }
      
      // For credit card payments (credits/refunds), mark as income
      if (lowerTitle.includes('payment') && (lowerTitle.includes('thank you') || lowerTitle.includes('credit'))) {
        type = 'income';
      }
      
      // Get notes/description
      const description = values[notesIdx]?.replace(/"/g, '').trim() || '';
      
      transactions.push({
        date: parsedDate?.toISOString() || new Date().toISOString(),
        title,
        amount: Math.abs(amount),
        type,
        category,
        paymentMethod: 'chase', // Default, user can change
        description,
        merchant: merchant || undefined, // Include merchant if found
        isValid: errors.length === 0,
        errors,
      });
    }
    
    return transactions;
  };
  
  // Parse CSV line handling quoted values
  const parseCSVLine = (line: string): string[] => {
    const values: string[] = [];
    let current = '';
    let inQuotes = false;
    
    for (let i = 0; i < line.length; i++) {
      const char = line[i];
      if (char === '"') {
        inQuotes = !inQuotes;
      } else if (char === ',' && !inQuotes) {
        values.push(current.trim());
        current = '';
      } else {
        current += char;
      }
    }
    values.push(current.trim());
    
    return values;
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
      const lines = content.split('\n').filter(line => line.trim());
      const headers = lines[0]?.split(',').map(h => h.trim().replace(/"/g, '').toLowerCase()) || [];
      
      // Try to detect account from filename and headers
      const detectedAccount = detectAccount(selectedFile.name, headers);
      if (detectedAccount) {
        setSelectedAccountId(detectedAccount.id);
        setDetectedAccountName(detectedAccount.name);
      }
      
      const parsed = parseCSV(content);
      setParsedData(parsed);
    };
    reader.readAsText(selectedFile);
  };

  const handleImport = async () => {
    const validTransactions = parsedData.filter(t => t.isValid);
    if (validTransactions.length === 0) {
      setError('No valid transactions to import');
      return;
    }
    
    setIsLoading(true);
    setError(null);
    
    try {
      // Get the selected account for payment method
      const linkedAccount = profile?.paymentAccounts?.find(a => a.id === selectedAccountId);
      
      const transactionsToAdd: Omit<Transaction, 'id'>[] = validTransactions.map(t => ({
        title: t.title,
        amount: t.amount,
        type: t.type,
        category: t.category,
        paymentMethod: linkedAccount?.provider || t.paymentMethod,
        date: t.date,
        description: t.description,
        merchant: t.merchant,
        accountId: selectedAccountId || undefined, // Link to selected account
        isRecurring: false,
        isProjected: false,
      }));
      
      await addBulkTransactions(transactionsToAdd);
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
              Successfully imported {validCount} transactions
            </p>
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

            {/* Account Linking */}
            {profile?.paymentAccounts && profile.paymentAccounts.length > 0 && (
              <div className="p-4 rounded-lg bg-[var(--background-tertiary)] border border-[var(--border-color)]">
                <div className="flex items-center gap-2 mb-3">
                  <Link2 className="w-4 h-4 text-[var(--accent-primary)]" />
                  <span className="font-medium text-[var(--foreground)]">Link to Account</span>
                  {detectedAccountName && (
                    <span className="text-xs px-2 py-0.5 rounded-full bg-emerald-500/20 text-emerald-500">
                      Auto-detected
                    </span>
                  )}
                </div>
                <p className="text-sm text-[var(--foreground-muted)] mb-3">
                  Link these transactions to an account for better tracking and filtering.
                </p>
                <div className="flex flex-wrap gap-2">
                  <button
                    onClick={() => setSelectedAccountId('')}
                    className={`px-3 py-2 rounded-lg text-sm font-medium transition-all ${
                      !selectedAccountId
                        ? 'bg-[var(--accent-primary)] text-white'
                        : 'bg-[var(--background-secondary)] text-[var(--foreground-secondary)] border border-[var(--border-color)]'
                    }`}
                  >
                    No Link
                  </button>
                  {profile.paymentAccounts.map((account) => (
                    <button
                      key={account.id}
                      onClick={() => setSelectedAccountId(account.id)}
                      className={`px-3 py-2 rounded-lg text-sm font-medium transition-all flex items-center gap-2 ${
                        selectedAccountId === account.id
                          ? 'text-white'
                          : 'text-[var(--foreground-secondary)] border'
                      }`}
                      style={{
                        backgroundColor: selectedAccountId === account.id 
                          ? account.color 
                          : 'var(--background-secondary)',
                        borderColor: selectedAccountId !== account.id ? account.color : 'transparent',
                      }}
                    >
                      <CreditCard className="w-4 h-4" />
                      {account.name}
                      {account.lastFourDigits && <span className="opacity-70">••{account.lastFourDigits}</span>}
                    </button>
                  ))}
                </div>
                {selectedAccountId && (
                  <p className="text-xs text-emerald-500 mt-2">
                    All {validCount} transactions will be linked to this account
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
                      <td className={`p-3 text-right font-medium ${t.type === 'income' ? 'text-emerald-500' : 'text-[var(--foreground)]'}`}>
                        {t.type === 'income' ? '+' : '-'}${t.amount.toFixed(2)}
                      </td>
                      <td className="p-3">
                        <span className={`text-xs px-2 py-1 rounded-full ${t.type === 'income' ? 'bg-emerald-500/20 text-emerald-500' : 'bg-[var(--background-tertiary)] text-[var(--foreground-secondary)]'}`}>
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

