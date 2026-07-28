'use client';

import React, { useState } from 'react';
import { Monitor, Moon, Sun } from 'lucide-react';

type Theme = 'auto' | 'dark' | 'light';

const OPTIONS: Array<{ key: Theme; label: string; icon: typeof Moon }> = [
  { key: 'auto', label: 'Auto', icon: Monitor },
  { key: 'dark', label: 'Dark', icon: Moon },
  { key: 'light', label: 'Light', icon: Sun },
];

/**
 * Auto follows the OS (prefers-color-scheme); Dark/Light force via
 * data-theme on <html>, which the token layer lets win in both directions.
 * Persisted to localStorage; applied pre-paint by the layout boot script.
 */
export default function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>(() => {
    if (typeof window === 'undefined') return 'auto';
    const t = localStorage.getItem('theme');
    return t === 'light' || t === 'dark' ? t : 'auto';
  });

  const apply = (t: Theme) => {
    setTheme(t);
    if (t === 'auto') {
      localStorage.removeItem('theme');
      delete document.documentElement.dataset.theme;
    } else {
      localStorage.setItem('theme', t);
      document.documentElement.dataset.theme = t;
    }
  };

  return (
    <div role="group" aria-label="Theme" className="flex gap-1 rounded-lg bg-[var(--background-tertiary)] p-1 w-fit">
      {OPTIONS.map(({ key, label, icon: Icon }) => (
        <button
          key={key}
          onClick={() => apply(key)}
          aria-pressed={theme === key}
          className={`flex items-center gap-2 px-3 py-2 rounded-md text-sm transition-colors ${
            theme === key
              ? 'bg-[var(--accent-primary)] text-[#16181c] font-medium'
              : 'text-[var(--foreground-secondary)] hover:text-[var(--foreground)]'
          }`}
        >
          <Icon className="w-4 h-4" aria-hidden="true" />
          {label}
        </button>
      ))}
    </div>
  );
}
