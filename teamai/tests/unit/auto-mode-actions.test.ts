/**
 * Unit tests for the auto-mode and terminal server actions.
 *
 * The actions are thin wrappers over the engine: these tests pin the wrapper contract
 * (method name, params containing projectPath, value returned unchanged, revalidated
 * paths). Toggling behaviour itself is covered by the engine handler tests.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Hoisted mocks ───────────────────────────────────────────────────────────

const mockGetActiveProjectPath = vi.fn();
const mockGetPipelineConfig = vi.fn();
const mockGetProvidersConfig = vi.fn();
const mockRevalidatePath = vi.fn();
const mockEngineCall = vi.fn();
const mockLogError = vi.fn();

vi.mock('@/app/actions/projects', () => ({
  getActiveProjectPath: (...args: unknown[]) => mockGetActiveProjectPath(...args),
}));

vi.mock('@/app/actions/pipeline', () => ({
  getPipelineConfig: (...args: unknown[]) => mockGetPipelineConfig(...args),
}));

vi.mock('@/app/actions/providers', () => ({
  getProvidersConfig: (...args: unknown[]) => mockGetProvidersConfig(...args),
}));

vi.mock('@/lib/providers', () => ({
  resolveTerminalModel: (role: string) => `model-for-${role}`,
}));

vi.mock('@/lib/logger', () => ({
  error: (...args: unknown[]) => mockLogError(...args),
}));

vi.mock('@/engine/engine-client', () => ({
  engineCall: (...args: unknown[]) => mockEngineCall(...args),
}));

vi.mock('next/cache', () => ({
  revalidatePath: (...args: unknown[]) => mockRevalidatePath(...args),
}));

const ROOT = '/projects/demo';

// ── Tests ───────────────────────────────────────────────────────────────────

describe('auto-mode server actions', () => {
  beforeEach(() => {
    mockGetActiveProjectPath.mockResolvedValue(ROOT);
    mockGetPipelineConfig.mockResolvedValue({ autoModeMaxParallel: 4 });
    mockEngineCall.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  describe('toggleAutoMode', () => {
    it('calls autoMode.toggle with projectPath, enabled and maxParallel from config', async () => {
      const { toggleAutoMode } = await import('@/app/actions/auto-mode');
      await toggleAutoMode(true);

      expect(mockEngineCall).toHaveBeenCalledTimes(1);
      expect(mockEngineCall).toHaveBeenCalledWith('autoMode.toggle', [{ projectPath: ROOT, enabled: true, maxParallel: 4 }]);
    });

    it('passes enabled=false through', async () => {
      const { toggleAutoMode } = await import('@/app/actions/auto-mode');
      await toggleAutoMode(false);

      expect(mockEngineCall).toHaveBeenCalledWith('autoMode.toggle', [{ projectPath: ROOT, enabled: false, maxParallel: 4 }]);
    });

    it('toggles when expectedProjectPath matches the active project', async () => {
      const { toggleAutoMode } = await import('@/app/actions/auto-mode');
      await toggleAutoMode(true, ROOT);

      expect(mockEngineCall).toHaveBeenCalledTimes(1);
    });

    it('refuses to toggle when expectedProjectPath differs from the active project', async () => {
      const { toggleAutoMode } = await import('@/app/actions/auto-mode');

      await expect(toggleAutoMode(false, '/projects/other')).rejects.toThrow('Active project changed');
      expect(mockEngineCall).not.toHaveBeenCalled();
      expect(mockRevalidatePath).not.toHaveBeenCalled();
    });

    it('revalidates the root path once after toggling', async () => {
      const { toggleAutoMode } = await import('@/app/actions/auto-mode');
      await toggleAutoMode(true);

      expect(mockRevalidatePath).toHaveBeenCalledWith('/');
      expect(mockRevalidatePath).toHaveBeenCalledTimes(1);
    });

    it('propagates an engine error without revalidating', async () => {
      mockEngineCall.mockRejectedValue(new Error('engine down'));

      const { toggleAutoMode } = await import('@/app/actions/auto-mode');
      await expect(toggleAutoMode(true)).rejects.toThrow('engine down');
      expect(mockRevalidatePath).not.toHaveBeenCalled();
    });

    it('propagates error when getActiveProjectPath fails', async () => {
      mockGetActiveProjectPath.mockRejectedValue(new Error('no project selected'));

      const { toggleAutoMode } = await import('@/app/actions/auto-mode');
      await expect(toggleAutoMode(true)).rejects.toThrow('no project selected');
      expect(mockEngineCall).not.toHaveBeenCalled();
    });

    it('propagates error when getPipelineConfig fails', async () => {
      mockGetPipelineConfig.mockRejectedValue(new Error('config read error'));

      const { toggleAutoMode } = await import('@/app/actions/auto-mode');
      await expect(toggleAutoMode(true)).rejects.toThrow('config read error');
      expect(mockEngineCall).not.toHaveBeenCalled();
    });
  });

  describe('markAutoReviewed', () => {
    it('calls autoMode.markReviewed with projectPath and taskId', async () => {
      const { markAutoReviewed } = await import('@/app/actions/auto-mode');
      await markAutoReviewed('task-123');

      expect(mockEngineCall).toHaveBeenCalledWith('autoMode.markReviewed', [{ projectPath: ROOT, taskId: 'task-123' }]);
    });

    it('revalidates both root and task detail paths', async () => {
      const { markAutoReviewed } = await import('@/app/actions/auto-mode');
      await markAutoReviewed('task-456');

      expect(mockRevalidatePath).toHaveBeenCalledWith('/');
      expect(mockRevalidatePath).toHaveBeenCalledWith('/task/task-456');
      expect(mockRevalidatePath).toHaveBeenCalledTimes(2);
    });

    it('rejects empty and whitespace-only taskId before any async work', async () => {
      const { markAutoReviewed } = await import('@/app/actions/auto-mode');
      await expect(markAutoReviewed('')).rejects.toThrow('Invalid taskId');
      await expect(markAutoReviewed('   ')).rejects.toThrow('Invalid taskId');

      expect(mockGetActiveProjectPath).not.toHaveBeenCalled();
      expect(mockEngineCall).not.toHaveBeenCalled();
      expect(mockRevalidatePath).not.toHaveBeenCalled();
    });

    it('propagates an engine error (e.g. task not found) without revalidating', async () => {
      mockEngineCall.mockRejectedValue(new Error('Task gone-task not found'));

      const { markAutoReviewed } = await import('@/app/actions/auto-mode');
      await expect(markAutoReviewed('gone-task')).rejects.toThrow('Task gone-task not found');
      expect(mockRevalidatePath).not.toHaveBeenCalled();
    });

    it('propagates error when getActiveProjectPath fails', async () => {
      mockGetActiveProjectPath.mockRejectedValue(new Error('no project selected'));

      const { markAutoReviewed } = await import('@/app/actions/auto-mode');
      await expect(markAutoReviewed('task-123')).rejects.toThrow('no project selected');
    });
  });
});

describe('terminal server actions', () => {
  beforeEach(() => {
    mockGetActiveProjectPath.mockResolvedValue(ROOT);
    mockGetProvidersConfig.mockResolvedValue({});
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  it('createTerminalSession calls terminals.create with the resolved model and returns the session', async () => {
    mockEngineCall.mockResolvedValue('sess-1');

    const { createTerminalSession } = await import('@/app/actions/terminals');
    const result = await createTerminalSession('coder');

    expect(mockEngineCall).toHaveBeenCalledWith('terminals.create', [{ projectPath: ROOT, role: 'coder', model: 'model-for-coder' }]);
    expect(result).toEqual({ sessionId: 'sess-1', role: 'coder', model: 'model-for-coder' });
  });

  it('createTerminalSession propagates an engine error', async () => {
    mockEngineCall.mockRejectedValue(new Error('engine down'));

    const { createTerminalSession } = await import('@/app/actions/terminals');
    await expect(createTerminalSession('coder')).rejects.toThrow('engine down');
  });

  it('closeTerminalSession calls terminals.close with the session id', async () => {
    mockEngineCall.mockResolvedValue(undefined);

    const { closeTerminalSession } = await import('@/app/actions/terminals');
    await closeTerminalSession('sess-1');

    expect(mockEngineCall).toHaveBeenCalledWith('terminals.close', [{ sessionId: 'sess-1' }]);
  });

  it('getActiveTerminals returns the engine list unchanged, with a 5s timeout', async () => {
    const list = [{ sessionId: 's', role: 'coder', model: 'm' }];
    mockEngineCall.mockResolvedValue(list);

    const { getActiveTerminals } = await import('@/app/actions/terminals');
    const result = await getActiveTerminals();

    expect(result).toBe(list);
    expect(mockEngineCall).toHaveBeenCalledWith('terminals.list', [{ projectPath: ROOT }], { timeoutMs: 5000 });
  });

  it('getActiveTerminals resolves [] and logs when the engine errors or times out', async () => {
    mockEngineCall.mockRejectedValue(new Error('timed out'));

    const { getActiveTerminals } = await import('@/app/actions/terminals');
    await expect(getActiveTerminals()).resolves.toEqual([]);
    expect(mockLogError).toHaveBeenCalledTimes(1);
  });

  it('getActiveTerminals resolves [] when the active project cannot be read', async () => {
    mockGetActiveProjectPath.mockRejectedValue(new Error('no project selected'));

    const { getActiveTerminals } = await import('@/app/actions/terminals');
    await expect(getActiveTerminals()).resolves.toEqual([]);
    expect(mockEngineCall).not.toHaveBeenCalled();
  });
});
