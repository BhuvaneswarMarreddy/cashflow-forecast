'use client';

import React, { useState } from 'react';
import { Plus, Camera, FileText, X, DollarSign } from 'lucide-react';
import AddTransactionModal from './AddTransactionModal';
import ReceiptScannerModal from './ReceiptScannerModal';

export default function QuickAddFAB() {
  const [isOpen, setIsOpen] = useState(false);
  const [showAddModal, setShowAddModal] = useState(false);
  const [showScanModal, setShowScanModal] = useState(false);

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
            {/* Scan Receipt */}
            <button
              onClick={handleScanReceipt}
              className="flex items-center gap-2 px-4 py-3 rounded-full bg-gradient-to-r from-amber-500 to-orange-500 text-white shadow-lg shadow-amber-500/30 animate-fade-in-up"
              style={{ animationDelay: '0ms' }}
            >
              <Camera className="w-5 h-5" />
              <span className="font-medium text-sm">Scan Receipt</span>
            </button>

            {/* Add Transaction */}
            <button
              onClick={handleAddTransaction}
              className="flex items-center gap-2 px-4 py-3 rounded-full bg-gradient-to-r from-emerald-500 to-teal-500 text-white shadow-lg shadow-emerald-500/30 animate-fade-in-up"
              style={{ animationDelay: '50ms' }}
            >
              <DollarSign className="w-5 h-5" />
              <span className="font-medium text-sm">Add Expense</span>
            </button>
          </>
        )}

        {/* Main FAB Button */}
        <button
          onClick={toggleMenu}
          aria-label={isOpen ? 'Close quick add menu' : 'Quick add — expense or receipt'}
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

