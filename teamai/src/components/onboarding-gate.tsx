'use client';

import { OnboardingWizard } from './onboarding-wizard';

/**
 * Client gate that renders the onboarding wizard overlay when the user
 * hasn't completed setup and has no registered projects.
 *
 * Children still render beneath the wizard (the backdrop covers them).
 */
export function OnboardingGate({ show, children }: { show: boolean; children: React.ReactNode }) {
  if (!show) return <>{children}</>;
  return (
    <>
      {children}
      <OnboardingWizard />
    </>
  );
}
