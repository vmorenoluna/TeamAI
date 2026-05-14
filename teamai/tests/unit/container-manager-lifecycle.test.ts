/**
 * Tests for ContainerManager advanced lifecycle methods.
 * Covers: devcontainerBin (indirectly), _doStart, _spawnDevcontainerUp,
 * _watchEvents, _onContainerDied, and the global singleton.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';

// ── Hoisted mocks ──

const { mockSpawn, mockExecFileSync } = vi.hoisted(() => ({
  mockSpawn: vi.fn(),
  mockExecFileSync: vi.fn(),
}));

const { mockExistsSync, mockReadFileSync } = vi.hoisted(() => ({
  mockExistsSync: vi.fn(),
  mockReadFileSync: vi.fn(),
}));

const { mockLogError, mockLogWarn } = vi.hoisted(() => ({
  mockLogError: vi.fn(),
  mockLogWarn: vi.fn(),
}));

vi.mock('child_process', () => ({
  spawn: mockSpawn,
  execFileSync: mockExecFileSync,
  ChildProcess: class MockChildProcess {},
}));

vi.mock('fs', () => ({
  existsSync: mockExistsSync,
  readFileSync: mockReadFileSync,
}));

vi.mock('../../src/lib/logger', () => ({
  error: mockLogError,
  warn: mockLogWarn,
}));

// ── Imports ──

import { ContainerManager, _resetDockerAvailableCache, containerManager } from '../../src/lib/container-manager';

// ── Helpers ──

function createMockSpawnProcess() {
  const proc = new EventEmitter() as any;
  proc.stdout = new EventEmitter() as any;
  proc.stderr = new EventEmitter() as any;
  proc.pid = 99999;
  proc.kill = vi.fn();
  return proc;
}

// ── Tests ──

describe('ContainerManager lifecycle — ensureContainer with new container start', () => {
  let cm: ContainerManager;

  // Spy on console.log to suppress lifecycle output
  beforeEach(() => {
    vi.clearAllMocks();
    _resetDockerAvailableCache();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    cm = new ContainerManager();
    (cm as any).records.clear();
  });

  describe('_spawnDevcontainerUp (via ensureContainer)', () => {
    it('resolves when devcontainer up succeeds with valid NDJSON output', async () => {
      mockExecFileSync.mockReturnValue(''); // dockerAvailable = true
      const mockProc = createMockSpawnProcess();
      mockSpawn.mockReturnValue(mockProc);

      // Start ensureContainer (async) — it will await _doStart → _spawnDevcontainerUp
      const promise = cm.ensureContainer('/test/project');

      // Simulate NDJSON output from devcontainer up
      const ndJsonLine = JSON.stringify({
        outcome: 'success',
        containerId: 'devcontainer-abc-123',
        remoteWorkspaceFolder: '/workspaces/project',
      });
      mockProc.stdout.emit('data', Buffer.from(ndJsonLine + '\n'));
      mockProc.emit('exit', 0);

      const result = await promise;
      expect(result).toEqual({
        containerId: 'devcontainer-abc-123',
        remoteWorkspaceFolder: '/workspaces/project',
      });

      // Check spawn was called with devcontainer binary and up args
      expect(mockSpawn).toHaveBeenCalledWith(
        expect.stringMatching(/devcontainer/),
        expect.arrayContaining(['up', '--workspace-folder', '/test/project', '--log-format', 'json']),
        expect.any(Object),
      );
    });

    it('rejects when devcontainer process errors (e.g., binary not found)', async () => {
      mockExecFileSync.mockReturnValue('');
      const mockProc = createMockSpawnProcess();
      mockSpawn.mockReturnValue(mockProc);

      const promise = cm.ensureContainer('/test/project');

      mockProc.emit('error', new Error('ENOENT'));

      await expect(promise).rejects.toThrow('devcontainer not found');
    });

    it('rejects when devcontainer exits with non-zero code', async () => {
      mockExecFileSync.mockReturnValue('');
      const mockProc = createMockSpawnProcess();
      mockSpawn.mockReturnValue(mockProc);

      const promise = cm.ensureContainer('/test/project');

      mockProc.stderr.emit('data', Buffer.from('Something went wrong\n'));
      mockProc.emit('exit', 1);

      await expect(promise).rejects.toThrow('devcontainer up failed (exit 1)');
    });

    it('rejects when devcontainer output has no result JSON', async () => {
      mockExecFileSync.mockReturnValue('');
      const mockProc = createMockSpawnProcess();
      mockSpawn.mockReturnValue(mockProc);

      const promise = cm.ensureContainer('/test/project');

      mockProc.stdout.emit('data', Buffer.from('not json\n'));
      mockProc.emit('exit', 0);

      await expect(promise).rejects.toThrow('No result JSON in devcontainer output');
    });

    it('rejects when devcontainer outcome is not success', async () => {
      mockExecFileSync.mockReturnValue('');
      const mockProc = createMockSpawnProcess();
      mockSpawn.mockReturnValue(mockProc);

      const promise = cm.ensureContainer('/test/project');

      const failureLine = JSON.stringify({
        outcome: 'failure',
        message: 'Dev container build failed',
      });
      mockProc.stdout.emit('data', Buffer.from(failureLine + '\n'));
      mockProc.emit('exit', 0);

      await expect(promise).rejects.toThrow('devcontainer up outcome: failure');
    });
  });

  describe('ensureContainer guard — non-running state', () => {
    it('throws when container state is starting with a resolved startPromise', async () => {
      mockExecFileSync.mockReturnValue('');

      // Set up a record with state 'starting' and an already-resolved startPromise
      (cm as any).records.set('/test/project', {
        projectRoot: '/test/project',
        state: 'starting',
        containerId: null,
        remoteWorkspaceFolder: null,
        startPromise: Promise.resolve(),
        eventWatcher: null,
      });

      await expect(cm.ensureContainer('/test/project')).rejects.toThrow(
        'Container for /test/project is not available (state: starting)'
      );
    });

    it('throws when container state is restarting with a resolved startPromise', async () => {
      mockExecFileSync.mockReturnValue('');

      (cm as any).records.set('/test/project', {
        projectRoot: '/test/project',
        state: 'restarting',
        containerId: null,
        remoteWorkspaceFolder: null,
        startPromise: Promise.resolve(),
        eventWatcher: null,
      });

      await expect(cm.ensureContainer('/test/project')).rejects.toThrow(
        'Container for /test/project is not available (state: restarting)'
      );
    });

    it('throws when container state is running but missing fields', async () => {
      mockExecFileSync.mockReturnValue('');

      (cm as any).records.set('/test/project', {
        projectRoot: '/test/project',
        state: 'running',
        containerId: null,      // missing containerId
        remoteWorkspaceFolder: null,
        startPromise: null,
        eventWatcher: null,
      });

      await expect(cm.ensureContainer('/test/project')).rejects.toThrow(
        'Container for /test/project is not available (state: running)'
      );
    });
  });

  describe('_onContainerDied (via watcher)', () => {
    it('restarts container when event watcher detects die event', async () => {
      mockExecFileSync.mockReturnValue(''); // dockerAvailable = true
      const devProc = createMockSpawnProcess();
      const watcherProc = createMockSpawnProcess();

      // First spawn call returns devcontainer up process
      // Second spawn call returns docker events watcher
      mockSpawn.mockReturnValueOnce(devProc);
      mockSpawn.mockReturnValueOnce(watcherProc);

      // Start the container
      const ndJsonLine = JSON.stringify({
        outcome: 'success',
        containerId: 'cont-abc',
        remoteWorkspaceFolder: '/workspace',
      });
      const startPromise = cm.ensureContainer('/test/project');

      devProc.stdout.emit('data', Buffer.from(ndJsonLine + '\n'));
      devProc.emit('exit', 0);

      await startPromise;

      // Now simulate watcher receiving die event
      // This should trigger _onContainerDied which starts a restart
      // The restart will need a third spawn call for the new devcontainer up
      const restartProc = createMockSpawnProcess();
      mockSpawn.mockReturnValueOnce(restartProc);

      // The watcher emits data on stdout → triggers _onContainerDied
      watcherProc.stdout.emit('data', Buffer.from('die\n'));

      // Wait for microtasks to process the restart
      await new Promise(r => setTimeout(r, 10));

      // Should have spawned a new devcontainer up process (the restart)
      expect(mockSpawn).toHaveBeenCalledTimes(3); // 2 from start + 1 from restart
    });

    it('triggers restart when watcher exit event fires while container is running', async () => {
      mockExecFileSync.mockReturnValue('');
      const devProc = createMockSpawnProcess();
      const watcherProc = createMockSpawnProcess();

      mockSpawn.mockReturnValueOnce(devProc);
      mockSpawn.mockReturnValueOnce(watcherProc);

      const ndJsonLine = JSON.stringify({
        outcome: 'success',
        containerId: 'cont-abc',
        remoteWorkspaceFolder: '/workspace',
      });
      const startPromise = cm.ensureContainer('/test/project');

      devProc.stdout.emit('data', Buffer.from(ndJsonLine + '\n'));
      devProc.emit('exit', 0);

      await startPromise;

      const restartProc = createMockSpawnProcess();
      mockSpawn.mockReturnValueOnce(restartProc);

      // Fire the exit event on the watcher (simulates watcher process dying)
      watcherProc.emit('exit', 0);

      await new Promise(r => setTimeout(r, 10));

      // Should have spawned a new devcontainer up (the restart triggered by watcher exit)
      expect(mockSpawn).toHaveBeenCalledTimes(3);
    });

    it('triggers restart when watcher error event fires while container is running', async () => {
      mockExecFileSync.mockReturnValue('');
      const devProc = createMockSpawnProcess();
      const watcherProc = createMockSpawnProcess();

      mockSpawn.mockReturnValueOnce(devProc);
      mockSpawn.mockReturnValueOnce(watcherProc);

      const ndJsonLine = JSON.stringify({
        outcome: 'success',
        containerId: 'cont-abc',
        remoteWorkspaceFolder: '/workspace',
      });
      const startPromise = cm.ensureContainer('/test/project');

      devProc.stdout.emit('data', Buffer.from(ndJsonLine + '\n'));
      devProc.emit('exit', 0);

      await startPromise;

      const restartProc = createMockSpawnProcess();
      mockSpawn.mockReturnValueOnce(restartProc);

      // Fire the error event on the watcher
      watcherProc.emit('error', new Error('stream connection lost'));

      await new Promise(r => setTimeout(r, 10));

      // Should have spawned a new devcontainer up (the restart triggered by watcher error)
      expect(mockSpawn).toHaveBeenCalledTimes(3);
    });

    it('does not restart when container dies but state is not running', async () => {
      mockExecFileSync.mockReturnValue('');
      const devProc = createMockSpawnProcess();
      const watcherProc = createMockSpawnProcess();

      mockSpawn.mockReturnValueOnce(devProc);
      mockSpawn.mockReturnValueOnce(watcherProc);

      const ndJsonLine = JSON.stringify({
        outcome: 'success',
        containerId: 'cont-abc',
        remoteWorkspaceFolder: '/workspace',
      });
      const startPromise = cm.ensureContainer('/test/project');

      devProc.stdout.emit('data', Buffer.from(ndJsonLine + '\n'));
      devProc.emit('exit', 0);

      await startPromise;

      // Manually set state to stopped (e.g., after a failure)
      const record = (cm as any).records.get('/test/project');
      record.state = 'stopped';

      watcherProc.stdout.emit('data', Buffer.from('die\n'));

      // Should NOT have spawned an additional devcontainer process
      expect(mockSpawn).toHaveBeenCalledTimes(2); // only the initial calls
    });
  });
});

describe('ContainerManager getState', () => {
  let cm: ContainerManager;

  beforeEach(() => {
    vi.clearAllMocks();
    _resetDockerAvailableCache();
    cm = new ContainerManager();
    (cm as any).records.clear();
  });

  it('returns running when docker ps shows Up status', () => {
    mockExecFileSync.mockReturnValue('Up 2 hours');

    const state = cm.getState('/test/project-docker-up');
    expect(state).toBe('running');
    expect(mockExecFileSync).toHaveBeenCalledWith(
      'docker',
      expect.arrayContaining(['ps', '-a', '--format', '{{.Status}}']),
      expect.any(Object),
    );
  });

  it('returns stopped when docker ps returns non-Up status', () => {
    mockExecFileSync.mockReturnValue('Exited (0) 1 hour ago');

    const state = cm.getState('/test/project-docker-exited');
    expect(state).toBe('stopped');
  });

  it('returns stopped when docker execFileSync throws', () => {
    mockExecFileSync.mockImplementation(() => { throw new Error('Docker not found'); });

    const state = cm.getState('/test/project-docker-error');
    expect(state).toBe('stopped');
  });

  it('returns stopped when docker ps returns empty string', () => {
    mockExecFileSync.mockReturnValue('');

    const state = cm.getState('/test/project-docker-empty');
    expect(state).toBe('stopped');
  });
});

describe('ContainerManager global singleton', () => {
  it('exports a singleton that persists across instances', () => {
    expect(containerManager).toBeDefined();
    const globalKey = '__containerManager';
    expect((global as any)[globalKey]).toBe(containerManager);
  });
});
