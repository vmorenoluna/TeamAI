import { describe, it, expect } from 'vitest';

// ── TaskCard spinner/hourglass logic ──────────────────────────────────

// Replicate the EXCLUDED_SPINNER_PHASES from task-card.tsx
const EXCLUDED_SPINNER_PHASES = new Set(['backlog', 'failed', 'merge', 'create-pr', 'done']);

// Active phases that should show spinner
const ACTIVE_PHASES = ['spec', 'plan', 'implement', 'qa-review', 'awaiting-review'];

// Rate-limited test helper
function shouldShowSpinner(phase: string, isRateLimited: boolean): boolean {
  return !EXCLUDED_SPINNER_PHASES.has(phase) && !isRateLimited;
}

function shouldShowHourglass(phase: string, isRateLimited: boolean): boolean {
  return !EXCLUDED_SPINNER_PHASES.has(phase) && isRateLimited;
}

describe('TaskCard spinner/hourglass logic', () => {
  it('shows spinner for active phases when not rate-limited', () => {
    for (const phase of ACTIVE_PHASES) {
      expect(shouldShowSpinner(phase, false)).toBe(true);
      expect(shouldShowHourglass(phase, false)).toBe(false);
    }
  });

  it('shows hourglass instead of spinner when rate-limited', () => {
    for (const phase of ACTIVE_PHASES) {
      expect(shouldShowSpinner(phase, true)).toBe(false);
      expect(shouldShowHourglass(phase, true)).toBe(true);
    }
  });

  it('shows neither spinner nor hourglass for excluded phases', () => {
    for (const phase of EXCLUDED_SPINNER_PHASES) {
      expect(shouldShowSpinner(phase, false)).toBe(false);
      expect(shouldShowHourglass(phase, false)).toBe(false);
      expect(shouldShowSpinner(phase, true)).toBe(false);
      expect(shouldShowHourglass(phase, true)).toBe(false);
    }
  });

  it('restores spinner when rate limit clears', () => {
    const phase = 'implement';
    // Initially rate-limited: hourglass, no spinner
    expect(shouldShowSpinner(phase, true)).toBe(false);
    expect(shouldShowHourglass(phase, true)).toBe(true);
    // After rate limit clears: spinner, no hourglass
    expect(shouldShowSpinner(phase, false)).toBe(true);
    expect(shouldShowHourglass(phase, false)).toBe(false);
  });
});

// ── getResumePhaseForFailedTask ───────────────────────────────────────

import { getResumePhaseForFailedTask } from '@/lib/task-utils';

describe('getResumePhaseForFailedTask', () => {
  it('returns the last real phase before failed (qa-review)', () => {
    const events = [
      { phase: 'backlog', timestamp: '2025-01-01T00:00:00Z' },
      { phase: 'spec', timestamp: '2025-01-01T01:00:00Z' },
      { phase: 'plan', timestamp: '2025-01-01T02:00:00Z' },
      { phase: 'implement', timestamp: '2025-01-01T03:00:00Z' },
      { phase: 'qa-review', timestamp: '2025-01-01T04:00:00Z' },
      { phase: 'failed', timestamp: '2025-01-01T05:00:00Z' },
    ];
    expect(getResumePhaseForFailedTask(events)).toBe('qa-review');
  });

  it('returns implement if that was the last phase before failed', () => {
    const events = [
      { phase: 'backlog', timestamp: '2025-01-01T00:00:00Z' },
      { phase: 'spec', timestamp: '2025-01-01T01:00:00Z' },
      { phase: 'plan', timestamp: '2025-01-01T02:00:00Z' },
      { phase: 'implement', timestamp: '2025-01-01T03:00:00Z' },
      { phase: 'failed', timestamp: '2025-01-01T04:00:00Z' },
    ];
    expect(getResumePhaseForFailedTask(events)).toBe('implement');
  });

  it('filters out backlog, failed, and done phases', () => {
    const events = [
      { phase: 'backlog', timestamp: '2025-01-01T00:00:00Z' },
      { phase: 'spec', timestamp: '2025-01-01T01:00:00Z' },
      { phase: 'done', timestamp: '2025-01-01T02:00:00Z' },
      { phase: 'backlog', timestamp: '2025-01-01T03:00:00Z' },
      { phase: 'plan', timestamp: '2025-01-01T04:00:00Z' },
      { phase: 'failed', timestamp: '2025-01-01T05:00:00Z' },
    ];
    // Last filtered phase should be 'plan' (skips backlog, done, failed)
    expect(getResumePhaseForFailedTask(events)).toBe('plan');
  });

  it('falls back to qa-review when there are no real phases before failed', () => {
    const events = [
      { phase: 'backlog', timestamp: '2025-01-01T00:00:00Z' },
      { phase: 'failed', timestamp: '2025-01-01T01:00:00Z' },
    ];
    expect(getResumePhaseForFailedTask(events)).toBe('qa-review');
  });

  it('falls back to qa-review for empty events', () => {
    expect(getResumePhaseForFailedTask([])).toBe('qa-review');
  });

  it('handles single real phase before failed', () => {
    const events = [
      { phase: 'backlog', timestamp: '2025-01-01T00:00:00Z' },
      { phase: 'implement', timestamp: '2025-01-01T01:00:00Z' },
      { phase: 'failed', timestamp: '2025-01-01T02:00:00Z' },
    ];
    expect(getResumePhaseForFailedTask(events)).toBe('implement');
  });

  it('handles awaiting-review and qa-fix as valid phases', () => {
    const events = [
      { phase: 'backlog', timestamp: '2025-01-01T00:00:00Z' },
      { phase: 'spec', timestamp: '2025-01-01T01:00:00Z' },
      { phase: 'plan', timestamp: '2025-01-01T02:00:00Z' },
      { phase: 'implement', timestamp: '2025-01-01T03:00:00Z' },
      { phase: 'qa-review', timestamp: '2025-01-01T04:00:00Z' },
      { phase: 'awaiting-review', timestamp: '2025-01-01T05:00:00Z' },
      { phase: 'failed', timestamp: '2025-01-01T06:00:00Z' },
    ];
    expect(getResumePhaseForFailedTask(events)).toBe('awaiting-review');
  });
});
