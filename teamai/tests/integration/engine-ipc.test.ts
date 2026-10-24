/**
 * Integration tests for the engine IPC boundary with a REAL forked engine
 * (engine.ts run through tsx), a private config dir and a stub `claude` binary.
 *
 * Covers: protocol round trip + error rehydration (AC2), Retry crossing the
 * boundary and resuming at the failed phase (AC3), a rejected background
 * operation reaching the UI as ok:false (AC5), orphan prevention when the IPC
 * channel closes (AC12) and the child registry (AC14).
 *
 * Nothing here polls: every wait is an event listener (or fs.watch) with a timeout.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { fork as nodeFork, execFileSync, spawnSync } from 'child_process';
import type { ChildProcess } from 'child_process';
import type { EventEmitter } from 'events';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, watch, writeFileSync } from 'fs';
import { createRequire } from 'module';
import { tmpdir } from 'os';
import { delimiter, join, resolve } from 'path';
import { pathToFileURL } from 'url';
import { appEvents } from '@/lib/app-events';
import { TaskStore } from '@/lib/task-store';
import { buildActionResultMessage } from '@/lib/action-result-message';
import { startEngine } from '@/engine/engine-host';
import type { EngineHost, ForkFn } from '@/engine/engine-host';
import { engineCall } from '@/engine/engine-client';
import { EngineRemoteError, ENGINE_METHOD_NOT_FOUND } from '@/engine/protocol';
import type { ChildEntry } from '@/engine/child-registry';

const TEAMAI_ROOT = resolve(__dirname, '..', '..');
const ENGINE_ENTRY = join(TEAMAI_ROOT, 'engine.ts');
const TSX_LOADER = pathToFileURL(createRequire(join(TEAMAI_ROOT, 'package.json')).resolve('tsx')).href;
const WAIT_MS = 30_000;

let tempDirs: string[] = [];
let enginePids: number[] = [];
let host: EngineHost | null = null;

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

/** A `claude` stub on PATH: exits 1 at once, or (hold) stays alive until killed. */
function makeStubDir(hold: boolean): string {
  const dir = makeTempDir('teamai-ipc-stub-');
  if (process.platform === 'win32') {
    writeFileSync(join(dir, 'claude.cmd'), hold ? '@echo off\r\nping -n 120 127.0.0.1 >nul\r\n' : '@echo off\r\nexit /b 1\r\n');
  } else {
    const stub = join(dir, 'claude');
    writeFileSync(stub, hold ? '#!/bin/sh\nexec sleep 120\n' : '#!/bin/sh\nexit 1\n');
    chmodSync(stub, 0o755);
  }
  return dir;
}

function uniquePort(): string {
  return String(41000 + Math.floor(Math.random() * 20000));
}

function registryPath(port: string): string {
  return join(tmpdir(), `teamai-engine-${port}-children.json`);
}

function readRegistry(port: string): ChildEntry[] {
  try {
    return JSON.parse(readFileSync(registryPath(port), 'utf-8')) as ChildEntry[];
  } catch {
    return [];
  }
}

function killPid(pid: number): void {
  try {
    if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(pid), '/t', '/f'], { stdio: 'ignore' });
    else process.kill(pid, 'SIGKILL');
  } catch { /* already gone */ }
}

interface EngineEnv {
  env: Record<string, string>;
  port: string;
  configDir: string;
}

function makeEngineEnv(hold = false): EngineEnv {
  const configDir = makeTempDir('teamai-ipc-config-');
  const port = uniquePort();
  const env: Record<string, string> = {
    TEAMAI_CONFIG_DIR: configDir,
    PORT: port,
    PATH: `${makeStubDir(hold)}${delimiter}${process.env.PATH ?? ''}`,
  };
  return { env, port, configDir };
}

/** Forks the engine through tsx from the teamai root; records the PID for cleanup. */
const forkViaTsx: ForkFn = (entry, args, options) => {
  const proc = nodeFork(entry, args, {
    ...options,
    cwd: TEAMAI_ROOT,
    execArgv: ['--import', TSX_LOADER],
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
  if (proc.pid !== undefined) enginePids.push(proc.pid);
  return proc;
};

function launchEngine(engineEnv: EngineEnv): EngineHost {
  host = startEngine({ entry: ENGINE_ENTRY, env: engineEnv.env as NodeJS.ProcessEnv, fork: forkViaTsx });
  globalThis.__teamaiEngine = host;
  return host;
}

function waitForEvent<T>(
  emitter: EventEmitter,
  name: string,
  predicate: (payload: T) => boolean,
  onMatch?: (payload: T) => void,
  timeoutMs = WAIT_MS,
): Promise<T> {
  return new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => {
      emitter.off(name, listener);
      reject(new Error(`Timed out waiting for "${name}" event`));
    }, timeoutMs);
    const listener = (payload: T) => {
      if (!predicate(payload)) return;
      clearTimeout(timer);
      emitter.off(name, listener);
      onMatch?.(payload);
      resolvePromise(payload);
    };
    emitter.on(name, listener);
  });
}

/** Resolves once the registry file satisfies `predicate`; re-checks on directory change events. */
function waitForRegistry(port: string, predicate: (entries: ChildEntry[]) => boolean, timeoutMs = WAIT_MS): Promise<ChildEntry[]> {
  return new Promise((resolvePromise, reject) => {
    const check = (): boolean => {
      const entries = readRegistry(port);
      if (!predicate(entries)) return false;
      cleanup();
      resolvePromise(entries);
      return true;
    };
    const watcher = watch(tmpdir(), () => { check(); });
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for child registry state (last: ${JSON.stringify(readRegistry(port))})`));
    }, timeoutMs);
    function cleanup() {
      clearTimeout(timer);
      watcher.close();
    }
    check();
  });
}

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', ['-c', 'user.email=test@example.com', '-c', 'user.name=Test', ...args], { cwd, stdio: 'ignore' });
}

/** Temp git repo registered through the project store of the temp config dir. */
async function createRegisteredProject(configDir: string): Promise<string> {
  const root = makeTempDir('teamai-ipc-project-');
  git(root, 'init', '-b', 'main');
  writeFileSync(join(root, 'README.md'), '# test\n');

  const previous = process.env.TEAMAI_CONFIG_DIR;
  process.env.TEAMAI_CONFIG_DIR = configDir;
  try {
    vi.resetModules(); // project-store caches the config dir at first use
    const { ProjectStore } = await import('@/lib/project-store');
    new ProjectStore().add(root, 'ipc-test');
  } finally {
    if (previous === undefined) delete process.env.TEAMAI_CONFIG_DIR;
    else process.env.TEAMAI_CONFIG_DIR = previous;
  }

  git(root, 'add', '-A');
  git(root, 'commit', '-m', 'init');
  return root;
}

beforeEach(() => {
  tempDirs = [];
  enginePids = [];
  host = null;
});

afterEach(async () => {
  delete globalThis.__teamaiEngine;
  if (host) {
    try { await host.shutdown(); } catch { /* best effort */ }
  }
  for (const pid of enginePids) killPid(pid);
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

describe('engine IPC (real forked engine)', () => {
  it('AC2: round-trips calls, rehydrates remote errors and rejects unknown methods', async () => {
    const engineEnv = makeEngineEnv();
    const projectPath = await createRegisteredProject(engineEnv.configDir);
    launchEngine(engineEnv);

    // Successful call: tasks.createTask returns { id }, JSON round-trips intact
    const created = await engineCall<{ id: string }>('tasks.createTask', [
      { projectPath, title: 'IPC round trip', description: 'd' },
    ]);
    expect(typeof created.id).toBe('string');
    expect(await new TaskStore(projectPath).getByIdAsync(created.id)).toMatchObject({ title: 'IPC round trip' });

    // Remote TaskNotFoundError arrives as an EngineRemoteError with the same name/message
    const err = await engineCall('tasks.rejectTask', [
      { projectPath, taskId: 'missing-task', feedback: 'x', target: 'coder' },
    ]).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EngineRemoteError);
    expect((err as Error).name).toBe('TaskNotFoundError');
    expect((err as Error).message).toBe('Task missing-task not found');
    expect((err as EngineRemoteError).code).toBe('TASK_NOT_FOUND');

    // Unknown method
    const unknown = await engineCall('no.suchMethod', []).catch((e: unknown) => e);
    expect(unknown).toBeInstanceOf(EngineRemoteError);
    expect((unknown as Error).name).toBe(ENGINE_METHOD_NOT_FOUND);
  }, 60_000);

  it('AC3: Retry crosses the IPC boundary and resumes the failed task at its failed phase', async () => {
    const engineEnv = makeEngineEnv();
    const projectPath = await createRegisteredProject(engineEnv.configDir);
    const store = new TaskStore(projectPath);
    const id = 'retry-task-1';
    store.create(id, 'Retry me', 'desc');
    store.updatePhase(id, 'spec');
    store.updatePhase(id, 'plan');
    store.updatePhase(id, 'failed');
    writeFileSync(join(store.getDirById(id), 'spec.md'), '# Spec\n');

    launchEngine(engineEnv);

    let phaseOnArrival: string | undefined;
    const phaseChange = waitForEvent<{ taskId: string; phase: string }>(
      appEvents,
      'phase-change',
      (p) => p.taskId === id && p.phase === 'plan',
      () => { phaseOnArrival = store.getById(id)?.phase; },
    );

    const result = await engineCall<{ success: boolean; operationId?: string }>('tasks.retryTask', [{ projectPath, taskId: id }]);
    expect(result.success).toBe(true);
    expect(typeof result.operationId).toBe('string');

    await phaseChange;
    expect(phaseOnArrival).toBe('plan');
  }, 60_000);

  it('AC5: a rejected background operation in the engine reaches the UI as ok:false', async () => {
    const engineEnv = makeEngineEnv();
    const projectPath = await createRegisteredProject(engineEnv.configDir);
    launchEngine(engineEnv);

    const taskId = 'nonexistent-task';
    const actionResult = waitForEvent<{ operationId: string; ok: boolean; error?: string; action: string; taskId: string }>(
      appEvents,
      'action-result',
      (r) => r.operationId === 'op-1',
    );

    const moved = await engineCall<{ operationId: string }>('tasks.moveTask', [
      { projectPath, taskId, targetPhase: 'plan', operationId: 'op-1' },
    ]);
    expect(moved).toEqual({ operationId: 'op-1' });

    const result = await actionResult;
    expect(result.ok).toBe(false);
    expect(result.error).toContain(taskId);

    expect(JSON.parse(buildActionResultMessage(result))).toEqual({
      type: 'action-result',
      operationId: 'op-1',
      action: 'move',
      taskId,
      ok: false,
      error: result.error,
    });

    // The registry lives in the engine: query it across the boundary
    const stored = await engineCall<{ status: string; error?: string }>('background.getResult', [{ operationId: 'op-1' }]);
    expect(stored).toEqual({ status: 'failed', error: result.error });
  }, 60_000);

  it('AC12: the engine exits within 5 s when its IPC channel is disconnected', async () => {
    const engineEnv = makeEngineEnv();
    const proc: ChildProcess = nodeFork(ENGINE_ENTRY, [], {
      cwd: TEAMAI_ROOT,
      env: { ...process.env, ...engineEnv.env, TEAMAI_PROCESS_ROLE: 'engine' },
      execArgv: ['--import', TSX_LOADER],
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    if (proc.pid !== undefined) enginePids.push(proc.pid);

    await new Promise<void>((ready, reject) => {
      const timer = setTimeout(() => reject(new Error('engine never sent ready')), WAIT_MS);
      proc.on('message', (m: { type?: string }) => {
        if (m?.type === 'ready') { clearTimeout(timer); ready(); }
      });
      proc.once('exit', () => { clearTimeout(timer); reject(new Error('engine exited before ready')); });
    });

    const exited = new Promise<void>((done, reject) => {
      const timer = setTimeout(() => reject(new Error('engine still alive 5 s after disconnect')), 5_000);
      proc.once('exit', () => { clearTimeout(timer); done(); });
    });
    proc.disconnect();
    await exited;
  }, 60_000);

  it('AC14: the child registry lists agent and terminal PIDs and drops them after exit', async () => {
    const engineEnv = makeEngineEnv(true);
    const projectPath = await createRegisteredProject(engineEnv.configDir);
    launchEngine(engineEnv);

    const agentId = await engineCall<string>('sessions.create', [
      { projectPath, taskId: 'ipc-agent', role: 'general', cwd: projectPath },
    ]);
    const terminalId = await engineCall<string>('terminals.create', [
      { projectPath, role: 'coder', model: 'sonnet' },
    ]);

    const listed = await waitForRegistry(
      engineEnv.port,
      (entries) => entries.some(e => e.sessionId === agentId) && entries.some(e => e.sessionId === terminalId),
    );
    const agent = listed.find(e => e.sessionId === agentId)!;
    const terminal = listed.find(e => e.sessionId === terminalId)!;
    expect(agent.kind).toBe('agent');
    expect(terminal.kind).toBe('terminal');
    expect(agent.pid).toBeGreaterThan(0);
    expect(terminal.pid).toBeGreaterThan(0);
    expect(existsSync(registryPath(engineEnv.port))).toBe(true);

    await engineCall('sessions.kill', [{ sessionId: agentId }]);
    await engineCall('terminals.close', [{ sessionId: terminalId }]);

    const remaining = await waitForRegistry(
      engineEnv.port,
      (entries) => !entries.some(e => e.sessionId === agentId || e.sessionId === terminalId),
    );
    expect(remaining).toEqual([]);
  }, 60_000);
});
