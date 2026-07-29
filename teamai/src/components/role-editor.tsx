'use client';

import { useState, useTransition } from 'react';
import { saveRole, resetRole } from '@/app/actions/roles';
import type { RoleDefinition } from '@/app/actions/roles';
import { formatActionError } from '@/lib/error-format';

export function RoleEditor({ role }: { role: RoleDefinition }) {
  const [open, setOpen] = useState(false);
  const [content, setContent] = useState(role.content);
  const [saved, setSaved] = useState(false);
  // Regression-fix contract: surfaces Server Action failures (raw-throw path).
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function handleSave() {
    setError(null);
    startTransition(async () => {
      try {
        await saveRole(role.filename, content);
        setSaved(true);
        setTimeout(() => setSaved(false), 2000);
      } catch (err) {
        setError(formatActionError('save role', err));
      }
    });
  }

  function handleReset() {
    setError(null);
    startTransition(async () => {
      try {
        const defaultContent = await resetRole(role.filename);
        setContent(defaultContent);
        setSaved(true);
        setTimeout(() => setSaved(false), 2000);
      } catch (err) {
        setError(formatActionError('reset role', err));
      }
    });
  }

  const dirty = content !== role.content;

  return (
    <div className="border border-[#1e293b] rounded-lg overflow-hidden">
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center justify-between px-4 py-3 bg-[#1a1f2e] text-sm font-medium text-slate-200 hover:bg-[#1e293b] transition-colors"
      >
        <span className="flex items-center gap-2">
          {role.name}
          <span className="text-xs text-slate-400 font-normal">{role.filename}</span>
          {dirty && <span className="text-xs text-amber-500">unsaved</span>}
        </span>
        <span className="text-slate-400 text-xs">{open ? '▲' : '▼'}</span>
      </button>

      {open && (
        <div data-component="role-editor-content" className="p-4 bg-[#11131b] space-y-3">
          <textarea
            value={content}
            onChange={e => setContent(e.target.value)}
            rows={16}
            className="w-full px-3 py-2 text-sm font-mono border border-[#334155] rounded-lg bg-[#1e2333] text-white focus:outline-none focus:ring-2 focus:ring-[#2563eb] resize-y"
          />
          {/* Inline error banner — surfaces Server Action throws from handleSave / handleReset. */}
          {error && (
            <div
              role="alert"
              className="p-2 bg-red-900/30 border border-red-800/50 rounded flex items-start justify-between gap-2"
            >
              <p className="text-xs text-red-300 flex-1">{error}</p>
              <button
                onClick={() => setError(null)}
                aria-label="Dismiss error"
                className="text-red-500 hover:text-red-300 text-xs leading-none transition-colors"
              >
                ✕
              </button>
            </div>
          )}

          <div className="flex items-center justify-between">
            <button
              onClick={handleReset}
              disabled={isPending}
              className="text-xs text-slate-400 hover:text-white disabled:opacity-40 transition-colors"
            >
              Reset to default
            </button>
            <button
              onClick={handleSave}
              disabled={isPending || !dirty}
              className="px-4 py-1.5 text-sm font-medium bg-[#2563eb] text-white rounded-lg hover:bg-[#1d4ed8] disabled:opacity-40 transition-colors"
            >
              {saved ? 'Saved!' : isPending ? 'Saving…' : 'Save'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
