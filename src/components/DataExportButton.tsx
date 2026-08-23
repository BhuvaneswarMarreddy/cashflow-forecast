'use client';

import React, { useState } from 'react';
import { Download, Loader2, CheckCircle2, AlertCircle } from 'lucide-react';

interface DataExportButtonProps {
  userId: string | undefined;
}

/**
 * Issue #144 — the full decision layer, not the Excel summary `ExportButton` produces:
 * every `USER_SUBCOLLECTIONS` collection, as one JSON file that round-trips. Built
 * client-side, straight from Firestore.
 *
 * `buildUserDataExport` throws rather than swallowing a failed read, so the catch below
 * is the ONLY place a partial export could leak out — and it downloads nothing. A file
 * only ever reaches disk after every collection has already succeeded.
 */
export default function DataExportButton({ userId }: DataExportButtonProps) {
  const [status, setStatus] = useState<'idle' | 'busy' | 'success' | 'error'>('idle');

  const handleExport = async () => {
    if (!userId) return;
    setStatus('busy');
    try {
      const { buildUserDataExport, serializeUserDataExport } = await import('@/lib/data-export');
      const data = await buildUserDataExport(userId);
      const json = serializeUserDataExport(data);
      const blob = new Blob([json], { type: 'application/json' });
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `cashflow-full-export-${new Date().toISOString().split('T')[0]}.json`;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      document.body.removeChild(a);
      setStatus('success');
      setTimeout(() => setStatus('idle'), 3000);
    } catch (error) {
      console.error('Full data export failed:', error);
      setStatus('error');
      setTimeout(() => setStatus('idle'), 3000);
    }
  };

  return (
    <button
      onClick={handleExport}
      disabled={status === 'busy' || !userId}
      className={`w-full flex items-center justify-between p-4 rounded-card transition-colors ${
        status === 'success'
          ? 'bg-emerald-500/10 border border-emerald-500/30'
          : status === 'error'
            ? 'bg-red-500/10 border border-red-500/30'
            : 'bg-[var(--background-tertiary)] hover:bg-[var(--background-secondary)]'
      }`}
    >
      <div className="flex items-center gap-4">
        <div
          className={`w-10 h-10 rounded-card flex items-center justify-center ${
            status === 'success'
              ? 'bg-emerald-500/20 text-emerald-500'
              : status === 'error'
                ? 'bg-red-500/20 text-red-500'
                : 'bg-[var(--accent-primary)]/20 text-[var(--accent-primary)]'
          }`}
        >
          {status === 'busy' ? (
            <Loader2 className="w-5 h-5 animate-spin" />
          ) : status === 'success' ? (
            <CheckCircle2 className="w-5 h-5" />
          ) : status === 'error' ? (
            <AlertCircle className="w-5 h-5" />
          ) : (
            <Download className="w-5 h-5" />
          )}
        </div>
        <div className="text-left">
          <p
            className={`font-medium ${
              status === 'success'
                ? 'text-emerald-500'
                : status === 'error'
                  ? 'text-red-500'
                  : 'text-[var(--foreground)]'
            }`}
          >
            {status === 'busy'
              ? 'Preparing your export…'
              : status === 'success'
                ? 'Download complete'
                : status === 'error'
                  ? 'Export failed — nothing was downloaded'
                  : 'Export everything (JSON)'}
          </p>
          <p className="text-sm text-[var(--foreground-muted)]">
            {status === 'error'
              ? 'A collection failed to read, so no file was written. Check your connection and try again.'
              : 'Every transaction, account, rule, review, bill, goal and setting — your full personal financial history — as one file you can keep or move elsewhere.'}
          </p>
        </div>
      </div>
    </button>
  );
}
