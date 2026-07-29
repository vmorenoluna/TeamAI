/**
 * Prerequisite tool checker — verifies all external CLI tools the app depends on.
 *
 * Each tool can have a custom path configured (persisted to tools.json in the
 * TeamAI app root). The checker tries the custom path first, then falls back
 * to the default binary name on PATH via findExecutable.
 *
 * Caches detection results per process lifetime so repeated lookups are cheap.
 */
import { execFileSync } from 'child_process';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

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

function findExecutable(name: string): string | null {
  try {
    if (process.platform === 'win32') {
      return execFileSync('where', [name], { encoding: 'utf-8', stdio: 'pipe', timeout: 5000 })
        .trim().split(/\r?\n/)[0].trim();
    }
    return execFileSync('which', [name], { encoding: 'utf-8', stdio: 'pipe', timeout: 5000 }).trim();
  } catch {
    return null;
  }
}

// ── Path resolution ─────────────────────────────────────────────────────────

function toolsConfigPath(): string {
  return join(process.cwd(), 'tools.json');
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
  } catch { /* best-effort */ }
}

// ── Detection cache ─────────────────────────────────────────────────────────

// Positive results (found=true) are cached for the process lifetime.
// Negative results expire after 60s — a tool like Docker may not be on PATH
// when the server first boots but become available seconds later. Without TTL,
// a single failed check permanently disables the tool for the process lifetime.
const TOOL_CHECK_NEGATIVE_TTL_MS = 60_000;

const _detectionCache = new Map<ToolName, ToolStatus>();
const _detectionTimestamps = new Map<ToolName, number>();

export function _resetToolCheckCache(): void {
  _detectionCache.clear();
  _detectionTimestamps.clear();
}

// ── Single tool check ───────────────────────────────────────────────────────

export function checkTool(name: ToolName): ToolStatus {
  const cached = _detectionCache.get(name);
  if (cached) {
    if (cached.found) return cached;
    // Negative result — check TTL before returning cached failure
    const checkedAt = _detectionTimestamps.get(name) || 0;
    if ((Date.now() - checkedAt) < TOOL_CHECK_NEGATIVE_TTL_MS) return cached;
  }

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
        version = execFileSync(candidate, [def.versionFlag], {
          encoding: 'utf-8', stdio: 'pipe', timeout: 5000,
        }).trim().split('\n')[0].slice(0, 120);
        found = true;
        break;
      } catch {
        error = `File exists at ${candidate} but execution failed`;
        continue;
      }
    }

    // Try to resolve via PATH (which/where)
    const resolved = findExecutable(candidate);
    if (resolved) {
      resolvedPath = resolved;
      try {
        version = execFileSync(resolved, [def.versionFlag], {
          encoding: 'utf-8', stdio: 'pipe', timeout: 5000,
        }).trim().split('\n')[0].slice(0, 120);
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

  const status: ToolStatus = {
    name,
    label: def.label,
    found,
    path: resolvedPath,
    version,
    error,
    customPath: !!customPath,
  };

  _detectionCache.set(name, status);
  _detectionTimestamps.set(name, Date.now());
  return status;
}

export function checkAllTools(): ToolStatus[] {
  return ALL_TOOLS.map(name => checkTool(name));
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
}

export function getToolPath(name: ToolName): string {
  const config = loadToolsConfig();
  return config[name] || name;
}

export function clearToolPath(name: ToolName): void {
  setToolPath(name, name);
}
