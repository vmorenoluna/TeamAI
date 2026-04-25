'use client';

import { useState } from 'react';
import Link from 'next/link';
import { ProjectSelector } from './project-selector';
import type { Project } from '@/lib/project-store';

interface Props {
  projects: Project[];
  activeProjectPath: string | null;
}

export function Sidebar({ projects, activeProjectPath }: Props) {
  const [collapsed, setCollapsed] = useState(false);

  return (
    <aside className={`shrink-0 flex flex-col bg-slate-900 text-slate-100 transition-all duration-200 ${collapsed ? 'w-12' : 'w-60'}`}>
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-4 border-b border-slate-700">
        {!collapsed && (
          <span className="text-lg font-bold tracking-tight">TeamAI</span>
        )}
        <button
          onClick={() => setCollapsed(c => !c)}
          title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          className="text-slate-400 hover:text-white transition-colors p-1 rounded"
        >
          {collapsed ? '→' : '←'}
        </button>
      </div>

      {/* Project selector (hidden when collapsed) */}
      {!collapsed && (
        <div className="flex-1 overflow-y-auto">
          <ProjectSelector projects={projects} activeProjectPath={activeProjectPath} />
        </div>
      )}

      {/* Nav links */}
      <nav className="border-t border-slate-700 py-2">
        {[
          { href: '/', label: 'Kanban', icon: '▦' },
          { href: '/insights', label: 'Insights', icon: '◎' },
          { href: '/ideation', label: 'Ideation', icon: '◈' },
          { href: '/roadmap', label: 'Roadmap', icon: '◉' },
          { href: '/settings', label: 'Settings', icon: '⚙' },
        ].map(({ href, label, icon }) => (
          <Link
            key={href}
            href={href}
            title={collapsed ? label : undefined}
            className="flex items-center gap-3 px-3 py-2 text-sm text-slate-300 hover:bg-slate-800 hover:text-white transition-colors"
          >
            <span className="shrink-0 text-base leading-none">{icon}</span>
            {!collapsed && label}
          </Link>
        ))}
      </nav>
    </aside>
  );
}
