import React from 'react';
import { TrendingUp } from 'lucide-react';

/**
 * The one full-page wait (UI spec A2). Seven screens each carried their own copy of
 * this block, drifting apart: two sizes, a white glyph on gold (never white on
 * #D9A521), and only one of them told a screen reader anything was happening.
 * The pulse stops under prefers-reduced-motion via the global rule in globals.css.
 */
export default function LoadingScreen() {
  return (
    <div role="status" className="min-h-screen flex items-center justify-center">
      <div className="bg-pattern" />
      <div className="animate-pulse-glow w-16 h-16 rounded-card bg-gradient-to-br from-[var(--accent-primary)] to-[var(--accent-secondary)] flex items-center justify-center">
        <TrendingUp className="w-8 h-8 text-[#16181c]" aria-hidden="true" />
      </div>
      <span className="sr-only">Loading</span>
    </div>
  );
}
