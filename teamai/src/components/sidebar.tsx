'use client';

import { useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import Link from 'next/link';
import type { Project } from '@/lib/project-store';

interface Props {
  projects: Project[];
  activeProjectPath: string | null;
  /** Number of pending role-refinement suggestions — shown as a badge on the
   *  Settings nav item (Role Refinement Assistant, Phase 2). Server-supplied
   *  so it refreshes with router.refresh() on refinement-update events. */
  refinementPendingCount?: number;
}

export function Sidebar({ projects: _projects, activeProjectPath: _activeProjectPath, refinementPendingCount = 0 }: Props) {
  const [collapsed, setCollapsed] = useState(false);
  const pathname = usePathname();
  const router = useRouter();

  return (
    <aside className={`shrink-0 flex flex-col bg-[#11131b] text-slate-300 transition-all duration-200 ${collapsed ? 'w-12' : 'w-48 lg:w-60'}`}>
      {/* Header */}
      <div className="flex items-center justify-between px-2 lg:px-3 py-4 border-b border-[#1e293b] bg-[#11131b]">
        {!collapsed && (
          <span className="text-base lg:text-lg font-bold tracking-tight text-white truncate">TeamAI</span>
        )}
        <button
          onClick={() => setCollapsed(c => !c)}
          title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          className="text-slate-500 hover:text-slate-300 transition-colors p-1 rounded"
        >
          {collapsed ? '→' : '←'}
        </button>
      </div>

      {/* Nav links */}
      <nav className={`flex-1 overflow-y-auto py-2 border-t border-[#1e293b]`}>
        {[
          { href: '/', label: 'Kanban', icon: '▦', match: (p: string) => p === '/' || p.startsWith('/task') },
          { href: '/workflow', label: 'Workflow', icon: '⇢' },
          { href: '/terminals', label: 'Terminals', icon: '▶' },
          { href: '/roadmap', label: 'Roadmap', icon: '◉' },
          { href: '/settings', label: 'Settings', icon: '⚙', badge: refinementPendingCount },
        ].map(({ href, label, icon, match, badge }) => {
          const isActive = match ? match(pathname) : pathname === href;
          return (
          <Link
            key={href}
            href={href}
            title={collapsed ? label : undefined}
            onKeyDown={(e) => {
              // Ensure keyboard Enter activates navigation even when Next.js
              // Link's synthetic click handling is not enough for the test
              // harness or assistive-tech users.
              if (e.key === 'Enter') {
                e.preventDefault();
                router.push(href);
              }
            }}
            className={`flex items-center gap-2 lg:gap-3 px-2 lg:px-3 py-2 text-sm transition-colors ${
              isActive
                ? 'text-white bg-[#2563eb]/15 border-r-2 border-[#2563eb]'
                : 'text-slate-400 hover:bg-[#1a1f2e] hover:text-white'
            }`}
          >
            <span className="shrink-0 text-base leading-none">{icon}</span>
            {!collapsed && label}
            {(badge ?? 0) > 0 && (
              <span
                data-component="sidebar-refinement-badge"
                className="ml-auto shrink-0 min-w-[1.25rem] h-5 px-1.5 inline-flex items-center justify-center rounded-full bg-[#2563eb]/30 text-[#93c5fd] text-[10px] font-semibold border border-[#2563eb]/50"
                title={`${badge} pending role refinement${badge === 1 ? '' : 's'}`}
              >
                {badge}
              </span>
            )}
          </Link>
        )})}
      </nav>
    </aside>
  );
}
