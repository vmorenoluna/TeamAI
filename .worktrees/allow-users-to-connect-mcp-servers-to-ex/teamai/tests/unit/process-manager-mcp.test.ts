/**
 * Tests for ProcessManager.createSession --mcp-config flag injection.
 *
 * AC-7: native spawn includes --mcp-config <path> when mcpConfigPath is provided
 * AC-8: native spawn omits --mcp-config when mcpConfigPath is absent
 * AC-9: container spawn uses container-translated path for --mcp-config
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';

// ── Hoisted mocks ──

const { mockReadContainerConfig, mockEnsureContainer, mockHostToContainerPath } = vi.hoisted(() => ({
  mockReadContainerConfig: vi.fn(),
  mockEnsureContainer: vi.fn(),
  mockHostToContainerPath: vi.fn(),
}));

const { mockSpawn } = vi.hoisted(() => ({
  mockSpawn: vi.fn(),
}));

vi.mock('../../src/lib/container-manager', () => ({
  readContainerConfig: mockReadContainerConfig,
  containerManager: { ensureContainer: mockEnsureContainer },
  hostToContainerPath: mockHostToContainerPath,
}));

vi.mock('child_process', () => ({
  spawn: mockSpawn,
  execFileSync: vi.fn(),
}));

vi.mock('crypto', () => ({
  randomUUID: vi.fn(() => 'mcp-test-session-id'),
}));

vi.mock('node-pty', () => ({
  spawn: vi.fn(),
}));

vi.mock('fs', () => ({
  readFileSync: vi.fn(),
  existsSync: vi.fn(() => false),
  appendFileSync: vi.fn(),
}));

// ── Imports ──

import { ProcessManager } from '../../src/lib/process-manager';

// ── Helpers ──

function createMockProcess() {
  const proc = new EventEmitter() as any;
  proc.stdout = new EventEmitter() as any;
  proc.stderr = new EventEmitter() as any;
  proc.stdin = { writable: true, write: vi.fn() };
  proc.kill = vi.fn();
  proc.exitCode = null;
  proc.killed = false;
  proc.pid = 99999;
  return proc;
}

// ── Tests ──

describe('ProcessManager createSession — --mcp-config flag', () => {
  let pm: ProcessManager;

  beforeEach(() => {
    vi.clearAllMocks();
    pm = new ProcessManager();
  });

  // AC-7: native mode includes --mcp-config when mcpConfigPath is provided
  it('AC-7: includes --mcp-config in native spawn when mcpConfigPath is provided', async () => {
    mockReadContainerConfig.mockReturnValue({ enabled: false });
    mockSpawn.mockReturnValue(createMockProcess());

    await pm.createSession({
      taskId: 'task-ac7',
      role: 'coder',
      cwd: '/project',
      projectRoot: '/project',
      mcpConfigPath: '/project/.mcp/config.json',
    });

    expect(mockSpawn).toHaveBeenCalledWith(
      'claude',
      expect.arrayContaining(['--mcp-config', '/project/.mcp/config.json']),
      expect.any(Object),
    );
  });

  // AC-8: --mcp-config absent when mcpConfigPath is not provided
  it('AC-8: omits --mcp-config in native spawn when mcpConfigPath is absent', async () => {
    mockReadContainerConfig.mockReturnValue({ enabled: false });
    mockSpawn.mockReturnValue(createMockProcess());

    await pm.createSession({
      taskId: 'task-ac8',
      role: 'coder',
      cwd: '/project',
      projectRoot: '/project',
    });

    const spawnArgs = mockSpawn.mock.calls[0][1] as string[];
    expect(spawnArgs).not.toContain('--mcp-config');
  });

  // AC-9: container mode translates host mcpConfigPath to container path
  it('AC-9: translates mcpConfigPath to container path in container mode', async () => {
    mockReadContainerConfig.mockReturnValue({ enabled: true });
    mockEnsureContainer.mockResolvedValue({
      containerId: 'cont-ac9',
      remoteWorkspaceFolder: '/workspace',
    });
    // First call: translate cwd; second call: translate mcpConfigPath
    mockHostToContainerPath
      .mockReturnValueOnce('/workspace/src')
      .mockReturnValueOnce('/workspace/.mcp/config.json');
    mockSpawn.mockReturnValue(createMockProcess());

    await pm.createSession({
      taskId: 'task-ac9',
      role: 'coder',
      cwd: '/host/project/src',
      projectRoot: '/host/project',
      mcpConfigPath: '/host/project/.mcp/config.json',
    });

    expect(mockHostToContainerPath).toHaveBeenCalledWith(
      '/host/project/.mcp/config.json', '/host/project', '/workspace',
    );
    expect(mockSpawn).toHaveBeenCalledWith(
      'docker',
      expect.arrayContaining(['--mcp-config', '/workspace/.mcp/config.json']),
      expect.any(Object),
    );
    // Confirm the translated path (not the host path) is used
    const spawnArgs = mockSpawn.mock.calls[0][1] as string[];
    const idx = spawnArgs.indexOf('--mcp-config');
    expect(spawnArgs[idx + 1]).toBe('/workspace/.mcp/config.json');
  });
});
