'use client';

/**
 * Developer-only provenance panel for the Accounts page: the trace id plus, for each
 * headline number, what produced it. Renders nothing at all unless diagnostics are
 * enabled (development/test, or an explicit NEXT_PUBLIC_OBS_LEVEL) — in production
 * this component returns null before it reads anything.
 */

import React from 'react';
import { AccountsProvenance } from '@/lib/obs/provenance';
import { isEnabled } from '@/lib/obs/events';

export default function AccountsDiagnostics({ traceId, provenance, onOpen }: {
  traceId: string;
  provenance: AccountsProvenance | null;
  onOpen: () => void;
}) {
  if (!isEnabled() || !traceId) return null;

  return (
    <details
      className="mb-6 rounded-control border border-[var(--border)] bg-[var(--background-tertiary)] text-sm"
      data-testid="accounts-diagnostics"
      data-trace-id={traceId}
      onToggle={(e) => { if ((e.currentTarget as HTMLDetailsElement).open) onOpen(); }}
    >
      <summary className="cursor-pointer px-4 py-2 text-[var(--foreground-secondary)]">
        Diagnostics · trace <code data-testid="accounts-trace-id">{traceId}</code>
      </summary>

      {provenance && (
        <div className="px-4 pb-4 space-y-3">
          <p className="text-xs text-[var(--foreground-muted)]">
            {provenance.calculationName} {provenance.calculationVersion} · source {provenance.dataSource} · cache{' '}
            {provenance.cacheStatus} · {provenance.accountCount} accounts / {provenance.transactionCount} transactions ·
            last sync {provenance.lastSourceSync ?? 'unknown'} ({provenance.lastSyncSource}) · {provenance.staleness}
          </p>

          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="text-[var(--foreground-muted)] text-left">
                <tr><th className="py-1 pr-3">Metric</th><th className="py-1 pr-3">Value</th><th className="py-1 pr-3">Included</th><th className="py-1 pr-3">Excluded</th><th className="py-1">Types</th></tr>
              </thead>
              <tbody className="text-[var(--foreground-secondary)]">
                {provenance.metrics.map((m) => (
                  <tr key={m.metric} data-testid={`provenance-${m.metric}`}>
                    <td className="py-1 pr-3">{m.metric}</td>
                    <td className="py-1 pr-3 tabular-nums">{m.displayedValue.toLocaleString()}</td>
                    <td className="py-1 pr-3">{m.includedAccountCount}</td>
                    <td className="py-1 pr-3">
                      {m.excludedAccountCount}
                      {m.excludedAccountCount > 0 && ` (${Object.entries(m.exclusionReasons).map(([r, n]) => `${r}×${n}`).join(', ')})`}
                    </td>
                    <td className="py-1">{m.includedAccountTypes.join(', ') || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <ul className="text-xs text-[var(--foreground-muted)] list-disc pl-4 space-y-1">
            {provenance.limitations.map((l) => <li key={l}>{l}</li>)}
          </ul>

          <p className="text-xs text-[var(--foreground-muted)]">
            Correlated backend evidence: <code>GET /api/diagnostics/trace?traceId={traceId}</code>
          </p>
        </div>
      )}
    </details>
  );
}
