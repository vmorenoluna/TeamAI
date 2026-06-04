import type { Metadata } from 'next';
import { Inter, Geist_Mono } from 'next/font/google';
import './globals.css';
import { getProjects, getActiveProject, getOutdatedProjects } from '@/app/actions/projects';
import { Sidebar } from '@/components/sidebar';
import { ProjectSelector } from '@/components/project-selector';
import { DefaultsUpdater } from '@/components/defaults-updater';
import { RecoveryBanner } from '@/components/recovery-banner';
import { getInterruptedTasks } from '@/app/actions/recovery';

const inter = Inter({ variable: '--font-inter', subsets: ['latin'] });
const geistMono = Geist_Mono({ variable: '--font-geist-mono', subsets: ['latin'] });

export const metadata: Metadata = {
  title: 'TeamAI',
  description: 'Multi-agent coding assistant',
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const projects = await getProjects();
  const activeProject = await getActiveProject();
  const staleDefaults = await getOutdatedProjects();
  const interruptedTasks = await getInterruptedTasks();

  return (
    <html lang="en" className={`${inter.variable} ${geistMono.variable} h-full`}>
      <body className="h-full flex antialiased bg-[#11131b]">
        <Sidebar projects={projects} activeProjectPath={activeProject?.path ?? null} />
        <div className="flex-1 min-w-0 overflow-auto flex flex-col">
          {/* Project tabs row - moved above main content */}
          <ProjectSelector projects={projects} activeProjectPath={activeProject?.path ?? null} />
          {/* Defaults update banner — shows when projects have outdated copies of TeamAI defaults */}
          <DefaultsUpdater initialStale={staleDefaults} />
          {/* Recovery banner — shows when interrupted tasks are detected from previous session */}
          <RecoveryBanner tasks={interruptedTasks} />
          <div className="flex-1 min-h-0">{children}</div>
        </div>
      </body>
    </html>
  );
}
