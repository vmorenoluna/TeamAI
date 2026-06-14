'use server';

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { join } from 'path';
import { revalidatePath } from 'next/cache';
import { getActiveProjectPath } from './projects';
import { error as logError } from '@/lib/logger';
import { CURATED_MODELS } from '@/defaults/models';

const execFileAsync = promisify(execFile);

export interface ProvidersConfig {
  default: { model: string; provider: string };
  roles: Record<string, { model?: string; provider?: string }>;
}

const DEFAULT: ProvidersConfig = {
  default: { model: 'claude-sonnet-4-6', provider: 'anthropic' },
  roles: {
    analyst: { model: 'claude-opus-4-5' },
    planner: { model: 'claude-haiku-4-5' },
    merger: { model: 'claude-haiku-4-5' },
  },
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

// ── Model listing ──────────────────────────────────────────────────────

/**
 * Get available models for a given provider.
 *
 * Resolution order:
 * 1. File cache (`.teamai/models-cache.json`) — returned if fresh (< 1 hour)
 * 2. Curated defaults (`CURATED_MODELS`) — always available fallback
 * 3. On explicit refresh: tries API/CLI, updates cache
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
        const res = await fetch('https://api.anthropic.com/v1/models', {
          headers: {
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
          },
        });
        if (!res.ok) {
          logError('providers', `Anthropic API returned ${res.status}`);
          return { models: [], error: `Anthropic API returned ${res.status}` };
        }
        const json = await res.json() as { data: Array<{ id: string; display_name?: string; type: string }> };
        const models = json.data
          .filter(m => m.type === 'model')
          .map(m => m.id)
          .sort();
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
