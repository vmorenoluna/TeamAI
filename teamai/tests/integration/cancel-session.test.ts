/**
 * Integration tests for the cancel flow with a real ProcessManager.
 *
 * Verifies that cancelRoadmapGeneration and cancelIdeationScan:
 *  1. Kill the underlying child process (SIGTERM)
 *  2. Set the session status to 'done'
 *  3. Remove the session from the tracking map
 *  4. Are no-ops when no active session exists (no crash)
 *
 * Strategy:
 *  We avoid statically importing process-manager so the module is only
 *  loaded when a test dynamically imports an action.  Before each test we
 *  delete global.__processManager and let the fresh module init create its
 *  own singleton (accessible via global.__processManager).  Sessions are
 *  created directly on that singleton — bypassing startRoadmapGeneration /
 *  startIdeationScan to avoid pulling in the providers.ts dependency chain.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';

// ── Hoisted mocks ───────────────────────────────────────────────────────────

const { mockSpawn, mockExecFileSync } = vi.hoisted(() => ({
  mockSpawn: vi.fn(),
  mockExecFileSync: vi.fn(),
}));

vi.mock('child_process', () => ({
  spawn: mockSpawn,
  execFile: vi.fn(),
  execFileSync: mockExecFileSync,
  ChildProcess: class MockChildProcess {},
}));

vi.mock('node-pty', () => ({
  spawn: vi.fn(),
}));

vi.mock('../../src/lib/container-manager', () => ({
  readContainerConfig: vi.fn(() => ({ enabled: false })),
  readContainerRemoteUser: vi.fn(() => 'node'),
  containerManager: {
    ensureContainer: vi.fn(),
    getRunningContainer: vi.fn(() => null),
  },
  hostToContainerPath: vi.fn((p: string) => p),
}));

const mockGetActiveProjectPath = vi.fn();

vi.mock('@/app/actions/projects', () => ({
  getActiveProjectPath: (...args: unknown[]) => mockGetActiveProjectPath(...args),
}));

// ── Helpers ─────────────────────────────────────────────────────────────────

let projectDir: string;

function initProject() {
  projectDir = join(tmpdir(), `teamai-cancel-integ-${randomUUID().slice(0, 8)}`);
  mkdirSync(projectDir, { recursive: true });
  mockGetActiveProjectPath.mockResolvedValue(projectDir);
  mockExecFileSync.mockReturnValue('claude');
}

function cleanupProject() {
  if (projectDir && existsSync(projectDir)) {
    try { rmSync(projectDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
}

interface MockChild {
  kill: ReturnType<typeof vi.fn>;
  exitCode: number | null;
  killed: boolean;
  stdin: { writable: boolean; write: ReturnType<typeof vi.fn> };
  stdout: { on: ReturnType<typeof vi.fn> };
  stderr: { on: ReturnType<typeof vi.fn> };
  on: ReturnType<typeof vi.fn>;
  _emitExit: (code: number | null) => void;
}

function mockChildProcess(): MockChild {
  const exitHandlers: Array<(code: number | null) => void> = [];
  const onMock = vi.fn((event: string, handler: (...args: unknown[]) => void) => {
    if (event === 'exit') exitHandlers.push(handler as (code: number | null) => void);
  });
  const proc: MockChild = {
    kill: vi.fn(),
    exitCode: null,
    killed: false,
    stdin: { writable: true, write: vi.fn() },
    stdout: { on: vi.fn() },
    stderr: { on: vi.fn() },
    on: onMock as unknown as ReturnType<typeof vi.fn>,
    _emitExit: (code: number | null) => {
      for (const h of exitHandlers) h(code);
    },
  };
  mockSpawn.mockReturnValue(proc);
  return proc;
}

/** Access the ProcessManager singleton (created fresh per test by module init). */
function getPm(): any {
  const pm = (global as Record<string, unknown>).__processManager;
  if (!pm) throw new Error('ProcessManager not initialised — did the test import an action yet?');
  return pm;
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('Cancel Session Integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Delete previous singleton so a fresh one is created when the module
    // is next imported (triggered by dynamic import of an action).
    delete (global as Record<string, unknown>).__processManager;
    initProject();
    (global as Record<string, unknown>).__roadmapSessions = new Map();
    (global as Record<string, unknown>).__ideationSessions = new Map();
  });

  afterEach(() => {
    cleanupProject();
    vi.resetModules();
    delete (global as Record<string, unknown>).__processManager;
    delete (global as Record<string, unknown>).__roadmapSessions;
    delete (global as Record<string, unknown>).__ideationSessions;
  });

  // ── cancelRoadmapGeneration ─────────────────────────────────────────

  describe('cancelRoadmapGeneration', () => {
    it('kills the child process and removes session from tracking map', async () => {
      const proc = mockChildProcess();

      // Import the action — this triggers process-manager module init which
      // reads global.__processManager (deleted in beforeEach → creates a new one).
      const { cancelRoadmapGeneration } = await import('@/app/actions/roadmap');
      const pm = getPm();

      const sessionId = await pm.createSession({
        taskId: `roadmap::${projectDir}`,
        role: 'general',
        cwd: projectDir,
      });

      const rmMap = (global as Record<string, unknown>).__roadmapSessions as Map<string, string>;
      rmMap.set(`roadmap::${projectDir}`, sessionId);

      expect(pm.getSession(sessionId).status).toBe('running');

      await cancelRoadmapGeneration('roadmap');

      expect(proc.kill).toHaveBeenCalledWith('SIGTERM');
      expect(pm.getSession(sessionId).status).toBe('done');
      expect(rmMap.has(`roadmap::${projectDir}`)).toBe(false);
    });

    it('does not crash when cancelling with no active session (idempotent)', async () => {
      const { cancelRoadmapGeneration } = await import('@/app/actions/roadmap');
      await expect(cancelRoadmapGeneration('roadmap')).resolves.toBeUndefined();
    });
  });

  // ── cancelIdeationScan ──────────────────────────────────────────────

  describe('cancelIdeationScan', () => {
    it('kills the child process and removes session from tracking map', async () => {
      const proc = mockChildProcess();
      const { cancelIdeationScan } = await import('@/app/actions/ideation');
      const pm = getPm();

      const sessionId = await pm.createSession({
        taskId: `ideation::${projectDir}`,
        role: 'general',
        cwd: projectDir,
      });

      const ideationMap = (global as Record<string, unknown>).__ideationSessions as Map<string, string>;
      ideationMap.set(projectDir, sessionId);

      expect(pm.getSession(sessionId).status).toBe('running');

      await cancelIdeationScan();

      expect(proc.kill).toHaveBeenCalledWith('SIGTERM');
      expect(pm.getSession(sessionId).status).toBe('done');
      expect(ideationMap.has(projectDir)).toBe(false);
    });

    it('does not crash when cancelling with no active session (idempotent)', async () => {
      const { cancelIdeationScan } = await import('@/app/actions/ideation');
      await expect(cancelIdeationScan()).resolves.toBeUndefined();
    });
  });

  // ── Cancel + re-create ──────────────────────────────────────────────

  describe('cancel and re-create', () => {
    it('allows a new session to be created after the previous one is cancelled', async () => {
      const { cancelRoadmapGeneration } = await import('@/app/actions/roadmap');
      const pm = getPm();
      const rmMap = (global as Record<string, unknown>).__roadmapSessions as Map<string, string>;

      const firstProc = mockChildProcess();
      const firstId = await pm.createSession({
        taskId: `roadmap::${projectDir}`,
        role: 'general',
        cwd: projectDir,
      });
      rmMap.set(`roadmap::${projectDir}`, firstId);

      await cancelRoadmapGeneration('roadmap');
      expect(firstProc.kill).toHaveBeenCalled();
      expect(rmMap.has(`roadmap::${projectDir}`)).toBe(false);

      const secondProc = mockChildProcess();
      const secondId = await pm.createSession({
        taskId: `roadmap::${projectDir}`,
        role: 'general',
        cwd: projectDir,
      });
      rmMap.set(`roadmap::${projectDir}`, secondId);

      expect(secondId).not.toBe(firstId);
      expect(pm.getSession(secondId).status).toBe('running');

      await cancelRoadmapGeneration('roadmap');
      expect(secondProc.kill).toHaveBeenCalled();
    });
  });

  // ── SIGKILL fallback (5-second timer) ───────────────────────────────

  describe('SIGKILL fallback', () => {
    it('schedules a SIGKILL after 5 seconds if process ignores SIGTERM', async () => {
      vi.useFakeTimers();
      const proc = mockChildProcess();
      const { cancelRoadmapGeneration } = await import('@/app/actions/roadmap');
      const pm = getPm();

      const sessionId = await pm.createSession({
        taskId: `roadmap::${projectDir}`,
        role: 'general',
        cwd: projectDir,
      });

      const rmMap = (global as Record<string, unknown>).__roadmapSessions as Map<string, string>;
      rmMap.set(`roadmap::${projectDir}`, sessionId);

      await cancelRoadmapGeneration('roadmap');

      expect(proc.kill).toHaveBeenCalledWith('SIGTERM');
      expect(proc.kill).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(5_000);

      expect(proc.kill).toHaveBeenCalledWith('SIGKILL');
      expect(proc.kill).toHaveBeenCalledTimes(2);

      vi.useRealTimers();
    });

    it('does not send SIGKILL if process already exited (exitCode set)', async () => {
      vi.useFakeTimers();
      const proc = mockChildProcess();
      const { cancelRoadmapGeneration } = await import('@/app/actions/roadmap');
      const pm = getPm();

      const sessionId = await pm.createSession({
        taskId: `roadmap::${projectDir}`,
        role: 'general',
        cwd: projectDir,
      });

      const rmMap = (global as Record<string, unknown>).__roadmapSessions as Map<string, string>;
      rmMap.set(`roadmap::${projectDir}`, sessionId);

      await cancelRoadmapGeneration('roadmap');

      expect(proc.kill).toHaveBeenCalledWith('SIGTERM');
      expect(proc.kill).toHaveBeenCalledTimes(1);

      proc.exitCode = 0;
      proc._emitExit(0);

      vi.advanceTimersByTime(5_000);

      expect(proc.kill).toHaveBeenCalledTimes(1); // SIGTERM only

      vi.useRealTimers();
    });
  });
});
