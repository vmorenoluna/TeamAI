import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { prewarmModelsCache, getAvailableModels } from '@/app/actions/providers';
import { CURATED_MODELS } from '@/defaults/models';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// Mock child_process preserving other exports (for promisify compat)
vi.mock('child_process', async () => {
  const actual = await vi.importActual<typeof import('child_process')>('child_process');
  return {
    ...actual,
    execFile: vi.fn(),
  };
});

// Mock logger
vi.mock('@/lib/logger', () => ({
  error: vi.fn(),
  log: vi.fn(),
  warn: vi.fn(),
  default: { error: vi.fn(), log: vi.fn(), warn: vi.fn() },
}));

// Mock getActiveProjectPath — hoisted, no top-level variable references
import type { Mock } from 'vitest';
let mockProjectPath = '/tmp/teamai-test-prewarm';

vi.mock('@/app/actions/projects', () => ({
  getActiveProjectPath: vi.fn(() => Promise.resolve(mockProjectPath)),
}));

import { existsSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';

/** Clear the globalThis-pinned prewarm store so tests start cold. */
function clearPrewarmStore() {
  delete (globalThis as { __teamaiModelsPrewarm?: unknown }).__teamaiModelsPrewarm;
}

function cleanTestDir() {
  try {
    if (existsSync(mockProjectPath)) {
      rmSync(mockProjectPath, { recursive: true, force: true });
    }
  } catch { /* ignore */ }
}

const cacheFile = () => join(mockProjectPath, '.teamai', 'models-cache.json');

describe('startup model prefetch (prewarmModelsCache)', () => {
  beforeEach(() => {
    mockFetch.mockReset();
    mockProjectPath = '/tmp/teamai-test-prewarm';
    cleanTestDir();
    clearPrewarmStore();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.useRealTimers();
    cleanTestDir();
    clearPrewarmStore();
  });

  // ── Successful prefetch warms the cache ──────────────────────────────

  it('successful prefetch warms the cache — first UI call gets live data without refetching', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-test-anthropic');
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: [
          { id: 'claude-sonnet-4-6', type: 'model' },
          { id: 'claude-3-5-sonnet-20241022', type: 'model' }, // deduped: older sonnet
          { id: 'claude-opus-4-8', type: 'model' },
        ],
        has_more: false,
      }),
    });

    const prewarm = await prewarmModelsCache('anthropic');
    expect(prewarm).toEqual({ ok: true, modelCount: 2 });
    expect(mockFetch).toHaveBeenCalledTimes(1);

    // First UI call after startup: served from the prewarm, no second fetch
    const result = await getAvailableModels('anthropic');
    expect(result.error).toBeUndefined();
    expect(result.models).toEqual(['claude-opus-4-8', 'claude-sonnet-4-6']);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('first UI call after prefetch writes the prewarmed models through to the project file cache', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-test-anthropic');
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: [{ id: 'claude-sonnet-4-6', type: 'model' }], has_more: false }),
    });

    await prewarmModelsCache('anthropic');
    // The prefetch itself is project-agnostic — it must NOT create any files
    expect(existsSync(cacheFile())).toBe(false);

    await getAvailableModels('anthropic');

    // The UI call (with an active project) persists the warm data — same as
    // a live fetch would have done
    const cache = JSON.parse(readFileSync(cacheFile(), 'utf-8'));
    expect(cache.anthropic.models).toEqual(['claude-sonnet-4-6']);
  });

  it('prefetch does not refetch when the prewarm cache is already fresh', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-test-anthropic');
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: [{ id: 'claude-sonnet-4-6', type: 'model' }], has_more: false }),
    });

    await prewarmModelsCache('anthropic');
    const second = await prewarmModelsCache('anthropic');

    expect(second).toEqual({ ok: true, modelCount: 1 });
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('works with no active project (zero registered projects) — warm data served, no cache file created', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-test-anthropic');

    const { getActiveProjectPath } = await import('@/app/actions/projects');
    (getActiveProjectPath as Mock).mockRejectedValueOnce(new Error('No active project'));

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: [{ id: 'claude-sonnet-4-6', type: 'model' }], has_more: false }),
    });

    const prewarm = await prewarmModelsCache('anthropic');
    expect(prewarm).toEqual({ ok: true, modelCount: 1 });

    const result = await getAvailableModels('anthropic');
    expect(result.error).toBeUndefined();
    expect(result.models).toEqual(['claude-sonnet-4-6']);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    // No project context → nothing was ever written to disk
    expect(existsSync(mockProjectPath)).toBe(false);
  });

  // ── Failure paths must never throw and must preserve the fallback ────

  it('prefetch failure (API error) resolves instead of throwing and leaves CURATED_MODELS as the fallback', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-test-anthropic');
    mockFetch.mockResolvedValue({ ok: false, status: 500 });

    // Must not throw past the startup sequence
    await expect(prewarmModelsCache('anthropic')).resolves.toMatchObject({
      ok: false,
      modelCount: 0,
    });
    // Failure caches nothing
    expect(existsSync(cacheFile())).toBe(false);

    // UI call after a failed prefetch: falls through to curated defaults
    const result = await getAvailableModels('anthropic');
    expect(result.models).toEqual(CURATED_MODELS.anthropic);
    expect(result.error).toBe('Anthropic API returned 500');
  });

  it('prefetch without ANTHROPIC_API_KEY records failure and the curated list is still served', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', '');

    const prewarm = await prewarmModelsCache('anthropic');
    expect(prewarm.ok).toBe(false);
    expect(prewarm.error).toContain('ANTHROPIC_API_KEY not set');

    const result = await getAvailableModels('anthropic');
    expect(result.models).toEqual(CURATED_MODELS.anthropic);
    expect(result.error).toBe('ANTHROPIC_API_KEY not set — using curated model list');
  });

  it('a hung fetch times out instead of pinning the prefetch forever', async () => {
    vi.useFakeTimers();
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-test-anthropic');
    mockFetch.mockReturnValueOnce(new Promise(() => { /* never resolves */ }));

    const promise = prewarmModelsCache('anthropic');
    const expectation = expect(promise).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining('timed out'),
    });
    await vi.advanceTimersByTimeAsync(30_000);
    await expectation;
  });

  // ── Freshness semantics ──────────────────────────────────────────────

  it('ignores a stale prewarm entry (older than 1 hour) and fetches live', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-test-anthropic');
    (globalThis as { __teamaiModelsPrewarm?: Map<string, { models: string[]; fetchedAt: number }> })
      .__teamaiModelsPrewarm = new Map([
        ['anthropic', { models: ['stale-model'], fetchedAt: Date.now() - 7_200_000 }],
      ]);

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: [{ id: 'claude-fresh-1', type: 'model' }], has_more: false }),
    });

    const result = await getAvailableModels('anthropic');
    expect(result.models).toEqual(['claude-fresh-1']);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('refresh=true bypasses the prewarm cache and fetches live', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-test-anthropic');
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: [{ id: 'claude-prewarmed-1', type: 'model' }], has_more: false }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: [{ id: 'claude-refreshed-1', type: 'model' }], has_more: false }),
      });

    await prewarmModelsCache('anthropic');
    const result = await getAvailableModels('anthropic', true);

    expect(result.models).toEqual(['claude-refreshed-1']);
    expect(mockFetch).toHaveBeenCalledTimes(2);
    // The refresh path persists the fresh data to the file cache (unchanged behavior)
    const cache = JSON.parse(readFileSync(cacheFile(), 'utf-8'));
    expect(cache.anthropic.models).toEqual(['claude-refreshed-1']);
  });

  // ── Scoping: unknown providers are never warmed ──────────────────────

  it('prefetching an unknown provider records failure and caches nothing', async () => {
    const prewarm = await prewarmModelsCache('bogus-provider');
    expect(prewarm).toMatchObject({ ok: false, modelCount: 0, error: 'Unknown provider: bogus-provider' });

    const result = await getAvailableModels('bogus-provider');
    expect(result.models).toEqual([]);
    expect(result.error).toBe('Unknown provider: bogus-provider');
    expect(existsSync(cacheFile())).toBe(false);
  });
});
