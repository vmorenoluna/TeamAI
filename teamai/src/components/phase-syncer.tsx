'use client';

import { usePhaseSync } from '@/hooks/use-phase-sync';

export function PhaseSyncer({ projectPath }: { projectPath?: string }) {
  usePhaseSync({ project: projectPath });
  return null;
}
