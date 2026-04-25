'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { setActiveProject, addProject } from '@/app/actions/projects';
import { DirectoryBrowser } from './directory-browser';
import type { Project } from '@/lib/project-store';

interface Props {
  projects: Project[];
  activeProjectPath: string | null;
}

export function ProjectSelector({ projects, activeProjectPath }: Props) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [showDialog, setShowDialog] = useState(false);
  const [showBrowser, setShowBrowser] = useState(false);
  const [pathValue, setPathValue] = useState('');

  function handleSelect(path: string) {
    startTransition(async () => {
      await setActiveProject(path);
      router.refresh();
    });
  }

  function handleAdd(formData: FormData) {
    startTransition(async () => {
      await addProject(formData);
      setShowDialog(false);
      setPathValue('');
      router.refresh();
    });
  }

  function handleBrowseSelect(path: string) {
    setPathValue(path);
    setShowBrowser(false);
  }

  return (
    <div className="p-3">
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs font-semibold uppercase tracking-wider text-slate-400">
          Projects
        </span>
        <button
          onClick={() => setShowDialog(true)}
          className="text-xs text-slate-400 hover:text-white transition-colors"
        >
          + Add
        </button>
      </div>

      <ul className="space-y-1">
        {projects.map(p => (
          <li key={p.path}>
            <button
              onClick={() => handleSelect(p.path)}
              disabled={isPending}
              title={p.path}
              className={`w-full text-left px-3 py-2 rounded text-sm truncate transition-colors ${
                p.path === activeProjectPath
                  ? 'bg-slate-700 text-white'
                  : 'text-slate-300 hover:bg-slate-800 hover:text-white'
              }`}
            >
              {p.name}
            </button>
          </li>
        ))}
        {projects.length === 0 && (
          <li className="text-xs text-slate-500 px-3 py-2">No projects yet</li>
        )}
      </ul>

      {/* Add Project Dialog */}
      {showDialog && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div className="absolute inset-0 bg-black/60" onClick={() => setShowDialog(false)} />
          <div className="relative bg-white dark:bg-slate-800 rounded-lg shadow-xl p-6 w-full max-w-md mx-4">
            <h2 className="text-base font-semibold text-slate-900 dark:text-white mb-4">
              Add Project
            </h2>
            <form action={handleAdd} className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">
                  Path{' '}
                  <span className="font-normal text-slate-400">(absolute path to git repo)</span>
                </label>
                <div className="flex gap-2">
                  <input
                    name="path"
                    required
                    value={pathValue}
                    onChange={e => setPathValue(e.target.value)}
                    placeholder="/home/user/my-project"
                    className="flex-1 min-w-0 px-3 py-2 text-sm border border-slate-300 dark:border-slate-600 rounded-md bg-white dark:bg-slate-700 text-slate-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-slate-500"
                  />
                  <button
                    type="button"
                    onClick={() => setShowBrowser(true)}
                    className="px-3 py-2 text-sm border border-slate-300 dark:border-slate-600 rounded-md bg-slate-50 dark:bg-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-600 transition-colors shrink-0"
                  >
                    Browse
                  </button>
                </div>
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">
                  Name{' '}
                  <span className="font-normal text-slate-400">(optional)</span>
                </label>
                <input
                  name="name"
                  placeholder="My Project"
                  className="w-full px-3 py-2 text-sm border border-slate-300 dark:border-slate-600 rounded-md bg-white dark:bg-slate-700 text-slate-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-slate-500"
                />
              </div>
              <div className="flex justify-end gap-3 pt-2">
                <button
                  type="button"
                  onClick={() => { setShowDialog(false); setPathValue(''); }}
                  className="px-4 py-2 text-sm text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isPending}
                  className="px-4 py-2 text-sm font-medium bg-slate-900 dark:bg-white text-white dark:text-slate-900 rounded-md hover:bg-slate-700 dark:hover:bg-slate-100 transition-colors disabled:opacity-50"
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
