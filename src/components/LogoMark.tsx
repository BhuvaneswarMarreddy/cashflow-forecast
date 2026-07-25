import React from 'react';

/**
 * The CashFlow mark — a gold coin with an embossed C and a slow gleam sweeping
 * across it. The gleam is inline SMIL so it animates without JS; it degrades to
 * a still coin when the tab is backgrounded or motion is reduced.
 */
export default function LogoMark({ size = 36, animated = true, className }: { size?: number; animated?: boolean; className?: string }) {
  const clip = React.useId().replace(/:/g, '');
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" className={className} role="img" aria-label="CashFlow">
      <defs>
        <clipPath id={`coin-${clip}`}>
          <circle cx="32" cy="32" r="23" />
        </clipPath>
      </defs>
      <circle cx="32" cy="32" r="23" fill="#b08d3f" />
      <circle cx="32" cy="32" r="23" fill="none" stroke="#8f7233" strokeWidth="2" />
      <path d="M42 25A12 12 0 1 0 42 39" fill="none" stroke="#2b3138" strokeWidth="6" strokeLinecap="round" />
      {animated && (
        <g clipPath={`url(#coin-${clip})`} className="motion-safe:block motion-reduce:hidden">
          <rect y="-6" width="12" height="76" fill="#fff" opacity="0.25" transform="rotate(18 32 32)">
            <animate attributeName="x" from="-24" to="70" dur="3.2s" repeatCount="indefinite" />
          </rect>
        </g>
      )}
    </svg>
  );
}
