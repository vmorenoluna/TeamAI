'use client';

import { useState, useTransition, useEffect, useRef } from 'react';
import { saveContainerConfig } from '@/app/actions/containers';
import type { ContainerConfig } from '@/app/actions/containers';
import type { ContainerState } from '@/lib/container-manager';

const STATE_BADGE: Record<ContainerState, { label: string; cls: string }> = {
  stopped:    { label: 'Stopped',    cls: 'bg-slate-100 text-slate-500 dark:bg-slate-700 dark:text-slate-400' },
  starting:   { label: 'Starting…',  cls: 'bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300' },
  running:    { label: 'Running',    cls: 'bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300' },
  restarting: { label: 'Restarting…', cls: 'bg-amber-100 text-amber-700 dark:bg-amber-900 dark:text-amber-300' },
};

interface Props {
  config: ContainerConfig;
  initialState: ContainerState;
  projectPath: string;
}

export function ContainerConfigEditor({ config, initialState, projectPath }: Props) {
  const [enabled, setEnabled] = useState(config.enabled);
  const [state, setState] = useState<ContainerState>(initialState);
  const [isPending, startTransition] = useTransition();
  const wsRef = useRef<WebSocket | null>(null);

  // Subscribe to live container-state events
  useEffect(() => {
    const ws = new WebSocket(`ws://${window.location.host}/ws`);
    wsRef.current = ws;
    ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        if (msg.type === 'container-state' && msg.projectRoot === projectPath) {
          setState(msg.state as ContainerState);
        }
      } catch { /* ignore */ }
    };
    return () => {
      if (ws.readyState === WebSocket.CONNECTING) {
        ws.addEventListener('open', () => ws.close());
      } else {
        ws.close();
      }
    };
  }, [projectPath]);

  function toggle() {
    const next = !enabled;
    setEnabled(next);
    startTransition(async () => { await saveContainerConfig({ enabled: next }); });
  }

  const badge = STATE_BADGE[state];

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between p-3 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/50">
        <div className="space-y-0.5">
          <p className="text-sm font-medium text-slate-800 dark:text-slate-200">
            Run agents in devcontainer
          </p>
          <p className="text-xs text-slate-500">
            Requires <code className="font-mono">.devcontainer/devcontainer.json</code> in the project.
            All tasks share one long-lived container; worktrees go to <code className="font-mono">.worktrees/</code>.
          </p>
        </div>
        <button
          onClick={toggle}
          disabled={isPending}
          aria-checked={enabled}
          role="switch"
          className={`relative ml-4 inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors focus:outline-none disabled:opacity-50 ${
            enabled ? 'bg-slate-900 dark:bg-white' : 'bg-slate-300 dark:bg-slate-600'
          }`}
        >
          <span
            className={`inline-block h-4 w-4 rounded-full bg-white dark:bg-slate-900 shadow transition-transform ${
              enabled ? 'translate-x-4' : 'translate-x-0'
            }`}
          />
        </button>
      </div>

      {enabled && (
        <div className="flex items-center gap-2 px-1">
          <span className="text-xs text-slate-500 dark:text-slate-400">Container status:</span>
          <span className={`text-[10px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded ${badge.cls}`}>
            {badge.label}
          </span>
        </div>
      )}
    </div>
  );
}
