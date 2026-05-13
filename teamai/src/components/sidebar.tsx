'use client';

import { useState } from 'react';
import { usePathname } from 'next/navigation';
import Link from 'next/link';
import type { Project } from '@/lib/project-store';

interface Props {
  projects: Project[];
  activeProjectPath: string | null;
}

export function Sidebar({ projects, activeProjectPath }: Props) {
  const [collapsed, setCollapsed] = useState(false);
  const pathname = usePathname();

  return (
    <aside className={`shrink-0 flex flex-col bg-[#11131b] text-slate-300 transition-all duration-200 ${collapsed ? 'w-12' : 'w-60'}`}>
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-4 border-b border-[#1e293b] bg-[#11131b]">
        {!collapsed && (
          <span className="text-lg font-bold tracking-tight text-white">TeamAI</span>
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
          { href: '/insights', label: 'Insights', icon: '◎' },
          { href: '/ideation', label: 'Ideation', icon: '◈' },
          { href: '/terminals', label: 'Terminals', icon: '▶' },
          { href: '/analytics', label: 'Analytics', icon: '⬡' },
          { href: '/roadmap', label: 'Roadmap', icon: '◉' },
          { href: '/settings', label: 'Settings', icon: '⚙' },
        ].map(({ href, label, icon, match }) => {
          const isActive = match ? match(pathname) : pathname === href;
          return (
          <Link
            key={href}
            href={href}
            title={collapsed ? label : undefined}
            className={`flex items-center gap-3 px-3 py-2 text-sm transition-colors ${
              isActive
                ? 'text-white bg-[#2563eb]/15 border-r-2 border-[#2563eb]'
                : 'text-slate-400 hover:bg-[#1a1f2e] hover:text-white'
            }`}
          >
            <span className="shrink-0 text-base leading-none">{icon}</span>
            {!collapsed && label}
          </Link>
        )})}
      </nav>
    </aside>
  );
}
