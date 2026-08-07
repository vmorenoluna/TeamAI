// @vitest-environment happy-dom

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { OnboardingGate } from '@/components/onboarding-gate';

// Mock the wizard so we can assert it's rendered without testing its internals
vi.mock('@/components/onboarding-wizard', () => ({
  OnboardingWizard: () => <div data-component="mock-wizard">Onboarding Wizard</div>,
}));

describe('OnboardingGate', () => {
  it('renders children only when show=false', () => {
    render(
      <OnboardingGate show={false}>
        <div data-component="child">Hello</div>
      </OnboardingGate>,
    );

    expect(screen.getByTestId('child')).toBeInTheDocument();
    expect(screen.queryByTestId('mock-wizard')).not.toBeInTheDocument();
  });

  it('renders children AND wizard when show=true', () => {
    render(
      <OnboardingGate show={true}>
        <div data-component="child">Hello</div>
      </OnboardingGate>,
    );

    expect(screen.getByTestId('child')).toBeInTheDocument();
    expect(screen.getByTestId('mock-wizard')).toBeInTheDocument();
  });

  it('renders no children when none are passed (show=true)', () => {
    render(<OnboardingGate show={true}>{null}</OnboardingGate>);
    expect(screen.getByTestId('mock-wizard')).toBeInTheDocument();
  });

  it('renders no children when none are passed (show=false)', () => {
    const { container } = render(<OnboardingGate show={false}>{null}</OnboardingGate>);
    expect(container.textContent).toBe('');
  });
});
