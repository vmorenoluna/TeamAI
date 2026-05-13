'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { setActiveProject, addProject, removeProject } from '@/app/actions/projects';
import { DirectoryBrowser } from './directory-browser';
import type { Project } from '@/lib/project-store';

interface Props {
  projects: Project[];
  activeProjectPath: string | null;
  collapsed?: boolean;
}

export function ProjectSelector({ projects, activeProjectPath, collapsed = false }: Props) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [showDialog, setShowDialog] = useState(false);
  const [showBrowser, setShowBrowser] = useState(false);
  const [pathValue, setPathValue] = useState('');
  const [addError, setAddError] = useState<string | null>(null);

  function handleSelect(path: string) {
    startTransition(async () => {
      await setActiveProject(path);
      router.refresh();
    });
  }

  function handleAdd(formData: FormData) {
    setAddError(null);
    startTransition(async () => {
      const result = await addProject(formData);
      if ('error' in result) {
        setAddError(result.error);
      } else {
        setShowDialog(false);
        setPathValue('');
        router.refresh();
      }
    });
  }

  function handleRemove(e: React.MouseEvent, path: string) {
    e.stopPropagation();
    startTransition(async () => {
      await removeProject(path);
      router.refresh();
    });
  }

  function handleBrowseSelect(path: string) {
    setPathValue(path);
    setShowBrowser(false);
  }

  // Collapsed: show nothing (no room for tabs)
  if (collapsed) return null;

  return (
    <div className="flex items-center gap-0 px-3 py-2 overflow-x-auto shrink-0 border-b border-[#1e293b]">
      {projects.map(p => (
        <div key={p.path} className="group relative shrink-0">
          <button
            onClick={() => handleSelect(p.path)}
            disabled={isPending}
            title={p.path}
            className={`px-4 py-2.5 text-sm font-medium transition-colors truncate max-w-[140px] border-b-2 ${
              p.path === activeProjectPath
                ? 'text-white border-[#2563eb]'
                : 'text-slate-500 border-transparent hover:text-slate-300 hover:border-[#334155]'
            }`}
          >
            {p.name}
          </button>
          <button
            onClick={(e) => handleRemove(e, p.path)}
            disabled={isPending}
            title="Remove project"
            className="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-[#1e2333] border border-[#1e293b] text-[10px] text-slate-500 hover:text-red-400 hover:border-red-800 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-all leading-none"
          >
            ×
          </button>
        </div>
      ))}

      {/* + Add button */}
      <button
        onClick={() => setShowDialog(true)}
        title="Add project"
        className="shrink-0 px-3 py-2.5 text-sm font-medium text-slate-500 hover:text-slate-300 transition-colors leading-none border-b-2 border-transparent"
      >
        +
      </button>

      {/* Add Project Dialog */}
      {showDialog && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div className="absolute inset-0 bg-black/60" onClick={() => setShowDialog(false)} />
          <div className="relative bg-[#1e2333] rounded-xl shadow-2xl shadow-black/40 border border-[#1e293b] p-6 w-full max-w-md mx-4">
            <h2 className="text-base font-semibold text-white mb-4">
              Add Project
            </h2>
            <form action={handleAdd} className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-slate-300 mb-1">
                  Path{' '}
                  <span className="font-normal text-slate-500">(absolute path to git repo)</span>
                </label>
                <div className="flex gap-2">
                  <input
                    name="path"
                    required
                    value={pathValue}
                    onChange={e => setPathValue(e.target.value)}
                    placeholder="/home/user/my-project"
                    className="flex-1 min-w-0 px-3 py-2 text-sm border border-[#334155] rounded-lg bg-[#11131b] text-white focus:outline-none focus:ring-2 focus:ring-[#2563eb] placeholder-slate-500"
                  />
                  <button
                    type="button"
                    onClick={() => setShowBrowser(true)}
                    className="px-3 py-2 text-sm border border-[#334155] rounded-lg bg-[#1a1f2e] text-slate-300 hover:bg-[#1e293b] transition-colors shrink-0"
                  >
                    Browse
                  </button>
                </div>
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-300 mb-1">
                  Name{' '}
                  <span className="font-normal text-slate-500">(optional)</span>
                </label>
                <input
                  name="name"
                  placeholder="My Project"
                  className="w-full px-3 py-2 text-sm border border-[#334155] rounded-lg bg-[#11131b] text-white focus:outline-none focus:ring-2 focus:ring-[#2563eb] placeholder-slate-500"
                />
              </div>
              {addError && (
                <p className="text-sm text-red-500">{addError}</p>
              )}
              <div className="flex justify-end gap-3 pt-2">
                <button
                  type="button"
                  onClick={() => { setShowDialog(false); setPathValue(''); setAddError(null); }}
                  className="px-4 py-2 text-sm text-slate-400 hover:text-white transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isPending}
                  className="px-4 py-2 text-sm font-medium bg-[#2563eb] text-white rounded-lg hover:bg-[#1d4ed8] transition-colors disabled:opacity-50"
                >
                  {isPending ? 'Adding…' : 'Add Project'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Directory Browser — z-[60] so it layers above the Add dialog */}
      {showBrowser && (
        <DirectoryBrowser
          onSelect={handleBrowseSelect}
          onClose={() => setShowBrowser(false)}
        />
      )}
    </div>
  );
}
