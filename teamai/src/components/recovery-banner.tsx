'use client';

import { useState } from 'react';
import type { InterruptedTask } from '@/lib/recovery';

export function RecoveryBanner({ tasks }: { tasks: InterruptedTask[] }) {
  const [dismissed, setDismissed] = useState(false);

  if (tasks.length === 0 || dismissed) return null;

  return (
    <div className="shrink-0 bg-amber-950/20 border-b border-amber-800/30 px-4 py-2 flex items-center justify-between gap-3">
      <p className="text-xs text-amber-300/90">
        <span className="font-semibold">⚠ {tasks.length} interrupted task{tasks.length > 1 ? 's' : ''}</span>
        {' '}detected from previous session — auto-resumed on server startup.
        {tasks.length === 1 && (
          <span className="text-amber-400/70"> ({tasks[0].title})</span>
        )}
      </p>
      <button
        onClick={() => setDismissed(true)}
        title="Dismiss"
        className="shrink-0 w-5 h-5 flex items-center justify-center rounded text-amber-400/60 hover:text-amber-300 hover:bg-amber-900/30 transition-colors text-sm leading-none"
      >
        ×
      </button>
    </div>
  );
}
