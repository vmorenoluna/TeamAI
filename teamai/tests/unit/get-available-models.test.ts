import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getAvailableModels, extractClaudeFamily, sortKey } from '@/app/actions/providers';
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
    // Isolate from any real Claude Code login on this machine — the
    // credential fallback reads ~/.claude/.credentials.json when no env
    // credential is set, which would make no-credential tests
    // machine-dependent. Point CLAUDE_CONFIG_DIR at a nonexistent dir;
    // file-credential tests re-stub it to a fixture dir.
    vi.stubEnv('CLAUDE_CONFIG_DIR', '/nonexistent-teamai-test-claude-config');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    cleanTestDir();
  });

  // ── Curated model list shape ────────────────────────────────────────

  it('CURATED_MODELS.anthropic has all current-gen models (fable, opus, sonnet, haiku)', () => {
    const models = CURATED_MODELS.anthropic;
    expect(models).toHaveLength(4);
    expect(models).toContain('claude-fable-5');
    expect(models).toContain('claude-opus-5');
    expect(models).toContain('claude-sonnet-5');
    expect(models).toContain('claude-haiku-4-5-20251001');
    // Ensure no old gen-3 models leaked in
    const gen3 = models.filter(m => /claude-3/.test(m));
    expect(gen3).toHaveLength(0);
    // Superseded gen-4 opus/sonnet IDs must not linger in the curated fallback
    expect(models).not.toContain('claude-opus-4-8');
    expect(models).not.toContain('claude-sonnet-4-6');
  });

  // ── Unknown provider ────────────────────────────────────────────────

  it('returns error for unknown provider', async () => {
    const result = await getAvailableModels('unknown');
    expect(result.models).toEqual([]);
    expect(result.error).toBe('Unknown provider: unknown');
  });

  // ── Curated defaults (always available, no API keys needed) ──────────

  it('returns curated Anthropic models when no credential resolves and no cache exists', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    const result = await getAvailableModels('anthropic');
    expect(result.models).toEqual(CURATED_MODELS.anthropic);
    expect(result.error).toContain('No Anthropic credential');
  });

  // ── Credential fallback chain (API key → env bearer → Claude Code login) ──

  it('falls back to ANTHROPIC_AUTH_TOKEN as a Bearer credential when no API key is set', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    vi.stubEnv('ANTHROPIC_AUTH_TOKEN', 'sk-ant-oat01-fixture-token');
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: [{ id: 'claude-opus-5', type: 'model' }],
        has_more: false,
      }),
    });

    const result = await getAvailableModels('anthropic');
    expect(result.models).toEqual(['claude-opus-5']);
    const headers = mockFetch.mock.calls[0][1].headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer sk-ant-oat01-fixture-token');
    expect(headers['x-api-key']).toBeUndefined();
  });

  it('falls back to CLAUDE_CODE_OAUTH_TOKEN when neither API key nor ANTHROPIC_AUTH_TOKEN is set', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    vi.stubEnv('ANTHROPIC_AUTH_TOKEN', '');
    vi.stubEnv('CLAUDE_CODE_OAUTH_TOKEN', 'cc-oauth-fixture-token');
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: [{ id: 'claude-sonnet-5', type: 'model' }],
        has_more: false,
      }),
    });

    const result = await getAvailableModels('anthropic');
    expect(result.models).toEqual(['claude-sonnet-5']);
    const headers = mockFetch.mock.calls[0][1].headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer cc-oauth-fixture-token');
  });

  it('reads the stored Claude Code subscription credential when no env credential is set', async () => {
    // Fixture credential file (fake token — fixtures never contain real
    // credentials). Mirrors Claude Code's documented layout:
    // CLAUDE_CONFIG_DIR/.credentials.json with claudeAiOauth.accessToken.
    const claudeDir = join(mockProjectPath, 'claude-config');
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(
      join(claudeDir, '.credentials.json'),
      JSON.stringify({
        claudeAiOauth: {
          accessToken: 'fixture-oat-token',
          expiresAt: Date.now() + 3_600_000,
        },
      }),
    );
    vi.stubEnv('CLAUDE_CONFIG_DIR', claudeDir);
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: [{ id: 'claude-fable-5', type: 'model' }],
        has_more: false,
      }),
    });

    const result = await getAvailableModels('anthropic');
    expect(result.models).toEqual(['claude-fable-5']);
    const headers = mockFetch.mock.calls[0][1].headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer fixture-oat-token');
  });

  it('ignores an expired Claude Code subscription credential and falls back to curated', async () => {
    const claudeDir = join(mockProjectPath, 'claude-config');
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(
      join(claudeDir, '.credentials.json'),
      JSON.stringify({
        claudeAiOauth: {
          accessToken: 'expired-fixture-oat-token',
          expiresAt: Date.now() - 1000,
        },
      }),
    );
    vi.stubEnv('CLAUDE_CONFIG_DIR', claudeDir);

    const result = await getAvailableModels('anthropic');
    expect(result.models).toEqual(CURATED_MODELS.anthropic);
    expect(result.error).toContain('No Anthropic credential');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('prefers the x-api-key path when both ANTHROPIC_API_KEY and ANTHROPIC_AUTH_TOKEN are set', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-test-anthropic');
    vi.stubEnv('ANTHROPIC_AUTH_TOKEN', 'sk-ant-oat01-should-not-be-used');
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: [{ id: 'claude-opus-5', type: 'model' }],
        has_more: false,
      }),
    });

    const result = await getAvailableModels('anthropic');
    expect(result.models).toEqual(['claude-opus-5']);
    const headers = mockFetch.mock.calls[0][1].headers as Record<string, string>;
    expect(headers['x-api-key']).toBe('sk-test-anthropic');
    expect(headers.Authorization).toBeUndefined();
  });

  it('returns empty models for OpenAI when no API key and no curated default', async () => {
    vi.stubEnv('OPENAI_API_KEY', '');
    const result = await getAvailableModels('openai');
    expect(result.models).toEqual([]);
    expect(result.error).toBe('OPENAI_API_KEY not set — using curated model list');
  });

  it('returns empty models for Gemini when no API key and no curated default', async () => {
    vi.stubEnv('GOOGLE_API_KEY', '');
    const result = await getAvailableModels('gemini');
    expect(result.models).toEqual([]);
    expect(result.error).toBe('GOOGLE_API_KEY not set — using curated model list');
  });

  it('returns empty models for Bedrock when CLI fails and no curated default', async () => {
    const { execFile } = await import('child_process');
    (vi.mocked(execFile) as unknown as Mock).mockImplementation(
      (_cmd: string, _args: readonly string[] | null | undefined, _opts: object | null | undefined, callback: (err: Error | null) => void) => {
        callback(new Error('AWS CLI not found'));
      },
    );
    const result = await getAvailableModels('bedrock');
    expect(result.models).toEqual([]);
    expect(result.error).toBe('AWS CLI not available');
  });

  it('returns empty models for Vertex when CLI fails and no curated default', async () => {
    const { execFile } = await import('child_process');
    (vi.mocked(execFile) as unknown as Mock).mockImplementation(
      (_cmd: string, _args: readonly string[] | null | undefined, _opts: object | null | undefined, callback: (err: Error | null) => void) => {
        callback(new Error('gcloud not found'));
      },
    );
    const result = await getAvailableModels('vertex');
    expect(result.models).toEqual([]);
    expect(result.error).toBe('gcloud CLI not available');
  });

  it('returns empty models for Ollama when not reachable and no curated default', async () => {
    mockFetch.mockRejectedValueOnce(new Error('fetch failed'));
    const result = await getAvailableModels('ollama');
    expect(result.models).toEqual([]);
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
    const cachedModels = ['claude-opus-4-8', 'claude-sonnet-4-6'];
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
    expect(result.error).toContain('No Anthropic credential');
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
        has_more: false,
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
    expect(result.error).toContain('No Anthropic credential');
  });

  it('handles cache write failure gracefully', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-test-anthropic');

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: [
          { id: 'claude-sonnet-4-6', type: 'model' },
          { id: 'claude-3-opus-20240229', type: 'model' },
        ],
        has_more: false,
      }),
    });

    // Make .teamai a file instead of a directory so writeFileSync fails
    const teamaiDir = join(mockProjectPath, '.teamai');
    mkdirSync(teamaiDir, { recursive: true });
    rmSync(teamaiDir, { recursive: true, force: true });
    writeFileSync(teamaiDir, 'this is a file, not a directory');

    const result = await getAvailableModels('anthropic');

    // Dedup keeps both: sonnet and opus are different families
    expect(result.models).toEqual(['claude-3-opus-20240229', 'claude-sonnet-4-6']);
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
          { id: 'claude-opus-4-8', type: 'model' },
        ],
        has_more: false,
      }),
    });

    const result = await getAvailableModels('anthropic');
    expect(result.error).toBeUndefined();
    // sonnet: claude-sonnet-4-6 wins over claude-3-5-sonnet-20241022 (dedup: latest per family)
    expect(result.models).toEqual(['claude-opus-4-8', 'claude-sonnet-4-6']);
    expect(mockFetch).toHaveBeenCalled();

    // Verify cache was written
    const cache = JSON.parse(
      readFileSync(join(mockProjectPath, '.teamai', 'models-cache.json'), 'utf-8'),
    );
    expect(cache.anthropic.models).toEqual(['claude-opus-4-8', 'claude-sonnet-4-6']);
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

  it('returns empty models for Ollama when API returns error and no curated default', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500 });
    const result = await getAvailableModels('ollama');
    expect(result.models).toEqual([]);
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

  it('returns error on OpenAI API non-ok response (no curated fallback)', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'sk-test-openai');
    mockFetch.mockResolvedValueOnce({ ok: false, status: 403 });

    const result = await getAvailableModels('openai');

    expect(result.models).toEqual([]);
    expect(result.error).toBe('OpenAI API returned 403');
  });

  it('returns error on Gemini API non-ok response (no curated fallback)', async () => {
    vi.stubEnv('GOOGLE_API_KEY', 'test-key');
    mockFetch.mockResolvedValueOnce({ ok: false, status: 400 });

    const result = await getAvailableModels('gemini');

    expect(result.models).toEqual([]);
    expect(result.error).toBe('Gemini API returned 400');
  });

  // ── Fetch edge cases ─────────────────────────────────────────────────

  it('falls back to curated when API returns empty model list without error', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-test-anthropic');
    // API returns 200 but with an empty data array (no models match 'type=model' filter)
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: [], has_more: false }),
    });

    const result = await getAvailableModels('anthropic');

    // Should fall back to curated defaults
    expect(result.models).toEqual(CURATED_MODELS.anthropic);
    expect(result.error).toBeUndefined();
  });

  it('keeps only the latest per family even when all models are older generations', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-test-anthropic');
    // API returns only Claude 3 / 3.5 models — dedup keeps the latest per family
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: [
          { id: 'claude-3-5-sonnet-20241022', type: 'model' },
          { id: 'claude-3-5-haiku-20241022', type: 'model' },
          { id: 'claude-3-opus-20240229', type: 'model' },
          { id: 'claude-3-sonnet-20240229', type: 'model' },
          { id: 'claude-3-haiku-20240307', type: 'model' },
        ],
        has_more: false,
      }),
    });

    const result = await getAvailableModels('anthropic');
    expect(result.error).toBeUndefined();
    // Per family, keep only the latest (alphabetically last):
    // sonnet: claude-3-5-sonnet-20241022 > claude-3-sonnet-20240229
    // haiku:  claude-3-5-haiku-20241022  > claude-3-haiku-20240307
    // opus:   claude-3-opus-20240229 (only one)
    // Sorted by sortKey: claude-3-opus < claude-3.5-haiku < claude-3.5-sonnet
    expect(result.models).toEqual([
      'claude-3-opus-20240229',
      'claude-3-5-haiku-20241022',
      'claude-3-5-sonnet-20241022',
    ]);
  });

  it('deduplicates to latest per family — older models lose to newer ones within same family', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-test-anthropic');
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: [
          { id: 'claude-sonnet-4-20250514', type: 'model' },
          { id: 'claude-opus-4-8', type: 'model' },
          { id: 'claude-haiku-4-5-20251001', type: 'model' },
          { id: 'claude-3-5-sonnet-20241022', type: 'model' },
          { id: 'claude-3-5-haiku-20241022', type: 'model' },
          { id: 'claude-3-opus-20240229', type: 'model' },
          { id: 'claude-3-sonnet-20240229', type: 'model' },
          { id: 'claude-3-haiku-20240307', type: 'model' },
        ],
        has_more: false,
      }),
    });

    const result = await getAvailableModels('anthropic');
    expect(result.error).toBeUndefined();
    // Per-family dedup: each family keeps only its latest (alphabetically last).
    // sonnet: claude-sonnet-4-20250514 beats claude-3-5/3-sonnet
    // haiku:  claude-haiku-4-5-20251001  beats claude-3-5/3-haiku
    // opus:   claude-opus-4-8            beats claude-3-opus
    expect(result.models).toEqual([
      'claude-haiku-4-5-20251001',
      'claude-opus-4-8',
      'claude-sonnet-4-20250514',
    ]);
    // Verify no older models leaked through
    const older = result.models.filter(m => /claude-3/.test(m));
    expect(older).toHaveLength(0);
  });

  it('keeps fable alongside the opus-5/sonnet-5 families — no collision, nothing dropped', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-test-anthropic');
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: [
          { id: 'claude-fable-5', type: 'model' },
          { id: 'claude-opus-5', type: 'model' },
          { id: 'claude-opus-4-8', type: 'model' },
          { id: 'claude-sonnet-5', type: 'model' },
          { id: 'claude-sonnet-4-6', type: 'model' },
          { id: 'claude-haiku-4-5-20251001', type: 'model' },
        ],
        has_more: false,
      }),
    });

    const result = await getAvailableModels('anthropic');
    expect(result.error).toBeUndefined();
    // All four families survive the dedup; within opus/sonnet the gen-5 ID wins
    // (claude-opus-5 > claude-opus-4-8, claude-sonnet-5 > claude-sonnet-4-6),
    // and the fable family is untouched by the bump.
    expect(result.models).toEqual([
      'claude-fable-5',
      'claude-haiku-4-5-20251001',
      'claude-opus-5',
      'claude-sonnet-5',
    ]);
  });

  // ── No active project (getActiveProjectPath fails) ───────────────────

  it('works when no active project (falls back to curated defaults)', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', '');

    // Simulate no active project
    const { getActiveProjectPath } = await import('@/app/actions/projects');
    (getActiveProjectPath as Mock).mockRejectedValueOnce(new Error('No active project'));

    const result = await getAvailableModels('anthropic');
    expect(result.models).toEqual(CURATED_MODELS.anthropic);
    expect(result.error).toContain('No Anthropic credential');
  });

  it('refreshes from API even without active project (no cache write)', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-test-anthropic');

    const { getActiveProjectPath } = await import('@/app/actions/projects');
    (getActiveProjectPath as Mock).mockRejectedValueOnce(new Error('No active project'));

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: [
          { id: 'claude-sonnet-4-6', type: 'model' },
          { id: 'claude-haiku-4-5-20251001', type: 'model' },
        ],
        has_more: false,
      }),
    });

    const result = await getAvailableModels('anthropic', true);
    // Dedup: sonnet and haiku are different families, both kept
    expect(result.models).toEqual(['claude-haiku-4-5-20251001', 'claude-sonnet-4-6']);
    expect(mockFetch).toHaveBeenCalled();
  });

  // ── API pagination ───────────────────────────────────────────────

  it('paginates through multiple pages using has_more and last_id cursor', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-test-anthropic');

    // Page 1: 2 models, has_more=true, last_id points to next page
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: [
            { id: 'claude-sonnet-4-6', type: 'model' },
            { id: 'claude-haiku-4-5-20251001', type: 'model' },
          ],
          has_more: true,
          last_id: 'claude-haiku-4-5-20251001',
        }),
      })
      // Page 2: 1 model (fable), has_more=false — stops pagination
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: [
            { id: 'claude-fable-5', type: 'model' },
          ],
          has_more: false,
        }),
      });

    const result = await getAvailableModels('anthropic');

    expect(result.error).toBeUndefined();
    // All 3 families (haiku, sonnet, fable) from both pages, deduped
    expect(result.models).toEqual([
      'claude-fable-5',
      'claude-haiku-4-5-20251001',
      'claude-sonnet-4-6',
    ]);

    // Verify two pages were fetched
    expect(mockFetch).toHaveBeenCalledTimes(2);
    // Page 1: no after_id param
    expect(mockFetch.mock.calls[0][0]).toBe('https://api.anthropic.com/v1/models?limit=100');
    // Page 2: includes after_id cursor
    expect(mockFetch.mock.calls[1][0]).toBe(
      'https://api.anthropic.com/v1/models?limit=100&after_id=claude-haiku-4-5-20251001',
    );
  });

  it('stops paginating when an intermediate page has has_more=false', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-test-anthropic');

    // Single page response: has_more=false — no second fetch needed
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: [{ id: 'claude-opus-4-8', type: 'model' }],
        has_more: false,
      }),
    });

    const result = await getAvailableModels('anthropic');

    expect(result.models).toEqual(['claude-opus-4-8']);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});

// ── extractClaudeFamily ──────────────────────────────────────────────

describe('extractClaudeFamily', () => {
  // ── Gen 4+ (no gen prefix) ───────────────────────────────────────

  it('extracts opus from claude-opus-4-8', async () => {
    expect(await extractClaudeFamily('claude-opus-4-8')).toBe('opus');
  });

  it('extracts sonnet from claude-sonnet-4-6', async () => {
    expect(await extractClaudeFamily('claude-sonnet-4-6')).toBe('sonnet');
  });

  it('extracts haiku from claude-haiku-4-5-20251001', async () => {
    expect(await extractClaudeFamily('claude-haiku-4-5-20251001')).toBe('haiku');
  });

  it('extracts sonnet from claude-sonnet-4-20250514 (date-suffixed gen 4)', async () => {
    expect(await extractClaudeFamily('claude-sonnet-4-20250514')).toBe('sonnet');
  });

  // ── Gen 3 │────────────────────────────────────────────────────────

  it('extracts opus from claude-3-opus-20240229', async () => {
    expect(await extractClaudeFamily('claude-3-opus-20240229')).toBe('opus');
  });

  it('extracts sonnet from claude-3-sonnet-20240229', async () => {
    expect(await extractClaudeFamily('claude-3-sonnet-20240229')).toBe('sonnet');
  });

  it('extracts haiku from claude-3-haiku-20240307', async () => {
    expect(await extractClaudeFamily('claude-3-haiku-20240307')).toBe('haiku');
  });

  // ── Gen 3.5 ──────────────────────────────────────────────────────

  it('extracts sonnet from claude-3-5-sonnet-20241022', async () => {
    expect(await extractClaudeFamily('claude-3-5-sonnet-20241022')).toBe('sonnet');
  });

  it('extracts haiku from claude-3-5-haiku-20241022', async () => {
    expect(await extractClaudeFamily('claude-3-5-haiku-20241022')).toBe('haiku');
  });

  // ── Future generations (any numeric gen prefix) ────────────────

  it('extracts sonnet from claude-4-sonnet-20250101 (hypothetical gen 4 prefixed)', async () => {
    expect(await extractClaudeFamily('claude-4-sonnet-20250101')).toBe('sonnet');
  });

  it('extracts sonnet from claude-4-5-sonnet-20250101 (hypothetical gen 4.5)', async () => {
    expect(await extractClaudeFamily('claude-4-5-sonnet-20250101')).toBe('sonnet');
  });

  it('extracts opus from claude-5-opus-20260101 (hypothetical gen 5)', async () => {
    expect(await extractClaudeFamily('claude-5-opus-20260101')).toBe('opus');
  });

  it('extracts sonnet from claude-10-sonnet-20260101 (multi-digit gen)', async () => {
    expect(await extractClaudeFamily('claude-10-sonnet-20260101')).toBe('sonnet');
  });

  // ── Future / hypothetical families (auto-detected) ──────────────

  it('auto-detects a new family like fable', async () => {
    expect(await extractClaudeFamily('claude-fable-4-1')).toBe('fable');
  });

  it('extracts fable from claude-fable-5 (curated fallback entry, unaffected by opus/sonnet bump)', async () => {
    expect(await extractClaudeFamily('claude-fable-5')).toBe('fable');
  });

  it('extracts the bumped gen-5 IDs to their families', async () => {
    expect(await extractClaudeFamily('claude-opus-5')).toBe('opus');
    expect(await extractClaudeFamily('claude-sonnet-5')).toBe('sonnet');
  });

  it('auto-detects a new family like mythos', async () => {
    expect(await extractClaudeFamily('claude-mythos-5')).toBe('mythos');
  });

  it('auto-detects fable with gen 3.5 prefix', async () => {
    expect(await extractClaudeFamily('claude-3-5-fable-20260101')).toBe('fable');
  });

  // ── Non-Claude IDs ───────────────────────────────────────────────

  it('returns null for non-claude model ID', async () => {
    expect(await extractClaudeFamily('gpt-4o')).toBeNull();
  });

  it('returns null for bedrock-prefixed ID', async () => {
    expect(await extractClaudeFamily('anthropic.claude-sonnet-4-20250514-v2:0')).toBeNull();
  });

  it('returns null for empty string', async () => {
    expect(await extractClaudeFamily('')).toBeNull();
  });

  it('returns null for bare claude without family', async () => {
    expect(await extractClaudeFamily('claude-')).toBeNull();
  });
});

// ── sortKey ─────────────────────────────────────────────────────────

describe('sortKey', () => {
  it('normalizes claude-3-5- to claude-3.5-', async () => {
    expect(await sortKey('claude-3-5-sonnet-20241022')).toBe('claude-3.5-sonnet-20241022');
  });

  it('normalizes claude-4-5- to claude-4.5- (hypothetical gen 4.5)', async () => {
    expect(await sortKey('claude-4-5-sonnet-20250101')).toBe('claude-4.5-sonnet-20250101');
  });

  it('normalizes multi-digit subgen: claude-4-10- to claude-4.10-', async () => {
    expect(await sortKey('claude-4-10-sonnet-20260101')).toBe('claude-4.10-sonnet-20260101');
  });

  it('preserves claude-3- (no normalization needed)', async () => {
    expect(await sortKey('claude-3-opus-20240229')).toBe('claude-3-opus-20240229');
  });

  it('preserves gen 4 IDs unchanged', async () => {
    expect(await sortKey('claude-sonnet-4-6')).toBe('claude-sonnet-4-6');
  });

  it('preserves non-claude IDs unchanged', async () => {
    expect(await sortKey('gpt-4o')).toBe('gpt-4o');
  });

  // ── Sort ordering verification ──────────────────────────────────

  it('sorts gen 3.5 after gen 3 (same family)', async () => {
    const ids = ['claude-3-5-haiku-20241022', 'claude-3-haiku-20240307'];
    const keys = new Map(await Promise.all(ids.map(async id => [id, await sortKey(id)] as const)));
    ids.sort((a, b) => keys.get(a)!.localeCompare(keys.get(b)!, undefined, { numeric: true }));
    expect(ids).toEqual(['claude-3-haiku-20240307', 'claude-3-5-haiku-20241022']);
  });

  it('sorts gen 4 after gen 3.5 (same family)', async () => {
    const ids = [
      'claude-sonnet-4-6',
      'claude-3-5-sonnet-20241022',
      'claude-3-sonnet-20240229',
    ];
    const keys = new Map(await Promise.all(ids.map(async id => [id, await sortKey(id)] as const)));
    ids.sort((a, b) => keys.get(a)!.localeCompare(keys.get(b)!, undefined, { numeric: true }));
    expect(ids).toEqual([
      'claude-3-sonnet-20240229',
      'claude-3-5-sonnet-20241022',
      'claude-sonnet-4-6',
    ]);
  });

  it('sorts multi-digit versions correctly (4-10 after 4-6)', async () => {
    const ids = ['claude-sonnet-4-10', 'claude-sonnet-4-6'];
    const keys = new Map(await Promise.all(ids.map(async id => [id, await sortKey(id)] as const)));
    ids.sort((a, b) => keys.get(a)!.localeCompare(keys.get(b)!, undefined, { numeric: true }));
    expect(ids).toEqual(['claude-sonnet-4-6', 'claude-sonnet-4-10']);
  });

  it('sorts date suffixes chronologically', async () => {
    const ids = ['claude-haiku-4-5-20251001', 'claude-haiku-4-5-20241201'];
    const keys = new Map(await Promise.all(ids.map(async id => [id, await sortKey(id)] as const)));
    ids.sort((a, b) => keys.get(a)!.localeCompare(keys.get(b)!, undefined, { numeric: true }));
    expect(ids).toEqual([
      'claude-haiku-4-5-20241201',
      'claude-haiku-4-5-20251001',
    ]);
  });

  it('sorts gen 4.5 after gen 4 (same family)', async () => {
    const ids = [
      'claude-4-5-sonnet-20250101',
      'claude-4-sonnet-20250101',
    ];
    const keys = new Map(await Promise.all(ids.map(async id => [id, await sortKey(id)] as const)));
    ids.sort((a, b) => keys.get(a)!.localeCompare(keys.get(b)!, undefined, { numeric: true }));
    expect(ids).toEqual([
      'claude-4-sonnet-20250101',
      'claude-4-5-sonnet-20250101',
    ]);
  });

  it('sorts multi-digit subgen correctly (4.10 after 4.5)', async () => {
    const ids = [
      'claude-4-10-sonnet-20260101',
      'claude-4-5-sonnet-20250101',
    ];
    const keys = new Map(await Promise.all(ids.map(async id => [id, await sortKey(id)] as const)));
    ids.sort((a, b) => keys.get(a)!.localeCompare(keys.get(b)!, undefined, { numeric: true }));
    expect(ids).toEqual([
      'claude-4-5-sonnet-20250101',
      'claude-4-10-sonnet-20260101',
    ]);
  });

  it('sorts different families independently', async () => {
    const ids = [
      'claude-sonnet-4-6',
      'claude-opus-4-8',
      'claude-haiku-4-5-20251001',
    ];
    const keys = new Map(await Promise.all(ids.map(async id => [id, await sortKey(id)] as const)));
    ids.sort((a, b) => keys.get(a)!.localeCompare(keys.get(b)!, undefined, { numeric: true }));
    // Alphabetical by family: haiku < opus < sonnet
    expect(ids).toEqual([
      'claude-haiku-4-5-20251001',
      'claude-opus-4-8',
      'claude-sonnet-4-6',
    ]);
  });
});
