'use client';

/**
 * #201 — approved pay, edited in Settings (moved from Accounts' Tools, #200).
 *
 * Invariant 4: a deposit counts as EARNED income only when it matches one of these
 * sources (or the owner confirmed it). The save path below is Accounts' original,
 * unchanged — including the alias rule, which is the part that decides matching.
 */
import React, { useState } from 'react';
import { Banknote, DollarSign, Edit3, Plus, Trash2, X } from 'lucide-react';
import { useUserProfile } from '@/context/UserProfileContext';
import { formatMoney } from '@/lib/money';
import type { Cadence } from '@/lib/income-cadence';
import type { IncomeSource } from '@/types';

const ordinal = (n: number) => {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return s[(v - 20) % 10] || s[v] || s[0];
};

const EMPTY_FORM = {
  name: '',
  amount: '',
  frequency: 'monthly' as 'weekly' | 'biweekly' | 'monthly' | 'yearly',
  payDate: '',
  // Comma-separated text that must appear on the bank line for a deposit to count
  // as THIS income. Without it the source name is the only alias, and a source
  // called "Canton Group" never matches a row that reads "CANTON PAYROLL PPD".
  matchAliases: '',
};

export default function IncomeSourcesSettings() {
  const { profile, addIncomeSource, updateIncomeSource, deleteIncomeSource } = useUserProfile();
  const [editing, setEditing] = useState<IncomeSource | null>(null);
  const [showModal, setShowModal] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [deleting, setDeleting] = useState<IncomeSource | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);

  const sources = profile?.incomeSources ?? [];

  const openEdit = (income: IncomeSource) => {
    setEditing(income);
    setForm({
      name: income.name,
      amount: income.amount.toString(),
      frequency: income.frequency,
      payDate: income.payDate?.toString() || '',
      matchAliases: (income.matchAliases ?? []).join(', '),
    });
    setShowModal(true);
  };

  const close = () => {
    setForm(EMPTY_FORM);
    setEditing(null);
    setShowModal(false);
  };

  const save = async () => {
    const aliases = form.matchAliases.split(',').map((a) => a.trim()).filter((a) => a.length >= 3);
    const incomeData = {
      name: form.name,
      amount: parseFloat(form.amount) || 0,
      frequency: form.frequency,
      payDate: form.payDate ? parseInt(form.payDate) : undefined,
      // Drop blanks and 1-2 char fragments (matchApprovedSources rejects those anyway —
      // a 2-char alias would match half the ledger). Empty => undefined, so the source
      // falls back to matching on its own name.
      matchAliases: aliases.length ? aliases : undefined,
      isActive: true,
    };
    if (editing) await updateIncomeSource(editing.id, incomeData);
    else await addIncomeSource(incomeData);
    close();
  };

  const confirmDelete = async () => {
    if (!deleting) return;
    setIsDeleting(true);
    try {
      await deleteIncomeSource(deleting.id);
    } finally {
      setIsDeleting(false);
      setDeleting(null);
    }
  };

  return (
    <div className="glass-card p-4">
      <div className="flex items-center justify-between gap-3 mb-3">
        <p className="text-sm text-[var(--foreground-muted)] min-w-0">
          Only deposits that match one of these count as earned income.
        </p>
        <button
          onClick={() => setShowModal(true)}
          className="btn-secondary inline-flex items-center gap-2 min-h-[44px] px-3 text-sm shrink-0 whitespace-nowrap"
        >
          <Plus className="w-4 h-4" aria-hidden="true" />
          Add Income
        </button>
      </div>

      {sources.length === 0 ? (
        <p className="text-sm text-[var(--foreground-secondary)] py-2">
          No income sources yet. Add your paycheck so the app can tell pay from other deposits.
        </p>
      ) : (
        <ul className="divide-y divide-[var(--border-color)]">
          {sources.map((income) => (
            <li key={income.id} className="py-3 flex items-center gap-3">
              <Banknote className="hidden sm:block w-5 h-5 text-[var(--foreground-muted)] shrink-0" aria-hidden="true" />
              <div className="min-w-0 flex-1">
                <p className="font-medium text-[var(--foreground)] break-words">{income.name}</p>
                <p className="text-xs text-[var(--foreground-muted)]">
                  {income.frequency.charAt(0).toUpperCase() + income.frequency.slice(1)}
                  {income.payDate && ` · pay day ${income.payDate}${ordinal(income.payDate)}`}
                  {!income.isActive && ' · paused'}
                </p>
              </div>
              <p className="font-semibold tnum text-[var(--money-in)] shrink-0">
                +{formatMoney(income.amount, profile?.currency, 2)}
              </p>
              <button
                onClick={() => openEdit(income)}
                aria-label={`Edit ${income.name}`}
                className="w-11 h-11 flex items-center justify-center rounded-control text-[var(--foreground-muted)] hover:text-[var(--accent-primary)] hover:bg-[var(--background-tertiary)]"
              >
                <Edit3 className="w-4 h-4" aria-hidden="true" />
              </button>
              <button
                onClick={() => setDeleting(income)}
                aria-label={`Delete ${income.name}`}
                className="w-11 h-11 flex items-center justify-center rounded-control text-[var(--foreground-muted)] hover:text-[var(--money-out)] hover:bg-[var(--background-tertiary)]"
              >
                <Trash2 className="w-4 h-4" aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
      )}

      {showModal && (
        <div className="modal-overlay" onClick={close}>
          <div className="modal-content max-w-lg" onClick={(e) => e.stopPropagation()}>
            <div className="flex justify-between items-start gap-4 mt-8 mb-4">
              <h2 className="text-xl font-bold text-[var(--foreground)]">{editing ? 'Edit Income' : 'Add Income'}</h2>
              <button onClick={close} aria-label="Close" className="p-2 rounded-control text-[var(--foreground-muted)] hover:bg-[var(--background-tertiary)]">
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="space-y-4">
              <div>
                <label htmlFor="income-name" className="block text-sm font-medium text-[var(--foreground-secondary)] mb-2">Income Name</label>
                <input
                  id="income-name"
                  type="text"
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  placeholder="e.g., Salary, Freelance"
                  className="input-field"
                />
              </div>

              <div>
                <label htmlFor="income-aliases" className="block text-sm font-medium text-[var(--foreground-secondary)] mb-2">
                  Bank description contains
                </label>
                <input
                  id="income-aliases"
                  type="text"
                  value={form.matchAliases}
                  onChange={(e) => setForm({ ...form, matchAliases: e.target.value })}
                  placeholder="e.g., CANTON PAYROLL, CANTON DEPOSIT"
                  className="input-field"
                  aria-describedby="income-aliases-help"
                />
                <p id="income-aliases-help" className="text-xs text-[var(--foreground-muted)] mt-2">
                  Text that appears on the bank line for this income, comma-separated. A deposit only
                  counts as earned income when it matches. Leave blank to match on the name above.
                </p>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label htmlFor="income-amount" className="block text-sm font-medium text-[var(--foreground-secondary)] mb-2">Amount</label>
                  <div className="relative">
                    <DollarSign className="absolute left-[1.1rem] top-1/2 -translate-y-1/2 w-5 h-5 text-[var(--foreground-muted)]" />
                    <input
                      id="income-amount"
                      type="number"
                      value={form.amount}
                      onChange={(e) => setForm({ ...form, amount: e.target.value })}
                      placeholder="5000"
                      className="input-field pl-[3.25rem]"
                    />
                  </div>
                </div>
                <div>
                  <label htmlFor="income-frequency" className="block text-sm font-medium text-[var(--foreground-secondary)] mb-2">Frequency</label>
                  <select
                    id="income-frequency"
                    value={form.frequency}
                    onChange={(e) => setForm({ ...form, frequency: e.target.value as Cadence })}
                    className="select-field"
                  >
                    <option value="weekly">Weekly</option>
                    <option value="biweekly">Bi-weekly</option>
                    <option value="monthly">Monthly</option>
                    <option value="yearly">Yearly</option>
                  </select>
                </div>
              </div>

              <div>
                <label htmlFor="income-paydate" className="block text-sm font-medium text-[var(--foreground-secondary)] mb-2">Pay Date (Day of Month)</label>
                <select
                  id="income-paydate"
                  value={form.payDate}
                  onChange={(e) => setForm({ ...form, payDate: e.target.value })}
                  className="input-field"
                >
                  <option value="">Not set</option>
                  {Array.from({ length: 31 }, (_, i) => String(i + 1)).map((d) => (
                    <option key={d} value={d}>{d}</option>
                  ))}
                </select>
              </div>

              <button
                onClick={save}
                disabled={!form.name || !form.amount}
                className="btn-primary w-full min-h-[44px] disabled:opacity-50"
              >
                {editing ? 'Update Income' : 'Add Income'}
              </button>
            </div>
          </div>
        </div>
      )}

      {deleting && (
        <div className="modal-overlay" onClick={() => setDeleting(null)}>
          <div className="delete-confirm-modal" onClick={(e) => e.stopPropagation()}>
            <Trash2 className="w-12 h-12 text-[var(--money-out)] mx-auto mb-4" aria-hidden="true" />
            <h3 className="text-xl font-bold text-[var(--foreground)] mb-2">Delete Income Source?</h3>
            <p className="text-[var(--foreground-secondary)] mb-6">
              Deposits that matched &quot;{deleting.name}&quot; will stop counting as earned income. This can&apos;t be undone.
            </p>
            <div className="flex gap-3">
              <button onClick={() => setDeleting(null)} className="btn-secondary flex-1 min-h-[44px]" disabled={isDeleting}>
                Cancel
              </button>
              <button onClick={confirmDelete} className="btn-danger flex-1 min-h-[44px]" disabled={isDeleting}>
                {isDeleting ? 'Deleting…' : 'Delete'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
