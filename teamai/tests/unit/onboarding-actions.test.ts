// @vitest-environment node

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, readFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// ── Path isolation ──────────────────────────────────────────────────────

let testDir: string;

beforeEach(() => {
  testDir = join(tmpdir(), `teamai-onboarding-action-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(testDir, { recursive: true });
  vi.spyOn(process, 'cwd').mockReturnValue(testDir);
});

afterEach(() => {
  vi.restoreAllMocks();
  try {
    rmSync(testDir, { recursive: true, force: true });
  } catch { /* best-effort */ }
});

// ── Mock revalidatePath ─────────────────────────────────────────────────

const mockRevalidatePath = vi.hoisted(() => vi.fn());

vi.mock('next/cache', () => ({
  revalidatePath: (...args: unknown[]) => mockRevalidatePath(...args),
}));

// ── Tests ──────────────────────────────────────────────────────────────

describe('completeOnboarding server action', () => {
  let completeOnboarding: () => Promise<void>;

  beforeEach(async () => {
    vi.clearAllMocks();
    const mod = await import('@/app/actions/onboarding');
    completeOnboarding = mod.completeOnboarding;
  });

  it('persists onboarding state to disk', async () => {
    await completeOnboarding();

    const p = join(testDir, 'onboarding.json');
    expect(existsSync(p)).toBe(true);

    const content = JSON.parse(readFileSync(p, 'utf-8'));
    expect(content.completed).toBe(true);
    expect(content.completedAt).toBeDefined();
  });

  it('revalidates both the page and layout paths', async () => {
    await completeOnboarding();

    expect(mockRevalidatePath).toHaveBeenCalledWith('/', 'layout');
  });

  it('calls revalidatePath exactly once', async () => {
    await completeOnboarding();
    expect(mockRevalidatePath).toHaveBeenCalledTimes(1);
  });
});
