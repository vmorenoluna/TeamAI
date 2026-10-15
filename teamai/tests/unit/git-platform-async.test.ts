/**
 * git-platform.ts must use promise-based execFile so gh/git calls never block
 * the shared Node server event loop. Covers AC1 (no sync subprocess APIs),
 * AC2 (event loop stays free during a real gh call), AC4 (return values and
 * fallbacks), AC5 (createPRViaCLI failure/success handling), AC6 (in-flight
 * resolveBaseBranch dedupe).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync, writeFileSync, mkdtempSync, rmSync, chmodSync, readdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// ── Hoisted mocks ──

const { mockExecFile, realMode } = vi.hoisted(() => ({
  // Node callback form: (cmd, args, opts, cb) with cb(err, stdout, stderr)
  mockExecFile: vi.fn(),
  // When true, delegate to the real execFile (AC2 uses a real stub script)
  realMode: { on: false },
}));

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  const { promisify } = await import('util');
  // Real execFile resolves { stdout, stderr } through util.promisify.custom;
  // a bare vi.fn() has no such hook, so provide the equivalent here.
  const execFile: any = (...args: unknown[]) => mockExecFile(...args);
  execFile[promisify.custom] = (...args: unknown[]) => {
    if (realMode.on) return (promisify(actual.execFile) as any)(...args);
    return new Promise((resolve, reject) => {
      mockExecFile(...args, (err: Error | null, stdout: string, stderr: string) => {
        if (err) reject(err);
        else resolve({ stdout, stderr });
      });
    });
  };
  return { ...actual, execFile };
});

// Per-test tool path overrides. Never persisted through setToolPath: that writes the
// shared <cwd>/tools.json, which other test files read concurrently in the full suite.
const { toolOverrides } = vi.hoisted(() => ({ toolOverrides: new Map<string, string>() }));
vi.mock('../../src/lib/tool-checker', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/tool-checker')>();
  return { ...actual, getToolPath: (name: Parameters<typeof actual.getToolPath>[0]) => toolOverrides.get(name) ?? actual.getToolPath(name) };
});

const { mockWarn } = vi.hoisted(() => ({ mockWarn: vi.fn() }));
vi.mock('../../src/lib/logger', () => ({
  log: vi.fn(), warn: mockWarn, error: vi.fn(),
}));

import {
  detectGitPlatform,
  detectDefaultBranch,
  resolveBaseBranch,
  checkExistingPRViaCLI,
  isPrMerged,
  createPRViaCLI,
} from '../../src/lib/git-platform';

/** Make mockExecFile answer the next call(s) in callback form. */
function ok(stdout: string, delayMs = 0) {
  mockExecFile.mockImplementationOnce((...args: unknown[]) => {
    const cb = args[args.length - 1] as (e: Error | null, o: string, s: string) => void;
    if (delayMs) setTimeout(() => cb(null, stdout, ''), delayMs);
    else cb(null, stdout, '');
  });
}
function fail(err: Error) {
  mockExecFile.mockImplementationOnce((...args: unknown[]) => {
    (args[args.length - 1] as (e: Error) => void)(err);
  });
}

beforeEach(() => {
  mockExecFile.mockReset();
  mockWarn.mockClear();
  realMode.on = false;
});

describe('AC1 — no sync subprocess APIs', () => {
  const read = (f: string) => readFileSync(join(__dirname, '../../src/lib', f), 'utf-8');

  it('git-platform.ts has no execFileSync/execSync/spawnSync and imports execFile', () => {
    const src = read('git-platform.ts');
    expect(src).not.toMatch(/execFileSync|execSync|spawnSync/);
    expect(src).toMatch(/import \{ execFile \} from 'child_process'/);
  });

  it('tool-checker.ts has no execFileSync/execSync/spawnSync and imports execFile', () => {
    const src = read('tool-checker.ts');
    expect(src).not.toMatch(/execFileSync|execSync|spawnSync/);
    expect(src).toMatch(/import \{[^}]*\bexecFile\b[^}]*\} from 'child_process'/);
  });
});

describe('AC2 — gh call does not block the event loop', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'gh-stub-'));
  });
  afterEach(() => {
    toolOverrides.clear();
    rmSync(dir, { recursive: true, force: true });
  });

  it.skipIf(process.platform === 'win32')('timer fires before a 1 s gh call resolves', async () => {
    realMode.on = true;
    const stub = join(dir, 'gh');
    writeFileSync(stub, '#!/bin/sh\nsleep 1\necho https://github.com/o/r/pull/1\n');
    chmodSync(stub, 0o755);
    toolOverrides.set('gh', stub);

    let timerAt = 0;
    setTimeout(() => { timerAt = Date.now(); }, 50);
    const url = await checkExistingPRViaCLI('github', 'b', dir);
    const resolvedAt = Date.now();

    expect(url).toBe('https://github.com/o/r/pull/1');
    expect(timerAt).toBeGreaterThan(0);
    expect(timerAt).toBeLessThan(resolvedAt);
  });
});

describe('AC4 — return values and fallbacks', () => {
  it('detectGitPlatform: github, unknown, and error fallback', async () => {
    ok('https://github.com/o/r.git\n');
    expect(await detectGitPlatform('/p')).toBe('github');
    ok('https://dev.azure.com/o/r\n');
    expect(await detectGitPlatform('/p')).toBe('unknown');
    fail(new Error('not a repo'));
    expect(await detectGitPlatform('/p')).toBe('unknown');
    expect(mockWarn).toHaveBeenCalledWith('orchestrator', 'Failed to detect git remote platform', expect.any(Error));
    expect(mockExecFile.mock.calls[0][2]).toMatchObject({ cwd: '/p', timeout: 5000 });
  });

  it('detectDefaultBranch: last segment, empty → main, error → main + warning', async () => {
    ok('refs/remotes/origin/feature/dev\n');
    expect(await detectDefaultBranch('/p')).toBe('dev');
    ok('');
    expect(await detectDefaultBranch('/p')).toBe('main');
    fail(new Error('no upstream'));
    expect(await detectDefaultBranch('/p')).toBe('main');
    expect(mockWarn).toHaveBeenCalledWith('orchestrator', 'Failed to detect default branch, falling back to main', expect.any(Error));
    expect(mockExecFile.mock.calls[0][2]).toMatchObject({ timeout: 3000 });
  });

  it('checkExistingPRViaCLI: url, empty → null, error → null, unknown → null w/o exec', async () => {
    ok('https://github.com/o/r/pull/7\n');
    expect(await checkExistingPRViaCLI('github', 'b', '/p')).toBe('https://github.com/o/r/pull/7');
    expect(mockExecFile.mock.calls[0][2]).toMatchObject({ timeout: 10_000 });
    ok('\n');
    expect(await checkExistingPRViaCLI('github', 'b', '/p')).toBeNull();
    fail(new Error('gh missing'));
    expect(await checkExistingPRViaCLI('github', 'b', '/p')).toBeNull();
    mockExecFile.mockClear();
    expect(await checkExistingPRViaCLI('unknown', 'b', '/p')).toBeNull();
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it('isPrMerged: MERGED/OPEN, error → null, bad JSON → null, unknown → null w/o exec', async () => {
    ok('{"state":"MERGED"}');
    expect(await isPrMerged('github', 'u', '/p')).toBe(true);
    ok('{"state":"OPEN"}');
    expect(await isPrMerged('github', 'u', '/p')).toBe(false);
    fail(new Error('offline'));
    expect(await isPrMerged('github', 'u', '/p')).toBeNull();
    ok('not json');
    expect(await isPrMerged('github', 'u', '/p')).toBeNull();
    mockExecFile.mockClear();
    expect(await isPrMerged('unknown', 'u', '/p')).toBeNull();
    expect(mockExecFile).not.toHaveBeenCalled();
  });
});

describe('AC5 — createPRViaCLI', () => {
  let specDir: string;
  let logFile: string;
  const bodyFiles = () => readdirSync(specDir).filter((f) => f.startsWith('pr-body-'));

  beforeEach(() => {
    specDir = mkdtempSync(join(tmpdir(), 'pr-spec-'));
    logFile = join(specDir, 'output.log');
  });
  afterEach(() => rmSync(specDir, { recursive: true, force: true }));

  it('success resolves the trimmed URL and deletes the temp body file', async () => {
    ok('refs/remotes/origin/main\n');
    ok('https://github.com/o/r/pull/9\n');
    const url = await createPRViaCLI('github', 'feat/x', 'T', 'body', '/p', logFile);
    expect(url).toBe('https://github.com/o/r/pull/9');
    expect(bodyFiles()).toEqual([]);
    expect(readFileSync(logFile, 'utf-8')).toContain('[PR] Created: https://github.com/o/r/pull/9');
    expect(mockExecFile.mock.calls[1][2]).toMatchObject({ timeout: 30_000 });
  });

  it('failure rejects with the original error, logs stderr, deletes the temp file', async () => {
    ok('refs/remotes/origin/main\n');
    const original = Object.assign(new Error('Command failed: gh pr create'), { stderr: 'ENAMETOOLONG: name too long' });
    fail(original);
    await expect(createPRViaCLI('github', 'feat/x', 'T', 'body', '/p', logFile)).rejects.toBe(original);
    const log = readFileSync(logFile, 'utf-8');
    expect(log).toContain('[PR] Failed to create GitHub PR via gh CLI: Command failed: gh pr create');
    expect(log).toContain('ENAMETOOLONG: name too long');
    expect(bodyFiles()).toEqual([]);
  });
});

describe('AC6 — resolveBaseBranch dedupes in-flight detection', () => {
  it('3 concurrent calls spawn git once; invalidate triggers a second', async () => {
    ok('refs/remotes/origin/trunk\n', 20);
    const results = await Promise.all([
      resolveBaseBranch('/p'),
      resolveBaseBranch('/p'),
      resolveBaseBranch('/p'),
    ]);
    expect(results).toEqual(['trunk', 'trunk', 'trunk']);
    expect(mockExecFile).toHaveBeenCalledTimes(1);

    ok('refs/remotes/origin/develop\n');
    expect(await resolveBaseBranch('/p', true)).toBe('develop');
    expect(mockExecFile).toHaveBeenCalledTimes(2);
  });
});
