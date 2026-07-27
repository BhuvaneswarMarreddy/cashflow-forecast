'use client';

import React, { useState, useRef } from 'react';
import { 
  X, 
  Camera, 
  Upload, 
  FileImage, 
  Loader2, 
  CheckCircle, 
  AlertCircle,
  Trash2,
  Plus,
  Sparkles
} from 'lucide-react';
import { useTransactions } from '@/context/TransactionContext';
import { useUserProfile } from '@/context/UserProfileContext';
import { Transaction, EXPENSE_CATEGORIES, ExpenseCategory, PAYMENT_METHODS, PaymentMethod } from '@/types';
import Sheet from '@/components/Sheet';

interface ReceiptScannerModalProps {
  isOpen: boolean;
  onClose: () => void;
}

interface ParsedTransaction {
  date: string;
  title: string;
  merchant?: string;
  amount: number;
  type: 'income' | 'expense';
  category: ExpenseCategory;
  paymentMethod?: string;
  lastFourDigits?: string;
  tax?: number;
  tip?: number;
  subtotal?: number;
  orderNumber?: string;
  confidence?: 'high' | 'medium' | 'low';
  selected?: boolean;
}

export default function ReceiptScannerModal({ isOpen, onClose }: ReceiptScannerModalProps) {
  const { addBulkTransactions } = useTransactions();
  const { profile } = useUserProfile();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const cameraInputRef = useRef<HTMLInputElement>(null);

  const [imagePreview, setImagePreview] = useState<string | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [parsedTransactions, setParsedTransactions] = useState<ParsedTransaction[]>([]);
  const [summary, setSummary] = useState<string>('');
  const [documentType, setDocumentType] = useState<string>('');
  const [detectedMerchant, setDetectedMerchant] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const [isImporting, setIsImporting] = useState(false);
  const [importSuccess, setImportSuccess] = useState(false);

  // Map detected payment method to our payment methods
  const mapPaymentMethod = (detected?: string, lastFour?: string): PaymentMethod => {
    if (!detected) return 'chase';
    const lower = detected.toLowerCase();
    if (lower.includes('visa')) return 'visa';
    if (lower.includes('mastercard') || lower.includes('master')) return 'mastercard';
    if (lower.includes('amex') || lower.includes('american express')) return 'amex';
    if (lower.includes('discover')) return 'discover';
    if (lower.includes('apple')) return 'apple';
    if (lower.includes('chase')) return 'chase';
    if (lower.includes('cash')) return 'cash';
    if (lower.includes('bank') || lower.includes('transfer')) return 'bank-transfer';
    
    // Try to match with user's accounts by last 4 digits
    if (lastFour && profile?.paymentAccounts) {
      const matchedAccount = profile.paymentAccounts.find(a => a.lastFourDigits === lastFour);
      if (matchedAccount) return matchedAccount.provider;
    }
    
    return 'other';
  };

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const selectedFile = e.target.files?.[0];
    if (!selectedFile) return;

    // Validate file type
    const validTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'application/pdf'];
    if (!validTypes.includes(selectedFile.type)) {
      setError('Please select an image (JPG, PNG, GIF, WebP) or PDF file');
      return;
    }

    // Validate file size (max 10MB)
    if (selectedFile.size > 10 * 1024 * 1024) {
      setError('File size must be less than 10MB');
      return;
    }

    setFile(selectedFile);
    setError(null);
    setParsedTransactions([]);
    setSummary('');
    setImportSuccess(false);

    // Create preview for images
    if (selectedFile.type.startsWith('image/')) {
      const reader = new FileReader();
      reader.onload = (e) => {
        setImagePreview(e.target?.result as string);
      };
      reader.readAsDataURL(selectedFile);
    } else {
      setImagePreview(null);
    }

    // Auto-process the file
    await processFile(selectedFile);
  };

  const processFile = async (fileToProcess: File) => {
    setIsProcessing(true);
    setError(null);

    try {
      const formData = new FormData();
      formData.append('file', fileToProcess);

      const response = await fetch('/api/parse-receipt', {
        method: 'POST',
        body: formData,
      });

      const data = await response.json();

      if (!response.ok) {
        setError(data.error || 'Failed to parse receipt');
        return;
      }

      if (data.parsed?.transactions?.length > 0) {
        // Mark all as selected by default and enhance with matched payment methods
        const documentMerchant = data.parsed.merchant || '';
        const transactions = data.parsed.transactions.map((t: ParsedTransaction) => ({
          ...t,
          selected: true,
          date: t.date || new Date().toISOString().split('T')[0],
          title: t.title || (t.merchant ? `${t.merchant} Purchase` : 'Purchase'),
          merchant: t.merchant || documentMerchant || undefined, // Keep merchant as separate field
          paymentMethod: mapPaymentMethod(t.paymentMethod, t.lastFourDigits),
        }));
        setParsedTransactions(transactions);
        setSummary(data.parsed.summary || `Found ${transactions.length} transaction(s)`);
        setDocumentType(data.parsed.documentType || '');
        setDetectedMerchant(documentMerchant);
      } else {
        setSummary(data.parsed?.summary || 'No transactions found in this image');
        setParsedTransactions([]);
      }
    } catch (err) {
      console.error('Process error:', err);
      setError('Failed to process the image. Please try again.');
    } finally {
      setIsProcessing(false);
    }
  };

  const handleImport = async () => {
    const selectedTransactions = parsedTransactions.filter(t => t.selected);
    if (selectedTransactions.length === 0) {
      setError('Please select at least one transaction to import');
      return;
    }

    setIsImporting(true);
    setError(null);

    try {
      const transactionsToAdd: Omit<Transaction, 'id'>[] = selectedTransactions.map(t => ({
        title: t.title,
        amount: t.amount,
        type: t.type,
        category: t.category,
        paymentMethod: (t.paymentMethod as PaymentMethod) || 'chase',
        date: new Date(t.date).toISOString(),
        merchant: t.merchant || detectedMerchant || undefined, // Include merchant
        description: [
          'Scanned receipt',
          t.orderNumber ? `Order: ${t.orderNumber}` : '',
          t.lastFourDigits ? `Card: ****${t.lastFourDigits}` : '',
        ].filter(Boolean).join(' | '),
        isRecurring: false,
        isProjected: false,
      }));

      await addBulkTransactions(transactionsToAdd);
      setImportSuccess(true);

      // Close after delay
      setTimeout(() => {
        handleReset();
        onClose();
      }, 2000);
    } catch (err) {
      setError('Failed to import transactions');
      console.error(err);
    } finally {
      setIsImporting(false);
    }
  };

  const toggleTransaction = (index: number) => {
    setParsedTransactions(prev => 
      prev.map((t, i) => i === index ? { ...t, selected: !t.selected } : t)
    );
  };

  const updateTransaction = (index: number, field: keyof ParsedTransaction, value: any) => {
    setParsedTransactions(prev =>
      prev.map((t, i) => i === index ? { ...t, [field]: value } : t)
    );
  };

  const removeTransaction = (index: number) => {
    setParsedTransactions(prev => prev.filter((_, i) => i !== index));
  };

  const handleReset = () => {
    setFile(null);
    setImagePreview(null);
    setParsedTransactions([]);
    setSummary('');
    setDocumentType('');
    setDetectedMerchant('');
    setError(null);
    setImportSuccess(false);
    if (fileInputRef.current) fileInputRef.current.value = '';
    if (cameraInputRef.current) cameraInputRef.current.value = '';
  };

  if (!isOpen) return null;

  const selectedCount = parsedTransactions.filter(t => t.selected).length;

  return (
    <Sheet open onClose={onClose} ariaLabel="Scan receipt" maxWidth="42rem" className="p-5 sm:p-8">
        <div className="flex justify-between items-center mb-6 sticky top-0 bg-[var(--background-secondary)] pb-4 -mt-2 pt-2">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg bg-gradient-to-br from-[var(--accent-primary)] to-[var(--accent-secondary)] flex items-center justify-center">
              <Sparkles className="w-5 h-5 text-white" />
            </div>
            <div>
              <h2 className="text-xl font-bold text-[var(--foreground)]">Scan Receipt</h2>
              <p className="text-sm text-[var(--foreground-muted)]">AI-powered receipt parsing</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-2 rounded-xl text-[var(--foreground-secondary)] hover:bg-[var(--background-tertiary)] transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Success State */}
        {importSuccess && (
          <div className="text-center py-8">
            <CheckCircle className="w-16 h-16 mx-auto mb-4 text-emerald-500" />
            <p className="text-xl font-semibold text-[var(--foreground)]">
              Successfully imported {selectedCount} transaction(s)
            </p>
          </div>
        )}

        {/* Upload Area */}
        {!file && !importSuccess && (
          <div className="space-y-4">
            {/* Camera Button (Mobile) */}
            <button
              onClick={() => cameraInputRef.current?.click()}
              className="w-full p-6 rounded-xl border-2 border-dashed border-[var(--accent-primary)] bg-[var(--accent-primary)]/5 hover:bg-[var(--accent-primary)]/10 transition-colors flex flex-col items-center gap-3"
            >
              <Camera className="w-10 h-10 text-[var(--accent-primary)]" />
              <span className="font-medium text-[var(--foreground)]">Take Photo</span>
              <span className="text-sm text-[var(--foreground-muted)]">Use camera to capture receipt</span>
            </button>

            {/* File Upload */}
            <button
              onClick={() => fileInputRef.current?.click()}
              className="w-full p-6 rounded-xl border-2 border-dashed border-[var(--border-color)] hover:border-[var(--accent-primary)] transition-colors flex flex-col items-center gap-3"
            >
              <FileImage className="w-10 h-10 text-[var(--foreground-muted)]" />
              <span className="font-medium text-[var(--foreground)]">Upload Image</span>
              <span className="text-sm text-[var(--foreground-muted)]">PNG, JPG, or PDF up to 10MB</span>
            </button>

            <input
              ref={fileInputRef}
              type="file"
              accept="image/*,application/pdf"
              onChange={handleFileSelect}
              className="hidden"
            />
            <input
              ref={cameraInputRef}
              type="file"
              accept="image/*"
              capture="environment"
              onChange={handleFileSelect}
              className="hidden"
            />

            <p className="text-center text-sm text-[var(--foreground-muted)]">
              Supports receipts, bank statements, and screenshots from any banking app
            </p>
          </div>
        )}

        {/* Processing State */}
        {isProcessing && (
          <div className="text-center py-12">
            <Loader2 className="w-12 h-12 mx-auto mb-4 text-[var(--accent-primary)] animate-spin" />
            <p className="text-lg font-medium text-[var(--foreground)]">Analyzing image...</p>
            <p className="text-sm text-[var(--foreground-muted)]">AI is extracting transaction data</p>
          </div>
        )}

        {/* Image Preview & Results */}
        {file && !isProcessing && !importSuccess && (
          <div className="space-y-6">
            {/* Preview */}
            {imagePreview && (
              <div className="relative rounded-xl overflow-hidden border border-[var(--border-color)]">
                <img 
                  src={imagePreview} 
                  alt="Receipt preview" 
                  className="w-full max-h-[200px] object-contain bg-[var(--background-tertiary)]"
                />
                <button
                  onClick={handleReset}
                  className="absolute top-2 right-2 p-2 rounded-lg bg-black/50 text-white hover:bg-black/70 transition-colors"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            )}

            {/* Summary with document info */}
            {summary && (
              <div className="p-4 rounded-lg bg-[var(--background-tertiary)] border border-[var(--border-color)]">
                <div className="flex flex-wrap items-center gap-2 mb-2">
                  {documentType && (
                    <span className="text-xs px-2 py-1 rounded-full bg-[var(--accent-primary)]/20 text-[var(--accent-primary)]">
                      {documentType.replace('_', ' ')}
                    </span>
                  )}
                  {detectedMerchant && (
                    <span className="text-xs px-2 py-1 rounded-full bg-emerald-500/20 text-emerald-500">
                      {detectedMerchant}
                    </span>
                  )}
                </div>
                <p className="text-sm text-[var(--foreground-secondary)]">{summary}</p>
              </div>
            )}

            {/* Error */}
            {error && (
              <div className="p-4 rounded-lg bg-red-500/10 border border-red-500/30 flex items-center gap-3">
                <AlertCircle className="w-5 h-5 text-red-500 flex-shrink-0" />
                <p className="text-sm text-red-400">{error}</p>
              </div>
            )}

            {/* Parsed Transactions */}
            {parsedTransactions.length > 0 && (
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <p className="font-medium text-[var(--foreground)]">
                    Found {parsedTransactions.length} transaction(s)
                  </p>
                  <p className="text-sm text-[var(--foreground-muted)]">
                    {selectedCount} selected
                  </p>
                </div>

                <div className="space-y-2 max-h-[300px] overflow-y-auto">
                  {parsedTransactions.map((txn, index) => (
                    <div
                      key={index}
                      className={`p-4 rounded-lg border transition-all ${
                        txn.selected 
                          ? 'bg-[var(--accent-primary)]/5 border-[var(--accent-primary)]/30' 
                          : 'bg-[var(--background-tertiary)] border-[var(--border-color)] opacity-60'
                      }`}
                    >
                      <div className="flex items-start gap-3">
                        {/* Checkbox */}
                        <input
                          type="checkbox"
                          checked={txn.selected}
                          onChange={() => toggleTransaction(index)}
                          className="mt-1 w-5 h-5 rounded border-[var(--border-color)] bg-[var(--background-tertiary)] text-[var(--accent-primary)] focus:ring-[var(--accent-primary)] cursor-pointer"
                        />

                        {/* Transaction Details */}
                        <div className="flex-1 space-y-2">
                          <div className="flex flex-col sm:flex-row sm:items-center gap-2">
                            <input
                              type="text"
                              value={txn.title}
                              onChange={(e) => updateTransaction(index, 'title', e.target.value)}
                              placeholder="Title"
                              className="flex-1 px-3 py-1.5 rounded-lg bg-[var(--background)] border border-[var(--border-color)] text-sm text-[var(--foreground)] focus:outline-none focus:border-[var(--accent-primary)]"
                            />
                            <input
                              type="text"
                              value={txn.merchant || ''}
                              onChange={(e) => updateTransaction(index, 'merchant', e.target.value)}
                              placeholder="Merchant (Amazon, Walmart...)"
                              className="w-40 px-3 py-1.5 rounded-lg bg-[var(--background)] border border-[var(--border-color)] text-sm text-[var(--foreground)] focus:outline-none focus:border-[var(--accent-primary)]"
                            />
                            <input
                              type="date"
                              value={txn.date}
                              onChange={(e) => updateTransaction(index, 'date', e.target.value)}
                              className="px-3 py-1.5 rounded-lg bg-[var(--background)] border border-[var(--border-color)] text-sm text-[var(--foreground)] focus:outline-none focus:border-[var(--accent-primary)]"
                            />
                          </div>

                          <div className="flex flex-col sm:flex-row items-start sm:items-center gap-2">
                            <div className="flex items-center gap-2">
                              <select
                                value={txn.type}
                                onChange={(e) => updateTransaction(index, 'type', e.target.value)}
                                className="px-3 py-1.5 rounded-lg bg-[var(--background)] border border-[var(--border-color)] text-sm text-[var(--foreground)] focus:outline-none focus:border-[var(--accent-primary)]"
                              >
                                <option value="expense">Expense</option>
                                <option value="income">Income</option>
                              </select>
                              <div className="relative">
                                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--foreground-muted)]">$</span>
                                <input
                                  type="number"
                                  value={txn.amount}
                                  onChange={(e) => updateTransaction(index, 'amount', parseFloat(e.target.value) || 0)}
                                  className="w-24 pl-7 pr-3 py-1.5 rounded-lg bg-[var(--background)] border border-[var(--border-color)] text-sm text-[var(--foreground)] focus:outline-none focus:border-[var(--accent-primary)]"
                                />
                              </div>
                            </div>

                            <select
                              value={txn.category}
                              onChange={(e) => updateTransaction(index, 'category', e.target.value)}
                              className="flex-1 px-3 py-1.5 rounded-lg bg-[var(--background)] border border-[var(--border-color)] text-sm text-[var(--foreground)] focus:outline-none focus:border-[var(--accent-primary)]"
                            >
                              {EXPENSE_CATEGORIES.map((cat) => (
                                <option key={cat.value} value={cat.value}>
                                  {cat.icon} {cat.label}
                                </option>
                              ))}
                            </select>
                          </div>

                          {/* Payment Method Row */}
                          <div className="flex flex-col sm:flex-row items-start sm:items-center gap-2 mt-2">
                            <select
                              value={txn.paymentMethod || 'chase'}
                              onChange={(e) => updateTransaction(index, 'paymentMethod', e.target.value)}
                              className="flex-1 px-3 py-1.5 rounded-lg bg-[var(--background)] border border-[var(--border-color)] text-sm text-[var(--foreground)] focus:outline-none focus:border-[var(--accent-primary)]"
                            >
                              {profile?.paymentAccounts && profile.paymentAccounts.length > 0 ? (
                                <>
                                  <option value="" disabled>-- Your Accounts --</option>
                                  {profile.paymentAccounts.map((acc) => (
                                    <option key={acc.id} value={acc.provider}>
                                      {acc.name} {acc.lastFourDigits ? `(****${acc.lastFourDigits})` : ''}
                                    </option>
                                  ))}
                                  <option value="" disabled>-- Other --</option>
                                </>
                              ) : null}
                              {PAYMENT_METHODS.map((method) => (
                                <option key={method.value} value={method.value}>
                                  {method.label}
                                </option>
                              ))}
                            </select>
                            {txn.lastFourDigits && (
                              <span className="text-xs text-[var(--foreground-muted)] px-2 py-1 bg-[var(--background)] rounded">
                                Detected: ****{txn.lastFourDigits}
                              </span>
                            )}
                            {txn.confidence && (
                              <span className={`text-xs px-2 py-1 rounded ${
                                txn.confidence === 'high' ? 'bg-emerald-500/20 text-emerald-500' :
                                txn.confidence === 'medium' ? 'bg-amber-500/20 text-amber-500' :
                                'bg-red-500/20 text-red-500'
                              }`}>
                                {txn.confidence} confidence
                              </span>
                            )}
                          </div>
                        </div>

                        {/* Delete */}
                        <button
                          onClick={() => removeTransaction(index)}
                          className="p-2 rounded-lg text-[var(--foreground-muted)] hover:text-red-500 hover:bg-red-500/10 transition-colors"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Actions */}
            <div className="flex gap-3 pt-4 border-t border-[var(--border-color)]">
              <button
                onClick={handleReset}
                className="btn-secondary flex-1"
              >
                Scan Another
              </button>
              {parsedTransactions.length > 0 && (
                <button
                  onClick={handleImport}
                  disabled={isImporting || selectedCount === 0}
                  className="btn-primary flex-1 flex items-center justify-center gap-2 disabled:opacity-50"
                >
                  {isImporting ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin" />
                      Importing...
                    </>
                  ) : (
                    <>
                      <Plus className="w-4 h-4" />
                      Import {selectedCount} Transaction(s)
                    </>
                  )}
                </button>
              )}
            </div>
          </div>
        )}
    </Sheet>
  );
}

