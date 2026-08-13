/**
 * Onboarding state persistence — tracks whether the first-run wizard has been completed.
 *
 * Reads/writes `onboarding.json` in the TeamAI app root (same location as `tools.json`).
 */
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { warn } from './logger';

export interface OnboardingState {
  completed: boolean;
  completedAt?: string;
}

function onboardingPath(): string {
  return join(/* turbopackIgnore: true */ process.cwd(), 'onboarding.json');
}

export function getOnboardingState(): OnboardingState {
  try {
    const p = onboardingPath();
    if (!existsSync(p)) return { completed: false };
    return JSON.parse(readFileSync(p, 'utf-8'));
  } catch {
    return { completed: false };
  }
}

export function completeOnboarding(): void {
  try {
    writeFileSync(onboardingPath(), JSON.stringify({
      completed: true,
      completedAt: new Date().toISOString(),
    }, null, 2));
  } catch (err) {
    // Never throw (completing onboarding must not crash the wizard), but
    // surface it: a silent failure here means the first-run wizard re-appears
    // on the next launch with no trace.
    warn('onboarding', 'Failed to persist onboarding completion', err);
  }
}
