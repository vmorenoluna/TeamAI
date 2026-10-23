import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'events';
import { rmSync } from 'fs';

const spawnMock = vi.fn();
vi.mock('child_process', async (orig) => ({ ...(await orig<typeof import('child_process')>()), spawn: (...a: unknown[]) => spawnMock(...a) }));
vi.mock('node-pty', () => ({ spawn: vi.fn() }));
vi.mock('../../src/lib/tool-checker', () => ({ getToolPath: () => 'claude' }));
vi.mock('../../src/lib/container-manager', () => ({
  containerManager: {},
  readContainerConfig: () => ({ enabled: false }),
  readContainerRemoteUser: () => undefined,
  hostToContainerPath: (p: string) => p,
}));

import { ProcessManager } from '../../src/lib/process-manager';
import { getChildRegistryPath, readChildRegistry } from '../../src/engine/child-registry';

function fakeProc(pid: number) {
  const proc = new EventEmitter() as EventEmitter & Record<string, unknown>;
  proc.pid = pid;
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.stdin = { write: vi.fn(), end: vi.fn(), on: vi.fn() };
  proc.exitCode = null;
  proc.killed = false;
  return proc;
}

describe('ProcessManager child registry (AC14 writer side)', () => {
  const savedPort = process.env.PORT;
  beforeEach(() => {
    process.env.PORT = '59123';
    rmSync(getChildRegistryPath(), { force: true });
  });
  afterEach(() => {
    if (savedPort === undefined) delete process.env.PORT;
    else process.env.PORT = savedPort;
    rmSync(getChildRegistryPath(), { force: true });
  });

  it('writes nothing until a session is spawned, lists the agent pid, drops it on close', async () => {
    const pm = new ProcessManager();
    expect(readChildRegistry()).toEqual([]);
    const proc = fakeProc(4242);
    spawnMock.mockReturnValue(proc);
    const id = await pm.createSession({ taskId: 't', role: 'coder', cwd: process.cwd() });
    expect(readChildRegistry()).toEqual([{ pid: 4242, sessionId: id, kind: 'agent' }]);
    proc.emit('exit', 0, null);
    proc.emit('close', 0);
    expect(readChildRegistry()).toEqual([]);
  });
});
