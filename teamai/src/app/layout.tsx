import type { Metadata } from 'next';
import { Geist, Geist_Mono } from 'next/font/google';
import './globals.css';
import { getProjects, getActiveProject } from '@/app/actions/projects';
import { Sidebar } from '@/components/sidebar';

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
      <body suppressHydrationWarning className="h-full flex antialiased bg-slate-50 dark:bg-slate-950">
        <Sidebar projects={projects} activeProjectPath={activeProject?.path ?? null} />
        <main className="flex-1 min-w-0 overflow-auto flex flex-col">{children}</main>
      </body>
    </html>
  );
}
