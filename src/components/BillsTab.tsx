'use client';

/**
 * Bills register (BILLS-001) — the manual source of truth for recurring
 * obligations, driving the autopay migration (credit cards → BofA debit).
 *
 * Deliberately manual: no recurrence inference, no transaction matching.
 * The owner validates every row. Money math lives in src/lib/bills.ts.
 */

import React, { useEffect, useMemo, useState } from 'react';
import {
  Bill,
  BillFrequency,
  LifecycleStatus,
  MigrationStatus,
  PAYMENT_METHODS,
  billsOnRetiredMethods,
  migrationSummary,
  monthlyCost,
  nonNegotiableMonthly,
  spendBreakdown,
  totalMonthlyCost,
} from '@/lib/bills';
import * as firestoreService from '@/lib/firestore';
import { formatMoney } from '@/lib/money';
import { useTransactions } from '@/context/TransactionContext';
import type { Transaction } from '@/types';
import { format } from 'date-fns';
import starterRows from '@/data/bills-starter.json';
import {
  AlertTriangle,
  Check,
  ChevronDown,
  ExternalLink,
  Lock,
  Pencil,
  Plus,
  Receipt,
  X,
} from 'lucide-react';

const FREQUENCIES: BillFrequency[] = ['weekly', 'biweekly', 'monthly', 'quarterly', 'semiannual', 'annual'];

const MIGRATION_LABELS: Record<MigrationStatus, string> = {
  'to-review': 'To review',
  'to-switch': 'To switch',
  switched: 'Switched',
  exception: 'Exception — stays on card',
  'no-change-needed': 'No change needed',
};

const LIFECYCLE_LABELS: Record<LifecycleStatus, string> = {
  active: 'Active',
  'cancel-planned': 'Cancel planned',
  cancelled: 'Cancelled',
};

type Filter = 'all' | 'todo' | 'done' | 'exceptions' | 'cancelled' | 'retired-cards';

// "Autopay to-do", not "To do": the filter tracks the autopay-migration
// checklist, and the shorter label read as a transaction list to the owner.
const FILTERS: Array<{ id: Filter; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'todo', label: 'Autopay to-do' },
  { id: 'done', label: 'Autopay done' },
  { id: 'exceptions', label: 'Exceptions' },
  { id: 'cancelled', label: 'Cancelled' },
];

function matchesFilter(bill: Bill, filter: Filter): boolean {
  switch (filter) {
    case 'all':
      return true;
    case 'todo':
      return bill.migrationStatus === 'to-switch' || bill.migrationStatus === 'to-review';
    case 'done':
      return bill.migrationStatus === 'switched' || bill.migrationStatus === 'no-change-needed';
    case 'exceptions':
      return bill.migrationStatus === 'exception';
    case 'cancelled':
      return bill.lifecycleStatus === 'cancelled';
    case 'retired-cards':
      return billsOnRetiredMethods([bill]).length > 0;
  }
}

interface BillsTabProps {
  userId: string;
  /** Fixture escape hatch for /dev routes and e2e — skips Firestore entirely. */
  initialBills?: Bill[];
  /** Fixture escape hatch: drill-down data without the transactions context. */
  initialTransactions?: Transaction[];
}

export default function BillsTab({ userId, initialBills, initialTransactions }: BillsTabProps) {
  const [bills, setBills] = useState<Bill[]>(initialBills ?? []);
  const [loading, setLoading] = useState(!initialBills);
  const [seeding, setSeeding] = useState(false);
  const [filter, setFilter] = useState<Filter>('all');
  const [annualView, setAnnualView] = useState(false);
  const [editing, setEditing] = useState<Bill | 'new' | null>(null);
  const [statusMenuFor, setStatusMenuFor] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const { transactions: ctxTransactions } = useTransactions();
  const transactions = initialTransactions ?? ctxTransactions;

  useEffect(() => {
    if (initialBills) return;
    let alive = true;
    firestoreService.getBills(userId).then((rows) => {
      if (!alive) return;
      setBills(rows);
      setLoading(false);
    });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fixture prop is mount-time only
  }, [userId]);

  const summary = useMemo(() => migrationSummary(bills), [bills]);
  const retired = useMemo(() => billsOnRetiredMethods(bills), [bills]);
  const total = useMemo(() => totalMonthlyCost(bills), [bills]);

  // Live actuals behind every matcher row (target-vs-actual on the row face),
  // and the full breakdown for whichever row is expanded.
  const actuals = useMemo(() => {
    const map = new Map<string, number>();
    const now = new Date();
    for (const b of bills) {
      if (b.matcher) map.set(b.id, spendBreakdown(b.matcher, transactions, now).actualMonthly);
    }
    return map;
  }, [bills, transactions]);
  const expandedBreakdown = useMemo(() => {
    const b = bills.find(x => x.id === expandedId);
    if (!b?.matcher) return null;
    return spendBreakdown(b.matcher, transactions, new Date());
  }, [expandedId, bills, transactions]);

  const visible = useMemo(
    () =>
      bills
        .filter((b) => matchesFilter(b, filter))
        .sort((a, b) => monthlyCost(b) - monthlyCost(a)),
    [bills, filter]
  );

  const factor = annualView ? 12 : 1;
  const money = (n: number) => formatMoney(n * factor, 'USD', 2);
  const per = annualView ? '/yr' : '/mo';

  const handleSeed = async () => {
    setSeeding(true);
    try {
      await firestoreService.seedBills(userId, starterRows as Array<Omit<Bill, 'id' | 'createdAt' | 'updatedAt'>>);
      setBills(await firestoreService.getBills(userId));
    } catch (err) {
      console.error('Seeding failed:', err);
    } finally {
      setSeeding(false);
    }
  };

  const applyUpdate = async (billId: string, updates: Partial<Bill>) => {
    // Optimistic: the register is single-owner, conflicts are not a real risk.
    setBills((prev) => prev.map((b) => (b.id === billId ? { ...b, ...updates } : b)));
    try {
      await firestoreService.updateBill(userId, billId, updates);
    } catch (err) {
      console.error('Update failed, reloading:', err);
      setBills(await firestoreService.getBills(userId));
    }
  };

  const handleSave = async (draft: Omit<Bill, 'id' | 'createdAt' | 'updatedAt'>, existingId?: string) => {
    if (existingId) {
      await applyUpdate(existingId, draft);
    } else {
      try {
        const id = await firestoreService.addBill(userId, { ...draft, source: 'manual' });
        const now = new Date().toISOString();
        setBills((prev) => [...prev, { ...draft, source: 'manual', id, createdAt: now, updatedAt: now }]);
      } catch (err) {
        console.error('Add failed:', err);
      }
    }
    setEditing(null);
  };

  const handleDelete = async (billId: string) => {
    if (!window.confirm('Delete this bill permanently? Mark it Cancelled instead if it just ended.')) return;
    setBills((prev) => prev.filter((b) => b.id !== billId));
    setEditing(null);
    try {
      await firestoreService.deleteBill(userId, billId);
    } catch (err) {
      console.error('Delete failed, reloading:', err);
      setBills(await firestoreService.getBills(userId));
    }
  };

  if (loading) {
    return (
      <div className="glass-card p-6 animate-pulse text-[var(--foreground-secondary)]">
        Loading bills…
      </div>
    );
  }

  if (bills.length === 0) {
    return (
      <div className="glass-card p-8 text-center">
        <Receipt className="w-10 h-10 mx-auto mb-3 text-[var(--foreground-muted)]" />
        <h3 className="text-lg font-semibold text-[var(--foreground)] mb-2">No bills yet</h3>
        <p className="text-sm text-[var(--foreground-secondary)] mb-6 max-w-md mx-auto">
          Start from the audited list of 28 recurring obligations found in your transaction
          history, then validate each one as you migrate autopay to your BofA debit card.
        </p>
        <div className="flex items-center justify-center gap-3">
          <button onClick={handleSeed} disabled={seeding} className="btn-primary px-5 py-3 rounded-control font-semibold">
            {seeding ? 'Importing…' : 'Import starter list (28)'}
          </button>
          <button onClick={() => setEditing('new')} className="btn-secondary px-5 py-3 rounded-control font-semibold">
            Add manually
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Header: financial total + migration progress */}
      <div className="glass-card p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="flex items-baseline gap-2">
              <h2 className="text-lg font-semibold text-[var(--foreground)]">Recurring bills</h2>
              <span className="text-2xl font-bold text-[var(--foreground)]">{money(total)}</span>
              <span className="text-sm text-[var(--foreground-muted)]">{per}</span>
            </div>
            <p className="text-sm text-[var(--foreground-secondary)] mt-1">
              {money(summary.switchedMonthly)} switched · {money(summary.onCardsMonthly)} still on cards ·{' '}
              {money(summary.exceptionMonthly)} exceptions
            </p>
            {nonNegotiableMonthly(bills) > 0 && (
              <p className="text-sm text-[var(--foreground-secondary)] mt-1 flex items-center gap-1">
                <Lock className="w-3.5 h-3.5" />
                {money(nonNegotiableMonthly(bills))}{per} non-negotiable — reserved first in every plan
              </p>
            )}
            <p className="text-sm text-[var(--foreground-secondary)] mt-2">
              <span className="font-semibold text-[var(--foreground)]">
                Autopay migration: {summary.completed} / {summary.total} done
              </span>
              {' · '}{summary.remaining} remaining · {summary.exceptions} exceptions
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setAnnualView((v) => !v)}
              className="btn-secondary px-3 py-2 rounded-control text-sm font-medium"
              aria-pressed={annualView}
            >
              {annualView ? 'Annual' : 'Monthly'}
            </button>
            <button onClick={() => setEditing('new')} className="btn-primary px-3 py-2 rounded-control text-sm font-semibold flex items-center gap-1">
              <Plus className="w-4 h-4" /> Add bill
            </button>
          </div>
        </div>

        {/* Retired-card warning: actionable, filters the list on tap */}
        {retired.length > 0 && (
          <button
            onClick={() => setFilter(filter === 'retired-cards' ? 'all' : 'retired-cards')}
            className="mt-4 w-full text-left flex items-center gap-2 rounded-control border border-amber-500/40 bg-amber-500/10 px-3 min-h-[44px] text-sm text-[var(--foreground)] hover:bg-amber-500/20 transition-colors"
          >
            <AlertTriangle className="w-4 h-4 text-amber-500 shrink-0" />
            <span>
              <strong>{retired.length}</strong> bill{retired.length === 1 ? '' : 's'} still use cards you&apos;re
              retiring · <strong>{money(totalMonthlyCost(retired))}{per}</strong>
            </span>
            <span className="ml-auto text-xs text-[var(--foreground-muted)]">
              {filter === 'retired-cards' ? 'clear filter' : 'show'}
            </span>
          </button>
        )}
      </div>

      {/* Filter segmented control */}
      <div className="flex items-center gap-2 p-2 bg-[var(--background-secondary)] rounded-control border border-[var(--border-color)] overflow-x-auto">
        {FILTERS.map((f) => (
          <button
            key={f.id}
            onClick={() => setFilter(f.id)}
            className={`px-3 min-h-[44px] text-sm font-semibold rounded-control whitespace-nowrap transition-all ${
              filter === f.id
                ? 'bg-[var(--accent-primary)] text-[#16181c] shadow-sm'
                : 'text-[var(--foreground-secondary)] hover:text-[var(--foreground)] hover:bg-[var(--background-tertiary)]'
            }`}
          >
            {f.label}
          </button>
        ))}
      </div>

      {/* Bill list */}
      <div className="space-y-2">
        {visible.length === 0 && (
          <div className="glass-card p-6 text-center text-sm text-[var(--foreground-secondary)]">
            Nothing matches this filter.
          </div>
        )}
        {visible.map((bill) => {
          const method = PAYMENT_METHODS[bill.paymentMethodId];
          const cancelled = bill.lifecycleStatus === 'cancelled';
          const needsAttention = billsOnRetiredMethods([bill]).length > 0;
          const actual = actuals.get(bill.id);
          const overTarget = actual !== undefined && actual > monthlyCost(bill);
          const isExpanded = expandedId === bill.id;
          const toggleExpand = bill.matcher
            ? () => setExpandedId(isExpanded ? null : bill.id)
            : undefined;
          return (
            <div key={bill.id} className={`glass-card p-4 ${cancelled ? 'opacity-55' : ''}`}>
            <div className="flex items-start gap-3">
              {/* Fast path: To switch → Switched as a literal checkbox */}
              {bill.migrationStatus === 'to-switch' ? (
                <button
                  onClick={() => applyUpdate(bill.id, { migrationStatus: 'switched', paymentMethodId: 'bofa-debit' })}
                  className="mt-1 w-6 h-6 min-w-[44px] min-h-[44px] shrink-0 rounded-control border-2 border-[var(--accent-primary)] hover:bg-[var(--accent-primary)]/20 transition-colors"
                  title="Mark switched to BofA debit"
                  aria-label={`Mark ${bill.vendor} switched to BofA debit`}
                />
              ) : bill.migrationStatus === 'switched' ? (
                <div className="mt-1 w-6 h-6 min-w-[44px] min-h-[44px] shrink-0 rounded-control bg-[var(--accent-primary)] flex items-center justify-center">
                  <Check className="w-4 h-4 text-[#16181c]" />
                </div>
              ) : (
                <div className="mt-1 w-6 h-6 min-w-[44px] min-h-[44px] shrink-0" />
              )}

              <div
                className={`min-w-0 flex-1 ${toggleExpand ? 'cursor-pointer' : ''}`}
                onClick={toggleExpand}
              >
                <div className="flex items-center gap-2">
                  <span className="font-semibold text-[var(--foreground)] truncate">
                    {bill.url ? (
                      <a
                        href={bill.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        onClick={(e) => e.stopPropagation()}
                        className="hover:underline inline-flex items-center gap-1"
                      >
                        {bill.vendor}
                        <ExternalLink className="w-3.5 h-3.5 text-[var(--foreground-muted)]" />
                      </a>
                    ) : (
                      bill.vendor
                    )}
                  </span>
                  {bill.nonNegotiable && (
                    <Lock className="w-3.5 h-3.5 text-[var(--accent-primary)] shrink-0" aria-label="Non-negotiable" />
                  )}
                  {toggleExpand && (
                    <button
                      onClick={(e) => { e.stopPropagation(); toggleExpand(); }}
                      className="p-1 -m-1 min-w-[44px] min-h-[44px] flex items-center justify-center text-[var(--foreground-muted)] hover:text-[var(--foreground)]"
                      aria-expanded={isExpanded}
                      aria-label={`${isExpanded ? 'Hide' : 'Show'} spending behind ${bill.vendor}`}
                    >
                      <ChevronDown className={`w-4 h-4 transition-transform ${isExpanded ? 'rotate-180' : ''}`} />
                    </button>
                  )}
                  {needsAttention && <AlertTriangle className="w-4 h-4 text-amber-500 shrink-0" />}
                </div>
                <div className="text-sm text-[var(--foreground-secondary)] mt-1">
                  {formatMoney(bill.amount, 'USD', 2)} · {bill.frequency}
                  {bill.autopayDay ? ` · day ${bill.autopayDay}` : ''}
                  {cancelled ? ` · ${LIFECYCLE_LABELS[bill.lifecycleStatus]}` : ''}
                </div>
                <div className="text-sm text-[var(--foreground-muted)] mt-1 relative">
                  {method?.label || bill.paymentMethodId} ·{' '}
                  <button
                    onClick={(e) => { e.stopPropagation(); setStatusMenuFor(statusMenuFor === bill.id ? null : bill.id); }}
                    className="font-medium text-[var(--foreground-secondary)] underline decoration-dotted underline-offset-2 hover:text-[var(--foreground)]"
                  >
                    {MIGRATION_LABELS[bill.migrationStatus]}
                  </button>
                  {statusMenuFor === bill.id && (
                    <div className="absolute z-20 mt-1 rounded-control border border-[var(--border-color)] bg-[var(--background-secondary)] shadow-lg py-1">
                      {(Object.keys(MIGRATION_LABELS) as MigrationStatus[]).map((s) => (
                        <button
                          key={s}
                          onClick={() => {
                            applyUpdate(bill.id, { migrationStatus: s });
                            setStatusMenuFor(null);
                          }}
                          className={`block w-full text-left px-4 py-2 text-sm hover:bg-[var(--background-tertiary)] ${
                            s === bill.migrationStatus
                              ? 'text-[var(--accent-primary)] font-semibold'
                              : 'text-[var(--foreground)]'
                          }`}
                        >
                          {MIGRATION_LABELS[s]}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
                {bill.remarks && (
                  <p className="text-xs text-[var(--foreground-muted)] mt-1 line-clamp-2">{bill.remarks}</p>
                )}
              </div>

              <div className="text-right shrink-0">
                <div className={`font-semibold ${cancelled ? 'line-through text-[var(--foreground-muted)]' : 'text-[var(--foreground)]'}`}>
                  {money(monthlyCost(bill))}
                  <span className="text-xs text-[var(--foreground-muted)]">{per}</span>
                </div>
                {actual !== undefined && (
                  <div className={`text-xs ${overTarget ? 'text-amber-500 font-medium' : 'text-[var(--foreground-muted)]'}`}>
                    actual {money(actual)}{per}
                  </div>
                )}
                <button
                  onClick={() => setEditing(bill)}
                  className="mt-1 p-2 -mr-2 min-w-[44px] min-h-[44px] flex items-center justify-center text-[var(--foreground-muted)] hover:text-[var(--foreground)]"
                  aria-label={`Edit ${bill.vendor}`}
                >
                  <Pencil className="w-4 h-4" />
                </button>
              </div>
            </div>

            {/* Merchant drill-down: the actual spending behind a target row */}
            {isExpanded && bill.matcher && expandedBreakdown && (
              <div className="mt-3 pt-3 border-t border-[var(--border-color)] text-sm">
                <div className="flex flex-wrap items-baseline gap-x-2 mb-2">
                  <span className="font-semibold text-[var(--foreground)]">
                    Target {formatMoney(monthlyCost(bill), 'USD', 2)}/mo
                  </span>
                  <span className="text-[var(--foreground-secondary)]">
                    · 3-mo actual {formatMoney(expandedBreakdown.actualMonthly, 'USD', 2)}/mo
                  </span>
                  {expandedBreakdown.actualMonthly > monthlyCost(bill) ? (
                    <span className="text-amber-500 font-medium">over target</span>
                  ) : (
                    <span className="text-emerald-500 font-medium">on target</span>
                  )}
                </div>
                {(() => {
                  const top = expandedBreakdown.merchants.slice(0, 8);
                  const rest = expandedBreakdown.merchants.slice(8);
                  const others = rest.reduce((s, x) => s + x.monthly, 0);
                  const max = Math.max(...top.map(x => Math.abs(x.monthly)), 0.01);
                  return (
                    <div className="space-y-2">
                      {top.map(x => (
                        <div key={x.merchant} className="flex items-center gap-2">
                          <span className="w-36 truncate text-[var(--foreground-secondary)]">{x.merchant}</span>
                          <span className="w-20 text-right tabular-nums text-[var(--foreground)]">
                            {formatMoney(x.monthly, 'USD', 0)}/mo
                          </span>
                          <div className="flex-1 h-1.5 rounded-control bg-[var(--background-tertiary)]">
                            <div
                              className="h-1.5 rounded-control bg-[var(--accent-primary)]"
                              style={{ width: `${Math.max(0, (x.monthly / max) * 100)}%` }}
                            />
                          </div>
                        </div>
                      ))}
                      {rest.length > 0 && (
                        <div className="flex items-center gap-2">
                          <span className="w-36 truncate text-[var(--foreground-muted)]">
                            {rest.length} others
                          </span>
                          <span className="w-20 text-right tabular-nums text-[var(--foreground-muted)]">
                            {formatMoney(others, 'USD', 0)}/mo
                          </span>
                        </div>
                      )}
                      {expandedBreakdown.merchants.length === 0 && (
                        <p className="text-[var(--foreground-muted)]">
                          No matching transactions in the last 3 months.
                        </p>
                      )}
                    </div>
                  );
                })()}
                <p className="text-xs text-[var(--foreground-muted)] mt-2">
                  {expandedBreakdown.months
                    .map(mm => `${format(new Date(`${mm.month}-15`), 'MMM')} ${formatMoney(mm.total, 'USD', 0)}`)
                    .join(' · ')}
                  {' · '}
                  {format(new Date(`${expandedBreakdown.currentMonth.month}-15`), 'MMM')} so far{' '}
                  {formatMoney(expandedBreakdown.currentMonth.total, 'USD', 0)}
                </p>
              </div>
            )}
            </div>
          );
        })}
      </div>

      {editing && (
        <BillForm
          bill={editing === 'new' ? null : editing}
          onSave={handleSave}
          onDelete={editing === 'new' ? undefined : () => handleDelete((editing as Bill).id)}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

interface BillFormProps {
  bill: Bill | null;
  onSave: (draft: Omit<Bill, 'id' | 'createdAt' | 'updatedAt'>, existingId?: string) => void;
  onDelete?: () => void;
  onClose: () => void;
}

function BillForm({ bill, onSave, onDelete, onClose }: BillFormProps) {
  const [vendor, setVendor] = useState(bill?.vendor ?? '');
  const [url, setUrl] = useState(bill?.url ?? '');
  const [amount, setAmount] = useState(bill ? String(bill.amount) : '');
  const [frequency, setFrequency] = useState<BillFrequency>(bill?.frequency ?? 'monthly');
  const [autopayDay, setAutopayDay] = useState(bill?.autopayDay ? String(bill.autopayDay) : '');
  const [anchorDate, setAnchorDate] = useState(bill?.anchorDate ?? '');
  const [category, setCategory] = useState(bill?.category ?? '');
  const [paymentMethodId, setPaymentMethodId] = useState(bill?.paymentMethodId ?? 'bofa-debit');
  const [migrationStatus, setMigrationStatus] = useState<MigrationStatus>(bill?.migrationStatus ?? 'to-review');
  const [lifecycleStatus, setLifecycleStatus] = useState<LifecycleStatus>(bill?.lifecycleStatus ?? 'active');
  const [nonNegotiable, setNonNegotiable] = useState(bill?.nonNegotiable ?? false);
  const [remarks, setRemarks] = useState(bill?.remarks ?? '');
  const [error, setError] = useState('');

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const amt = parseFloat(amount);
    if (!vendor.trim()) return setError('Vendor is required.');
    if (!(amt > 0)) return setError('Amount must be greater than 0.');
    const day = autopayDay ? parseInt(autopayDay, 10) : undefined;
    if (day !== undefined && (day < 1 || day > 31)) return setError('Autopay day must be 1–31.');
    onSave(
      {
        vendor: vendor.trim(),
        url: url.trim() || undefined,
        amount: amt,
        frequency,
        autopayDay: day,
        anchorDate: anchorDate || undefined,
        category: category.trim() || undefined,
        paymentMethodId,
        migrationStatus,
        lifecycleStatus,
        nonNegotiable: nonNegotiable || undefined,
        remarks: remarks.trim() || undefined,
        source: bill?.source,
        seedVersion: bill?.seedVersion,
      },
      bill?.id
    );
  };

  const weeklyish = frequency === 'weekly' || frequency === 'biweekly';

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/50 p-0 sm:p-4" onClick={onClose}>
      <div
        className="w-full sm:max-w-lg max-h-[92vh] overflow-y-auto rounded-t-card sm:rounded-card bg-[var(--background)] border border-[var(--border-color)] p-5"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={bill ? `Edit ${bill.vendor}` : 'Add bill'}
      >
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-semibold text-[var(--foreground)]">{bill ? 'Edit bill' : 'Add bill'}</h3>
          <button onClick={onClose} className="p-2 text-[var(--foreground-muted)] hover:text-[var(--foreground)]" aria-label="Close">
            <X className="w-5 h-5" />
          </button>
        </div>

        <form onSubmit={submit} className="space-y-3">
          <label className="block text-sm font-medium text-[var(--foreground-secondary)]">
            Vendor *
            <input className="input-field mt-1 w-full" value={vendor} onChange={(e) => setVendor(e.target.value)} placeholder="e.g. Verizon Wireless" />
          </label>

          <label className="block text-sm font-medium text-[var(--foreground-secondary)]">
            Login / manage URL
            <input className="input-field mt-1 w-full" type="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…" />
          </label>

          <div className="grid grid-cols-2 gap-3">
            <label className="block text-sm font-medium text-[var(--foreground-secondary)]">
              Amount *
              <input className="input-field mt-1 w-full" type="number" step="0.01" min="0.01" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
            </label>
            <label className="block text-sm font-medium text-[var(--foreground-secondary)]">
              Frequency *
              <select className="input-field mt-1 w-full" value={frequency} onChange={(e) => setFrequency(e.target.value as BillFrequency)}>
                {FREQUENCIES.map((f) => (
                  <option key={f} value={f}>{f}</option>
                ))}
              </select>
            </label>
          </div>

          <div className="grid grid-cols-2 gap-3">
            {weeklyish ? (
              <label className="block text-sm font-medium text-[var(--foreground-secondary)]">
                Anchor date
                <input className="input-field mt-1 w-full" type="date" value={anchorDate} onChange={(e) => setAnchorDate(e.target.value)} />
              </label>
            ) : (
              <label className="block text-sm font-medium text-[var(--foreground-secondary)]">
                Autopay day (1–31)
                <input className="input-field mt-1 w-full" type="number" min="1" max="31" inputMode="numeric" value={autopayDay} onChange={(e) => setAutopayDay(e.target.value)} />
              </label>
            )}
            <label className="block text-sm font-medium text-[var(--foreground-secondary)]">
              Category
              <input className="input-field mt-1 w-full" value={category} onChange={(e) => setCategory(e.target.value)} placeholder="Phone, Insurance…" />
            </label>
          </div>

          <label className="block text-sm font-medium text-[var(--foreground-secondary)]">
            Paid from *
            <select className="input-field mt-1 w-full" value={paymentMethodId} onChange={(e) => setPaymentMethodId(e.target.value)}>
              {Object.entries(PAYMENT_METHODS).map(([id, m]) => (
                <option key={id} value={id}>
                  {m.label}{m.active ? '' : ' (retiring)'}
                </option>
              ))}
            </select>
          </label>

          <div className="grid grid-cols-2 gap-3">
            <label className="block text-sm font-medium text-[var(--foreground-secondary)]">
              Migration
              <select className="input-field mt-1 w-full" value={migrationStatus} onChange={(e) => setMigrationStatus(e.target.value as MigrationStatus)}>
                {(Object.keys(MIGRATION_LABELS) as MigrationStatus[]).map((s) => (
                  <option key={s} value={s}>{MIGRATION_LABELS[s]}</option>
                ))}
              </select>
            </label>
            <label className="block text-sm font-medium text-[var(--foreground-secondary)]">
              Lifecycle
              <select className="input-field mt-1 w-full" value={lifecycleStatus} onChange={(e) => setLifecycleStatus(e.target.value as LifecycleStatus)}>
                {(Object.keys(LIFECYCLE_LABELS) as LifecycleStatus[]).map((s) => (
                  <option key={s} value={s}>{LIFECYCLE_LABELS[s]}</option>
                ))}
              </select>
            </label>
          </div>

          <label className="flex items-center gap-2 text-sm font-medium text-[var(--foreground-secondary)] py-1 cursor-pointer">
            <input
              type="checkbox"
              checked={nonNegotiable}
              onChange={(e) => setNonNegotiable(e.target.checked)}
              className="w-4 h-4 accent-[var(--accent-primary)]"
            />
            <Lock className="w-3.5 h-3.5" />
            Non-negotiable — reserve first in every plan, never suggest cutting
          </label>

          <label className="block text-sm font-medium text-[var(--foreground-secondary)]">
            Remarks
            <textarea className="input-field mt-1 w-full" rows={2} value={remarks} onChange={(e) => setRemarks(e.target.value)} />
          </label>

          {error && <p className="text-sm text-red-500">{error}</p>}

          <div className="flex items-center justify-between pt-2">
            {onDelete ? (
              <button type="button" onClick={onDelete} className="text-sm font-medium text-red-500 hover:text-red-400 px-2 py-2">
                Delete
              </button>
            ) : (
              <span />
            )}
            <div className="flex gap-2">
              <button type="button" onClick={onClose} className="btn-secondary px-4 py-2 rounded-control font-medium">
                Cancel
              </button>
              <button type="submit" className="btn-primary px-4 py-2 rounded-control font-semibold">
                Save
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}
