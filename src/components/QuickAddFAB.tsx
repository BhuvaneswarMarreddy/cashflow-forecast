'use client';

/**
 * UI-101 — the FAB is ONE action: Add a transaction.
 *
 * It used to open a six-item menu (2 actions + 4 navigation links) behind a
 * grid icon — navigation hiding inside an "add" button, with reversed tab
 * order and no Escape (design audit, issue #32). The ex-menu routes now live
 * in the Navbar menus until UI-103/104 fold them into tabs; receipt scanning
 * stays available where receipts are worked with (History).
 *
 * UI spec B3: on phones the corner FAB sat on the Accounts tab (bottom-20 right-4),
 * so phones get the `header` variant in the Navbar and the corner FAB is md+ only.
 * Each variant is hidden at the other breakpoint, so one Add is ever on screen.
 */

import React, { useState } from 'react';
import { Plus } from 'lucide-react';
import AddTransactionModal from './AddTransactionModal';

export default function QuickAddFAB({ variant = 'corner' }: { variant?: 'corner' | 'header' }) {
  const [showAddModal, setShowAddModal] = useState(false);

  return (
    <>
      <button
        onClick={() => setShowAddModal(true)}
        aria-label="Add transaction"
        className={
          variant === 'header'
            ? 'md:hidden w-11 h-11 rounded-control flex items-center justify-center bg-gradient-to-br from-[var(--accent-primary)] to-[var(--accent-secondary)] transition-transform active:scale-95'
            : 'hidden md:flex fixed bottom-6 right-6 z-50 w-14 h-14 rounded-pill items-center justify-center shadow-lg bg-gradient-to-br from-[var(--accent-primary)] to-[var(--accent-secondary)] shadow-[var(--accent-primary)]/30 transition-transform hover:scale-105 active:scale-95'
        }
      >
        <Plus className={variant === 'header' ? 'w-5 h-5 text-[#16181c]' : 'w-7 h-7 text-[#16181c]'} aria-hidden="true" />
      </button>

      <AddTransactionModal
        isOpen={showAddModal}
        onClose={() => setShowAddModal(false)}
      />
    </>
  );
}
