'use client';

import { useState, useTransition } from 'react';
import { saveRole, resetRole } from '@/app/actions/roles';
import type { RoleDefinition } from '@/app/actions/roles';

export function RoleEditor({ role }: { role: RoleDefinition }) {
  const [open, setOpen] = useState(false);
  const [content, setContent] = useState(role.content);
  const [saved, setSaved] = useState(false);
  const [isPending, startTransition] = useTransition();

  function handleSave() {
    startTransition(async () => {
      await saveRole(role.filename, content);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    });
  }

  function handleReset() {
    startTransition(async () => {
      const defaultContent = await resetRole(role.filename);
      setContent(defaultContent);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    });
  }

  const dirty = content !== role.content;

  return (
    <div className="border border-slate-200 dark:border-slate-700 rounded-lg overflow-hidden">
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center justify-between px-4 py-3 bg-slate-50 dark:bg-slate-800 text-sm font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors"
      >
        <span className="flex items-center gap-2">
          {role.name}
          <span className="text-xs text-slate-400 font-normal">{role.filename}</span>
          {dirty && <span className="text-xs text-amber-500">unsaved</span>}
        </span>
        <span className="text-slate-400 text-xs">{open ? '▲' : '▼'}</span>
      </button>

      {open && (
        <div className="p-4 bg-white dark:bg-slate-900 space-y-3">
          <textarea
            value={content}
            onChange={e => setContent(e.target.value)}
            rows={16}
            className="w-full px-3 py-2 text-sm font-mono border border-slate-300 dark:border-slate-600 rounded-md bg-white dark:bg-slate-800 text-slate-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-slate-500 resize-y"
          />
          <div className="flex items-center justify-between">
            <button
              onClick={handleReset}
              disabled={isPending}
              className="text-xs text-slate-500 hover:text-slate-700 dark:hover:text-slate-300 disabled:opacity-40 transition-colors"
            >
              Reset to default
            </button>
            <button
              onClick={handleSave}
              disabled={isPending || !dirty}
              className="px-4 py-1.5 text-sm font-medium bg-slate-900 dark:bg-white text-white dark:text-slate-900 rounded-md hover:bg-slate-700 disabled:opacity-40 transition-colors"
            >
              {saved ? 'Saved!' : isPending ? 'Saving…' : 'Save'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
