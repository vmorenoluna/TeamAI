import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

export interface ProviderConfig {
  model?: string;
  provider?: 'anthropic' | 'bedrock' | 'vertex' | 'openai' | 'gemini' | 'ollama';
  /** Extra environment variables injected into the spawned Claude CLI process
   *  (see ProcessManager.createSession) — merged over process.env (or passed
   *  as `-e` flags in container mode). The shipped `qa-reviewer` role raises
   *  Claude Code's own `BASH_DEFAULT_TIMEOUT_MS`/`BASH_MAX_TIMEOUT_MS` (from
   *  their 2min/10min stock defaults) here: a QA-review session gets exactly
   *  one turn and is torn down the instant it ends (see qa-review.ts), so a
   *  long verification command (the full test suite) MUST complete inside a
   *  single foreground Bash call rather than being backgrounded — Claude
   *  Code's stock 2-minute default timeout would truncate that call well
   *  before most real suites finish. This makes that work even if the agent
   *  forgets to pass an explicit `timeout`, instead of relying purely on
   *  qa-review.md's Step 6 instructions to get it right every time. */
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
  // Every role resolves the same way: an explicit override in the project's
  // own config wins; otherwise, fall back to the project's generic default.
  // TeamAI's recommended per-role models (analyst -> Opus, planner/merger ->
  // Haiku) are written into a project's own .teamai/providers.json once, at
  // registration time (see ProjectStore.scaffold), so "settings" and
  // "resolved behavior" stay identical here — there is no separate
  // code-level per-role fallback tier that can drift out of sync with what's
  // actually on disk.
  const defaults = readDefaultProviders();
  const shippedDefault = defaults?.default ?? {};

  const cfgPath = join(projectRoot, '.teamai', 'providers.json');
  if (!existsSync(cfgPath)) {
    // No project config at all (e.g. registered before providers.json
    // scaffolding existed, or the file was deleted) — use TeamAI's shipped
    // recommendation as a last-resort baseline.
    const shippedRoleOverride = defaults?.roles?.[role] ?? {};
    return { ...shippedDefault, ...shippedRoleOverride };
  }
  try {
    const cfg: ProvidersFile = JSON.parse(readFileSync(cfgPath, 'utf-8'));
    const roleOverride = cfg.roles?.[role] ?? {};
    return { ...shippedDefault, ...cfg.default, ...roleOverride };
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
