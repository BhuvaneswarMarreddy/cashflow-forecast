'use client';

import React from 'react';
import { RelationBadge } from '@/lib/review-queue';

/**
 * A relation badge: TEXT plus icon, never colour alone (FIN-REVIEW-002.md:921).
 *
 * The icon is decorative — `aria-hidden` — because the text already carries the whole
 * meaning. A badge is derived on read; nothing here writes a field on a transaction.
 */
const TONE: Record<RelationBadge['tone'], string> = {
  neutral: 'border-[var(--border-color)] text-[var(--foreground-secondary)]',
  good: 'border-[var(--accent-success)]/50 text-[var(--accent-success)]',
  warn: 'border-[var(--accent-danger)]/50 text-[var(--accent-danger)]',
};

export default function TransactionRelationBadge({ badge }: { badge: RelationBadge }) {
  return (
    <span className={`inline-flex items-center gap-1 rounded-pill border px-2 py-1 text-xs ${TONE[badge.tone]}`}>
      <span aria-hidden="true">{badge.icon}</span>
      {badge.text}
    </span>
  );
}

export function RelationBadgeRow({ badges }: { badges: readonly RelationBadge[] }) {
  if (!badges.length) return null;
  return (
    <span className="inline-flex flex-wrap gap-1 align-middle">
      {badges.map((b) => (
        <TransactionRelationBadge key={b.text} badge={b} />
      ))}
    </span>
  );
}
