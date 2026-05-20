import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getAvailableModels } from '@/app/actions/providers';
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
let mockProjectPath = '/tmp/teamai-test-providers';

vi.mock('@/app/actions/projects', () => ({
  getActiveProjectPath: vi.fn(() => Promise.resolve(mockProjectPath)),
}));

import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';

// Helper to clean up test dir
function cleanTestDir() {
  try {
    if (existsSync(mockProjectPath)) {
      rmSync(mockProjectPath, { recursive: true, force: true });
    }
  } catch { /* ignore */ }
}

describe('getAvailableModels', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockProjectPath = '/tmp/teamai-test-providers';
    cleanTestDir();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    cleanTestDir();
  });

  // ── Unknown provider ────────────────────────────────────────────────

  it('returns error for unknown provider', async () => {
    const result = await getAvailableModels('unknown');
    expect(result.models).toEqual([]);
    expect(result.error).toBe('Unknown provider: unknown');
  });

  // ── Curated defaults (always available, no API keys needed) ──────────

  it('returns curated Anthropic models when no API key and no cache', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    const result = await getAvailableModels('anthropic');
    expect(result.models).toEqual(CURATED_MODELS.anthropic);
    expect(result.error).toBe('ANTHROPIC_API_KEY not set — using curated model list');
  });

  it('returns curated OpenAI models when no API key and no cache', async () => {
    vi.stubEnv('OPENAI_API_KEY', '');
    const result = await getAvailableModels('openai');
    expect(result.models).toEqual(CURATED_MODELS.openai);
  });

  it('returns curated Gemini models when no API key and no cache', async () => {
    vi.stubEnv('GOOGLE_API_KEY', '');
    const result = await getAvailableModels('gemini');
    expect(result.models).toEqual(CURATED_MODELS.gemini);
  });

  it('returns curated Bedrock models as fallback when CLI fails', async () => {
    const { execFile } = await import('child_process');
    (vi.mocked(execFile) as unknown as Mock).mockImplementation(
      (_cmd: string, _args: readonly string[] | null | undefined, _opts: object | null | undefined, callback: (err: Error | null) => void) => {
        callback(new Error('AWS CLI not found'));
      },
    );
    const result = await getAvailableModels('bedrock');
    expect(result.models).toEqual(CURATED_MODELS.bedrock);
    expect(result.error).toBe('AWS CLI not available');
  });

  it('returns curated Vertex models as fallback when CLI fails', async () => {
    const { execFile } = await import('child_process');
    (vi.mocked(execFile) as unknown as Mock).mockImplementation(
      (_cmd: string, _args: readonly string[] | null | undefined, _opts: object | null | undefined, callback: (err: Error | null) => void) => {
        callback(new Error('gcloud not found'));
      },
    );
    const result = await getAvailableModels('vertex');
    expect(result.models).toEqual(CURATED_MODELS.vertex);
    expect(result.error).toBe('gcloud CLI not available');
  });

  it('returns curated Ollama models as fallback when not reachable', async () => {
    mockFetch.mockRejectedValueOnce(new Error('fetch failed'));
    const result = await getAvailableModels('ollama');
    expect(result.models).toEqual(CURATED_MODELS.ollama);
    expect(result.error).toBe('Ollama not running on localhost:11434');
  });

  // ── CLI-based provider success (Bedrock, Vertex) ─────────────────

  it('returns Claude models from AWS Bedrock CLI when available', async () => {
    const { execFile } = await import('child_process');
    (vi.mocked(execFile) as unknown as Mock).mockImplementation(
      (_cmd: string, _args: readonly string[] | null | undefined, _opts: object | null | undefined, callback: (err: Error | null, result: { stdout: string }) => void) => {
        callback(null, {
          stdout: JSON.stringify([
            'anthropic.claude-sonnet-4-20250514',
            'anthropic.claude-3-5-sonnet-20241022-v2:0',
            'meta.llama3-70b-instruct-v1:0',
          ]),
        });
      },
    );

    const result = await getAvailableModels('bedrock');

    expect(result.error).toBeUndefined();
    // Only Claude models returned, sorted
    expect(result.models).toEqual([
      'anthropic.claude-3-5-sonnet-20241022-v2:0',
      'anthropic.claude-sonnet-4-20250514',
    ]);
  });

  it('returns all models when AWS Bedrock CLI returns no Claude models', async () => {
    const { execFile } = await import('child_process');
    (vi.mocked(execFile) as unknown as Mock).mockImplementation(
      (_cmd: string, _args: readonly string[] | null | undefined, _opts: object | null | undefined, callback: (err: Error | null, result: { stdout: string }) => void) => {
        callback(null, {
          stdout: JSON.stringify([
            'meta.llama3-70b-instruct-v1:0',
            'mistral.mixtral-8x7b-instruct-v0:1',
          ]),
        });
      },
    );

    const result = await getAvailableModels('bedrock');

    expect(result.error).toBeUndefined();
    // All models returned since no Claude models found
    expect(result.models).toEqual([
      'meta.llama3-70b-instruct-v1:0',
      'mistral.mixtral-8x7b-instruct-v0:1',
    ]);
  });

  it('returns models from gcloud Vertex AI CLI when available', async () => {
    const { execFile } = await import('child_process');
    (vi.mocked(execFile) as unknown as Mock).mockImplementation(
      (_cmd: string, _args: readonly string[] | null | undefined, _opts: object | null | undefined, callback: (err: Error | null, result: { stdout: string }) => void) => {
        callback(null, {
          stdout: JSON.stringify([
            { name: 'projects/test/locations/us-central1/publishers/anthropic/models/claude-sonnet-4-20250514' },
            { name: 'projects/test/locations/us-central1/publishers/google/models/gemini-2.0-flash-001' },
          ]),
        });
      },
    );

    const result = await getAvailableModels('vertex');

    expect(result.error).toBeUndefined();
    expect(result.models).toEqual([
      'claude-sonnet-4-20250514',
      'gemini-2.0-flash-001',
    ]);
  });

  // ── Cache behavior ──────────────────────────────────────────────────

  it('returns cached models when cache is fresh', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', '');

    // Write a cache entry manually
    const cachedModels = ['claude-sonnet-4-6', 'claude-3-5-sonnet-20241022'];
    const cacheDir = join(mockProjectPath, '.teamai');
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(
      join(cacheDir, 'models-cache.json'),
      JSON.stringify({
        anthropic: { models: cachedModels, fetchedAt: new Date().toISOString() },
      }),
    );

    const result = await getAvailableModels('anthropic');
    expect(result.models).toEqual(cachedModels);
    expect(result.error).toBeUndefined();
  });

  it('ignores stale cache and returns curated defaults', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', '');

    // Write a stale cache entry (2 hours old)
    const staleTimestamp = new Date(Date.now() - 7_200_000).toISOString();
    const cacheDir = join(mockProjectPath, '.teamai');
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(
      join(cacheDir, 'models-cache.json'),
      JSON.stringify({
        anthropic: { models: ['old-model'], fetchedAt: staleTimestamp },
      }),
    );

    const result = await getAvailableModels('anthropic');
    expect(result.models).toEqual(CURATED_MODELS.anthropic);
    expect(result.error).toBe('ANTHROPIC_API_KEY not set — using curated model list');
  });

  it('uses cache when available with refresh=false', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-test-anthropic');

    const cachedModels = ['cached-model-1', 'cached-model-2'];
    const cacheDir = join(mockProjectPath, '.teamai');
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(
      join(cacheDir, 'models-cache.json'),
      JSON.stringify({
        anthropic: { models: cachedModels, fetchedAt: new Date().toISOString() },
      }),
    );

    const result = await getAvailableModels('anthropic', false);
    expect(result.models).toEqual(cachedModels);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('bypasses cache and fetches fresh when refresh=true', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-test-anthropic');

    const cacheDir = join(mockProjectPath, '.teamai');
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(
      join(cacheDir, 'models-cache.json'),
      JSON.stringify({
        anthropic: { models: ['old-model'], fetchedAt: new Date(Date.now() - 7_200_000).toISOString() },
      }),
    );

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: [{ id: 'claude-sonnet-4-6', type: 'model' }],
      }),
    });

    const result = await getAvailableModels('anthropic', true);
    expect(result.models).toEqual(['claude-sonnet-4-6']);
    expect(mockFetch).toHaveBeenCalled();
  });

  it('returns curated defaults when cache file is corrupted', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', '');

    // Write an invalid JSON cache file
    const cacheDir = join(mockProjectPath, '.teamai');
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(
      join(cacheDir, 'models-cache.json'),
      '{invalid json content',
    );

    const result = await getAvailableModels('anthropic');
    // readModelsCache catches parse error → falls through to curated defaults
    expect(result.models).toEqual(CURATED_MODELS.anthropic);
    expect(result.error).toBe('ANTHROPIC_API_KEY not set — using curated model list');
  });

  it('handles cache write failure gracefully', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-test-anthropic');

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: [{ id: 'claude-sonnet-4-6', type: 'model' }],
      }),
    });

    // Make .teamai a file instead of a directory so writeFileSync fails
    const teamaiDir = join(mockProjectPath, '.teamai');
    mkdirSync(teamaiDir, { recursive: true });
    rmSync(teamaiDir, { recursive: true, force: true });
    writeFileSync(teamaiDir, 'this is a file, not a directory');

    const result = await getAvailableModels('anthropic');

    // Should still return models despite cache write failure
    expect(result.models).toEqual(['claude-sonnet-4-6']);
    expect(result.error).toBeUndefined();
  });

  // ── Direct API fetch (with API keys) ─────────────────────────────────

  it('fetches Anthropic models from API when key is set and no cache', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-test-anthropic');
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: [
          { id: 'claude-sonnet-4-6', type: 'model' },
          { id: 'claude-3-5-sonnet-20241022', type: 'model' },
        ],
      }),
    });

    const result = await getAvailableModels('anthropic');
    expect(result.error).toBeUndefined();
    expect(result.models).toEqual(['claude-3-5-sonnet-20241022', 'claude-sonnet-4-6']);
    expect(mockFetch).toHaveBeenCalled();

    // Verify cache was written
    const cache = JSON.parse(
      readFileSync(join(mockProjectPath, '.teamai', 'models-cache.json'), 'utf-8'),
    );
    expect(cache.anthropic.models).toEqual(['claude-3-5-sonnet-20241022', 'claude-sonnet-4-6']);
  });

  it('fetches OpenAI models from API when key is set', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'sk-test-openai');
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: [{ id: 'gpt-4o' }, { id: 'whisper-1' }],
      }),
    });

    const result = await getAvailableModels('openai');
    expect(result.error).toBeUndefined();
    expect(result.models).toEqual(['gpt-4o']);
  });

  it('fetches Gemini models from API when key is set', async () => {
    vi.stubEnv('GOOGLE_API_KEY', 'test-key');
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        models: [{ name: 'models/gemini-2.0-flash' }, { name: 'models/embedding-001' }],
      }),
    });

    const result = await getAvailableModels('gemini');
    expect(result.error).toBeUndefined();
    expect(result.models).toEqual(['gemini-2.0-flash']);
  });

  it('fetches Ollama models from local API', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        models: [{ name: 'llama3.2:3b' }, { name: 'mistral:7b' }],
      }),
    });

    const result = await getAvailableModels('ollama');
    expect(result.error).toBeUndefined();
    expect(result.models).toEqual(['llama3.2:3b', 'mistral:7b']);
    expect(mockFetch.mock.calls[0][0]).toBe('http://localhost:11434/api/tags');
  });

  it('returns curated Ollama models when local API is not reachable', async () => {
    mockFetch.mockRejectedValueOnce(new Error('fetch failed'));
    const result = await getAvailableModels('ollama');
    expect(result.models).toEqual(CURATED_MODELS.ollama);
    expect(result.error).toBe('Ollama not running on localhost:11434');
  });

  it('returns curated Ollama models when API returns error', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500 });
    const result = await getAvailableModels('ollama');
    expect(result.models).toEqual(CURATED_MODELS.ollama);
    expect(result.error).toBe('Ollama API returned 500');
  });

  // ── API error responses ──────────────────────────────────────────────

  it('returns error on Anthropic API non-ok response', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-test-anthropic');
    mockFetch.mockResolvedValueOnce({ ok: false, status: 401 });

    const result = await getAvailableModels('anthropic');

    expect(result.models).toEqual(CURATED_MODELS.anthropic);
    expect(result.error).toBe('Anthropic API returned 401');
  });

  it('returns error on OpenAI API non-ok response', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'sk-test-openai');
    mockFetch.mockResolvedValueOnce({ ok: false, status: 403 });

    const result = await getAvailableModels('openai');

    expect(result.models).toEqual(CURATED_MODELS.openai);
    expect(result.error).toBe('OpenAI API returned 403');
  });

  it('returns error on Gemini API non-ok response', async () => {
    vi.stubEnv('GOOGLE_API_KEY', 'test-key');
    mockFetch.mockResolvedValueOnce({ ok: false, status: 400 });

    const result = await getAvailableModels('gemini');

    expect(result.models).toEqual(CURATED_MODELS.gemini);
    expect(result.error).toBe('Gemini API returned 400');
  });

  // ── Fetch edge cases ─────────────────────────────────────────────────

  it('falls back to curated when API returns empty model list without error', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-test-anthropic');
    // API returns 200 but with an empty data array (no models match 'type=model' filter)
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: [] }),
    });

    const result = await getAvailableModels('anthropic');

    // Should fall back to curated defaults
    expect(result.models).toEqual(CURATED_MODELS.anthropic);
    expect(result.error).toBeUndefined();
  });

  // ── No active project (getActiveProjectPath fails) ───────────────────

  it('works when no active project (falls back to curated defaults)', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', '');

    // Simulate no active project
    const { getActiveProjectPath } = await import('@/app/actions/projects');
    (getActiveProjectPath as Mock).mockRejectedValueOnce(new Error('No active project'));

    const result = await getAvailableModels('anthropic');
    expect(result.models).toEqual(CURATED_MODELS.anthropic);
    expect(result.error).toBe('ANTHROPIC_API_KEY not set — using curated model list');
  });

  it('refreshes from API even without active project (no cache write)', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-test-anthropic');

    const { getActiveProjectPath } = await import('@/app/actions/projects');
    (getActiveProjectPath as Mock).mockRejectedValueOnce(new Error('No active project'));

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: [{ id: 'claude-sonnet-4-6', type: 'model' }],
      }),
    });

    const result = await getAvailableModels('anthropic', true);
    expect(result.models).toEqual(['claude-sonnet-4-6']);
    expect(mockFetch).toHaveBeenCalled();
  });
});
