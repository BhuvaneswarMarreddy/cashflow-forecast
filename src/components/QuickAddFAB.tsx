'use client';

/**
 * UI-101 — the FAB is ONE action: Add a transaction.
 *
 * It used to open a six-item menu (2 actions + 4 navigation links) behind a
 * grid icon — navigation hiding inside an "add" button, with reversed tab
 * order and no Escape (design audit, issue #32). The ex-menu routes now live
 * in the Navbar menus until UI-103/104 fold them into tabs; receipt scanning
 * stays available where receipts are worked with (History).
 */

import React, { useState } from 'react';
import { Plus } from 'lucide-react';
import AddTransactionModal from './AddTransactionModal';

export default function QuickAddFAB() {
  const [showAddModal, setShowAddModal] = useState(false);

  return (
    <>
      {/* Lifted above the mobile bottom nav (bottom-24) on phones */}
      <button
        onClick={() => setShowAddModal(true)}
        aria-label="Add transaction"
        className="fixed bottom-24 md:bottom-6 right-6 z-50 w-14 h-14 rounded-pill flex items-center justify-center shadow-lg bg-gradient-to-br from-[var(--accent-primary)] to-[var(--accent-secondary)] shadow-[var(--accent-primary)]/30 transition-transform hover:scale-105"
      >
        <Plus className="w-7 h-7 text-[#16181c]" aria-hidden="true" />
      </button>

      <AddTransactionModal
        isOpen={showAddModal}
        onClose={() => setShowAddModal(false)}
      />
    </>
  );
}
