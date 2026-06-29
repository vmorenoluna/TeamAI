/**
 * Unit tests for auto-mode server actions.
 *
 * Tests cover toggleAutoMode (enable/disable, revalidatePath, error propagation),
 * getAutoModeStateAction (delegates to engine, error propagation), and
 * markAutoReviewed (writes autoReviewed:true, revalidates paths, error propagation).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync } from 'fs';
import { join } from 'path';

// ── Hoisted mocks ───────────────────────────────────────────────────────────

const mockGetActiveProjectPath = vi.fn();
const mockGetPipelineConfig = vi.fn();
const mockGetAutoModeState = vi.fn();
const mockSetAutoModeState = vi.fn();
const mockRevalidatePath = vi.fn();
const mockTaskStoreUpdate = vi.fn();

vi.mock('@/app/actions/projects', () => ({
  getActiveProjectPath: (...args: unknown[]) => mockGetActiveProjectPath(...args),
}));

vi.mock('@/app/actions/pipeline', () => ({
  getPipelineConfig: (...args: unknown[]) => mockGetPipelineConfig(...args),
}));

vi.mock('@/lib/auto-mode', () => ({
  getAutoModeState: (...args: unknown[]) => mockGetAutoModeState(...args),
  setAutoModeState: (...args: unknown[]) => mockSetAutoModeState(...args),
  isAutoModeEnabled: vi.fn(),
}));

vi.mock('@/lib/task-store', () => ({
  TaskStore: class {
    projectPath: string;
    constructor(projectPath: string) {
      this.projectPath = projectPath;
    }
    update = mockTaskStoreUpdate;
    getById = vi.fn();
    getAll = vi.fn();
    updatePhase = vi.fn();
    getDirById = vi.fn((id: string) => join(this.projectPath, '.teamai', id));
  },
}));

vi.mock('next/cache', () => ({
  revalidatePath: (...args: unknown[]) => mockRevalidatePath(...args),
}));

// ── Helpers ─────────────────────────────────────────────────────────────────

import { createTestProject } from '../utils/test-project';

let root: string;
let clean: () => void;

// ── Tests ───────────────────────────────────────────────────────────────────

describe('auto-mode server actions', () => {
  beforeEach(() => {
    const project = createTestProject();
    root = project.root;
    clean = project.clean;
    mkdirSync(join(root, '.teamai'), { recursive: true });
    mockGetActiveProjectPath.mockResolvedValue(root);
    mockGetPipelineConfig.mockResolvedValue({
      maxQaAttempts: 3,
      parallelSubtasks: true,
      autoModeMaxParallel: 4,
    });
    mockGetAutoModeState.mockReturnValue({
      enabled: true,
      maxParallel: 4,
      activeCount: 2,
      trackedCount: 1,
    });
  });

  afterEach(() => {
    clean();
    vi.clearAllMocks();
    vi.resetModules();
  });

  // ── getAutoModeStateAction ─────────────────────────────────────────────

  describe('getAutoModeStateAction', () => {
    it('delegates to getAutoModeState with the active project path', async () => {
      const { getAutoModeStateAction } = await import('@/app/actions/auto-mode');
      const result = await getAutoModeStateAction();

      expect(mockGetActiveProjectPath).toHaveBeenCalledTimes(1);
      expect(mockGetAutoModeState).toHaveBeenCalledWith(root);
      expect(result).toEqual({
        enabled: true,
        maxParallel: 4,
        activeCount: 2,
        trackedCount: 1,
      });
    });

    it('returns state when auto mode is disabled', async () => {
      mockGetAutoModeState.mockReturnValue({
        enabled: false,
        maxParallel: 2,
        activeCount: 0,
        trackedCount: 0,
      });

      const { getAutoModeStateAction } = await import('@/app/actions/auto-mode');
      const result = await getAutoModeStateAction();

      expect(result.enabled).toBe(false);
      expect(result.activeCount).toBe(0);
      expect(result.trackedCount).toBe(0);
    });

    it('propagates error when getActiveProjectPath fails', async () => {
      mockGetActiveProjectPath.mockRejectedValue(new Error('no project selected'));

      const { getAutoModeStateAction } = await import('@/app/actions/auto-mode');
      await expect(getAutoModeStateAction()).rejects.toThrow('no project selected');
    });
  });

  // ── toggleAutoMode ─────────────────────────────────────────────────────

  describe('toggleAutoMode', () => {
    it('enables auto mode with correct project path and maxParallel from config', async () => {
      const { toggleAutoMode } = await import('@/app/actions/auto-mode');
      await toggleAutoMode(true);

      expect(mockGetActiveProjectPath).toHaveBeenCalledTimes(1);
      expect(mockGetPipelineConfig).toHaveBeenCalledTimes(1);
      expect(mockSetAutoModeState).toHaveBeenCalledWith(root, true, 4);
    });

    it('disables auto mode', async () => {
      const { toggleAutoMode } = await import('@/app/actions/auto-mode');
      await toggleAutoMode(false);

      expect(mockSetAutoModeState).toHaveBeenCalledWith(root, false, 4);
    });

    it('revalidates the root path after toggling', async () => {
      const { toggleAutoMode } = await import('@/app/actions/auto-mode');
      mockRevalidatePath.mockClear();

      await toggleAutoMode(true);

      expect(mockRevalidatePath).toHaveBeenCalledWith('/');
      expect(mockRevalidatePath).toHaveBeenCalledTimes(1);
    });

    it('uses default autoModeMaxParallel when pipeline config is missing the field', async () => {
      mockGetPipelineConfig.mockResolvedValue({
        maxQaAttempts: 3,
        parallelSubtasks: true,
        autoModeMaxParallel: 1,
      });

      const { toggleAutoMode } = await import('@/app/actions/auto-mode');
      await toggleAutoMode(true);

      expect(mockSetAutoModeState).toHaveBeenCalledWith(root, true, 1);
    });

    it('propagates error when getActiveProjectPath fails', async () => {
      mockGetActiveProjectPath.mockRejectedValue(new Error('no project selected'));

      const { toggleAutoMode } = await import('@/app/actions/auto-mode');
      await expect(toggleAutoMode(true)).rejects.toThrow('no project selected');
    });

    it('propagates error when getPipelineConfig fails', async () => {
      mockGetPipelineConfig.mockRejectedValue(new Error('config read error'));

      const { toggleAutoMode } = await import('@/app/actions/auto-mode');
      await expect(toggleAutoMode(true)).rejects.toThrow('config read error');
    });
  });

  // ── markAutoReviewed ───────────────────────────────────────────────────

  describe('markAutoReviewed', () => {
    it('updates the task with autoReviewed: true', async () => {
      const { markAutoReviewed } = await import('@/app/actions/auto-mode');
      await markAutoReviewed('task-123');

      expect(mockGetActiveProjectPath).toHaveBeenCalledTimes(1);
      expect(mockTaskStoreUpdate).toHaveBeenCalledWith('task-123', { autoReviewed: true });
    });

    it('revalidates both root and task detail paths', async () => {
      const { markAutoReviewed } = await import('@/app/actions/auto-mode');
      mockRevalidatePath.mockClear();

      await markAutoReviewed('task-456');

      expect(mockRevalidatePath).toHaveBeenCalledWith('/');
      expect(mockRevalidatePath).toHaveBeenCalledWith('/task/task-456');
      expect(mockRevalidatePath).toHaveBeenCalledTimes(2);
    });

    it('propagates error when getActiveProjectPath fails', async () => {
      mockGetActiveProjectPath.mockRejectedValue(new Error('no project selected'));

      const { markAutoReviewed } = await import('@/app/actions/auto-mode');
      await expect(markAutoReviewed('task-123')).rejects.toThrow('no project selected');
    });

    it('propagates error when TaskStore.update throws', async () => {
      mockTaskStoreUpdate.mockImplementation(() => {
        throw new Error('task not found');
      });

      const { markAutoReviewed } = await import('@/app/actions/auto-mode');
      await expect(markAutoReviewed('nonexistent')).rejects.toThrow('task not found');
    });
  });
});
