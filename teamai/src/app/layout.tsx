import type { Metadata } from 'next';
import { Inter, Geist_Mono } from 'next/font/google';
import './globals.css';
import { getProjects, getActiveProject, getDefaultsSyncReport, getGitattributesRenormalizeSuggestion } from '@/app/actions/projects';
import { Sidebar } from '@/components/sidebar';
import { ProjectSelector } from '@/components/project-selector';
import { DefaultsUpdater } from '@/components/defaults-updater';
import { RecoveryBanner } from '@/components/recovery-banner';
import { UpdateBanner } from '@/components/update-banner';
import { MissingToolsBanner } from '@/components/missing-tools-banner';
import { GitattributesRenormalizeBanner } from '@/components/gitattributes-renormalize-banner';
import { AutoModeButton } from '@/components/auto-mode-button';
import { ContainerDockerMissingDialog } from '@/components/container-docker-missing-dialog';
import { getInterruptedTasks } from '@/app/actions/recovery';
import { getAutoModeState } from '@/lib/auto-mode-state';
import { getOnboardingState } from '@/lib/onboarding';
import { OnboardingGate } from '@/components/onboarding-gate';
import { checkTools } from '@/app/actions/tools';
import { getRefinementSuggestions } from '@/app/actions/role-refinement';

const inter = Inter({ variable: '--font-inter', subsets: ['latin'] });
const geistMono = Geist_Mono({ variable: '--font-geist-mono', subsets: ['latin'] });

export const metadata: Metadata = {
  title: 'TeamAI',
  description: 'Multi-agent coding assistant',
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const projects = await getProjects();
  const activeProject = await getActiveProject();
  const defaultsSyncReport = await getDefaultsSyncReport();
  const interruptedTasks = await getInterruptedTasks();
  const autoModeState = activeProject ? getAutoModeState(activeProject.path) : { enabled: false };
  const toolStatuses = await checkTools();
  const gitattributesRenormalizePath = await getGitattributesRenormalizeSuggestion();
  const onboardingState = getOnboardingState();
  const needsOnboarding = !onboardingState.completed && projects.length === 0;

  // Role Refinement Assistant — pending-suggestion count for the sidebar badge.
  // Only fetched when a project is active (getActiveProjectPath throws otherwise).
  let refinementPendingCount = 0;
  if (activeProject) {
    try {
      refinementPendingCount = (await getRefinementSuggestions())
        .filter(s => s.status === 'suggested').length;
    } catch { /* no active project / unreadable store — badge stays hidden */ }
  }

  return (
    <html lang="en" className={`${inter.variable} ${geistMono.variable} h-full`}>
      <body className="h-full flex antialiased bg-[#11131b]">
        <Sidebar
          projects={projects}
          activeProjectPath={activeProject?.path ?? null}
          refinementPendingCount={refinementPendingCount}
        />
        <div className="flex-1 min-w-0 overflow-auto flex flex-col">
          {/* Project tabs row - moved above main content */}
          <div className="flex items-center justify-between gap-1">
            <div className="flex-1 min-w-0">
              <ProjectSelector projects={projects} activeProjectPath={activeProject?.path ?? null} />
            </div>
            <div className="pr-4 shrink-0">
              <AutoModeButton activeProjectPath={activeProject?.path ?? null} initialEnabled={autoModeState.enabled} />
            </div>
          </div>
          {/* Defaults auto-sync banner — informs which commands were force-synced at startup */}
          <DefaultsUpdater initialReport={defaultsSyncReport} />
          {/* Update banner — shows when an auto-update is downloaded and ready to install */}
          <UpdateBanner />
          {/* Recovery banner — shows when interrupted tasks are detected from previous session */}
          <RecoveryBanner tasks={interruptedTasks} />
          {/* Missing tools banner — shows when required CLI tools are not found */}
          <MissingToolsBanner tools={toolStatuses} />
          {/* Gitattributes renormalize suggestion — one-time prompt after .gitattributes is first added */}
          <GitattributesRenormalizeBanner projectPath={gitattributesRenormalizePath ?? ''} />
          <div className="flex-1 min-h-0 flex flex-col">
            <OnboardingGate show={needsOnboarding}>{children}</OnboardingGate>
          </div>
        </div>
        {/* Global dialog: shown when container mode is enabled but Docker is not running */}
        <ContainerDockerMissingDialog projectPath={activeProject?.path ?? null} />
      </body>
    </html>
  );
}
