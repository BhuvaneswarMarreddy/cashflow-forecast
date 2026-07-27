'use client';

import React, { useEffect, useRef } from 'react';

/**
 * The one modal primitive: a native <dialog>. showModal() gives focus trap,
 * Esc (via cancel), and the top layer for free. Desktop looks exactly like the
 * old .modal-content card; <=640px it renders as a bottom sheet (see globals.css).
 *
 * iOS Safari does NOT lock background scroll behind an open dialog — the body
 * position:fixed dance below is the load-bearing part, don't remove it.
 */
export default function Sheet({ open, onClose, ariaLabel, maxWidth, className, children }: {
  open: boolean;
  onClose: () => void;
  ariaLabel: string;
  /** CSS length for the desktop max width (default 500px), e.g. "48rem". */
  maxWidth?: string;
  /** Padding/layout utilities for the content wrapper (NOT the dialog itself). */
  className?: string;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);

  // Keep the native dialog in sync with the `open` prop.
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    else if (!open && d.open) d.close();
  }, [open]);

  // iOS body-scroll lock: fix the body at the current scroll offset, restore on close.
  useEffect(() => {
    if (!open) return;
    const y = window.scrollY;
    const prev = {
      position: document.body.style.position,
      top: document.body.style.top,
      width: document.body.style.width,
    };
    document.body.style.position = 'fixed';
    document.body.style.top = `-${y}px`;
    document.body.style.width = '100%';
    return () => {
      document.body.style.position = prev.position;
      document.body.style.top = prev.top;
      document.body.style.width = prev.width;
      window.scrollTo(0, y);
    };
  }, [open]);

  return (
    <dialog
      ref={ref}
      className="sheet"
      style={maxWidth ? ({ ['--sheet-max-w' as string]: maxWidth } as React.CSSProperties) : undefined}
      aria-label={ariaLabel}
      onCancel={(e) => { e.preventDefault(); onClose(); }} // Esc → parent state stays the source of truth
      onClick={(e) => { if (e.target === ref.current) onClose(); }} // backdrop click
    >
      <div className={className}>{children}</div>
    </dialog>
  );
}
