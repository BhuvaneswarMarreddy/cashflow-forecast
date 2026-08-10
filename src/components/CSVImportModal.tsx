'use client';

import React, { useState, useRef, useMemo } from 'react';
import { X, Upload, FileText, AlertCircle, CheckCircle, Download, HelpCircle, CreditCard, Building2, Link2, Plus } from 'lucide-react';
import Sheet from '@/components/Sheet';
import * as XLSX from 'xlsx';
import { format as formatDate } from 'date-fns';
import { useTransactions } from '@/context/TransactionContext';
import { useUserProfile } from '@/context/UserProfileContext';
import { findTwin, fingerprintOfRow, mergeFields } from '@/lib/fingerprint';
import { Transaction, TransactionType, ExpenseCategory, PaymentMethod, AccountType, EXPENSE_CATEGORIES, PaymentAccount, getMerchantColor } from '@/types';
import {
  CREATE_ACCOUNT,
  CSV_SOURCE,
  detectFormat,
  inferAccountFromCsv,
  inferAccountType,
  importKey,
  isOutflow,
  isTransferCategory,
  parseAmount,
  parseCsv,
  matchAccountByName as matchAccountByName_,
  detectAccountFromFilename,
  type ParsedTransaction,
} from '@/lib/csv-import';

// Re-exported so the existing import sites and `src/__tests__/csv-import.test.ts`
// keep working now that the implementations live in the shared lib.
export {
  detectFormat,
  inferAccountFromCsv,
  inferAccountType,
  importKey,
  isOutflow,
  isTransferCategory,
  parseAmount,
};

interface CSVImportModalProps {
  isOpen: boolean;
  onClose: () => void;
}

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
  const [enrichedCount, setEnrichedCount] = useState(0);
  const [unchangedCount, setUnchangedCount] = useState(0);
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
  const matchAccountByName = (csvName: string) =>
    matchAccountByName_(csvName, profile?.paymentAccounts ?? []);
  const detectAccount = (filename: string) =>
    detectAccountFromFilename(filename, profile?.paymentAccounts ?? []);

  // Category mapping from common bank categories

  
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
      const { rows: parsed, error: parseError } = parseCsv(content);
      if (parseError) setError(parseError);
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

      // 2. Enrich-or-insert. A row whose importKey already exists was skipped above, so
      //    its stored doc is pre-claimed here: otherwise a genuinely NEW same-amount row
      //    (the second $5.00 coffee that day) would absorb it and one real expense would
      //    vanish. See findTwin's one-to-one contract.
      const claimed = new Set(validTransactions.map(t => t.id).filter(id => alreadyImported.has(id)));
      const inserts: (Omit<Transaction, 'id'> & { id?: string })[] = [];
      const enrichments: (Omit<Transaction, 'id'> & { id?: string })[] = [];
      let unchanged = 0;

      for (const t of fresh) {
        const account = resolve(t.csvAccount);
        const row = {
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

        const twin = findTwin(row, transactions, 3, claimed);
        if (!twin) {
          inserts.push({ ...row, id: t.id, fingerprint: fingerprintOfRow(row), sources: [CSV_SOURCE] });
          continue;
        }
        const patch = mergeFields(twin, row, CSV_SOURCE);
        if (Object.keys(patch).length === 0) {
          unchanged++;
          continue;
        }
        // Rides the same merging bulk write as the inserts — one round trip for the
        // whole file instead of a per-row update for a few thousand enriched rows.
        enrichments.push({ ...twin, ...patch });
      }

      const toWrite = [...inserts, ...enrichments];
      const result = toWrite.length > 0 ? await addBulkTransactions(toWrite) : { persisted: true };
      setSkippedCount(validTransactions.length - fresh.length);
      setImportedCount(inserts.length);
      setEnrichedCount(enrichments.length);
      setUnchangedCount(unchanged);
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
    <Sheet open onClose={onClose} ariaLabel="Import transactions" maxWidth="42rem" className="p-5 sm:p-8">
        <div className="flex justify-between items-center mb-6">
          <h2 className="text-2xl font-bold text-[var(--foreground)]">Import Transactions</h2>
          <button
            onClick={onClose}
            className="p-2 rounded-card text-[var(--foreground-secondary)] hover:bg-[var(--background-tertiary)] transition-colors"
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
            <div className="mt-3 p-4 rounded-control bg-[var(--background-tertiary)] text-sm text-[var(--foreground-secondary)]">
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
            className="border-2 border-dashed border-[var(--border-color)] rounded-card p-8 text-center hover:border-[var(--accent-primary)] transition-colors cursor-pointer"
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
            {/* Enriched rows are the ones this file recognised as already-known charges
                and improved (category, merchant) instead of inserting a second time. */}
            {(enrichedCount > 0 || unchangedCount > 0 || skippedCount > 0) && (
              <p className="text-sm text-[var(--foreground-muted)] mt-2">
                {[
                  enrichedCount > 0 && `${enrichedCount} enriched`,
                  unchangedCount > 0 && `${unchangedCount} already up to date`,
                  skippedCount > 0 && `${skippedCount} already imported`,
                ].filter(Boolean).join(' · ')}
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
              <div className="p-3 rounded-control bg-[var(--background-tertiary)]">
                <p className="text-xs text-[var(--foreground-muted)]">Total Found</p>
                <p className="text-lg font-bold text-[var(--foreground)]">{parsedData.length}</p>
              </div>
              <div className="p-3 rounded-control bg-emerald-500/10">
                <p className="text-xs text-emerald-500">Valid</p>
                <p className="text-lg font-bold text-emerald-500">{validCount}</p>
              </div>
              {invalidCount > 0 && (
                <div className="p-3 rounded-control bg-amber-500/10">
                  <p className="text-xs text-amber-500">Invalid</p>
                  <p className="text-lg font-bold text-amber-500">{invalidCount}</p>
                </div>
              )}
            </div>

            {/* Account Linking — one picker per account found in the file. Each label
                defaults to "Create" so importing a file also creates its account
                (typed from the name); the user can relink or unlink any of them. */}
            {(csvAccounts.length > 0 || (profile?.paymentAccounts?.length ?? 0) > 0) && (
              <div className="p-4 rounded-control bg-[var(--background-tertiary)] border border-[var(--border-color)] space-y-4">
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
                            className={`px-3 py-2 rounded-control text-sm font-medium transition-all flex items-center gap-2 ${
                              isCreating
                                ? 'bg-[var(--accent-primary)] text-[#16181c]'
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
                            className={`px-3 py-2 rounded-control text-sm font-medium transition-all flex items-center gap-2 ${
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
                          className={`px-3 py-2 rounded-control text-sm font-medium transition-all ${
                            current === ''
                              ? 'bg-[var(--accent-primary)] text-[#16181c]'
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
                                className={`px-3 py-1 rounded-control text-xs font-medium flex items-center gap-2 transition-all ${
                                  createType === t
                                    ? 'bg-[var(--accent-primary)] text-[#16181c]'
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
            <div className="max-h-[300px] overflow-y-auto rounded-control border border-[var(--border-color)]">
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
                        <span className={`text-xs px-2 py-1 rounded-pill ${t.type === 'income' ? 'bg-emerald-500/20 text-emerald-500' : t.type === 'transfer' ? 'bg-amber-500/20 text-amber-400' : 'bg-[var(--background-tertiary)] text-[var(--foreground-secondary)]'}`}>
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
              <div className="p-3 rounded-control bg-red-500/10 border border-red-500/30 flex items-center gap-2">
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
                  <div className="w-4 h-4 border-2 border-current border-t-transparent rounded-pill animate-spin" />
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
    </Sheet>
  );
}

