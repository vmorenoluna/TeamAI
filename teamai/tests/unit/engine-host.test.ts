import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { readFileSync, writeFileSync, rmSync } from 'fs';
import type { ChildProcess } from 'child_process';
import { startEngine } from '@/engine/engine-host';
import type { EngineHost } from '@/engine/engine-host';
import { engineCall, engineNotify } from '@/engine/engine-client';
import { getChildRegistryPath } from '@/engine/child-registry';
import { EngineTimeoutError, EngineUnavailableError } from '@/engine/protocol';
import { appEvents } from '@/lib/app-events';

class FakeChild extends EventEmitter {
  connected = true;
  sent: Record<string, unknown>[] = [];
  killed: string[] = [];
  autoExitOnShutdown = true;
  send(msg: Record<string, unknown>) {
    this.sent.push(msg);
    if (msg.type === 'shutdown' && this.autoExitOnShutdown) queueMicrotask(() => this.emit('exit', 0, null));
    return true;
  }
  kill(sig: string) {
    this.killed.push(sig);
    this.emit('exit', null, sig);
    return true;
  }
  ready() { this.emit('message', { type: 'ready' }); }
  crash(code = 1) { this.emit('exit', code, null); }
}

describe('engine host', () => {
  let children: FakeChild[];
  let forkOpts: Record<string, unknown>[];
  let host: EngineHost;
  const fork = (_entry: string, _args: string[], options: Record<string, unknown>) => {
    const c = new FakeChild();
    children.push(c);
    forkOpts.push(options);
    return c as unknown as ChildProcess;
  };
  const start = () => (host = startEngine({ entry: '/fake/engine.js', fork }));

  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    process.env.PORT = 'engine-host-test';
    children = [];
    forkOpts = [];
  });

  afterEach(async () => {
    rmSync(getChildRegistryPath(), { force: true });
    globalThis.__teamaiEngine = undefined;
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('forks with ipc stdio and the engine role', () => {
    start();
    expect(forkOpts[0].stdio).toEqual(['inherit', 'inherit', 'inherit', 'ipc']);
    expect((forkOpts[0].env as NodeJS.ProcessEnv).TEAMAI_PROCESS_ROLE).toBe('engine');
    expect(host.status).toBe('starting');
  });

  it('AC10: queues calls before ready and sends them in order afterwards', async () => {
    start();
    const a = host.call('a', [1]);
    const b = host.call('b', [2]);
    expect(children[0].sent).toEqual([]);
    children[0].ready();
    expect(host.status).toBe('ready');
    expect(children[0].sent.map((m) => m.method)).toEqual(['a', 'b']);
    const [m1, m2] = children[0].sent;
    children[0].emit('message', { type: 'result', id: m2.id, ok: true, value: 'B' });
    children[0].emit('message', { type: 'result', id: m1.id, ok: true, value: 'A' });
    await expect(a).resolves.toBe('A');
    await expect(b).resolves.toBe('B');
  });

  it('rejects a call with the deserialized remote error', async () => {
    start();
    children[0].ready();
    const p = host.call('x');
    children[0].emit('message', { type: 'result', id: children[0].sent[0].id, ok: false, error: { name: 'Boom', message: 'bad', code: 'E1' } });
    await expect(p).rejects.toMatchObject({ name: 'Boom', message: 'bad', code: 'E1' });
  });

  it('timeoutMs rejects with EngineTimeoutError and drops the late result', async () => {
    start();
    children[0].ready();
    const p = host.call('slow', [], { timeoutMs: 500 });
    const assertion = expect(p).rejects.toBeInstanceOf(EngineTimeoutError);
    await vi.advanceTimersByTimeAsync(500);
    await assertion;
    expect(() => children[0].emit('message', { type: 'result', id: children[0].sent[0].id, ok: true, value: 1 })).not.toThrow();
  });

  it('has no default timeout', async () => {
    start();
    children[0].ready();
    let settled = false;
    host.call('slow').then(() => { settled = true; }, () => { settled = true; });
    await vi.advanceTimersByTimeAsync(24 * 3600_000);
    expect(settled).toBe(false);
  });

  it('re-emits engine events on appEvents and host.events', () => {
    start();
    const onApp = vi.fn();
    const onHost = vi.fn();
    appEvents.on('engine-host-test-evt', onApp);
    host.events.on('engine-host-test-evt', onHost);
    children[0].emit('message', { type: 'event', name: 'engine-host-test-evt', args: [{ a: 1 }, 'x'] });
    expect(onApp).toHaveBeenCalledWith({ a: 1 }, 'x');
    expect(onHost).toHaveBeenCalledWith({ a: 1 }, 'x');
    appEvents.off('engine-host-test-evt', onApp);
  });

  it('AC11: crash rejects pending, kills registry pids, re-forks after 1s', async () => {
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    start();
    children[0].ready();
    writeFileSync(getChildRegistryPath(), JSON.stringify([{ pid: 424242, sessionId: 's', kind: 'agent' }]));
    const p = host.call('x');
    const assertion = expect(p).rejects.toThrow('Pipeline engine restarted — the operation was interrupted; retry it');
    children[0].crash();
    await assertion;
    await expect(p).rejects.toBeInstanceOf(EngineUnavailableError);
    if (process.platform !== 'win32') expect(kill).toHaveBeenCalledWith(424242, 'SIGKILL');
    expect(host.status).toBe('restarting');
    expect(children).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(children).toHaveLength(2);
    expect(host.status).toBe('starting');
    children[1].ready();
    expect(host.status).toBe('ready');
  });

  it('ignores ESRCH when killing registry pids', () => {
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('gone'), { code: 'ESRCH' });
    });
    start();
    writeFileSync(getChildRegistryPath(), JSON.stringify([{ pid: 1, sessionId: 's', kind: 'agent' }]));
    expect(() => children[0].crash()).not.toThrow();
  });

  it('does not touch the registry at cold start', () => {
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    writeFileSync(getChildRegistryPath(), JSON.stringify([{ pid: 424242, sessionId: 's', kind: 'agent' }]));
    start();
    children[0].ready();
    expect(kill).not.toHaveBeenCalled();
    expect(readFileSync(getChildRegistryPath(), 'utf-8')).toContain('424242');
  });

  it('AC11: no ready within 60s counts as an unexpected exit', async () => {
    start();
    const p = host.call('x');
    const assertion = expect(p).rejects.toBeInstanceOf(EngineUnavailableError);
    await vi.advanceTimersByTimeAsync(60_000);
    await assertion;
    expect(children[0].killed).toContain('SIGKILL');
    expect(host.status).toBe('restarting');
    await vi.advanceTimersByTimeAsync(1000);
    expect(children).toHaveLength(2);
  });

  it('AC11: 3 crashes in 10 minutes -> down, calls reject immediately', async () => {
    vi.spyOn(process, 'kill').mockImplementation(() => true);
    start();
    children[0].crash();
    await vi.advanceTimersByTimeAsync(1000);
    children[1].crash();
    await vi.advanceTimersByTimeAsync(1000);
    expect(children).toHaveLength(3);
    children[2].crash();
    expect(host.status).toBe('down');
    await vi.advanceTimersByTimeAsync(5000);
    expect(children).toHaveLength(3);
    await expect(host.call('x')).rejects.toThrow('Pipeline engine stopped after repeated crashes — restart TeamAI');
  });

  it('crashes older than 10 minutes do not count towards giving up', async () => {
    vi.spyOn(process, 'kill').mockImplementation(() => true);
    start();
    children[0].crash();
    await vi.advanceTimersByTimeAsync(1000);
    children[1].crash();
    await vi.advanceTimersByTimeAsync(1000);
    children[2].ready();
    await vi.advanceTimersByTimeAsync(10 * 60_000 + 1000);
    children[2].crash();
    expect(host.status).toBe('restarting');
  });

  it('AC13: shutdown sends {type:shutdown} and waits for exit without SIGKILL', async () => {
    start();
    children[0].ready();
    await host.shutdown();
    expect(children[0].sent).toContainEqual({ type: 'shutdown' });
    expect(children[0].killed).toEqual([]);
    expect(host.status).toBe('down');
    await vi.advanceTimersByTimeAsync(5000);
    expect(children).toHaveLength(1);
  });

  it('AC13: shutdown SIGKILLs the engine after 3s if it will not exit', async () => {
    start();
    children[0].ready();
    children[0].autoExitOnShutdown = false;
    const done = host.shutdown();
    await vi.advanceTimersByTimeAsync(2999);
    expect(children[0].killed).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    await done;
    expect(children[0].killed).toEqual(['SIGKILL']);
  });

  it('shutdown does not signal registered agents', async () => {
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    writeFileSync(getChildRegistryPath(), JSON.stringify([{ pid: 424242, sessionId: 's', kind: 'agent' }]));
    start();
    children[0].ready();
    await host.shutdown();
    expect(kill).not.toHaveBeenCalled();
  });

  describe('engine-client', () => {
    it('throws EngineUnavailableError when no engine is running', async () => {
      globalThis.__teamaiEngine = undefined;
      await expect(engineCall('x')).rejects.toThrow('Pipeline engine is not running');
      expect(() => engineNotify('x')).toThrow(EngineUnavailableError);
    });

    it('delegates to globalThis.__teamaiEngine', async () => {
      const call = vi.fn().mockResolvedValue(7);
      const notify = vi.fn();
      globalThis.__teamaiEngine = { call, notify };
      await expect(engineCall<number>('m', [1], { timeoutMs: 5 })).resolves.toBe(7);
      expect(call).toHaveBeenCalledWith('m', [1], { timeoutMs: 5 });
      engineNotify('n', [2]);
      expect(notify).toHaveBeenCalledWith('n', [2]);
    });

    it('R5: imports only the protocol and types', () => {
      const src = readFileSync(require.resolve('../../src/engine/engine-client.ts'), 'utf-8');
      const imports = [...src.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]);
      expect(imports).toEqual(['./protocol']);
    });
  });
});
