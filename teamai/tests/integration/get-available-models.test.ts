/**
 * Integration tests for getAvailableModels.
 *
 * Tests exercise the full filesystem pipeline: creating real .teamai/providers.json
 * files, verifying that saveProvidersConfig + getProvidersConfig round-trips
 * correctly, and that getAvailableModels uses the correct project path.
 *
 * The actual model-fetching logic (fetch/execFile) is mocked since it cannot
 * make real API calls in a test environment, but the filesystem setup uses
 * real temp directories and files.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, writeFileSync, existsSync, rmSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';

// ── Mocks ───────────────────────────────────────────────────────────────────

const mockGetActiveProjectPath = vi.fn();

vi.mock('@/app/actions/projects', () => ({
  getActiveProjectPath: (...args: unknown[]) => mockGetActiveProjectPath(...args),
}));

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

vi.mock('child_process', async () => {
  const actual = await vi.importActual<typeof import('child_process')>('child_process');
  return {
    ...actual,
    execFile: vi.fn(),
  };
});

vi.mock('next/cache', () => ({
  revalidatePath: vi.fn(),
}));

vi.mock('@/lib/logger', () => ({
  error: vi.fn(),
  log: vi.fn(),
  warn: vi.fn(),
  default: { error: vi.fn(), log: vi.fn(), warn: vi.fn() },
}));

// ── Test Fixture Helpers ────────────────────────────────────────────────────

let projectDir: string;

/** Create a temp project directory with .teamai/ subdirectory */
function initProject() {
  projectDir = join(tmpdir(), `teamai-providers-integ-${randomUUID().slice(0, 8)}`);
  mkdirSync(join(projectDir, '.teamai'), { recursive: true });
  mockGetActiveProjectPath.mockResolvedValue(projectDir);
  return projectDir;
}

/** Clean up the temp project directory */
function cleanupProject() {
  if (projectDir && existsSync(projectDir)) {
    try { rmSync(projectDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
}

/** Write a providers.json file in the project's .teamai/ directory */
function writeProvidersConfig(config: object) {
  const cfgPath = join(projectDir, '.teamai', 'providers.json');
  writeFileSync(cfgPath, JSON.stringify(config, null, 2));
}

/** Read providers.json from the project's .teamai/ directory */
function readProvidersConfig(): object {
  const cfgPath = join(projectDir, '.teamai', 'providers.json');
  return JSON.parse(readFileSync(cfgPath, 'utf-8'));
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('getAvailableModels Integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    initProject();
  });

  afterEach(() => {
    cleanupProject();
    vi.resetModules();
  });

  // ── Config Round-Trip ──────────────────────────────────────────────

  describe('config save/get round-trip', () => {
    it('saves and reads back a providers config', async () => {
      const { saveProvidersConfig, getProvidersConfig } = await import('@/app/actions/providers');

      const config = {
        default: { model: 'claude-sonnet-4-6', provider: 'anthropic' },
        roles: {
          coder: { model: 'gpt-4o', provider: 'openai' },
          planner: { provider: 'bedrock' },
        },
      };

      await saveProvidersConfig(config);
      const readBack = await getProvidersConfig();

      expect(readBack.default.model).toBe('claude-sonnet-4-6');
      expect(readBack.default.provider).toBe('anthropic');
      expect(readBack.roles.coder?.model).toBe('gpt-4o');
      expect(readBack.roles.coder?.provider).toBe('openai');
      expect(readBack.roles.planner?.provider).toBe('bedrock');
      expect(readBack.roles.planner?.model).toBeUndefined();
    });

    it('merges saved config with defaults on read', async () => {
      const { saveProvidersConfig, getProvidersConfig } = await import('@/app/actions/providers');

      // Save partial config (only role overrides, no default)
       
      await saveProvidersConfig({
        roles: { coder: { provider: 'bedrock' } },
      } as any);
       

      const readBack = await getProvidersConfig();

      // Default should be filled in from DEFAULT constant
      expect(readBack.default.model).toBe('claude-sonnet-4-6');
      expect(readBack.default.provider).toBe('anthropic');
      expect(readBack.roles.coder?.provider).toBe('bedrock');
    });

    it('returns defaults when providers.json does not exist', async () => {
      // Remove .teamai/providers.json (initProject creates it empty — just the dir)
      const { getProvidersConfig } = await import('@/app/actions/providers');

      const config = await getProvidersConfig();

      expect(config.default.model).toBe('claude-sonnet-4-6');
      expect(config.default.provider).toBe('anthropic');
      // getProvidersConfig merges with DEFAULT_PROVIDERS_CONFIG which includes role defaults
      expect(config.roles).toBeDefined();
      expect(typeof config.roles).toBe('object');
    });

    it('persists the config to the actual filesystem', async () => {
      const { saveProvidersConfig } = await import('@/app/actions/providers');

      await saveProvidersConfig({
        default: { model: 'test-model', provider: 'ollama' },
        roles: {},
      });

      // Read the actual file from disk
       
      const onDisk = readProvidersConfig() as any;
      expect(onDisk.default.model).toBe('test-model');
      expect(onDisk.default.provider).toBe('ollama');
    });
  });

  // ── Model Fetching with Project Context ────────────────────────────

  describe('model fetching with project context', () => {
    it('fetches Anthropic models using the project context', async () => {
      // Set up a provider config with anthropic as default
      writeProvidersConfig({
        default: { model: 'claude-sonnet-4-6', provider: 'anthropic' },
        roles: {},
      });

      vi.stubEnv('ANTHROPIC_API_KEY', 'sk-test-anthropic');
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: [
            { id: 'claude-sonnet-4-6', type: 'model' },
            { id: 'claude-haiku-4-5-20251001', type: 'model' },
            { id: 'claude-3-5-sonnet-20241022', type: 'model' }, // deduped: older sonnet loses to claude-sonnet-4-6
          ],
        }),
      });

      const { getAvailableModels } = await import('@/app/actions/providers');
      const result = await getAvailableModels('anthropic');

      expect(result.error).toBeUndefined();
      // claude-3-5-sonnet-20241022 is deduped out (claude-sonnet-4-6 is the latest sonnet)
      expect(result.models).toEqual([
        'claude-haiku-4-5-20251001',
        'claude-sonnet-4-6',
      ]);
    });

    it('fetches Ollama models (no API key required)', async () => {
      writeProvidersConfig({
        default: { model: 'llama3', provider: 'ollama' },
        roles: {},
      });

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          models: [
            { name: 'llama3.2:3b' },
            { name: 'mistral:7b' },
          ],
        }),
      });

      const { getAvailableModels } = await import('@/app/actions/providers');
      const result = await getAvailableModels('ollama');

      expect(result.error).toBeUndefined();
      expect(result.models).toEqual(['llama3.2:3b', 'mistral:7b']);
    });

    it('returns empty models when API key is missing and no curated default', async () => {
      writeProvidersConfig({
        default: { model: 'gpt-4o', provider: 'openai' },
        roles: {},
      });

      vi.stubEnv('OPENAI_API_KEY', '');

      const { getAvailableModels } = await import('@/app/actions/providers');
      const result = await getAvailableModels('openai');

      // No curated fallback for non-Anthropic providers — returns empty with error
      expect(result.models).toEqual([]);
      expect(result.error).toBe('OPENAI_API_KEY not set — using curated model list');
    });

    it('handles unknown provider gracefully', async () => {
      writeProvidersConfig({
        default: { model: 'unknown', provider: 'unknown-prov' },
        roles: {},
      });

      const { getAvailableModels } = await import('@/app/actions/providers');
      const result = await getAvailableModels('unknown-prov');

      expect(result.models).toEqual([]);
      expect(result.error).toBe('Unknown provider: unknown-prov');
    });

    it('fetches Bedrock models via AWS CLI using project context', async () => {
      writeProvidersConfig({
        default: { model: 'claude-sonnet-4-20250514', provider: 'bedrock' },
        roles: {},
      });

      const { execFile } = await import('child_process');
       
      (vi.mocked(execFile) as any).mockImplementation(
        (_cmd: string, _args: readonly string[] | null | undefined, _opts: any, callback: any) => {
          callback(null, {
            stdout: JSON.stringify([
              'anthropic.claude-sonnet-4-20250514',
              'anthropic.claude-3-5-sonnet-20241022-v2:0',
              'meta.llama3-70b-instruct-v1:0',
            ]),
          });
        },
      );

      const { getAvailableModels } = await import('@/app/actions/providers');
      const result = await getAvailableModels('bedrock');

      expect(result.error).toBeUndefined();
      expect(result.models).toEqual([
        'anthropic.claude-3-5-sonnet-20241022-v2:0',
        'anthropic.claude-sonnet-4-20250514',
      ]);
    });

    it('fetches Vertex models via gcloud CLI using project context', async () => {
      writeProvidersConfig({
        default: { model: 'claude-sonnet-4-20250514', provider: 'vertex' },
        roles: {},
      });

      const { execFile } = await import('child_process');
       
      (vi.mocked(execFile) as any).mockImplementation(
        (_cmd: string, _args: readonly string[] | null | undefined, _opts: any, callback: any) => {
          callback(null, {
            stdout: JSON.stringify([
              { name: 'projects/test/locations/us-central1/publishers/anthropic/models/claude-sonnet-4-20250514' },
              { name: 'projects/test/locations/us-central1/publishers/google/models/gemini-2.0-flash-001' },
            ]),
          });
        },
      );

      const { getAvailableModels } = await import('@/app/actions/providers');
      const result = await getAvailableModels('vertex');

      expect(result.error).toBeUndefined();
      expect(result.models).toEqual([
        'claude-sonnet-4-20250514',
        'gemini-2.0-flash-001',
      ]);
    });
  });

  // ── Full Flow: Save Config → Fetch Models ─────────────────────────

  describe('full save-then-fetch flow', () => {
    it('saves config with Ollama, then fetches models', async () => {
      const { saveProvidersConfig, getAvailableModels } = await import('@/app/actions/providers');

      // Save provider config with Ollama
      await saveProvidersConfig({
        default: { model: 'llama3', provider: 'ollama' },
        roles: {},
      });

      // Verify it was persisted
       
      const config = readProvidersConfig() as any;
      expect(config.default.provider).toBe('ollama');

      // Fetch models
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ models: [{ name: 'llama3.2' }, { name: 'codellama' }] }),
      });

      const result = await getAvailableModels('ollama');

      expect(result.error).toBeUndefined();
      expect(result.models).toEqual(['codellama', 'llama3.2']);
    });

    it('saves config with OpenAI, returns empty models without API key (no curated fallback)', async () => {
      const { saveProvidersConfig, getAvailableModels } = await import('@/app/actions/providers');

      vi.stubEnv('OPENAI_API_KEY', '');

      await saveProvidersConfig({
        default: { model: 'gpt-4o', provider: 'openai' },
        roles: { coder: { provider: 'openai' } },
      });

      // Verify on disk
       
      const config = readProvidersConfig() as any;
      expect(config.default.provider).toBe('openai');
      expect(config.roles.coder.provider).toBe('openai');

      // No curated fallback for non-Anthropic providers — returns empty with error
      const result = await getAvailableModels('openai');
      expect(result.models).toEqual([]);
      expect(result.error).toBe('OPENAI_API_KEY not set — using curated model list');
    });
  });

  // ── Cache Behavior ───────────────────────────────────────────────────

  describe('cache behavior', () => {
    it('caches fetched models and returns them on subsequent calls', async () => {
      vi.stubEnv('ANTHROPIC_API_KEY', 'sk-test-anthropic');

      const { getAvailableModels } = await import('@/app/actions/providers');

      // First call: fetch from API, should write to cache
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: [
            { id: 'claude-sonnet-4-6', type: 'model' },
            { id: 'claude-haiku-4-5-20251001', type: 'model' },
          ],
        }),
      });

      const first = await getAvailableModels('anthropic');
      expect(first.models).toEqual(['claude-haiku-4-5-20251001', 'claude-sonnet-4-6']);

      // Verify cache was written to disk
      const cachePath = join(projectDir, '.teamai', 'models-cache.json');
      expect(existsSync(cachePath)).toBe(true);
      const cache = JSON.parse(readFileSync(cachePath, 'utf-8'));
      expect(cache.anthropic.models).toEqual(['claude-haiku-4-5-20251001', 'claude-sonnet-4-6']);

      // Second call: should use cache, not fetch
      const second = await getAvailableModels('anthropic');
      expect(second.models).toEqual(['claude-haiku-4-5-20251001', 'claude-sonnet-4-6']);
      // fetch should only have been called once (from the first call)
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('handles corrupted cache file gracefully', async () => {
      vi.stubEnv('ANTHROPIC_API_KEY', '');

      // Write corrupted cache file
      const cachePath = join(projectDir, '.teamai', 'models-cache.json');
      writeFileSync(cachePath, '{malformed json');

      const { getAvailableModels } = await import('@/app/actions/providers');
      const result = await getAvailableModels('anthropic');

      // Should ignore corrupted cache and fall through to curated defaults
      expect(result.models.length).toBeGreaterThan(0);
      expect(result.error).toContain('ANTHROPIC_API_KEY not set');
    });

    it('bypasses cache when refresh flag is set', async () => {
      vi.stubEnv('ANTHROPIC_API_KEY', 'sk-test-anthropic');

      const { getAvailableModels } = await import('@/app/actions/providers');

      // Seed a cache entry
      const cachePath = join(projectDir, '.teamai', 'models-cache.json');
      writeFileSync(
        cachePath,
        JSON.stringify({
          anthropic: { models: ['old-cached-model'], fetchedAt: new Date().toISOString() },
        }),
      );

      // Call with refresh=true — should bypass cache
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: [{ id: 'claude-opus-4-8', type: 'model' }],
        }),
      });

      const result = await getAvailableModels('anthropic', true);
      expect(result.models).toEqual(['claude-opus-4-8']);
      expect(mockFetch).toHaveBeenCalledTimes(1);

      // Verify cache was updated with fresh data
      const cache = JSON.parse(readFileSync(cachePath, 'utf-8'));
      expect(cache.anthropic.models).toEqual(['claude-opus-4-8']);
    });
  });
});
