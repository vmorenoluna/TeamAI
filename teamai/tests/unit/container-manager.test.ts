/**
 * Unit tests for ContainerManager.
 *
 * Covers:
 *   - dockerAvailable (with and without Docker)
 *   - readContainerConfig (file exists, invalid JSON, missing file)
 *   - hostToContainerPath (path translation)
 *   - ContainerManager.getState, getRunningContainer, ensureContainer
 *   - Global singleton
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';

// ── Hoisted mocks ──

const { mockExecFileSync, mockSpawn, mockExistsSync, mockReadFileSync, mockAppendFileSync, mockLogError, mockLogWarn } = vi.hoisted(() => ({
  mockExecFileSync: vi.fn(),
  mockSpawn: vi.fn(),
  mockExistsSync: vi.fn(),
  mockReadFileSync: vi.fn(),
  mockAppendFileSync: vi.fn(),
  mockLogError: vi.fn(),
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
  readFileSync: mockReadFileSync,
  appendFileSync: mockAppendFileSync,
}));

vi.mock('../../src/lib/logger', () => ({
  error: mockLogError,
  log: vi.fn(), warn: mockLogWarn,
}));

// ── Imports ──

import { ContainerManager, readContainerConfig, readContainerRemoteUser, hostToContainerPath, containerManager, dockerAvailable, _resetDockerAvailableCache } from '../../src/lib/container-manager';

// ── Tests ──

describe('dockerAvailable', () => {
  beforeEach(() => {
    _resetDockerAvailableCache();
  });

  it('returns false when docker info fails and logs warning', () => {
    mockExecFileSync.mockImplementationOnce(() => { throw new Error('Docker not found'); });
    expect(dockerAvailable()).toBe(false);
    expect(mockLogWarn).toHaveBeenCalledWith('container', 'docker info check failed', expect.any(Error));
  });

  it('returns true when docker info succeeds', () => {
    _resetDockerAvailableCache();
    mockExecFileSync.mockReturnValueOnce('');
    expect(dockerAvailable()).toBe(true);
    expect(mockExecFileSync).toHaveBeenCalledWith('docker', ['info'], expect.any(Object));
  });
});

describe('readContainerConfig', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetDockerAvailableCache();
  });

  it('returns enabled: true when container.json says enabled', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify({ enabled: true }));
    const result = readContainerConfig('/test/project');
    expect(result).toEqual({ enabled: true, explicit: true });
  });

  it('returns enabled: false when container.json says disabled', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify({ enabled: false }));
    const result = readContainerConfig('/test/project');
    expect(result).toEqual({ enabled: false, explicit: true });
  });

  it('logs warning on invalid JSON and falls back to dockerAvailable', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue('{invalid}');
    mockExecFileSync.mockReturnValue(''); // docker available
    const result = readContainerConfig('/test/project');
    expect(result).toEqual({ enabled: true, explicit: false });
    expect(mockLogWarn).toHaveBeenCalledWith('container', 'Failed to parse container config, using defaults', expect.any(Error));
  });

  it('returns dockerAvailable result when container.json missing and docker is available', () => {
    mockExistsSync.mockReturnValue(false);
    mockExecFileSync.mockReturnValue(''); // docker available
    const result = readContainerConfig('/test/project');
    expect(result).toEqual({ enabled: true, explicit: false });
  });

  it('returns disabled when container.json missing and docker unavailable', () => {
    mockExistsSync.mockReturnValue(false);
    mockExecFileSync.mockImplementation(() => { throw new Error('no docker'); });
    const result = readContainerConfig('/test/project');
    expect(result).toEqual({ enabled: false, explicit: false });
  });
});

describe('hostToContainerPath', () => {
  it('returns translated path for simple paths', () => {
    const result = hostToContainerPath('/host/project/src', '/host/project', '/workspace');
    expect(result).toBe('/workspace/src');
  });

  it('returns translated path for nested paths', () => {
    const result = hostToContainerPath('/host/project/src/components', '/host/project', '/workspace');
    expect(result).toBe('/workspace/src/components');
  });

  it('handles Windows backslashes by converting to forward slashes', () => {
    const result = hostToContainerPath('C:\\host\\project\\src', 'C:\\host\\project', '/workspace');
    expect(result).toBe('/workspace/src');
  });

  it('returns workspace root when hostPath equals projectRoot', () => {
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
    it('returns null when no record exists', () => {
      expect(cm.getRunningContainer('/test')).toBeNull();
    });

    it('returns null when container is not running', () => {
      (cm as any).records.set('/test', {
        projectRoot: '/test',
        state: 'stopped',
        containerId: null,
        remoteWorkspaceFolder: null,
        startPromise: null,
        eventWatcher: null,
      });
      expect(cm.getRunningContainer('/test')).toBeNull();
    });

    it('returns container info when container is running (liveness check passes)', () => {
      (cm as any).records.set('/test', {
        projectRoot: '/test',
        state: 'running',
        containerId: 'abc123',
        remoteWorkspaceFolder: '/workspace',
        startPromise: null,
        eventWatcher: null,
      });
      // Liveness check: docker inspect returns true
      mockExecFileSync.mockReturnValueOnce('true\n');
      const info = cm.getRunningContainer('/test');
      expect(info).toEqual({ containerId: 'abc123', remoteWorkspaceFolder: '/workspace' });
    });

    it('returns null when cached record says running but container is actually dead', () => {
      (cm as any).records.set('/test', {
        projectRoot: '/test',
        state: 'running',
        containerId: 'abc123',
        remoteWorkspaceFolder: '/workspace',
        startPromise: null,
        eventWatcher: null,
      });
      // Liveness check: docker inspect returns false — container died
      mockExecFileSync.mockReturnValueOnce('false\n');
      // Fallback scan also finds nothing
      mockExecFileSync.mockReturnValueOnce('');

      const info = cm.getRunningContainer('/test');
      expect(info).toBeNull();

      // Verify the record was transitioned to stopped
      const record = (cm as any).records.get('/test');
      expect(record.state).toBe('stopped');
      expect(record.containerId).toBeNull();
      expect(record.remoteWorkspaceFolder).toBeNull();
    });

    it('kills the eventWatcher when stale record is detected', () => {
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
      mockExecFileSync.mockReturnValueOnce('false\n');
      // Fallback scan also finds nothing
      mockExecFileSync.mockReturnValueOnce('');

      cm.getRunningContainer('/test');
      expect(mockWatcher.kill).toHaveBeenCalled();

      // Verify eventWatcher was cleared on the record
      const record = (cm as any).records.get('/test');
      expect(record.eventWatcher).toBeNull();
    });

    it('falls through to Docker scan when cached record is stale but container restarted', () => {
      (cm as any).records.set('/test', {
        projectRoot: '/test',
        state: 'running',
        containerId: 'abc123',
        remoteWorkspaceFolder: '/workspace',
        startPromise: null,
        eventWatcher: null,
      });
      // Liveness check: docker inspect fails (container gone)
      mockExecFileSync.mockImplementationOnce(() => { throw new Error('No such container'); });
      // Fallback scan finds a *new* container instance
      mockExecFileSync
        .mockReturnValueOnce('new-container-id')
        .mockReturnValueOnce(JSON.stringify([
          { Source: '/test', Destination: '/workspaces/test' },
        ]));

      const info = cm.getRunningContainer('/test');
      expect(info).toEqual({
        containerId: 'new-container-id',
        remoteWorkspaceFolder: '/workspaces/test',
      });
    });
  });

  describe('getState', () => {
    it('returns stopped when no record exists and docker check fails', () => {
      mockExecFileSync.mockImplementation(() => { throw new Error('not found'); });
      const state = cm.getState('/test');
      expect(state).toBe('stopped');
      expect(mockLogWarn).toHaveBeenCalled();
    });

    it('returns running when docker ps shows Up', () => {
      mockExecFileSync.mockReturnValue('Up 2 hours\n');
      const state = cm.getState('/test');
      expect(state).toBe('running');
    });

    it('returns stopped when docker ps shows Exited', () => {
      mockExecFileSync.mockReturnValue('Exited (0) 5 minutes ago\n');
      const state = cm.getState('/test');
      expect(state).toBe('stopped');
    });

    it('returns stopped when docker ps returns empty string', () => {
      mockExecFileSync.mockReturnValue('');
      const state = cm.getState('/test');
      expect(state).toBe('stopped');
    });

    it('returns existing record state when record exists (no docker call)', () => {
      (cm as any).records.set('/test', {
        projectRoot: '/test',
        state: 'running',
        containerId: 'abc',
        remoteWorkspaceFolder: '/workspace',
        startPromise: null,
        eventWatcher: null,
      });
      const state = cm.getState('/test');
      expect(state).toBe('running');
      expect(mockExecFileSync).not.toHaveBeenCalled();
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
      failPromise.catch(() => {}); // prevent unhandled rejection

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
    it('emits container-state events', () => {
      const stateSpy = vi.fn();
      cm.on('container-state', stateSpy);
      cm.emit('container-state', { projectRoot: '/test', state: 'running' });
      expect(stateSpy).toHaveBeenCalledWith({ projectRoot: '/test', state: 'running' });
    });
  });
});

describe('containerManager singleton', () => {
  it('exports a ContainerManager instance', () => {
    expect(containerManager).toBeDefined();
    expect(containerManager).toBeInstanceOf(ContainerManager);
  });
});

// ── Additional coverage: _findRunningContainerSync ───────────────

describe('ContainerManager — _findRunningContainerSync', () => {
  let cm: ContainerManager;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    cm = new ContainerManager();
    (cm as any).records.clear();
  });

  it('returns null when no container is running', () => {
    mockExecFileSync.mockReturnValue('');
    const result = (cm as any)._findRunningContainerSync('/test/project');
    expect(result).toBeNull();
  });

  it('returns null when docker ps fails', () => {
    mockExecFileSync.mockImplementation(() => { throw new Error('Docker not running'); });
    const result = (cm as any)._findRunningContainerSync('/test/project');
    expect(result).toBeNull();
  });

  it('returns null when no workspace mount matches', () => {
    mockExecFileSync
      .mockReturnValueOnce('container-abc')
      .mockReturnValueOnce(JSON.stringify([
        { Source: '/other/project', Destination: '/workspaces/other' },
      ]));

    const result = (cm as any)._findRunningContainerSync('/test/project');
    expect(result).toBeNull();
  });

  it('returns ContainerInfo when mount matches', () => {
    mockExecFileSync
      .mockReturnValueOnce('container-abc')
      .mockReturnValueOnce(JSON.stringify([
        { Source: '/test/project', Destination: '/workspaces/test-project' },
      ]));

    const result = (cm as any)._findRunningContainerSync('/test/project');
    expect(result).toEqual({
      containerId: 'container-abc',
      remoteWorkspaceFolder: '/workspaces/test-project',
    });
  });

  it('returns null when docker inspect fails', () => {
    mockExecFileSync
      .mockReturnValueOnce('container-abc')
      .mockImplementationOnce(() => { throw new Error('Docker inspect failed'); });

    const result = (cm as any)._findRunningContainerSync('/test/project');
    expect(result).toBeNull();
  });

  it('normalizes project root path when comparing mounts', () => {
    mockExecFileSync
      .mockReturnValueOnce('container-xyz')
      .mockReturnValueOnce(JSON.stringify([
        { Source: 'C:\\Users\\test\\project', Destination: '/workspaces/project' },
      ]));

    const result = (cm as any)._findRunningContainerSync('c:\\users\\test\\project');
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

  it('falls back to Docker label scan when no in-memory record', () => {
    // No liveness check needed — no in-memory record to validate
    mockExecFileSync
      .mockReturnValueOnce('container-found')
      .mockReturnValueOnce(JSON.stringify([
        { Source: '/test/project', Destination: '/workspaces/test' },
      ]));

    const info = cm.getRunningContainer('/test/project');
    expect(info).toEqual({
      containerId: 'container-found',
      remoteWorkspaceFolder: '/workspaces/test',
    });

    const record = (cm as any).records.get('/test/project');
    expect(record).not.toBeNull();
    expect(record.containerId).toBe('container-found');
  });

  it('returns null when Docker scan also fails', () => {
    mockExecFileSync.mockImplementation(() => { throw new Error('Docker unavailable'); });
    const info = cm.getRunningContainer('/test/project');
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
    mockExecFileSync
      .mockReturnValueOnce('existing-container')
      .mockReturnValueOnce(JSON.stringify([
        { Source: '/test/project', Destination: '/workspaces/test' },
      ]));

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

  it('returns remoteUser from devcontainer.json when present', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify({ remoteUser: 'developer' }));

    const result = readContainerRemoteUser('/test/project');
    expect(result).toBe('developer');
  });

  it('falls back to node when devcontainer.json has no remoteUser', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify({ image: 'node:20' }));

    const result = readContainerRemoteUser('/test/project');
    expect(result).toBe('node');
  });

  it('falls back to node when devcontainer.json does not exist', () => {
    mockExistsSync.mockReturnValue(false);

    const result = readContainerRemoteUser('/test/project');
    expect(result).toBe('node');
  });

  it('falls back to node when devcontainer.json is invalid JSON', () => {
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

  it('handles state lookup with no Docker and no record', () => {
    mockExecFileSync.mockImplementation(() => { throw new Error('No Docker'); });

    const state = cm.getState('/test/project');
    expect(state).toBe('stopped');
    expect(mockExecFileSync).toHaveBeenCalledWith(
      'docker',
      expect.arrayContaining(['ps', '-a']),
      expect.any(Object),
    );
  });

  it('returns state from in-memory record without calling Docker', () => {
    (cm as any).records.set('/test/project', {
      projectRoot: '/test/project',
      state: 'starting',
      containerId: null,
      remoteWorkspaceFolder: null,
      startPromise: null,
      eventWatcher: null,
    });

    const state = cm.getState('/test/project');
    expect(state).toBe('starting');
    expect(mockExecFileSync).not.toHaveBeenCalled();
  });
});
