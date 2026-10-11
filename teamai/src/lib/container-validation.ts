/**
 * Container validation: the pieces that decide whether a project's devcontainer
 * is actually usable, kept apart from ContainerManager's lifecycle code.
 *
 * A container that starts is not necessarily a container that works — e.g. a
 * bind-mounted workspace whose node_modules was installed on a Windows host has
 * no Linux native binaries, so every build or test inside it crashes. The
 * result of validating is persisted per project, keyed by a fingerprint of
 * everything that could change the answer, and ContainerManager refuses to hand
 * out a container whose current fingerprint has not passed.
 */
import { createHash } from 'crypto';
import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync, statSync } from 'fs';
import path from 'path';
import { OrchestratorError } from './orchestrator/errors';

// ── Errors ────────────────────────────────────────────────────────────────

/** Thrown when a container is up but failed validation. Blocks the pipeline. */
export class ContainerValidationError extends OrchestratorError {
  constructor(message: string, readonly step?: string) {
    super(message, 'CONTAINER_INVALID');
    this.name = 'ContainerValidationError';
  }
}

// ── Project directory discovery ───────────────────────────────────────────

const PROJECT_MARKERS = [
  'package.json', 'pyproject.toml', 'requirements.txt', 'setup.py', 'go.mod',
  'Cargo.toml', 'pom.xml', 'build.gradle', 'build.gradle.kts', 'build.sbt',
];

const SKIPPED_DIRS = new Set(['node_modules', 'dist', 'build', 'target', 'vendor', 'docs', 'demo', 'test-results']);

function hasMarker(dir: string): boolean {
  try {
    const entries = new Set(readdirSync(dir));
    return PROJECT_MARKERS.some(m => entries.has(m));
  } catch {
    return false;
  }
}

/**
 * Where the buildable project actually lives, relative to the repo root with
 * forward slashes ('' = the root itself). Many repos keep their source in a
 * subdirectory (this one uses `teamai/`), and analysing only the root would
 * see "no project" and validate nothing. Looks at the root first, then at most
 * two directory levels down, preferring shallower and alphabetically earlier.
 */
export function findProjectDir(projectRoot: string): string {
  if (hasMarker(projectRoot)) return '';
  const candidates: string[] = [];
  const walk = (rel: string, depth: number) => {
    let entries;
    try { entries = readdirSync(path.join(projectRoot, rel), { withFileTypes: true }); } catch { return; }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!e.isDirectory() || e.name.startsWith('.') || SKIPPED_DIRS.has(e.name)) continue;
      const child = rel ? `${rel}/${e.name}` : e.name;
      if (hasMarker(path.join(projectRoot, child))) candidates.push(child);
      else if (depth < 2) walk(child, depth + 1);
    }
  };
  try {
    walk('', 1);
  } catch {
    return ''; // any filesystem oddity means "no subproject", never a crash
  }
  return candidates[0] ?? '';
}

// ── Native-module check ───────────────────────────────────────────────────

/**
 * Node script run inside the container, in the project directory. Fails when
 * node_modules holds platform-specific native packages (rollup, esbuild, swc,
 * ...) for some other OS/CPU and none for this one — the signature of a
 * node_modules installed on the host and shared into the container.
 * A healthy tree always has a matching variant, so this has no false alarm on
 * packages that simply ship no binary for a platform.
 */
export const NATIVE_MODULES_CHECK_SCRIPT = String.raw`
const fs = require('fs'), path = require('path');
const nm = path.join(process.cwd(), 'node_modules');
if (!fs.existsSync(nm)) process.exit(0);
const names = [];
for (const e of fs.readdirSync(nm)) {
  if (e.startsWith('.')) continue;
  if (e.startsWith('@')) { for (const s of fs.readdirSync(path.join(nm, e))) names.push(e + '/' + s); }
  else names.push(e);
}
const re = /^(.*?)[-\/]?(win32|darwin|linux|freebsd|openbsd|android|sunos|aix)-(x64|arm64|ia32|arm|ppc64|s390x|riscv64|loong64)(?:-[a-z0-9]+)*$/;
const groups = {};
for (const n of names) {
  const m = n.match(re);
  if (!m) continue;
  (groups[m[1]] = groups[m[1]] || []).push({ os: m[2], arch: m[3] });
}
const bad = Object.keys(groups).filter(g => !groups[g].some(v => v.os === process.platform && v.arch === process.arch));
if (bad.length) {
  const found = [...new Set(bad.flatMap(g => groups[g].map(v => v.os + '-' + v.arch)))].join(', ');
  console.error('node_modules has native packages only for other platforms (' + found + '), none for ' + process.platform + '-' + process.arch + ': ' + bad.slice(0, 5).join(', ') + (bad.length > 5 ? ', ...' : '') + '. It was most likely installed on the host and shared into the container; give the container its own node_modules (a named volume) and install into it.');
  process.exit(1);
}
`;

/** Shell command that runs the native-module check without any quoting hazards. */
export function nativeModulesCheckCommand(): string {
  const b64 = Buffer.from(NATIVE_MODULES_CHECK_SCRIPT, 'utf-8').toString('base64');
  return `echo ${b64} | base64 -d | node`;
}

// ── Persisted result ──────────────────────────────────────────────────────

export interface ValidationRecord {
  status: 'passed' | 'failed';
  /** What the result was computed for — see computeFingerprint. */
  fingerprint: string;
  validatedAt: string;
  /** Name of the first failing step, when status is 'failed'. */
  failedStep?: string;
  /** Tail of the failing step's output, when status is 'failed'. */
  error?: string;
}

function recordPath(projectRoot: string): string {
  return path.join(projectRoot, '.teamai', 'container-validation.json');
}

export function readValidationRecord(projectRoot: string): ValidationRecord | null {
  try {
    const parsed = JSON.parse(readFileSync(recordPath(projectRoot), 'utf-8'));
    if (parsed && (parsed.status === 'passed' || parsed.status === 'failed') && typeof parsed.fingerprint === 'string') {
      return parsed as ValidationRecord;
    }
  } catch { /* absent or unreadable — treated as never validated */ }
  return null;
}

export function writeValidationRecord(projectRoot: string, record: ValidationRecord): void {
  try {
    mkdirSync(path.join(projectRoot, '.teamai'), { recursive: true });
    writeFileSync(recordPath(projectRoot), JSON.stringify(record, null, 2));
  } catch { /* best-effort — the in-memory result still gates this process */ }
}

/**
 * True when the last validation failed and nothing that could change the
 * answer has been touched since — cheap enough for a 5s tick, no Docker call.
 * Editing the devcontainer definition after the failure lifts the block so the
 * next task start re-validates against the fix.
 */
export function isContainerBlocked(projectRoot: string): boolean {
  const saved = readValidationRecord(projectRoot);
  if (saved?.status !== 'failed') return false;
  try {
    const devcontainer = path.join(projectRoot, '.devcontainer', 'devcontainer.json');
    if (statSync(devcontainer).mtimeMs > Date.parse(saved.validatedAt)) return false;
  } catch { /* no devcontainer file — stays blocked */ }
  return true;
}

const LOCKFILES = [
  'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lock', 'poetry.lock',
  'Pipfile.lock', 'go.sum', 'Cargo.lock', 'gradle.lockfile',
];

/**
 * Everything that can change whether the container works: the devcontainer
 * definition, the dependency lockfiles, the validation commands themselves,
 * and the identity of the container (a rebuilt container is a new container).
 */
export function computeFingerprint(
  projectRoot: string,
  projectDir: string,
  containerId: string,
  commands: string[],
): string {
  const hash = createHash('sha256');
  const feed = (label: string, data: string | Buffer) => { hash.update(label); hash.update('\0'); hash.update(data); hash.update('\0'); };

  const devcontainer = path.join(projectRoot, '.devcontainer', 'devcontainer.json');
  feed('devcontainer', existsSync(devcontainer) ? readFileSync(devcontainer) : '');
  for (const lock of LOCKFILES) {
    const file = path.join(projectRoot, projectDir, lock);
    if (existsSync(file)) feed(lock, readFileSync(file));
  }
  feed('container', containerId);
  feed('commands', JSON.stringify(commands));
  return hash.digest('hex');
}

/** A failure message for the pipeline: what failed, why, and how to get unblocked. */
export function describeFailure(record: Pick<ValidationRecord, 'failedStep' | 'error'>): string {
  const detail = (record.error ?? '').trim().split('\n').slice(-12).join('\n');
  return (
    `The project's container failed validation at step "${record.failedStep ?? 'unknown'}"` +
    (detail ? `:\n${detail}\n` : '. ') +
    `Fix .devcontainer/devcontainer.json (or the project setup) and retry — validation re-runs ` +
    `automatically when the devcontainer definition or a lockfile changes, or on demand with ` +
    `"Re-validate" in Settings → Container.`
  );
}
