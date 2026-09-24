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

/** Read the TeamAI-shipped defaults file. Returns null on any failure. */
function readDefaultProviders(): ProvidersFile | null {
  try {
    const defaultsDir = join(/* turbopackIgnore: true */ process.cwd(), 'defaults');
    const defaultsPath = join(defaultsDir, 'providers.json');
    if (!existsSync(defaultsPath)) return null;
    return JSON.parse(readFileSync(defaultsPath, 'utf-8'));
  } catch {
    return null;
  }
}

export function resolveProvider(projectRoot: string, role: string): ProviderConfig {
  const defaults = readDefaultProviders();
  const shippedDefault = defaults?.default ?? {};
  // TeamAI's shipped per-role default (analyst -> Opus, planner/merger -> Haiku).
  // Used both when the project has no config at all, and — below — as a
  // fallback layer for a role the project's own config doesn't mention.
  const shippedRoleOverride = defaults?.roles?.[role] ?? {};

  const cfgPath = join(projectRoot, '.teamai', 'providers.json');
  if (!existsSync(cfgPath)) {
    return { ...shippedDefault, ...shippedRoleOverride };
  }
  try {
    const cfg: ProvidersFile = JSON.parse(readFileSync(cfgPath, 'utf-8'));
    // A role absent from the project's own `roles` object still gets
    // TeamAI's shipped per-role default layered in ahead of the project's
    // generic default — otherwise, once a project has ANY providers.json,
    // any role it doesn't explicitly list silently collapses to
    // cfg.default instead of its intended model. A role the project DOES
    // list is honored exactly as saved (merged only with cfg.default for
    // fields it leaves unset), matching the existing override semantics.
    const roleOverride = cfg.roles?.[role] ?? shippedRoleOverride;
    return { ...shippedDefault, ...cfg.default, ...roleOverride };
  } catch {
    // Malformed project config — return nothing rather than guessing;
    // unchanged from prior behavior (unrelated to the missing-role gap above).
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
