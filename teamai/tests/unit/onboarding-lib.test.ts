// @vitest-environment node

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const { mockWarn } = vi.hoisted(() => ({ mockWarn: vi.fn() }));

vi.mock('@/lib/logger', () => ({
  log: vi.fn(),
  warn: mockWarn,
  error: vi.fn(),
  info: vi.fn(),
}));

// ── Path isolation ──────────────────────────────────────────────────────

let testDir: string;

beforeEach(() => {
  testDir = join(tmpdir(), `teamai-onboarding-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(testDir, { recursive: true });
  mockWarn.mockClear();
  // Stub process.cwd() to return our temp directory so onboarding.json
  // is written there instead of the real project root.
  vi.spyOn(process, 'cwd').mockReturnValue(testDir);
});

afterEach(() => {
  vi.restoreAllMocks();
  // Clean up temp files
  try {
      rmSync(testDir, { recursive: true, force: true });
    } catch { /* best-effort */ }
});

// ── Helper ─────────────────────────────────────────────────────────────

function onboardingPath(): string {
  return join(testDir, 'onboarding.json');
}

// ── Tests ──────────────────────────────────────────────────────────────

describe('onboarding persistence', () => {
  // Import after process.cwd() is mocked so the module picks up the test
  // directory for the onboarding.json path.
  async function importModule() {
    return await import('@/lib/onboarding');
  }

  it('getOnboardingState returns {completed: false} when file does not exist', async () => {
    const { getOnboardingState } = await importModule();
    expect(getOnboardingState()).toEqual({ completed: false });
  });

  it('getOnboardingState returns parsed state when file exists', async () => {
    const fs = await import('fs');
    const p = onboardingPath();
    fs.writeFileSync(p, JSON.stringify({ completed: true, completedAt: '2025-01-01T00:00:00.000Z' }));

    const { getOnboardingState } = await importModule();
    expect(getOnboardingState()).toEqual({
      completed: true,
      completedAt: '2025-01-01T00:00:00.000Z',
    });
  });

  it('getOnboardingState returns {completed: false} on corrupt JSON', async () => {
    const fs = await import('fs');
    fs.writeFileSync(onboardingPath(), 'not valid json {{{');

    const { getOnboardingState } = await importModule();
    expect(getOnboardingState()).toEqual({ completed: false });
  });

  it('getOnboardingState returns partial data as-is when file has valid JSON without completed', async () => {
    const fs = await import('fs');
    fs.writeFileSync(onboardingPath(), JSON.stringify({ completedAt: '2025-01-01T00:00:00.000Z' }));

    const { getOnboardingState } = await importModule();
    // Returns parsed JSON as-is; consumer checks .completed which is
    // undefined here, so it acts like not-completed.
    expect(getOnboardingState()).toEqual({ completedAt: '2025-01-01T00:00:00.000Z' });
  });

  it('completeOnboarding writes the state file', async () => {
    const { completeOnboarding } = await importModule();
    completeOnboarding();

    const content = readFileSync(onboardingPath(), 'utf-8');
    const parsed = JSON.parse(content);
    expect(parsed.completed).toBe(true);
    expect(parsed.completedAt).toBeDefined();
    expect(typeof parsed.completedAt).toBe('string');
    // Should be a valid ISO date
    expect(new Date(parsed.completedAt).getTime()).not.toBeNaN();
  });

  it('completeOnboarding overwrites an existing file', async () => {
    const fs = await import('fs');
    const p = onboardingPath();
    fs.writeFileSync(p, JSON.stringify({ completed: false }));

    const { completeOnboarding } = await importModule();
    completeOnboarding();

    const content = readFileSync(p, 'utf-8');
    expect(JSON.parse(content).completed).toBe(true);
  });

  it('completeOnboarding does not throw when the directory is unwritable', async () => {
    // Use a path where write will fail
    vi.spyOn(process, 'cwd').mockReturnValue('/nonexistent/readonly/path');
    const { completeOnboarding } = await importModule();
    // Should not throw
    expect(() => completeOnboarding()).not.toThrow();
    // …but must surface the failure so the re-appearing wizard has a trace
    expect(mockWarn).toHaveBeenCalledWith(
      'onboarding',
      'Failed to persist onboarding completion',
      expect.anything(),
    );
  });
});
