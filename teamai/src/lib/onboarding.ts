/**
 * Onboarding state persistence — tracks whether the first-run wizard has been completed.
 *
 * Reads/writes `onboarding.json` in the TeamAI app root (same location as `tools.json`).
 */
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

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
  } catch { /* best-effort */ }
}
