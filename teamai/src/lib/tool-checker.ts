/**
 * Prerequisite tool checker — verifies all external CLI tools the app depends on.
 *
 * Each tool can have a custom path configured (persisted to tools.json in the
 * TeamAI app root). The checker tries the custom path first, then falls back
 * to the default binary name on PATH via findExecutable.
 *
 * Caches detection results per process lifetime so repeated lookups are cheap.
 */
import { execFile } from 'child_process';
import { promisify } from 'util';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { warn } from './logger';

const execFileAsync = promisify(execFile);

// ── Types ───────────────────────────────────────────────────────────────────

export type ToolName = 'claude' | 'git' | 'gh' | 'docker' | 'devcontainer';

export interface ToolStatus {
  name: ToolName;
  label: string;
  found: boolean;
  path: string;
  version: string | null;
  error?: string;
  customPath: boolean;
}

interface ToolsConfig {
  [key: string]: string;
}

// ── Tool definitions ────────────────────────────────────────────────────────

const TOOL_DEFAULTS: Record<ToolName, { label: string; versionFlag: string }> = {
  claude:        { label: 'Claude CLI',       versionFlag: '--version' },
  git:           { label: 'Git',              versionFlag: '--version' },
  gh:            { label: 'GitHub CLI (gh)',  versionFlag: '--version' },

  docker:        { label: 'Docker',           versionFlag: '--version' },
  devcontainer:  { label: 'Devcontainer CLI', versionFlag: '--version' },
};

const ALL_TOOLS: ToolName[] = ['claude', 'git', 'gh', 'docker', 'devcontainer'];

// ── findExecutable (inlined copy — avoids circular import from process-manager) ──

async function findExecutable(name: string): Promise<string | null> {
  try {
    if (process.platform === 'win32') {
      const { stdout } = await execFileAsync('where', [name], { encoding: 'utf-8', timeout: 5000 });
      return stdout.trim().split(/\r?\n/)[0].trim();
    }
    const { stdout } = await execFileAsync('which', [name], { encoding: 'utf-8', timeout: 5000 });
    return stdout.trim();
  } catch {
    return null;
  }
}

async function readVersion(bin: string, versionFlag: string): Promise<string> {
  const { stdout } = await execFileAsync(bin, [versionFlag], { encoding: 'utf-8', timeout: 5000 });
  return stdout.trim().split('\n')[0].slice(0, 120);
}

// ── Path resolution ─────────────────────────────────────────────────────────

function toolsConfigPath(): string {
  return join(/* turbopackIgnore: true */ process.cwd(), 'tools.json');
}

// ── Config persistence ──────────────────────────────────────────────────────

export function loadToolsConfig(): ToolsConfig {
  const p = toolsConfigPath();
  try {
    if (!existsSync(p)) return {};
    return JSON.parse(readFileSync(p, 'utf-8'));
  } catch {
    return {};
  }
}

function saveToolsConfig(cfg: ToolsConfig): void {
  try {
    writeFileSync(toolsConfigPath(), JSON.stringify(cfg, null, 2));
  } catch (err) {
    // Never throw (a config write must not break tool detection), but surface
    // it: a silent failure means a custom tool path reverts on the next launch.
    warn('tool-checker', 'Failed to persist tools.json', err);
  }
}

// ── Detection cache ─────────────────────────────────────────────────────────

// Positive results (found=true) are cached for the process lifetime.
// Negative results expire after 60s — a tool like Docker may not be on PATH
// when the server first boots but become available seconds later. Without TTL,
// a single failed check permanently disables the tool for the process lifetime.
const TOOL_CHECK_NEGATIVE_TTL_MS = 60_000;

const _detectionCache = new Map<ToolName, ToolStatus>();
const _detectionTimestamps = new Map<ToolName, number>();

// In-flight detections, so concurrent callers share one set of spawns. Dropping
// an entry (set/clear path, cache reset) also marks that detection stale: it
// only writes the cache while it is still the registered entry for its tool.
const _inFlight = new Map<ToolName, Promise<ToolStatus>>();

export function _resetToolCheckCache(): void {
  _detectionCache.clear();
  _detectionTimestamps.clear();
  _inFlight.clear();
}

// ── Single tool check ───────────────────────────────────────────────────────

async function detectTool(name: ToolName): Promise<ToolStatus> {
  const def = TOOL_DEFAULTS[name];
  const config = loadToolsConfig();
  const customPath: string | null = config[name] ?? null;

  const pathsToTry: string[] = customPath ? [customPath] : [];
  // Always try the default name last
  pathsToTry.push(name);

  let found = false;
  let resolvedPath: string = name;
  let version: string | null = null;
  let error: string | undefined;

  for (const candidate of pathsToTry) {
    // If it looks like a path (contains / or \), check that the file exists
    if (candidate.includes('/') || candidate.includes('\\')) {
      if (!existsSync(candidate)) continue;
      resolvedPath = candidate;
      try {
        version = await readVersion(candidate, def.versionFlag);
        found = true;
        break;
      } catch {
        error = `File exists at ${candidate} but execution failed`;
        continue;
      }
    }

    // Try to resolve via PATH (which/where)
    const resolved = await findExecutable(candidate);
    if (resolved) {
      resolvedPath = resolved;
      try {
        version = await readVersion(resolved, def.versionFlag);
        found = true;
        break;
      } catch {
        // Found by which/where but version check failed — still consider found
        found = true;
        break;
      }
    }
  }

  if (!found && !error) {
    error = customPath
      ? `Not found at configured path: ${customPath}`
      : `"${name}" not found on PATH`;
  }

  return {
    name,
    label: def.label,
    found,
    path: resolvedPath,
    version,
    error,
    customPath: !!customPath,
  };

}

export function checkTool(name: ToolName): Promise<ToolStatus> {
  const cached = _detectionCache.get(name);
  if (cached) {
    if (cached.found) return Promise.resolve(cached);
    // Negative result — check TTL before returning cached failure
    const checkedAt = _detectionTimestamps.get(name) || 0;
    if ((Date.now() - checkedAt) < TOOL_CHECK_NEGATIVE_TTL_MS) return Promise.resolve(cached);
  }

  const existing = _inFlight.get(name);
  if (existing) return existing;

  const self: { promise?: Promise<ToolStatus> } = {};
  const promise = (async () => {
    try {
      const status = await detectTool(name);
      // Only cache while still the registered detection; otherwise the config
      // changed mid-flight and this result is stale (the caller still gets it).
      if (_inFlight.get(name) === self.promise) {
        _detectionCache.set(name, status);
        _detectionTimestamps.set(name, Date.now());
      }
      return status;
    } finally {
      if (_inFlight.get(name) === self.promise) _inFlight.delete(name);
    }
  })();
  self.promise = promise;
  _inFlight.set(name, promise);
  return promise;
}

export function checkAllTools(): Promise<ToolStatus[]> {
  return Promise.all(ALL_TOOLS.map(name => checkTool(name)));
}

// ── Path configuration ──────────────────────────────────────────────────────

export function setToolPath(name: ToolName, binaryPath: string): void {
  const config = loadToolsConfig();
  if (binaryPath === name || binaryPath.trim() === '') {
    delete config[name];
  } else {
    config[name] = binaryPath;
  }
  saveToolsConfig(config);
  _detectionCache.delete(name);
  _inFlight.delete(name);
}

export function getToolPath(name: ToolName): string {
  const config = loadToolsConfig();
  return config[name] || name;
}

export function clearToolPath(name: ToolName): void {
  setToolPath(name, name);
}
