/**
 * Tests for ContainerManager advanced lifecycle methods.
 * Covers: devcontainerBin (indirectly), _doStart, _spawnDevcontainerUp,
 * _watchEvents, _onContainerDied.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';

// ── Hoisted mocks ──

const { mockSpawn, mockExecFileSync } = vi.hoisted(() => ({
  mockSpawn: vi.fn(),
  mockExecFileSync: vi.fn(),
}));

const { mockExistsSync } = vi.hoisted(() => ({
  mockExistsSync: vi.fn(),
}));

const { mockLogWarn } = vi.hoisted(() => ({
  mockLogWarn: vi.fn(),
}));

vi.mock('child_process', () => ({
  spawn: mockSpawn,
  execFile: vi.fn(),
  execFileSync: mockExecFileSync,
  ChildProcess: class MockChildProcess {},
}));

vi.mock('fs', () => ({
  existsSync: mockExistsSync,
}));

vi.mock('../../src/lib/logger', () => ({
  log: vi.fn(), error: vi.fn(), warn: mockLogWarn,
}));

// ── Imports ──

import { ContainerManager, _resetDockerAvailableCache, dockerAvailable } from '../../src/lib/container-manager';

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

  describe('devcontainerBin (tested via _spawnDevcontainerUp)', () => {
    it('uses local node_modules/.bin/devcontainer when it exists', async () => {
      mockExecFileSync.mockReturnValue(''); // dockerAvailable = true

      // Mock existsSync to return true for local devcontainer path
      mockExistsSync.mockImplementation((p: any) => {
        const pathStr = String(p);
        if (pathStr.includes('node_modules') && pathStr.includes('devcontainer')) return true;
        return false;
      });

      const mockProc = createMockSpawnProcess();
      mockSpawn.mockReturnValue(mockProc);

      const promise = cm.ensureContainer('/test/project-local');

      // reject so the test doesn't hang
      mockProc.emit('error', new Error('ENOENT'));
      await expect(promise).rejects.toThrow();

      // Should have been called with the local path (not just 'devcontainer')
      expect(mockSpawn).toHaveBeenCalledWith(
        expect.stringContaining('node_modules'),
        expect.any(Array),
        expect.any(Object),
      );
    });

    it('uses default devcontainer when local path does not exist', async () => {
      mockExecFileSync.mockReturnValue('');
      mockExistsSync.mockReturnValue(false);

      const mockProc = createMockSpawnProcess();
      mockSpawn.mockReturnValue(mockProc);

      const promise = cm.ensureContainer('/test/project-default');

      mockProc.emit('error', new Error('ENOENT'));
      await expect(promise).rejects.toThrow();

      // Should have been called with devcontainer (may have .cmd on Windows,
      // quoted because the .cmd shim is spawned through a shell — EINVAL fix)
      const callArg = mockSpawn.mock.calls[0][0];
      expect(callArg).toMatch(/^"?devcontainer(\.cmd)?"?$/);
    });

    it('spawns the .cmd shim through a shell with quoted args on Windows (spawn EINVAL fix)', async () => {
      if (process.platform !== 'win32') return; // Windows-only spawn behavior
      mockExecFileSync.mockReturnValue('');
      mockExistsSync.mockReturnValue(false);

      const mockProc = createMockSpawnProcess();
      mockSpawn.mockReturnValue(mockProc);

      const promise = cm.ensureContainer('/test/project-shell');
      mockProc.emit('error', new Error('ENOENT'));
      await expect(promise).rejects.toThrow();

      // Node >=18.20/20.12/21.7 throws EINVAL when spawning .cmd/.bat without
      // shell: true; the fix routes through a shell and quotes every argument.
      const [bin, args, opts] = mockSpawn.mock.calls[0];
      expect(opts.shell).toBe(true);
      expect(bin).toBe('"devcontainer.cmd"');
      for (const a of args as string[]) expect(a).toMatch(/^".*"$/);
    });
  });

  describe('dockerAvailable cache', () => {
    beforeEach(() => {
      _resetDockerAvailableCache();
    });

    it('returns cached value on second call', () => {
      mockExecFileSync.mockReturnValue('');

      // First call should execFileSync
      const first = dockerAvailable();
      expect(first).toBe(true);
      expect(mockExecFileSync).toHaveBeenCalledTimes(1);

      // Second call should use cache, no additional execFileSync
      const second = dockerAvailable();
      expect(second).toBe(true);
      expect(mockExecFileSync).toHaveBeenCalledTimes(1);
    });

    it('returns cached false value', () => {
      mockExecFileSync.mockImplementation(() => { throw new Error('Docker not available'); });

      const first = dockerAvailable();
      expect(first).toBe(false);
      expect(mockExecFileSync).toHaveBeenCalledTimes(1);

      const second = dockerAvailable();
      expect(second).toBe(false);
      expect(mockExecFileSync).toHaveBeenCalledTimes(1);
    });
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

      // Check spawn was called with devcontainer binary and up args.
      // On Windows the .cmd shim goes through a shell with quoted args
      // (EINVAL fix), so strip surrounding quotes before comparing.
      const [binArg, argsArg] = mockSpawn.mock.calls[0];
      expect(binArg).toMatch(/devcontainer/);
      const unquoted = (argsArg as string[]).map(a => a.replace(/^"|"$/g, ''));
      expect(unquoted).toEqual(
        expect.arrayContaining(['up', '--workspace-folder', '/test/project', '--log-format', 'json']),
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

    // Coverage: line 212 — _doStart failure during restart
    it('handles _doStart failure during restart gracefully (catch branch)', async () => {
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

      // Make the restart spawn emit an error (simulates devcontainer binary failure)
      const failingProc = createMockSpawnProcess();
      mockSpawn.mockReturnValueOnce(failingProc);

      // Trigger _onContainerDied via watcher
      watcherProc.stdout.emit('data', Buffer.from('die\n'));

      // Small delay to let microtasks process
      await new Promise(r => setTimeout(r, 10));

      // Should have spawned a 3rd devcontainer process for the restart
      expect(mockSpawn).toHaveBeenCalledTimes(3);

      // Now fail the restart by emitting error on the failing proc
      // Wait for the startPromise to reject, which exercises the .catch(() => {}) line
      // _doStart will reject → catch handler runs → state set to 'stopped'
      // The eventWatcher should have been killed during the attempt
      failingProc.emit('error', new Error('devcontainer restart failed'));

      await new Promise(r => setTimeout(r, 10));

      // After failure, state should be 'stopped'
      const record = (cm as any).records.get('/test/project');
      expect(record.state).toBe('stopped');
      expect(record.containerId).toBeNull();
      expect(record.remoteWorkspaceFolder).toBeNull();
    });
  });
});


