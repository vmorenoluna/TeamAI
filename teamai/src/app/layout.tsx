import type { Metadata } from 'next';
import { Geist, Geist_Mono } from 'next/font/google';
import './globals.css';
import Link from 'next/link';
import { getProjects, getActiveProject } from '@/app/actions/projects';
import { ProjectSelector } from '@/components/project-selector';

const geistSans = Geist({ variable: '--font-geist-sans', subsets: ['latin'] });
const geistMono = Geist_Mono({ variable: '--font-geist-mono', subsets: ['latin'] });

export const metadata: Metadata = {
  title: 'TeamAI',
  description: 'Multi-agent coding assistant',
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const projects = await getProjects();
  const activeProject = await getActiveProject();

  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable} h-full`}>
      <body className="h-full flex antialiased bg-slate-50 dark:bg-slate-950">
        <aside className="w-60 shrink-0 flex flex-col bg-slate-900 text-slate-100">
          <div className="px-4 py-5 border-b border-slate-700">
            <span className="text-lg font-bold tracking-tight">TeamAI</span>
          </div>
          <div className="flex-1 overflow-y-auto">
            <ProjectSelector
              projects={projects}
              activeProjectPath={activeProject?.path ?? null}
            />
          </div>
          <nav className="border-t border-slate-700 py-2">
            {[
              { href: '/', label: 'Kanban' },
              { href: '/insights', label: 'Insights' },
              { href: '/roadmap', label: 'Roadmap' },
              { href: '/settings', label: 'Settings' },
            ].map(({ href, label }) => (
              <Link
                key={href}
                href={href}
                className="flex items-center px-4 py-2 text-sm text-slate-300 hover:bg-slate-800 hover:text-white transition-colors"
              >
                {label}
              </Link>
            ))}
          </nav>
        </aside>
        <main className="flex-1 min-w-0 overflow-auto flex flex-col">{children}</main>
      </body>
    </html>
  );
}
