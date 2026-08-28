'use server';

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { join } from 'path';
import { revalidatePath } from 'next/cache';
import { getActiveProjectPath } from './projects';
import { error as logError } from '@/lib/logger';
import { CURATED_MODELS } from '@/defaults/models';
import { migrateProvidersConfig, migrationSignature } from '@/lib/providers-migration';
import type { ModelMigrationChange } from '@/lib/providers-migration';

const execFileAsync = promisify(execFile);

export interface ProvidersConfig {
  default: { model: string; provider: string };
  roles: Record<string, { model?: string; provider?: string }>;
  /** Model to use for exploration commands (ideation, roadmap). Falls back to default.model when unset. */
  exploration?: { model?: string };
}

const DEFAULT: ProvidersConfig = {
  default: { model: 'claude-sonnet-5', provider: 'anthropic' },
  roles: {
    analyst: { model: 'claude-opus-5' },
    planner: { model: 'claude-haiku-4-5-20251001' },
    merger: { model: 'claude-haiku-4-5-20251001' },
  },
  exploration: { model: 'claude-sonnet-5' },
};

// ── Cache helpers ──────────────────────────────────────────────────────

interface ModelsCacheEntry {
  models: string[];
  fetchedAt: string; // ISO timestamp
}

type ModelsCache = Record<string, ModelsCacheEntry>;

function cachePath(projectRoot: string): string {
  return join(projectRoot, '.teamai', 'models-cache.json');
}

function readModelsCache(projectRoot: string): ModelsCache {
  const path = cachePath(projectRoot);
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return {};
  }
}

function writeModelsCache(projectRoot: string, cache: ModelsCache): void {
  const dir = join(projectRoot, '.teamai');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(cachePath(projectRoot), JSON.stringify(cache, null, 2));
}

/** Return models from the file cache if it was fetched within the last hour. */
function getCachedModels(projectRoot: string, provider: string): string[] | null {
  const cache = readModelsCache(projectRoot);
  const entry = cache[provider];
  if (!entry) return null;
  const age = Date.now() - new Date(entry.fetchedAt).getTime();
  if (age > 3_600_000) return null; // stale after 1 hour
  return entry.models;
}

function setCachedModels(projectRoot: string, provider: string, models: string[]): void {
  const cache = readModelsCache(projectRoot);
  cache[provider] = { models, fetchedAt: new Date().toISOString() };
  writeModelsCache(projectRoot, cache);
}

// ── In-memory prewarm (server startup prefetch) ────────────────────────

/** Model list warmed once at process startup — see prewarmModelsCache. */
interface PrewarmedModels {
  models: string[];
  fetchedAt: number; // epoch ms
}

/** Same freshness window as the per-project file cache (1 hour). */
const PREWARM_TTL_MS = 3_600_000;

/**
 * Access the prewarm store. Pinned on globalThis (same pattern as
 * auto-mode's `__autoModeProjectStates`) so the server.ts instance and the
 * Next.js runtime instance of this module share one store even if bundling
 * ever duplicates the module.
 */
function getPrewarmStore(): Map<string, PrewarmedModels> {
  const g = globalThis as unknown as { __teamaiModelsPrewarm?: Map<string, PrewarmedModels> };
  if (!g.__teamaiModelsPrewarm) g.__teamaiModelsPrewarm = new Map();
  return g.__teamaiModelsPrewarm;
}

/** Return the prewarmed model list for a provider if fresh, else null. */
function getFreshPrewarmedModels(provider: string): string[] | null {
  const entry = getPrewarmStore().get(provider);
  if (!entry) return null;
  if (Date.now() - entry.fetchedAt > PREWARM_TTL_MS) return null;
  return entry.models;
}

/**
 * Fetch and cache a provider's model list once at process startup, before
 * any UI asks for it. Called from server.ts's startup sequence so the first
 * Settings visit gets live data from the prewarm cache instead of a loading
 * spinner followed by a fresh fetch (or CURATED_MODELS as a "first paint"
 * fallback when the on-mount fetch fails).
 *
 * Scoping decision — deliberately project-agnostic: the model list is
 * provider-global data; the per-project keying of
 * `.teamai/models-cache.json` is incidental (it exists only because
 * getAvailableModels resolves the active project from a request cookie).
 * Prefetching per registered project would silently create cache files in
 * projects the user never opens, and the "active" project is unknowable at
 * boot (no request context yet). getAvailableModels consults this store
 * when the per-project file cache is cold and writes through to that
 * project's file cache on the first real UI call — so cache files appear
 * only for projects the user actually uses.
 *
 * Never throws: a network error, missing API key, or timeout resolves to
 * `{ ok: false, error }` so the startup sequence is never blocked or failed
 * (CURATED_MODELS remains the usable fallback through the normal path).
 */
export async function prewarmModelsCache(
  provider: string,
): Promise<{ ok: boolean; modelCount: number; error?: string }> {
  try {
    // Already warmed and fresh? Don't refetch.
    const existing = getPrewarmStore().get(provider);
    if (existing && Date.now() - existing.fetchedAt <= PREWARM_TTL_MS) {
      return { ok: true, modelCount: existing.models.length };
    }

    // Guard against a hung fetch keeping the prewarm pending forever: race
    // the real fetch against a timeout (the loser is simply discarded —
    // fetchModelsFromProvider catches its own errors and never rejects).
    const FETCH_TIMEOUT_MS = 30_000;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        fetchModelsFromProvider(provider),
        new Promise<{ models: string[]; error: string }>(resolve => {
          timer = setTimeout(
            () => resolve({ models: [], error: `Model prefetch timed out after ${FETCH_TIMEOUT_MS / 1000}s` }),
            FETCH_TIMEOUT_MS,
          );
          // Don't keep the process alive just for a pending prefetch.
          if (typeof timer.unref === 'function') timer.unref();
        }),
      ]);

      if (result.models.length === 0) {
        // Fetch failed (no API key, network error, non-2xx). Cache nothing —
        // CURATED_MODELS stays the fallback via the normal resolution path.
        return { ok: false, modelCount: 0, error: result.error ?? 'no models returned' };
      }

      getPrewarmStore().set(provider, { models: result.models, fetchedAt: Date.now() });
      return { ok: true, modelCount: result.models.length };
    } finally {
      if (timer) clearTimeout(timer);
    }
  } catch (err) {
    // Last resort — fetchModelsFromProvider already handles its own errors;
    // this guards the prewarm bookkeeping itself.
    logError('providers', 'Startup model prefetch failed', err);
    return { ok: false, modelCount: 0, error: err instanceof Error ? err.message : String(err) };
  }
}

// ── Config read/write ──────────────────────────────────────────────────

export async function getProvidersConfig(): Promise<ProvidersConfig> {
  const projectPath = await getActiveProjectPath();
  const cfgPath = join(projectPath, '.teamai', 'providers.json');
  if (!existsSync(cfgPath)) return DEFAULT;
  try {
    return { ...DEFAULT, ...JSON.parse(readFileSync(cfgPath, 'utf-8')) };
  } catch {
    return DEFAULT;
  }
}

export async function saveProvidersConfig(config: ProvidersConfig): Promise<void> {
  const projectPath = await getActiveProjectPath();
  const cfgPath = join(projectPath, '.teamai', 'providers.json');
  writeFileSync(cfgPath, JSON.stringify(config, null, 2));
  revalidatePath('/settings');
}

// ── Superseded-model migration hint ────────────────────────────────────
// Projects registered before a defaults bump keep their seeded
// .teamai/providers.json (by design — saved model choices are never
// force-overwritten). These actions power an opt-in Settings hint that
// migrates ONLY the superseded IDs to the current generation, preserving
// every other field of the user's config.

const MIGRATION_MARKER_PREFIX = 'providers-migration-dismissed-';

/**
 * Pending migration hint for the active project, or null when there is
 * nothing to offer: no project, no project-level providers.json (the project
 * already tracks the shipped defaults), no superseded IDs, an unreadable
 * config, or the user dismissed this migration signature.
 * Never throws — the Settings page renders regardless.
 */
export async function getProvidersMigrationHint(): Promise<{ changes: ModelMigrationChange[] } | null> {
  try {
    const projectPath = await getActiveProjectPath().catch(() => null);
    if (!projectPath) return null;
    const cfgPath = join(projectPath, '.teamai', 'providers.json');
    if (!existsSync(cfgPath)) return null;
    const config = JSON.parse(readFileSync(cfgPath, 'utf-8')) as ProvidersConfig;
    const { changes } = migrateProvidersConfig(config);
    if (changes.length === 0) return null;
    const marker = join(
      projectPath, '.teamai', `${MIGRATION_MARKER_PREFIX}${migrationSignature()}`,
    );
    if (existsSync(marker)) return null;
    return { changes };
  } catch {
    return null; // unreadable/invalid config — non-fatal
  }
}

/**
 * Migrate the active project's on-disk providers.json, replacing only the
 * superseded model IDs (see MODEL_MIGRATIONS). The editor mirrors the same
 * pure migration into its local state, so the UI reflects the new IDs
 * immediately without a reload.
 */
export async function applyProvidersMigration(): Promise<{
  ok: boolean;
  changes?: ModelMigrationChange[];
  error?: string;
}> {
  try {
    const projectPath = await getActiveProjectPath();
    const cfgPath = join(projectPath, '.teamai', 'providers.json');
    if (!existsSync(cfgPath)) {
      return { ok: false, error: 'No project-level providers.json — this project already tracks the built-in defaults.' };
    }
    const config = JSON.parse(readFileSync(cfgPath, 'utf-8')) as ProvidersConfig;
    const { config: migrated, changes } = migrateProvidersConfig(config);
    if (changes.length === 0) {
      return { ok: false, error: 'No superseded model IDs found in this project\'s config.' };
    }
    writeFileSync(cfgPath, JSON.stringify(migrated, null, 2));
    revalidatePath('/settings');
    return { ok: true, changes };
  } catch (err) {
    logError('providers', 'Failed to apply model migration', err);
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Dismiss the migration hint for the CURRENT migration signature. A future
 * default bump changes the signature, so its hint will still be shown.
 */
export async function dismissProvidersMigrationHint(): Promise<void> {
  try {
    const projectPath = await getActiveProjectPath();
    const dir = join(projectPath, '.teamai');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${MIGRATION_MARKER_PREFIX}${migrationSignature()}`), '');
  } catch (err) {
    logError('providers', 'Failed to dismiss model migration hint', err);
  }
}

// ── Model deduplication ─────────────────────────────────────────────────

/**
 * Extract the model family from a Claude model ID (internal sync version).
 *
 * Claude naming conventions:
 *   Gen 4+:  claude-{family}-{version}          e.g. claude-opus-4-8
 *   Gen 3.x: claude-3-5-{family}-{date}         e.g. claude-3-5-sonnet-20241022
 *   Gen 3:   claude-3-{family}-{date}           e.g. claude-3-haiku-20240307
 *
 * The optional numeric-gen prefix `(?:\d+(?:-\d+)?-)?` detects and strips
 * any generation prefix (3-, 3-5-, 4-, 4-5-, 10-) so that the family name
 * (opus, sonnet, haiku, …) is captured regardless of generation — no code
 * change needed when Anthropic ships gen 4.5, gen 5, or beyond.
 *
 * Returns the family name (opus, sonnet, haiku, fable, mythos, …) or null.
 * New families are detected automatically — no code change required.
 */
function _extractClaudeFamily(id: string): string | null {
  const match = id.match(/^claude-(?:\d+(?:-\d+)?-)?([a-z]+)/);
  return match ? match[1] : null;
}

/** Async wrapper required by Next.js 'use server'. */
export async function extractClaudeFamily(id: string): Promise<string | null> {
  return _extractClaudeFamily(id);
}

/**
 * Normalize a Claude model ID for chronological sorting (internal sync version).
 *
 * Transforms any claude-{gen}-{subgen}- prefix to claude-{gen}.{subgen}-
 * (e.g. claude-3-5-sonnet → claude-3.5-sonnet, claude-4-5-sonnet → claude-4.5-sonnet)
 * so that sub-generations sort after their base generation (since '.' > '-' in ASCII).
 * When combined with localeCompare({numeric:true}) (done by the caller in
 * deduplicateByLatestFamily), this ensures multi-digit version components
 * (claude-sonnet-4-10 vs 4-6) and date suffixes (20241022 vs 20240307)
 * sort correctly.
 */
function _sortKey(id: string): string {
  return id.replace(/^claude-(\d+)-(\d+)-/, 'claude-$1.$2-');
}

/** Async wrapper required by Next.js 'use server'. */
export async function sortKey(id: string): Promise<string> {
  return _sortKey(id);
}

/**
 * Keep only the latest model per family.
 */
function deduplicateByLatestFamily(modelIds: string[]): string[] {
  const claudeModels = modelIds.filter(m => m.startsWith('claude-'));
  if (claudeModels.length === 0) return [];

  const byFamily = new Map<string, string[]>();

  for (const m of claudeModels) {
    const family = _extractClaudeFamily(m);
    if (!family) continue;
    const existing = byFamily.get(family) || [];
    existing.push(m);
    byFamily.set(family, existing);
  }

  const sorter = (a: string, b: string) =>
    _sortKey(a).localeCompare(_sortKey(b), undefined, { numeric: true });

  // Per family: sort ascending (older → newer) and take the last (latest)
  const latest: string[] = [];
  for (const familyModels of byFamily.values()) {
    familyModels.sort(sorter);
    latest.push(familyModels[familyModels.length - 1]);
  }

  return latest.sort(sorter);
}

// ── Model listing ──────────────────────────────────────────────────────

/**
 * Get available models for a given provider.
 *
 * Resolution order:
 * 1. File cache (`.teamai/models-cache.json`) — returned if fresh (< 1 hour)
 * 2. In-memory prewarm (warmed at server startup by prewarmModelsCache) —
 *    returned if fresh; also written through to the file cache so the data
 *    survives restarts (only when a project is active)
 * 3. Curated defaults (`CURATED_MODELS`) — always available fallback
 * 4. On explicit refresh: tries API/CLI, updates cache
 *
 * @param provider - Provider name
 * @param refresh  - If true, bypass cache and fetch fresh from the provider
 */
export async function getAvailableModels(
  provider: string,
  refresh = false,
): Promise<{ models: string[]; error?: string }> {
  const projectPath = await getActiveProjectPath().catch(() => null);

  // If not refreshing, check file cache first
  if (!refresh && projectPath) {
    const cached = getCachedModels(projectPath, provider);
    if (cached) return { models: cached };
  }

  // If not refreshing, consult the in-memory prewarm warmed at server
  // startup before falling back to a live fetch. On a hit, write through to
  // the active project's file cache (same as a live fetch would) so the
  // warm data survives restarts — cache files are only ever created for
  // projects the user actually opens.
  if (!refresh) {
    const prewarmed = getFreshPrewarmedModels(provider);
    if (prewarmed) {
      if (projectPath) {
        try {
          setCachedModels(projectPath, provider, prewarmed);
        } catch {
          // non-fatal: cache write failure
        }
      }
      return { models: prewarmed };
    }
  }

  // Try to fetch fresh (refresh or no cache available)
  const result = await fetchModelsFromProvider(provider);

  // If we got models and have a project path, cache them
  if (result.models.length > 0 && projectPath) {
    try {
      setCachedModels(projectPath, provider, result.models);
    } catch {
      // non-fatal: cache write failure
    }
  }

  // If fetch yielded no models, fall back to curated defaults
  if (result.models.length === 0 && result.error) {
    const curated = CURATED_MODELS[provider];
    if (curated && curated.length > 0) {
      return { models: curated, error: result.error };
    }
  }

  // If fetch yielded no models AND no curated defaults, return curated (may be empty too)
  if (result.models.length === 0 && !result.error) {
    const curated = CURATED_MODELS[provider];
    if (curated) {
      return { models: curated };
    }
  }

  return result;
}

/**
 * Internal: actually call the provider's API/CLI to fetch models.
 * Does NOT use cache.
 */
async function fetchModelsFromProvider(provider: string): Promise<{ models: string[]; error?: string }> {
  switch (provider) {
    case 'anthropic': {
      const apiKey = process.env.ANTHROPIC_API_KEY;
      if (!apiKey) {
        return { models: [], error: 'ANTHROPIC_API_KEY not set — using curated model list' };
      }
      try {
        // Paginate through all available models. Default page size is 20;
        // we request 100 (the max) to minimise round-trips, then follow
        // the after_id cursor until has_more is false.
        const allModels: Array<{ id: string; display_name?: string; type: string }> = [];
        let afterId: string | undefined;
        let hasMore = true;
        const baseUrl = 'https://api.anthropic.com/v1/models?limit=100';

        while (hasMore) {
          const url = afterId ? `${baseUrl}&after_id=${afterId}` : baseUrl;
          const res = await fetch(url, {
            headers: {
              'x-api-key': apiKey,
              'anthropic-version': '2023-06-01',
            },
          });
          if (!res.ok) {
            logError('providers', `Anthropic API returned ${res.status}`);
            return { models: [], error: `Anthropic API returned ${res.status}` };
          }
          const json = await res.json() as {
            data: Array<{ id: string; display_name?: string; type: string }>;
            has_more: boolean;
            last_id?: string;
          };
          allModels.push(...json.data.filter(m => m.type === 'model'));
          hasMore = json.has_more;
          afterId = json.last_id;
        }

        const modelIds = allModels.map(m => m.id);
        const models = deduplicateByLatestFamily(modelIds);
        return { models };
      } catch (err) {
        logError('providers', 'Failed to fetch Anthropic models', err);
        return { models: [], error: `Failed to fetch Anthropic models` };
      }
    }

    case 'openai': {
      const apiKey = process.env.OPENAI_API_KEY;
      if (!apiKey) {
        return { models: [], error: 'OPENAI_API_KEY not set — using curated model list' };
      }
      try {
        const res = await fetch('https://api.openai.com/v1/models', {
          headers: { Authorization: `Bearer ${apiKey}` },
        });
        if (!res.ok) {
          logError('providers', `OpenAI API returned ${res.status}`);
          return { models: [], error: `OpenAI API returned ${res.status}` };
        }
        const json = await res.json() as { data: Array<{ id: string }> };
        const models = json.data
          .map(m => m.id)
          .filter(id => /^gpt-|^o1|^o3/.test(id))
          .sort();
        return { models };
      } catch (err) {
        logError('providers', 'Failed to fetch OpenAI models', err);
        return { models: [], error: `Failed to fetch OpenAI models` };
      }
    }

    case 'gemini': {
      const apiKey = process.env.GOOGLE_API_KEY;
      if (!apiKey) {
        return { models: [], error: 'GOOGLE_API_KEY not set — using curated model list' };
      }
      try {
        const res = await fetch(`https://generativelanguage.googleapis.com/v1/models?key=${apiKey}`);
        if (!res.ok) {
          logError('providers', `Gemini API returned ${res.status}`);
          return { models: [], error: `Gemini API returned ${res.status}` };
        }
        const json = await res.json() as { models: Array<{ name: string }> };
        const models = json.models
          .map(m => m.name.replace('models/', ''))
          .filter(name => name.startsWith('gemini'))
          .sort();
        return { models };
      } catch (err) {
        logError('providers', 'Failed to fetch Gemini models', err);
        return { models: [], error: `Failed to fetch Gemini models` };
      }
    }

    case 'bedrock': {
      try {
        const { stdout } = await execFileAsync('aws', [
          'bedrock', 'list-foundation-models',
          '--query', 'modelSummaries[].modelId',
          '--output', 'json',
        ], { timeout: 8_000 });
        const models: string[] = JSON.parse(stdout);
        const claudeModels = models.filter(m => m.toLowerCase().includes('claude')).sort();
        return { models: claudeModels.length > 0 ? claudeModels : models };
      } catch (err) {
        logError('providers', 'Failed to list Bedrock models', err);
        return { models: [], error: 'AWS CLI not available' };
      }
    }

    case 'vertex': {
      try {
        const { stdout } = await execFileAsync('gcloud', [
          'ai', 'models', 'list', '--format=json',
        ], { timeout: 8_000 });
        const models: Array<{ name: string }> = JSON.parse(stdout);
        const names = models
          .map(m => m.name.split('/').pop() ?? '')
          .filter(Boolean)
          .sort();
        return { models: names };
      } catch (err) {
        logError('providers', 'Failed to list Vertex models', err);
        return { models: [], error: 'gcloud CLI not available' };
      }
    }

    case 'ollama': {
      try {
        const res = await fetch('http://localhost:11434/api/tags', { signal: AbortSignal.timeout(5_000) });
        if (!res.ok) {
          return { models: [], error: `Ollama API returned ${res.status}` };
        }
        const json = await res.json() as { models: Array<{ name: string }> };
        const models = json.models.map(m => m.name).sort();
        return { models };
      } catch (err) {
        logError('providers', 'Failed to fetch Ollama models', err);
        return { models: [], error: 'Ollama not running on localhost:11434' };
      }
    }

    default:
      return { models: [], error: `Unknown provider: ${provider}` };
  }
}
