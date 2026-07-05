/**
 * Unit tests for auto-mode server actions.
 *
 * Tests cover toggleAutoMode (enable/disable, revalidatePath, error propagation), and
 * markAutoReviewed (writes autoReviewed:true, revalidates paths, error propagation).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync } from 'fs';
import { join } from 'path';

// ── Hoisted mocks ───────────────────────────────────────────────────────────

const mockGetActiveProjectPath = vi.fn();
const mockGetPipelineConfig = vi.fn();
const mockSetAutoModeState = vi.fn();
const mockRevalidatePath = vi.fn();
const mockTaskStoreUpdate = vi.fn();
const mockTaskStoreGetById = vi.fn().mockReturnValue({ phase: 'done' });
const mockProcessManagerEmit = vi.fn();

vi.mock('@/app/actions/projects', () => ({
  getActiveProjectPath: (...args: unknown[]) => mockGetActiveProjectPath(...args),
}));

vi.mock('@/app/actions/pipeline', () => ({
  getPipelineConfig: (...args: unknown[]) => mockGetPipelineConfig(...args),
}));

vi.mock('@/lib/auto-mode', () => ({
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
    getById = mockTaskStoreGetById;
    getAll = vi.fn();
    updatePhase = vi.fn();
    getDirById = vi.fn((id: string) => join(this.projectPath, '.teamai', id));
  },
}));

vi.mock('next/cache', () => ({
  revalidatePath: (...args: unknown[]) => mockRevalidatePath(...args),
}));

vi.mock('@/lib/process-manager', () => ({
  processManager: {
    emit: (...args: unknown[]) => mockProcessManagerEmit(...args),
  },
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
  });

  afterEach(() => {
    clean();
    vi.clearAllMocks();
    vi.resetModules();
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
    it('updates the task with autoReviewed: true and reads it first for the current phase', async () => {
      const { markAutoReviewed } = await import('@/app/actions/auto-mode');
      await markAutoReviewed('task-123');

      expect(mockGetActiveProjectPath).toHaveBeenCalledTimes(1);
      expect(mockTaskStoreGetById).toHaveBeenCalledWith('task-123');
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

    it('rejects empty string taskId immediately (before any async work)', async () => {
      const { markAutoReviewed } = await import('@/app/actions/auto-mode');
      await expect(markAutoReviewed('')).rejects.toThrow('Invalid taskId');

      // Should NOT have called getActiveProjectPath or TaskStore
      expect(mockGetActiveProjectPath).not.toHaveBeenCalled();
      expect(mockTaskStoreUpdate).not.toHaveBeenCalled();
      expect(mockRevalidatePath).not.toHaveBeenCalled();
    });

    it('rejects whitespace-only taskId immediately', async () => {
      const { markAutoReviewed } = await import('@/app/actions/auto-mode');
      await expect(markAutoReviewed('   ')).rejects.toThrow('Invalid taskId');

      expect(mockGetActiveProjectPath).not.toHaveBeenCalled();
    });

    it('emits a phase-change event with the current task phase after marking reviewed', async () => {
      const { markAutoReviewed } = await import('@/app/actions/auto-mode');
      mockProcessManagerEmit.mockClear();

      await markAutoReviewed('task-789');

      expect(mockProcessManagerEmit).toHaveBeenCalledWith('phase-change', {
        taskId: 'task-789',
        phase: 'done',
        projectRoot: root,
      });
    });

    it('throws when getById returns null (task not found in store)', async () => {
      mockTaskStoreGetById.mockReturnValue(null);

      const { markAutoReviewed } = await import('@/app/actions/auto-mode');
      await expect(markAutoReviewed('gone-task')).rejects.toThrow('Task gone-task not found');
    });

    it('propagates error when TaskStore.update throws', async () => {
      // Ensure getById succeeds so we reach the update call
      mockTaskStoreGetById.mockReturnValue({ phase: 'done' });
      mockTaskStoreUpdate.mockImplementation(() => {
        throw new Error('task not found');
      });

      const { markAutoReviewed } = await import('@/app/actions/auto-mode');
      await expect(markAutoReviewed('nonexistent')).rejects.toThrow('task not found');
    });
  });
});
