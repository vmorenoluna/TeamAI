/**
 * Unit tests for ContainerManager.
 *
 * Covers:
 *   - checkDockerAvailable (with and without Docker)
 *   - readContainerConfig (file exists, invalid JSON, missing file)
 *   - hostToContainerPath (path translation)
 *   - ContainerManager.getState, getRunningContainer, ensureContainer
 *   - Global singleton
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';

// ── Hoisted mocks ──

const { mockDockerExec, mockSpawn, mockExistsSync, mockReadFileSync, mockAppendFileSync, mockLogError, mockLogWarn } = vi.hoisted(() => ({
  mockDockerExec: vi.fn(),
  mockSpawn: vi.fn(),
  mockExistsSync: vi.fn(),
  mockReadFileSync: vi.fn(),
  mockAppendFileSync: vi.fn(),
  mockLogError: vi.fn(),
  mockLogWarn: vi.fn(),
}));

// execFile (callback form) adapter: the sync-style handler either returns stdout or throws.
function execFileFromHandler(handler: (file: string, args: string[], opts: unknown) => unknown) {
  return (file: string, args: string[], opts: unknown, cb: (err: Error | null, stdout: string, stderr: string) => void) => {
    let out: unknown;
    try { out = handler(file, args, opts); } catch (err) { setImmediate(() => cb(err as Error, '', '')); return; }
    setImmediate(() => cb(null, typeof out === 'string' ? out : '', ''));
  };
}

vi.mock('child_process', () => ({
  spawn: mockSpawn,
  execFile: execFileFromHandler((...a) => mockDockerExec(...a)),
  ChildProcess: class MockChildProcess {},
}));

vi.mock('fs', () => ({
  existsSync: mockExistsSync,
  readFileSync: mockReadFileSync,
  appendFileSync: mockAppendFileSync,
}));

vi.mock('../../src/lib/logger', () => ({
  error: mockLogError,
  log: vi.fn(), warn: mockLogWarn,
}));

// ── Imports ──

import { ContainerManager, readContainerConfig, readContainerRemoteUser, hostToContainerPath, containerManager, checkDockerAvailable, _resetDockerAvailableCache } from '../../src/lib/container-manager';

// ── Tests ──

describe('checkDockerAvailable', () => {
  beforeEach(() => {
    _resetDockerAvailableCache();
  });

  it('returns false when docker info fails and logs warning', async () => {
    mockDockerExec.mockImplementationOnce(() => { throw new Error('Docker not found'); });
    expect(await checkDockerAvailable()).toBe(false);
    expect(mockLogWarn).toHaveBeenCalledWith('container', 'docker info check failed', expect.any(Error));
  });

  it('returns true when docker info succeeds', async () => {
    _resetDockerAvailableCache();
    mockDockerExec.mockReturnValueOnce('');
    expect(await checkDockerAvailable()).toBe(true);
    expect(mockDockerExec).toHaveBeenCalledWith('docker', ['info'], expect.any(Object));
  });
});

describe('readContainerConfig', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetDockerAvailableCache();
  });

  it('returns enabled: true when container.json says enabled', async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify({ enabled: true }));
    const result = readContainerConfig('/test/project');
    expect(result).toEqual({ enabled: true, explicit: true });
  });

  it('returns enabled: false when container.json says disabled', async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify({ enabled: false }));
    const result = readContainerConfig('/test/project');
    expect(result).toEqual({ enabled: false, explicit: true });
  });

  it('logs warning on invalid JSON and falls back to the cached docker availability', async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue('{invalid}');
    mockDockerExec.mockReturnValue(''); // docker available
    await checkDockerAvailable(); // warm the cache — readContainerConfig stays sync
    const result = readContainerConfig('/test/project');
    expect(result).toEqual({ enabled: true, explicit: false });
    expect(mockLogWarn).toHaveBeenCalledWith('container', 'Failed to parse container config, using defaults', expect.any(Error));
  });

  it('returns the cached docker availability when container.json missing and docker is available', async () => {
    mockExistsSync.mockReturnValue(false);
    mockDockerExec.mockReturnValue(''); // docker available
    await checkDockerAvailable(); // warm the cache — readContainerConfig stays sync
    const result = readContainerConfig('/test/project');
    expect(result).toEqual({ enabled: true, explicit: false });
  });

  it('returns disabled when container.json missing and docker unavailable', async () => {
    mockExistsSync.mockReturnValue(false);
    mockDockerExec.mockImplementation(() => { throw new Error('no docker'); });
    await checkDockerAvailable();
    const result = readContainerConfig('/test/project');
    expect(result).toEqual({ enabled: false, explicit: false });
  });
});

describe('hostToContainerPath', () => {
  it('returns translated path for simple paths', async () => {
    const result = hostToContainerPath('/host/project/src', '/host/project', '/workspace');
    expect(result).toBe('/workspace/src');
  });

  it('returns translated path for nested paths', async () => {
    const result = hostToContainerPath('/host/project/src/components', '/host/project', '/workspace');
    expect(result).toBe('/workspace/src/components');
  });

  it('handles Windows backslashes by converting to forward slashes', async () => {
    const result = hostToContainerPath('C:\\host\\project\\src', 'C:\\host\\project', '/workspace');
    expect(result).toBe('/workspace/src');
  });

  it('returns workspace root when hostPath equals projectRoot', async () => {
    const result = hostToContainerPath('/host/project', '/host/project', '/workspace');
    expect(result).toBe('/workspace/');
  });
});

describe('ContainerManager', () => {
  let cm: ContainerManager;

  beforeEach(() => {
    vi.clearAllMocks();
    cm = new ContainerManager();
    // Access private records for test setup
    (cm as any).records.clear();
  });

  describe('getRunningContainer', () => {
    it('returns null when no record exists', async () => {
      expect(await cm.getRunningContainer('/test')).toBeNull();
    });

    it('returns null when container is not running', async () => {
      (cm as any).records.set('/test', {
        projectRoot: '/test',
        state: 'stopped',
        containerId: null,
        remoteWorkspaceFolder: null,
        startPromise: null,
        eventWatcher: null,
      });
      expect(await cm.getRunningContainer('/test')).toBeNull();
    });

    it('returns container info when container is running (liveness check passes)', async () => {
      (cm as any).records.set('/test', {
        projectRoot: '/test',
        state: 'running',
        containerId: 'abc123',
        remoteWorkspaceFolder: '/workspace',
        startPromise: null,
        eventWatcher: null,
      });
      // Liveness check: docker inspect returns true
      mockDockerExec.mockReturnValueOnce('true\n');
      const info = await cm.getRunningContainer('/test');
      expect(info).toEqual({ containerId: 'abc123', remoteWorkspaceFolder: '/workspace' });
    });

    it('returns null when cached record says running but container is actually dead', async () => {
      (cm as any).records.set('/test', {
        projectRoot: '/test',
        state: 'running',
        containerId: 'abc123',
        remoteWorkspaceFolder: '/workspace',
        startPromise: null,
        eventWatcher: null,
      });
      // Liveness check: docker inspect returns false — container died
      mockDockerExec.mockReturnValueOnce('false\n');
      // Fallback scan also finds nothing
      mockDockerExec.mockReturnValueOnce('');

      const info = await cm.getRunningContainer('/test');
      expect(info).toBeNull();

      // Verify the record was transitioned to stopped
      const record = (cm as any).records.get('/test');
      expect(record.state).toBe('stopped');
      expect(record.containerId).toBeNull();
      expect(record.remoteWorkspaceFolder).toBeNull();
    });

    it('kills the eventWatcher when stale record is detected', async () => {
      const mockWatcher = { kill: vi.fn() };
      (cm as any).records.set('/test', {
        projectRoot: '/test',
        state: 'running',
        containerId: 'abc123',
        remoteWorkspaceFolder: '/workspace',
        startPromise: null,
        eventWatcher: mockWatcher,
      });
      // Liveness check fails — container is dead
      mockDockerExec.mockReturnValueOnce('false\n');
      // Fallback scan also finds nothing
      mockDockerExec.mockReturnValueOnce('');

      await cm.getRunningContainer('/test');
      expect(mockWatcher.kill).toHaveBeenCalled();

      // Verify eventWatcher was cleared on the record
      const record = (cm as any).records.get('/test');
      expect(record.eventWatcher).toBeNull();
    });

    it('falls through to Docker scan when cached record is stale but container restarted', async () => {
      (cm as any).records.set('/test', {
        projectRoot: '/test',
        state: 'running',
        containerId: 'abc123',
        remoteWorkspaceFolder: '/workspace',
        startPromise: null,
        eventWatcher: null,
      });
      // Liveness check: docker inspect fails (container gone)
      mockDockerExec.mockImplementationOnce(() => { throw new Error('No such container'); });
      // Fallback scan finds a *new* container instance
      mockDockerExec
        .mockReturnValueOnce('new-container-id')
        .mockReturnValueOnce(JSON.stringify([
          { Source: '/test', Destination: '/workspaces/test' },
        ]));

      const info = await cm.getRunningContainer('/test');
      expect(info).toEqual({
        containerId: 'new-container-id',
        remoteWorkspaceFolder: '/workspaces/test',
      });
    });
  });

  describe('getState', () => {
    it('returns stopped when no record exists and docker check fails', async () => {
      mockDockerExec.mockImplementation(() => { throw new Error('not found'); });
      const state = await cm.getState('/test');
      expect(state).toBe('stopped');
      expect(mockLogWarn).toHaveBeenCalled();
    });

    it('returns running when docker ps shows Up', async () => {
      mockDockerExec.mockReturnValue('Up 2 hours\n');
      const state = await cm.getState('/test');
      expect(state).toBe('running');
    });

    it('returns stopped when docker ps shows Exited', async () => {
      mockDockerExec.mockReturnValue('Exited (0) 5 minutes ago\n');
      const state = await cm.getState('/test');
      expect(state).toBe('stopped');
    });

    it('returns stopped when docker ps returns empty string', async () => {
      mockDockerExec.mockReturnValue('');
      const state = await cm.getState('/test');
      expect(state).toBe('stopped');
    });

    it('returns existing record state when record exists (no docker call)', async () => {
      (cm as any).records.set('/test', {
        projectRoot: '/test',
        state: 'running',
        containerId: 'abc',
        remoteWorkspaceFolder: '/workspace',
        startPromise: null,
        eventWatcher: null,
      });
      const state = await cm.getState('/test');
      expect(state).toBe('running');
      expect(mockDockerExec).not.toHaveBeenCalled();
    });
  });

  describe('ensureContainer', () => {
    it('returns container info when record already exists and running', async () => {
      (cm as any).records.set('/test', {
        projectRoot: '/test',
        state: 'running',
        containerId: 'abc-123',
        remoteWorkspaceFolder: '/workspace',
        startPromise: null,
        eventWatcher: null,
      });

      const info = await cm.ensureContainer('/test');
      expect(info).toEqual({ containerId: 'abc-123', remoteWorkspaceFolder: '/workspace' });
    });

    it('throws when container start promise rejects', async () => {
      const failPromise = Promise.reject(new Error('Start failed'));
      failPromise.catch(() => { /* best-effort */ }); // prevent unhandled rejection

      (cm as any).records.set('/test', {
        projectRoot: '/test',
        state: 'starting',
        containerId: null,
        remoteWorkspaceFolder: null,
        startPromise: failPromise,
        eventWatcher: null,
      });

      await expect(cm.ensureContainer('/test')).rejects.toThrow('Start failed');
    });
  });

  describe('EventEmitter functionality', () => {
    it('emits container-state events', async () => {
      const stateSpy = vi.fn();
      cm.on('container-state', stateSpy);
      cm.emit('container-state', { projectRoot: '/test', state: 'running' });
      expect(stateSpy).toHaveBeenCalledWith({ projectRoot: '/test', state: 'running' });
    });
  });
});

describe('containerManager singleton', () => {
  it('exports a ContainerManager instance', async () => {
    expect(containerManager).toBeDefined();
    expect(containerManager).toBeInstanceOf(ContainerManager);
  });
});

// ── Additional coverage: _findRunningContainer ───────────────

describe('ContainerManager — _findRunningContainer', () => {
  let cm: ContainerManager;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    cm = new ContainerManager();
    (cm as any).records.clear();
  });

  it('returns null when no container is running', async () => {
    mockDockerExec.mockReturnValue('');
    const result = await (cm as any)._findRunningContainer('/test/project');
    expect(result).toBeNull();
  });

  it('returns null when docker ps fails', async () => {
    mockDockerExec.mockImplementation(() => { throw new Error('Docker not running'); });
    const result = await (cm as any)._findRunningContainer('/test/project');
    expect(result).toBeNull();
  });

  it('returns null when no workspace mount matches', async () => {
    mockDockerExec
      .mockReturnValueOnce('container-abc')
      .mockReturnValueOnce(JSON.stringify([
        { Source: '/other/project', Destination: '/workspaces/other' },
      ]));

    const result = await (cm as any)._findRunningContainer('/test/project');
    expect(result).toBeNull();
  });

  it('returns ContainerInfo when mount matches', async () => {
    mockDockerExec
      .mockReturnValueOnce('container-abc')
      .mockReturnValueOnce(JSON.stringify([
        { Source: '/test/project', Destination: '/workspaces/test-project' },
      ]));

    const result = await (cm as any)._findRunningContainer('/test/project');
    expect(result).toEqual({
      containerId: 'container-abc',
      remoteWorkspaceFolder: '/workspaces/test-project',
    });
  });

  it('returns null when docker inspect fails', async () => {
    mockDockerExec
      .mockReturnValueOnce('container-abc')
      .mockImplementationOnce(() => { throw new Error('Docker inspect failed'); });

    const result = await (cm as any)._findRunningContainer('/test/project');
    expect(result).toBeNull();
  });

  it('normalizes project root path when comparing mounts', async () => {
    mockDockerExec
      .mockReturnValueOnce('container-xyz')
      .mockReturnValueOnce(JSON.stringify([
        { Source: 'C:\\Users\\test\\project', Destination: '/workspaces/project' },
      ]));

    const result = await (cm as any)._findRunningContainer('c:\\users\\test\\project');
    expect(result).toEqual({
      containerId: 'container-xyz',
      remoteWorkspaceFolder: '/workspaces/project',
    });
  });
});

// ── Additional coverage: getRunningContainer fallback ────────────

describe('ContainerManager — getRunningContainer fallback scan', () => {
  let cm: ContainerManager;

  beforeEach(() => {
    vi.clearAllMocks();
    cm = new ContainerManager();
    (cm as any).records.clear();
  });

  it('falls back to Docker label scan when no in-memory record', async () => {
    // No liveness check needed — no in-memory record to validate
    mockDockerExec
      .mockReturnValueOnce('container-found')
      .mockReturnValueOnce(JSON.stringify([
        { Source: '/test/project', Destination: '/workspaces/test' },
      ]));

    const info = await cm.getRunningContainer('/test/project');
    expect(info).toEqual({
      containerId: 'container-found',
      remoteWorkspaceFolder: '/workspaces/test',
    });

    const record = (cm as any).records.get('/test/project');
    expect(record).not.toBeNull();
    expect(record.containerId).toBe('container-found');
  });

  it('returns null when Docker scan also fails', async () => {
    mockDockerExec.mockImplementation(() => { throw new Error('Docker unavailable'); });
    const info = await cm.getRunningContainer('/test/project');
    expect(info).toBeNull();
  });
});

// ── Additional coverage: ensureContainer existing scan ───────────

describe('ContainerManager — ensureContainer existing via scan', () => {
  let cm: ContainerManager;

  beforeEach(() => {
    vi.clearAllMocks();
    cm = new ContainerManager();
    (cm as any).records.clear();
  });

  it('finds existing running container when in-memory record is missing', async () => {
    // Adopting a running container also records workspace trust in it (a
    // third docker call), so answer by subcommand rather than by call order.
    mockDockerExec.mockReset();
    mockDockerExec.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === 'ps') return 'existing-container';
      if (args[0] === 'inspect') return JSON.stringify([{ Source: '/test/project', Destination: '/workspaces/test' }]);
      return '';
    });

    const proc = new EventEmitter() as any;
    proc.stdout = new EventEmitter() as any;
    proc.stderr = new EventEmitter() as any;
    proc.pid = 99999;
    proc.kill = vi.fn();
    mockSpawn.mockReturnValue(proc);

    const info = await cm.ensureContainer('/test/project');

    expect(info).toEqual({
      containerId: 'existing-container',
      remoteWorkspaceFolder: '/workspaces/test',
    });
  });
});

// ── Additional coverage: readContainerRemoteUser ─────────────────

describe('readContainerRemoteUser', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns remoteUser from devcontainer.json when present', async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify({ remoteUser: 'developer' }));

    const result = readContainerRemoteUser('/test/project');
    expect(result).toBe('developer');
  });

  it('falls back to node when devcontainer.json has no remoteUser', async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify({ image: 'node:20' }));

    const result = readContainerRemoteUser('/test/project');
    expect(result).toBe('node');
  });

  it('falls back to node when devcontainer.json does not exist', async () => {
    mockExistsSync.mockReturnValue(false);

    const result = readContainerRemoteUser('/test/project');
    expect(result).toBe('node');
  });

  it('falls back to node when devcontainer.json is invalid JSON', async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue('{invalid json');

    const result = readContainerRemoteUser('/test/project');
    expect(result).toBe('node');
    expect(mockLogWarn).toHaveBeenCalled();
  });
});

// ── Additional coverage: getState edge cases ─────────────────────

describe('ContainerManager — getState edge cases', () => {
  let cm: ContainerManager;

  beforeEach(() => {
    vi.clearAllMocks();
    cm = new ContainerManager();
    (cm as any).records.clear();
  });

  it('handles state lookup with no Docker and no record', async () => {
    mockDockerExec.mockImplementation(() => { throw new Error('No Docker'); });

    const state = await cm.getState('/test/project');
    expect(state).toBe('stopped');
    expect(mockDockerExec).toHaveBeenCalledWith(
      'docker',
      expect.arrayContaining(['ps', '-a']),
      expect.any(Object),
    );
  });

  it('returns state from in-memory record without calling Docker', async () => {
    (cm as any).records.set('/test/project', {
      projectRoot: '/test/project',
      state: 'starting',
      containerId: null,
      remoteWorkspaceFolder: null,
      startPromise: null,
      eventWatcher: null,
    });

    const state = await cm.getState('/test/project');
    expect(state).toBe('starting');
    expect(mockDockerExec).not.toHaveBeenCalled();
  });
});
