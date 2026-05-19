'use client';

import { useState, useTransition, useEffect, useRef } from 'react';
import { createTerminalSession, closeTerminalSession } from '@/app/actions/terminals';
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
    // Also kill the PTY server-side so resources are freed immediately
    closeTerminalSession(sessionId).catch(() => {});
    setTerminals(prev => prev.filter(t => t.sessionId !== sessionId));
  }

  // Kill all terminal sessions when the component unmounts (user navigates away).
  // Use a ref so the cleanup always sees the latest terminals without re-running
  // on every state change (which would double-close on individual terminal removal).
  const terminalsRef = useRef(terminals);

  useEffect(() => {
    terminalsRef.current = terminals;
    return () => {
      for (const t of terminalsRef.current) {
        closeTerminalSession(t.sessionId).catch(() => {});
      }
    };
    // Only run on mount/unmount; terminalsRef.current is always fresh
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="shrink-0 flex items-center justify-between px-6 py-4 border-b border-[#1e293b] bg-[#11131b]">
        <div>
          <h1 className="text-base font-semibold text-white">Terminals</h1>
          <p className="text-xs text-slate-400 mt-0.5">Interactive Claude sessions pre-loaded with a role persona.</p>
        </div>
        <button
          onClick={() => setShowDialog(true)}
          className="px-3 py-1.5 text-sm font-medium bg-[#2563eb] text-white rounded-lg hover:bg-[#1d4ed8] transition-colors"
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
            Click &quot;+ New Terminal&quot; to open an interactive Claude session.
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
          <div className="relative bg-[#1e2333] rounded-xl shadow-2xl shadow-black/40 border border-[#1e293b] p-6 w-full max-w-sm mx-4 space-y-4">
            <h2 className="text-base font-semibold text-white">New Terminal</h2>
            <div>
              <label className="block text-sm font-medium text-slate-300 mb-1">Role</label>
              <select
                value={selectedRole}
                onChange={e => setSelectedRole(e.target.value)}
                className="w-full px-3 py-2 text-sm border border-[#334155] rounded-lg bg-[#11131b] text-white focus:outline-none focus:ring-2 focus:ring-[#2563eb]"
              >
                {roles.map(r => (
                  <option key={r.filename} value={r.filename}>{r.name}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">
                Model                <span className="font-normal text-slate-500">(optional override)</span>
              </label>
              <input
                value={model}
                onChange={e => setModel(e.target.value)}
                placeholder="claude-sonnet-4-6"
                className="w-full px-3 py-2 text-sm border border-[#334155] rounded-lg bg-[#11131b] text-white focus:outline-none focus:ring-2 focus:ring-[#2563eb] placeholder-slate-500"
              />
            </div>
            <div className="flex justify-end gap-3 pt-1">
              <button onClick={() => setShowDialog(false)} className="px-4 py-2 text-sm text-slate-400 hover:text-white transition-colors">Cancel</button>
              <button
                onClick={handleOpen}
                disabled={isPending || !selectedRole}
                className="px-4 py-2 text-sm font-medium bg-[#2563eb] text-white rounded-lg hover:bg-[#1d4ed8] disabled:opacity-40 transition-colors"
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
