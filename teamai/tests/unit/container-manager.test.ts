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

// ── Hoisted mocks ──

const { mockExecFileSync, mockSpawn, mockExistsSync, mockReadFileSync, mockLogError, mockLogWarn } = vi.hoisted(() => ({
  mockExecFileSync: vi.fn(),
  mockSpawn: vi.fn(),
  mockExistsSync: vi.fn(),
  mockReadFileSync: vi.fn(),
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

import { ContainerManager, readContainerConfig, hostToContainerPath, containerManager, dockerAvailable, _resetDockerAvailableCache } from '../../src/lib/container-manager';

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
    expect(result).toEqual({ enabled: true });
  });

  it('returns enabled: false when container.json says disabled', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify({ enabled: false }));
    const result = readContainerConfig('/test/project');
    expect(result).toEqual({ enabled: false });
  });

  it('logs warning on invalid JSON and falls back to dockerAvailable', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue('{invalid}');
    mockExecFileSync.mockReturnValue(''); // docker available
    const result = readContainerConfig('/test/project');
    expect(result).toEqual({ enabled: true });
    expect(mockLogWarn).toHaveBeenCalledWith('container', 'Failed to parse container config, using defaults', expect.any(Error));
  });

  it('returns dockerAvailable result when container.json missing and docker is available', () => {
    mockExistsSync.mockReturnValue(false);
    mockExecFileSync.mockReturnValue(''); // docker available
    const result = readContainerConfig('/test/project');
    expect(result).toEqual({ enabled: true });
  });

  it('returns disabled when container.json missing and docker unavailable', () => {
    mockExistsSync.mockReturnValue(false);
    mockExecFileSync.mockImplementation(() => { throw new Error('no docker'); });
    const result = readContainerConfig('/test/project');
    expect(result).toEqual({ enabled: false });
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

    it('returns container info when container is running', () => {
      (cm as any).records.set('/test', {
        projectRoot: '/test',
        state: 'running',
        containerId: 'abc123',
        remoteWorkspaceFolder: '/workspace',
        startPromise: null,
        eventWatcher: null,
      });
      const info = cm.getRunningContainer('/test');
      expect(info).toEqual({ containerId: 'abc123', remoteWorkspaceFolder: '/workspace' });
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
