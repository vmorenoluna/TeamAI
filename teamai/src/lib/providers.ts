import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

export interface ProviderConfig {
  model?: string;
  provider?: 'anthropic' | 'bedrock' | 'vertex' | 'openai' | 'gemini' | 'ollama';
  env?: Record<string, string>;
}

interface ProvidersFile {
  default?: ProviderConfig;
  roles?: Record<string, ProviderConfig>;
}

const DEFAULTS_DIR = join(process.cwd(), 'defaults');

/** Read the TeamAI-shipped defaults file. Returns null on any failure. */
function readDefaultProviders(): ProvidersFile | null {
  try {
    const defaultsPath = join(DEFAULTS_DIR, 'providers.json');
    if (!existsSync(defaultsPath)) return null;
    return JSON.parse(readFileSync(defaultsPath, 'utf-8'));
  } catch {
    return null;
  }
}

export function resolveProvider(projectRoot: string, role: string): ProviderConfig {
  const cfgPath = join(projectRoot, '.teamai', 'providers.json');
  if (!existsSync(cfgPath)) {
    // Fall back to TeamAI defaults when no project-level config exists,
    // so the orchestrator uses intended role-specific models (analyst → Opus, etc.)
    const defaults = readDefaultProviders();
    if (defaults) {
      const roleOverride = defaults.roles?.[role] ?? {};
      return { ...(defaults.default ?? {}), ...roleOverride };
    }
    return {};
  }
  try {
    const cfg: ProvidersFile = JSON.parse(readFileSync(cfgPath, 'utf-8'));
    const roleOverride = cfg.roles?.[role] ?? {};
    return { ...cfg.default, ...roleOverride };
  } catch {
    return {};
  }
}

/**
 * Resolve the model for a terminal session given a role filename (e.g. "analyst.md").
 * Strips the .md extension before looking up the role override in config.roles,
 * falling back to config.default.model when no override is configured.
 */
export function resolveTerminalModel(roleFilename: string, config: { default: { model: string }; roles: Record<string, { model?: string }> }): string {
  const roleKey = roleFilename.replace(/\.md$/, '');
  return config.roles[roleKey]?.model ?? config.default.model;
}

/**
 * Convert a ProviderConfig into CLI args and env overrides for ProcessManager.createSession().
 */
export function providerToSessionOpts(cfg: ProviderConfig): {
  model?: string;
  permissionMode?: string;
  env?: Record<string, string>;
} {
  const env: Record<string, string> = { ...(cfg.env ?? {}) };

  if (cfg.provider === 'bedrock') env['CLAUDE_CODE_USE_BEDROCK'] = '1';
  if (cfg.provider === 'vertex') env['CLAUDE_CODE_USE_VERTEX'] = '1';
  if (cfg.provider === 'openai') env['OPENAI_API_KEY'] = env['OPENAI_API_KEY'] ?? '';
  if (cfg.provider === 'gemini') env['GOOGLE_API_KEY'] = env['GOOGLE_API_KEY'] ?? '';
  if (cfg.provider === 'ollama') env['ANTHROPIC_BASE_URL'] = env['ANTHROPIC_BASE_URL'] ?? 'http://localhost:11434';

  return {
    model: cfg.model,
    env: Object.keys(env).length ? env : undefined,
  };
}
