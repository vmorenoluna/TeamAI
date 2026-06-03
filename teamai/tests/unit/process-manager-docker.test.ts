/**
 * Tests for ProcessManager.createSession with container (Docker) mode enabled.
 * Covers the docker exec spawn path (lines ~73-90 of process-manager.ts).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';

// ── Hoisted mocks ──

const { mockReadContainerConfig, mockReadContainerRemoteUser, mockEnsureContainer, mockHostToContainerPath } = vi.hoisted(() => ({
  mockReadContainerConfig: vi.fn(),
  mockReadContainerRemoteUser: vi.fn(() => 'node'),
  mockEnsureContainer: vi.fn(),
  mockHostToContainerPath: vi.fn(),
}));

const { mockSpawn } = vi.hoisted(() => ({
  mockSpawn: vi.fn(),
}));

const { mockRandomUUID } = vi.hoisted(() => ({
  mockRandomUUID: vi.fn(() => 'test-session-id-123'),
}));

vi.mock('../../src/lib/container-manager', () => ({
  readContainerConfig: mockReadContainerConfig,
  readContainerRemoteUser: mockReadContainerRemoteUser,
  containerManager: { ensureContainer: mockEnsureContainer },
  hostToContainerPath: mockHostToContainerPath,
}));

vi.mock('child_process', () => ({
  spawn: mockSpawn,
  execFileSync: vi.fn(),
}));

vi.mock('crypto', () => ({
  randomUUID: mockRandomUUID,
}));

// ── Imports ──

import { ProcessManager } from '../../src/lib/process-manager';

// ── Helpers ──

function createMockProcess() {
  const proc = new EventEmitter() as any;
  proc.stdout = new EventEmitter() as any;
  proc.stderr = new EventEmitter() as any;
  proc.stdout.writable = true;
  proc.stderr.writable = true;
  proc.stdin = { writable: true, write: vi.fn() };
  proc.kill = vi.fn();
  proc.exitCode = null;
  proc.killed = false;
  proc.pid = 12345;
  return proc;
}

// ── Tests ──

describe('ProcessManager createSession — Docker container mode', () => {
  let pm: ProcessManager;

  beforeEach(() => {
    vi.clearAllMocks();
    pm = new ProcessManager();
  });

  it('spawns docker exec when container mode is enabled', async () => {
    mockReadContainerConfig.mockReturnValue({ enabled: true });
    mockEnsureContainer.mockResolvedValue({
      containerId: 'docker-container-abc',
      remoteWorkspaceFolder: '/workspace',
    });
    mockHostToContainerPath.mockReturnValue('/workspace/src');
    const mockProc = createMockProcess();
    mockSpawn.mockReturnValue(mockProc);

    const sessionId = await pm.createSession({
      taskId: 'task-1',
      role: 'coder',
      cwd: '/host/project/src',
      projectRoot: '/host/project',
    });

    expect(sessionId).toBe('test-session-id-123');
    expect(mockReadContainerConfig).toHaveBeenCalledWith('/host/project');
    expect(mockEnsureContainer).toHaveBeenCalledWith('/host/project', undefined);
    expect(mockHostToContainerPath).toHaveBeenCalledWith(
      '/host/project/src', '/host/project', '/workspace'
    );

    // Should spawn docker exec with the right args
    expect(mockSpawn).toHaveBeenCalledWith(
      'docker',
      expect.arrayContaining([
        'exec', '-i',
        '-u', 'node',
        '-w', '/workspace/src',
        'docker-container-abc',
        'claude',
        '-p',
        '--input-format', 'stream-json',
        '--output-format', 'stream-json',
        '--verbose',
        '--dangerously-skip-permissions',
      ]),
      { stdio: ['pipe', 'pipe', 'pipe'] },
    );
  });

  it('includes env flags when env is provided', async () => {
    mockReadContainerConfig.mockReturnValue({ enabled: true });
    mockEnsureContainer.mockResolvedValue({
      containerId: 'container-abc',
      remoteWorkspaceFolder: '/workspace',
    });
    mockHostToContainerPath.mockReturnValue('/workspace/src');
    const mockProc = createMockProcess();
    mockSpawn.mockReturnValue(mockProc);

    await pm.createSession({
      taskId: 'task-2',
      role: 'planner',
      cwd: '/host/project',
      projectRoot: '/host/project',
      env: { ANTHROPIC_API_KEY: 'sk-xxx', MODEL: 'claude-4' },
    });

    expect(mockSpawn).toHaveBeenCalledWith(
      'docker',
      expect.arrayContaining([
        '-e', 'ANTHROPIC_API_KEY=sk-xxx',
        '-e', 'MODEL=claude-4',
      ]),
      expect.any(Object),
    );
  });

  it('falls back to direct claude spawn when container mode is disabled', async () => {
    mockReadContainerConfig.mockReturnValue({ enabled: false });
    const mockProc = createMockProcess();
    mockSpawn.mockReturnValue(mockProc);

    await pm.createSession({
      taskId: 'task-3',
      role: 'coder',
      cwd: '/host/project/src',
      projectRoot: '/host/project',
    });

    expect(mockEnsureContainer).not.toHaveBeenCalled();
    expect(mockSpawn).toHaveBeenCalledWith(
      'claude',
      expect.arrayContaining(['-p', '--input-format', 'stream-json', '--output-format', 'stream-json']),
      expect.objectContaining({ cwd: '/host/project/src' }),
    );
  });

  it('includes --permission-mode when container mode is disabled and permissionMode is set', async () => {
    mockReadContainerConfig.mockReturnValue({ enabled: false });
    const mockProc = createMockProcess();
    mockSpawn.mockReturnValue(mockProc);

    await pm.createSession({
      taskId: 'task-4',
      role: 'general',
      cwd: '/project',
      projectRoot: '/project',
      permissionMode: 'someMode',
    });

    expect(mockSpawn).toHaveBeenCalledWith(
      'claude',
      expect.arrayContaining(['--permission-mode', 'someMode']),
      expect.any(Object),
    );
  });

  it('skips --permission-mode when container mode is enabled (uses --dangerously-skip-permissions instead)', async () => {
    mockReadContainerConfig.mockReturnValue({ enabled: true });
    mockEnsureContainer.mockResolvedValue({
      containerId: 'cont-xyz',
      remoteWorkspaceFolder: '/workspace',
    });
    mockHostToContainerPath.mockReturnValue('/workspace');
    const mockProc = createMockProcess();
    mockSpawn.mockReturnValue(mockProc);

    await pm.createSession({
      taskId: 'task-5',
      role: 'coder',
      cwd: '/project/src',
      projectRoot: '/project',
      permissionMode: 'bypassPermissions',
    });

    // Should NOT include --permission-mode
    const spawnCall = mockSpawn.mock.calls[0];
    const spawnArgs = spawnCall[1] as string[];
    expect(spawnArgs).not.toContain('--permission-mode');
    expect(spawnArgs).toContain('--dangerously-skip-permissions');
  });

  it('includes model flag when specified', async () => {
    mockReadContainerConfig.mockReturnValue({ enabled: true });
    mockEnsureContainer.mockResolvedValue({
      containerId: 'cont-xyz',
      remoteWorkspaceFolder: '/workspace',
    });
    mockHostToContainerPath.mockReturnValue('/workspace');
    const mockProc = createMockProcess();
    mockSpawn.mockReturnValue(mockProc);

    await pm.createSession({
      taskId: 'task-6',
      role: 'coder',
      cwd: '/project',
      projectRoot: '/project',
      model: 'deepseek/deepseek-v4',
    });

    expect(mockSpawn).toHaveBeenCalledWith(
      'docker',
      expect.arrayContaining(['--model', 'deepseek/deepseek-v4']),
      expect.any(Object),
    );
  });
});
