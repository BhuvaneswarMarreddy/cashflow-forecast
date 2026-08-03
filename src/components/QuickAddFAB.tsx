'use client';

import React, { useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Plus, Camera, X, DollarSign } from 'lucide-react';
import AddTransactionModal from './AddTransactionModal';
import ReceiptScannerModal from './ReceiptScannerModal';
import { SECONDARY_ITEMS } from '@/lib/nav';

export default function QuickAddFAB() {
  const [isOpen, setIsOpen] = useState(false);
  const [showAddModal, setShowAddModal] = useState(false);
  const [showScanModal, setShowScanModal] = useState(false);
  const pathname = usePathname();

  const toggleMenu = () => {
    setIsOpen(!isOpen);
  };

  const handleAddTransaction = () => {
    setIsOpen(false);
    setShowAddModal(true);
  };

  const handleScanReceipt = () => {
    setIsOpen(false);
    setShowScanModal(true);
  };

  return (
    <>
      {/* FAB Menu — lifted above the mobile bottom nav (bottom-24) on phones */}
      <div className="fixed bottom-24 md:bottom-6 right-6 z-50 flex flex-col-reverse items-end gap-3">
        {/* Sub-buttons (shown when open) */}
        {isOpen && (
          <>
            {/* The four screens that left the nav bar when it collapsed to four
                destinations (UX-IA-001). They lived at the bottom of /flow, which
                made them reachable from exactly one page; here they are reachable
                from every page. SECONDARY_ITEMS is the same list nav.ts owns, so
                adding a screen there surfaces it here with no second edit.
                Rendered first = furthest from the thumb, since navigation is the
                colder action; Add/Scan stay closest. */}
            {SECONDARY_ITEMS.map(({ href, label, icon: Icon }, i) => (
              <Link
                key={href}
                href={href}
                onClick={() => setIsOpen(false)}
                aria-current={pathname === href ? 'page' : undefined}
                className={`flex items-center gap-2 px-4 py-3 min-h-[44px] rounded-full border shadow-lg animate-fade-in-up transition-colors ${
                  pathname === href
                    ? 'bg-[var(--accent-primary)] border-transparent text-[#16181c]'
                    : 'bg-[var(--background-secondary)] border-[var(--border-color)] text-[var(--foreground-secondary)] hover:text-[var(--foreground)] hover:bg-[var(--background-tertiary)]'
                }`}
                style={{ animationDelay: `${i * 30}ms` }}
              >
                <Icon className="w-5 h-5" aria-hidden="true" />
                <span className="font-medium text-sm">{label}</span>
              </Link>
            ))}

            {/* Scan Receipt */}
            <button
              onClick={handleScanReceipt}
              className="flex items-center gap-2 px-4 py-3 rounded-full bg-gradient-to-r from-amber-500 to-orange-500 text-white shadow-lg shadow-amber-500/30 animate-fade-in-up"
              style={{ animationDelay: '120ms' }}
            >
              <Camera className="w-5 h-5" />
              <span className="font-medium text-sm">Scan Receipt</span>
            </button>

            {/* Add Transaction */}
            <button
              onClick={handleAddTransaction}
              className="flex items-center gap-2 px-4 py-3 rounded-full bg-gradient-to-r from-emerald-500 to-teal-500 text-white shadow-lg shadow-emerald-500/30 animate-fade-in-up"
              style={{ animationDelay: '150ms' }}
            >
              <DollarSign className="w-5 h-5" />
              <span className="font-medium text-sm">Add Expense</span>
            </button>
          </>
        )}

        {/* Main FAB Button */}
        <button
          onClick={toggleMenu}
          aria-label={isOpen ? 'Close menu' : 'Add a transaction, scan a receipt, or open another view'}
          aria-expanded={isOpen}
          className={`w-14 h-14 rounded-full flex items-center justify-center shadow-lg transition-all duration-300 ${
            isOpen 
              ? 'bg-[var(--background-tertiary)] border border-[var(--border-color)] rotate-45' 
              : 'bg-gradient-to-br from-[var(--accent-primary)] to-[var(--accent-secondary)] shadow-[var(--accent-primary)]/30'
          }`}
        >
          {isOpen ? (
            <X className="w-6 h-6 text-[var(--foreground)]" />
          ) : (
            <Plus className="w-6 h-6 text-white" />
          )}
        </button>
      </div>

      {/* Backdrop when menu is open */}
      {isOpen && (
        <div 
          className="fixed inset-0 bg-black/20 z-40"
          onClick={() => setIsOpen(false)}
        />
      )}

      {/* Modals */}
      <AddTransactionModal 
        isOpen={showAddModal} 
        onClose={() => setShowAddModal(false)} 
      />
      <ReceiptScannerModal 
        isOpen={showScanModal} 
        onClose={() => setShowScanModal(false)} 
      />
    </>
  );
}

