import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

export interface ProviderConfig {
  model?: string;
  provider?: 'anthropic' | 'bedrock' | 'vertex' | 'ollama';
  env?: Record<string, string>;
}

interface ProvidersFile {
  default?: ProviderConfig;
  roles?: Record<string, ProviderConfig>;
}

export function resolveProvider(projectRoot: string, role: string): ProviderConfig {
  const cfgPath = join(projectRoot, '.teamai', 'providers.json');
  if (!existsSync(cfgPath)) return {};
  try {
    const cfg: ProvidersFile = JSON.parse(readFileSync(cfgPath, 'utf-8'));
    const roleOverride = cfg.roles?.[role] ?? {};
    return { ...cfg.default, ...roleOverride };
  } catch {
    return {};
  }
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
  if (cfg.provider === 'ollama') env['ANTHROPIC_BASE_URL'] = env['ANTHROPIC_BASE_URL'] ?? 'http://localhost:11434';

  return {
    model: cfg.model,
    env: Object.keys(env).length ? env : undefined,
  };
}
