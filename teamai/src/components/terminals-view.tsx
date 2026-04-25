'use client';

import { useState, useTransition } from 'react';
import { createTerminalSession } from '@/app/actions/terminals';
import { TerminalPanel } from './terminal-panel';
import type { RoleDefinition } from '@/app/actions/roles';

interface ActiveTerminal {
  sessionId: string;
  role: string;
}

export function TerminalsView({ roles }: { roles: RoleDefinition[] }) {
  const [terminals, setTerminals] = useState<ActiveTerminal[]>([]);
  const [showDialog, setShowDialog] = useState(false);
  const [selectedRole, setSelectedRole] = useState(roles[0]?.filename ?? '');
  const [model, setModel] = useState('');
  const [isPending, startTransition] = useTransition();

  function handleOpen() {
    startTransition(async () => {
      const sessionId = await createTerminalSession(selectedRole, model || undefined);
      setTerminals(prev => [...prev, { sessionId, role: selectedRole }]);
      setShowDialog(false);
    });
  }

  function handleClose(sessionId: string) {
    setTerminals(prev => prev.filter(t => t.sessionId !== sessionId));
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="shrink-0 flex items-center justify-between px-6 py-4 border-b border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900">
        <div>
          <h1 className="text-base font-semibold text-slate-900 dark:text-white">Terminals</h1>
          <p className="text-xs text-slate-500 mt-0.5">Interactive Claude sessions pre-loaded with a role persona.</p>
        </div>
        <button
          onClick={() => setShowDialog(true)}
          className="px-3 py-1.5 text-sm font-medium bg-slate-900 dark:bg-white text-white dark:text-slate-900 rounded-md hover:bg-slate-700 transition-colors"
        >
          + New Terminal
        </button>
      </div>

      {/* Terminal grid */}
      <div className={`flex-1 min-h-0 p-4 grid gap-4 ${
        terminals.length === 0 ? '' :
        terminals.length === 1 ? 'grid-cols-1' :
        'grid-cols-2'
      }`}>
        {terminals.length === 0 && (
          <div className="flex items-center justify-center text-sm text-slate-400">
            Click "+ New Terminal" to open an interactive Claude session.
          </div>
        )}
        {terminals.map(t => (
          <TerminalPanel
            key={t.sessionId}
            sessionId={t.sessionId}
            role={t.role}
            onClose={() => handleClose(t.sessionId)}
          />
        ))}
      </div>

      {/* New Terminal dialog */}
      {showDialog && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div className="absolute inset-0 bg-black/60" onClick={() => setShowDialog(false)} />
          <div className="relative bg-white dark:bg-slate-800 rounded-lg shadow-xl p-6 w-full max-w-sm mx-4 space-y-4">
            <h2 className="text-base font-semibold text-slate-900 dark:text-white">New Terminal</h2>
            <div>
              <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">Role</label>
              <select
                value={selectedRole}
                onChange={e => setSelectedRole(e.target.value)}
                className="w-full px-3 py-2 text-sm border border-slate-300 dark:border-slate-600 rounded-md bg-white dark:bg-slate-700 text-slate-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-slate-500"
              >
                {roles.map(r => (
                  <option key={r.filename} value={r.filename}>{r.name}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">
                Model <span className="font-normal text-slate-400">(optional override)</span>
              </label>
              <input
                value={model}
                onChange={e => setModel(e.target.value)}
                placeholder="claude-sonnet-4-6"
                className="w-full px-3 py-2 text-sm border border-slate-300 dark:border-slate-600 rounded-md bg-white dark:bg-slate-700 text-slate-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-slate-500"
              />
            </div>
            <div className="flex justify-end gap-3 pt-1">
              <button onClick={() => setShowDialog(false)} className="px-4 py-2 text-sm text-slate-600 dark:text-slate-300">Cancel</button>
              <button
                onClick={handleOpen}
                disabled={isPending || !selectedRole}
                className="px-4 py-2 text-sm font-medium bg-slate-900 dark:bg-white text-white dark:text-slate-900 rounded-md hover:bg-slate-700 disabled:opacity-40 transition-colors"
              >
                {isPending ? 'Opening…' : 'Open'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
