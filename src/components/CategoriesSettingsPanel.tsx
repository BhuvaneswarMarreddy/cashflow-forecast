'use client';

import React, { useMemo, useState } from 'react';
import { useUserProfile } from '@/context/UserProfileContext';
import {
  CustomCategory,
  EXPENSE_CATEGORIES,
  ResolvedCategory,
  resolveCategories,
  slugForCategoryLabel,
} from '@/types';
import { Archive, ArchiveRestore, Pencil, Plus } from 'lucide-react';

type Feedback = { type: 'success' | 'error'; text: string };

const SAVE_FAILED = 'Could not save — check your connection and try again.';

/**
 * cashflow-mobile#27. Point-and-click home for settings.categories — the same
 * store DataChatSheet's applyCategory writes, via the same updateProfile round
 * trip. Add / rename (custom only) / archive-unarchive. Removal-with-reassignment
 * is deliberately NOT here — a parallel task is moving that to a server callable;
 * archiving is the safe subset (hides from new selections, touches no transaction).
 */
export default function CategoriesSettingsPanel() {
  const { profile, updateProfile } = useUserProfile();

  const resolved = useMemo(() => resolveCategories(profile?.settings), [profile?.settings]);
  const builtInValues = useMemo(() => new Set(EXPENSE_CATEGORIES.map((c) => c.value as string)), []);

  const [label, setLabel] = useState('');
  const [icon, setIcon] = useState('');
  const [renamingValue, setRenamingValue] = useState<string | null>(null);
  const [renameLabel, setRenameLabel] = useState('');
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<Feedback | null>(null);

  // The one path to the store. Never claims success the write did not confirm —
  // updateProfile's return is the real Firestore outcome, not the optimistic local
  // update (see UserProfileContext.updateProfile).
  const writeCategories = async (next: CustomCategory[], successText: string): Promise<boolean> => {
    setFeedback(null);
    const ok = await updateProfile({ settings: { categories: next } });
    setFeedback(ok ? { type: 'success', text: successText } : { type: 'error', text: SAVE_FAILED });
    return ok;
  };

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmedLabel = label.trim();
    if (!trimmedLabel || busy) return;
    setBusy(true);
    const taken = new Set(resolved.map((c) => c.value));
    const value = slugForCategoryLabel(trimmedLabel, taken);
    const current = profile?.settings?.categories ?? [];
    const trimmedIcon = icon.trim();
    const next: CustomCategory[] = [
      ...current,
      { value, label: trimmedLabel, ...(trimmedIcon ? { icon: trimmedIcon } : {}) },
    ];
    const ok = await writeCategories(next, `Added "${trimmedLabel}".`);
    if (ok) {
      setLabel('');
      setIcon('');
    }
    setBusy(false);
  };

  const startRename = (entry: ResolvedCategory) => {
    setFeedback(null);
    setRenamingValue(entry.value);
    setRenameLabel(entry.label);
  };
  const cancelRename = () => {
    setRenamingValue(null);
    setRenameLabel('');
  };

  const submitRename = async (e: React.FormEvent, value: string) => {
    e.preventDefault();
    const trimmed = renameLabel.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    const current = profile?.settings?.categories ?? [];
    const next = current.map((c) => (c.value === value ? { ...c, label: trimmed } : c));
    const ok = await writeCategories(next, `Renamed to "${trimmed}".`);
    if (ok) {
      setRenamingValue(null);
      setRenameLabel('');
    }
    setBusy(false);
  };

  const toggleArchive = async (entry: ResolvedCategory) => {
    if (busy) return;
    setBusy(true);
    const current = profile?.settings?.categories ?? [];
    const nextArchived = !entry.archived;
    const next = current.map((c) => (c.value === entry.value ? { ...c, archived: nextArchived } : c));
    await writeCategories(next, nextArchived ? `Archived "${entry.label}".` : `Unarchived "${entry.label}".`);
    setBusy(false);
  };

  return (
    <div className="glass-card p-4">
      <p className="text-sm text-[var(--foreground-muted)] mb-4">
        Your full category set — the 13 built-in categories plus any you&apos;ve added.
        Built-in categories can&apos;t be renamed. Archiving hides a category from new
        selections without touching anything already filed under it.
      </p>

      <ul role="list" className="divide-y divide-[var(--border-color)] mb-4">
        {resolved.map((entry) => {
          const isBuiltIn = builtInValues.has(entry.value);
          const isRenaming = renamingValue === entry.value;
          return (
            <li
              key={entry.value}
              className={`py-3 flex items-center gap-3 ${entry.archived ? 'opacity-50' : ''}`}
            >
              <span className="text-xl shrink-0" aria-hidden="true">{entry.icon}</span>
              <div className="flex-1 min-w-0">
                {isRenaming ? (
                  <form onSubmit={(e) => submitRename(e, entry.value)} className="flex items-center gap-2 flex-wrap">
                    <label htmlFor={`rename-${entry.value}`} className="sr-only">
                      New name for {entry.label}
                    </label>
                    <input
                      id={`rename-${entry.value}`}
                      type="text"
                      value={renameLabel}
                      onChange={(e) => setRenameLabel(e.target.value)}
                      autoFocus
                      className="input-field py-1 text-sm flex-1 min-w-[8rem]"
                    />
                    <button type="submit" disabled={busy || !renameLabel.trim()} className="btn-primary px-3 py-1 text-sm disabled:opacity-50">
                      Save
                    </button>
                    <button type="button" onClick={cancelRename} className="btn-secondary px-3 py-1 text-sm">
                      Cancel
                    </button>
                  </form>
                ) : (
                  <>
                    <p className="text-sm text-[var(--foreground)] break-words">{entry.label}</p>
                    <p className="text-xs text-[var(--foreground-muted)] font-mono break-all">{entry.value}</p>
                  </>
                )}
              </div>
              {!isRenaming && (
                <div className="flex items-center gap-2 shrink-0">
                  <span
                    className={`px-2 py-1 text-xs rounded-pill ${
                      isBuiltIn
                        ? 'bg-[var(--background-tertiary)] text-[var(--foreground-muted)]'
                        : 'bg-[var(--accent-primary)]/10 text-[var(--accent-primary)]'
                    }`}
                  >
                    {isBuiltIn ? 'Built-in' : 'Custom'}
                  </span>
                  {entry.archived && (
                    <span className="px-2 py-1 text-xs rounded-pill bg-[var(--background-tertiary)] text-[var(--foreground-muted)]">
                      Archived
                    </span>
                  )}
                  {!isBuiltIn && (
                    <>
                      <button
                        type="button"
                        onClick={() => startRename(entry)}
                        aria-label={`Rename ${entry.label}`}
                        className="w-9 h-9 flex items-center justify-center rounded-card text-[var(--foreground-secondary)] hover:bg-[var(--background-tertiary)] transition-colors"
                      >
                        <Pencil className="w-4 h-4" aria-hidden="true" />
                      </button>
                      <button
                        type="button"
                        onClick={() => toggleArchive(entry)}
                        disabled={busy}
                        aria-label={`${entry.archived ? 'Unarchive' : 'Archive'} ${entry.label}`}
                        className="w-9 h-9 flex items-center justify-center rounded-card text-[var(--foreground-secondary)] hover:bg-[var(--background-tertiary)] transition-colors disabled:opacity-50"
                      >
                        {entry.archived ? (
                          <ArchiveRestore className="w-4 h-4" aria-hidden="true" />
                        ) : (
                          <Archive className="w-4 h-4" aria-hidden="true" />
                        )}
                      </button>
                    </>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>

      <form onSubmit={handleAdd} className="space-y-3 border-t border-[var(--border-color)] pt-4">
        <div className="flex gap-3 flex-wrap">
          <div className="flex-1 min-w-[10rem]">
            <label htmlFor="new-category-label" className="block text-sm font-medium text-[var(--foreground-secondary)] mb-2">
              Category name
            </label>
            <input
              id="new-category-label"
              type="text"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="e.g. Vacations"
              className="input-field"
            />
          </div>
          <div className="w-24">
            <label htmlFor="new-category-icon" className="block text-sm font-medium text-[var(--foreground-secondary)] mb-2">
              Emoji
            </label>
            <input
              id="new-category-icon"
              type="text"
              value={icon}
              onChange={(e) => setIcon(e.target.value)}
              placeholder="🏷️"
              maxLength={4}
              className="input-field text-center"
            />
          </div>
        </div>
        <button
          type="submit"
          disabled={busy || !label.trim()}
          className="btn-primary flex items-center gap-2 disabled:opacity-50"
        >
          <Plus className="w-4 h-4" aria-hidden="true" />
          Add category
        </button>
        {feedback && (
          <p
            role={feedback.type === 'error' ? 'alert' : 'status'}
            className={`text-sm ${feedback.type === 'error' ? 'text-[var(--accent-danger)]' : 'text-[var(--accent-success)]'}`}
          >
            {feedback.text}
          </p>
        )}
      </form>
    </div>
  );
}
