'use client';

import { useEffect, useState } from 'react';

export function DarkModeToggle({ collapsed }: { collapsed: boolean }) {
  const [dark, setDark] = useState(false);

  useEffect(() => {
    // Sync with what the inline script already set
    setDark(document.documentElement.classList.contains('dark'));
  }, []);

  function toggle() {
    const next = !dark;
    setDark(next);
    document.documentElement.classList.toggle('dark', next);
    try { localStorage.setItem('theme', next ? 'dark' : 'light'); } catch { /* ignore */ }
  }

  return (
    <button
      onClick={toggle}
      title={dark ? 'Switch to light mode' : 'Switch to dark mode'}
      className="flex items-center gap-3 w-full px-3 py-2 text-sm text-slate-300 hover:bg-slate-800 hover:text-white transition-colors"
    >
      <span className="shrink-0 text-base leading-none">{dark ? '☀' : '☾'}</span>
      {!collapsed && (dark ? 'Light mode' : 'Dark mode')}
    </button>
  );
}
