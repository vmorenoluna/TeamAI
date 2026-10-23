/**
 * API-side supervisor of the engine child process: forks it, correlates
 * call/result messages, queues calls until it is ready, and restarts it after a
 * crash (reaping the agents it left behind).
 */
import { fork as nodeFork, spawnSync } from 'child_process';
import type { ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import { existsSync } from 'fs';
import { createRequire } from 'module';
import { basename, dirname, join, resolve } from 'path';
import { pathToFileURL } from 'url';
import { appEvents } from '../lib/app-events';
import { readChildRegistry } from './child-registry';
import {
  EngineTimeoutError,
  EngineUnavailableError,
  deserializeError,
} from './protocol';
import type { ApiToEngineMessage, EngineToApiMessage } from './protocol';

export type EngineStatus = 'starting' | 'ready' | 'restarting' | 'down';

export interface EngineCallOptions {
  timeoutMs?: number;
}

export type ForkFn = (entry: string, args: string[], options: Record<string, unknown>) => ChildProcess;

export interface StartEngineOptions {
  env?: NodeJS.ProcessEnv;
  entry?: string;
  fork?: ForkFn;
}

export interface EngineHost {
  call(method: string, args?: unknown[], opts?: EngineCallOptions): Promise<unknown>;
  notify(method: string, args?: unknown[]): void;
  events: EventEmitter;
  shutdown(): Promise<void>;
  readonly status: EngineStatus;
}

export const ENGINE_READY_TIMEOUT_MS = 60_000;
export const ENGINE_RESTART_DELAY_MS = 1_000;
export const ENGINE_CRASH_WINDOW_MS = 10 * 60_000;
export const ENGINE_MAX_CRASHES = 3;
export const ENGINE_SHUTDOWN_GRACE_MS = 3_000;

const RESTARTED_MESSAGE = 'Pipeline engine restarted — the operation was interrupted; retry it';
const DOWN_MESSAGE = 'Pipeline engine stopped after repeated crashes — restart TeamAI';

interface ForkTarget {
  entry: string;
  execArgv: string[];
}

/** Bundled build: engine.cjs sits beside server.cjs. Dev: engine.ts at the teamai root via tsx. */
export function resolveEngineTarget(entryOverride?: string): ForkTarget {
  if (entryOverride) return { entry: entryOverride, execArgv: [] };
  const main = process.argv[1] ? resolve(process.argv[1]) : '';
  if (basename(main) === 'server.cjs') {
    return { entry: join(dirname(main), 'engine.cjs'), execArgv: [] };
  }
  const req = createRequire(join(process.cwd(), 'package.json'));
  const tsxLoader = pathToFileURL(req.resolve('tsx')).href;
  const root = existsSync(join(process.cwd(), 'engine.ts')) ? process.cwd() : resolve(__dirname, '..', '..');
  return { entry: join(root, 'engine.ts'), execArgv: ['--import', tsxLoader] };
}

interface Pending {
  message: ApiToEngineMessage;
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
  sent: boolean;
}

function killPid(pid: number): void {
  try {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/pid', String(pid), '/t', '/f'], { stdio: 'ignore' });
    } else {
      process.kill(pid, 'SIGKILL');
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ESRCH') {
      console.warn(`[engine] failed to kill orphan pid ${pid}:`, err);
    }
  }
}

export function startEngine(opts: StartEngineOptions = {}): EngineHost {
  const forkFn: ForkFn = opts.fork ?? ((entry, args, options) => nodeFork(entry, args, options));
  const events = new EventEmitter();
  const pending = new Map<number, Pending>();
  const queue: number[] = [];
  const crashTimes: number[] = [];
  let nextId = 1;
  let status: EngineStatus = 'starting';
  let child: ChildProcess | null = null;
  let readyTimer: ReturnType<typeof setTimeout> | undefined;
  let restartTimer: ReturnType<typeof setTimeout> | undefined;
  let shuttingDown = false;

  const setStatus = (s: EngineStatus) => { status = s; };

  function send(message: ApiToEngineMessage): boolean {
    if (!child || !child.connected) return false;
    try {
      child.send(message);
      return true;
    } catch (err) {
      console.warn('[engine] send failed:', err);
      return false;
    }
  }

  function flushQueue(): void {
    while (queue.length > 0) {
      const id = queue.shift()!;
      const p = pending.get(id);
      if (!p || p.sent) continue;
      p.sent = true;
      if (!send(p.message)) {
        pending.delete(id);
        if (p.timer) clearTimeout(p.timer);
        p.reject(new EngineUnavailableError(RESTARTED_MESSAGE));
      }
    }
  }

  function rejectAll(err: () => Error): void {
    const all = [...pending.values()];
    pending.clear();
    queue.length = 0;
    for (const p of all) {
      if (p.timer) clearTimeout(p.timer);
      p.reject(err());
    }
  }

  function spawn(): void {
    const target = resolveEngineTarget(opts.entry);
    const env = { ...process.env, ...opts.env, TEAMAI_PROCESS_ROLE: 'engine' };
    const proc = forkFn(target.entry, [], {
      env,
      execArgv: target.execArgv,
      stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
    });
    child = proc;
    readyTimer = setTimeout(() => {
      console.error(`[engine] no ready message within ${ENGINE_READY_TIMEOUT_MS / 1000}s`);
      handleExit(proc, null, null, true);
      try { proc.kill('SIGKILL'); } catch { /* already gone */ }
    }, ENGINE_READY_TIMEOUT_MS);

    proc.on('message', (raw: unknown) => {
      if (proc !== child) return;
      const msg = raw as EngineToApiMessage;
      if (!msg || typeof msg !== 'object') return;
      if (msg.type === 'ready') {
        if (readyTimer) clearTimeout(readyTimer);
        readyTimer = undefined;
        setStatus('ready');
        flushQueue();
      } else if (msg.type === 'result') {
        const p = pending.get(msg.id);
        if (!p) return; // timed out or interrupted: drop the late result
        pending.delete(msg.id);
        if (p.timer) clearTimeout(p.timer);
        if (msg.ok) p.resolve(msg.value);
        else p.reject(deserializeError(msg.error));
      } else if (msg.type === 'event') {
        appEvents.emit(msg.name, ...msg.args);
        events.emit(msg.name, ...msg.args);
      }
    });
    proc.on('error', (err) => console.error('[engine] process error:', err));
    proc.on('exit', (code, signal) => handleExit(proc, code, signal, false));
  }

  function handleExit(proc: ChildProcess, code: number | null, signal: NodeJS.Signals | null, timedOut: boolean): void {
    if (proc !== child) return; // already handled (ready timeout then exit)
    child = null;
    if (readyTimer) clearTimeout(readyTimer);
    readyTimer = undefined;
    if (shuttingDown) {
      setStatus('down');
      return;
    }
    console.error(`[engine] exited unexpectedly (code=${code}, signal=${signal}${timedOut ? ', ready timeout' : ''})`);
    rejectAll(() => new EngineUnavailableError(RESTARTED_MESSAGE));

    // Reap agents/terminals the dead engine left behind (restart path only).
    for (const entry of readChildRegistry()) killPid(entry.pid);

    const now = Date.now();
    crashTimes.push(now);
    while (crashTimes.length > 0 && now - crashTimes[0] > ENGINE_CRASH_WINDOW_MS) crashTimes.shift();
    if (crashTimes.length >= ENGINE_MAX_CRASHES) {
      console.error('[engine] too many crashes; giving up');
      setStatus('down');
      return;
    }
    setStatus('restarting');
    console.error(`[engine] restarting in ${ENGINE_RESTART_DELAY_MS}ms`);
    restartTimer = setTimeout(() => {
      restartTimer = undefined;
      if (shuttingDown) return;
      setStatus('starting');
      spawn();
    }, ENGINE_RESTART_DELAY_MS);
  }

  function enqueue(message: ApiToEngineMessage & { type: 'call' }, timeoutMs?: number): Promise<unknown> {
    if (status === 'down') return Promise.reject(new EngineUnavailableError(DOWN_MESSAGE));
    return new Promise((resolvePromise, reject) => {
      const p: Pending = { message, resolve: resolvePromise, reject, sent: false };
      if (timeoutMs !== undefined) {
        p.timer = setTimeout(() => {
          pending.delete(message.id);
          reject(new EngineTimeoutError(`Engine call ${message.method} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }
      pending.set(message.id, p);
      if (status === 'ready') {
        p.sent = true;
        if (!send(message)) {
          pending.delete(message.id);
          if (p.timer) clearTimeout(p.timer);
          reject(new EngineUnavailableError(RESTARTED_MESSAGE));
        }
      } else {
        queue.push(message.id);
      }
    });
  }

  spawn();

  return {
    events,
    get status() { return status; },
    call(method, args = [], callOpts = {}) {
      return enqueue({ type: 'call', id: nextId++, method, args }, callOpts.timeoutMs);
    },
    notify(method, args = []) {
      if (status !== 'ready') return; // notifications are fire-and-forget; drop when not running
      send({ type: 'notify', method, args });
    },
    async shutdown() {
      shuttingDown = true;
      if (restartTimer) clearTimeout(restartTimer);
      if (readyTimer) clearTimeout(readyTimer);
      rejectAll(() => new EngineUnavailableError('Pipeline engine is shutting down'));
      const proc = child;
      if (!proc) { setStatus('down'); return; }
      await new Promise<void>((done) => {
        const killTimer = setTimeout(() => {
          try { proc.kill('SIGKILL'); } catch { /* already gone */ }
          done();
        }, ENGINE_SHUTDOWN_GRACE_MS);
        proc.once('exit', () => { clearTimeout(killTimer); done(); });
        if (!send({ type: 'shutdown' })) {
          clearTimeout(killTimer);
          try { proc.kill('SIGKILL'); } catch { /* already gone */ }
          done();
        }
      });
      child = null;
      setStatus('down');
    },
  };
}
