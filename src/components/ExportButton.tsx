'use client';

import React, { useState } from 'react';
import { UserProfile, Transaction, SavingsGoal, DebtPayoffPlan, InflowReview } from '@/types';
import { Download, FileSpreadsheet, Loader2, CheckCircle2, AlertCircle } from 'lucide-react';
import { buildExportWorkbook, workbookToBlob } from '@/lib/export-xlsx';

interface ExportButtonProps {
  profile: UserProfile | null;
  transactions: Transaction[];
  savingsGoals?: SavingsGoal[];
  debtPlan?: DebtPayoffPlan;
  /** `incomeContext.reviews` from UserProfileContext, so the export's Total Income
   *  is the same earned-income total every screen shows. */
  inflowReviews?: Record<string, InflowReview>;
}

export default function ExportButton({
  profile,
  transactions,
  savingsGoals,
  debtPlan,
  inflowReviews,
}: ExportButtonProps) {
  const [isExporting, setIsExporting] = useState(false);
  const [exportStatus, setExportStatus] = useState<'idle' | 'success' | 'error'>('idle');
  
  const handleExport = async () => {
    if (!profile) return;
    
    setIsExporting(true);
    setExportStatus('idle');
    
    try {
      // Built entirely in the browser — no server round-trip, works offline.
      const wb = buildExportWorkbook({
        profile: {
          name: profile.name,
          email: profile.email,
          monthlyBudget: profile.monthlyBudget,
          currency: profile.currency,
          settings: profile.settings,
        },
        accounts: profile.paymentAccounts,
        incomeSources: profile.incomeSources,
        // The same earned-income context every screen uses, so the export's
        // "Total Income" cannot disagree with the Calendar's.
        inflowReviews,
        transactions,
        savingsGoals,
        debtPlan,
      });
      const blob = workbookToBlob(wb);
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `cashflow-export-${new Date().toISOString().split('T')[0]}.xlsx`;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      document.body.removeChild(a);
      
      setExportStatus('success');
      setTimeout(() => setExportStatus('idle'), 3000);
      
    } catch (error) {
      console.error('Export error:', error);
      setExportStatus('error');
      setTimeout(() => setExportStatus('idle'), 3000);
    } finally {
      setIsExporting(false);
    }
  };
  
  return (
    <button
      onClick={handleExport}
      disabled={isExporting || !profile}
      className={`w-full flex items-center justify-between p-4 rounded-card transition-colors ${
        exportStatus === 'success' 
          ? 'bg-emerald-500/10 border border-emerald-500/30' 
          : exportStatus === 'error'
            ? 'bg-red-500/10 border border-red-500/30'
            : 'bg-[var(--background-tertiary)] hover:bg-[var(--background-secondary)]'
      }`}
    >
      <div className="flex items-center gap-4">
        <div className={`w-10 h-10 rounded-card flex items-center justify-center ${
          exportStatus === 'success'
            ? 'bg-emerald-500/20 text-emerald-500'
            : exportStatus === 'error'
              ? 'bg-red-500/20 text-red-500'
              : 'bg-[var(--accent-primary)]/20 text-[var(--accent-primary)]'
        }`}>
          {isExporting ? (
            <Loader2 className="w-5 h-5 animate-spin" />
          ) : exportStatus === 'success' ? (
            <CheckCircle2 className="w-5 h-5" />
          ) : exportStatus === 'error' ? (
            <AlertCircle className="w-5 h-5" />
          ) : (
            <FileSpreadsheet className="w-5 h-5" />
          )}
        </div>
        <div className="text-left">
          <p className={`font-medium ${
            exportStatus === 'success' ? 'text-emerald-500' :
            exportStatus === 'error' ? 'text-red-500' :
            'text-[var(--foreground)]'
          }`}>
            {isExporting ? 'Exporting...' :
             exportStatus === 'success' ? 'Download Complete!' :
             exportStatus === 'error' ? 'Export Failed' :
             'Export to Excel'}
          </p>
          <p className="text-sm text-[var(--foreground-muted)]">
            {exportStatus === 'success' ? 'Your data has been downloaded' :
             exportStatus === 'error' ? 'Please try again' :
             'Download all your data as .xlsx file'}
          </p>
        </div>
      </div>
      
      {!isExporting && exportStatus === 'idle' && (
        <Download className="w-5 h-5 text-[var(--foreground-muted)]" />
      )}
    </button>
  );
}


