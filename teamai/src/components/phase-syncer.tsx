'use client';

import { usePhaseSync } from '@/hooks/use-phase-sync';

export function PhaseSyncer() {
  usePhaseSync();
  return null;
}
