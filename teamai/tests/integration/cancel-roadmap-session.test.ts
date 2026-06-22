/**
 * Integration tests for the roadmap cancel flow with a real ProcessManager.
 *
 * Verifies that cancelRoadmapGeneration for both roadmap and changelog types:
 *  1. Kills the underlying child process (SIGTERM)
 *  2. Sets the session status to 'done'
 *  3. Removes the session from the tracking map
 *  4. Is a no-op when no active session exists (no crash)
 *  5. Allows re-creating a session after cancellation
 *
 * Also tests isRoadmapSessionAlive post-cancel and SIGKILL fallback.
 *
 * Strategy:
 *  We avoid statically importing process-manager so the module is only
 *  loaded when a test dynamically imports an action.  Before each test we
 *  delete global.__processManager and let the fresh module init create its
 *  own singleton (accessible via global.__processManager).  Sessions are
 *  created directly on that singleton — bypassing startRoadmapGeneration
 *  to avoid pulling in the providers.ts dependency chain.
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
  projectDir = join(tmpdir(), `teamai-cancel-rm-${randomUUID().slice(0, 8)}`);
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
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getPm(): any {
  const pm = (global as Record<string, unknown>).__processManager;
  if (!pm) throw new Error('ProcessManager not initialised — did the test import an action yet?');
  return pm;
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('Cancel Roadmap Session Integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete (global as Record<string, unknown>).__processManager;
    initProject();
    (global as Record<string, unknown>).__roadmapSessions = new Map();
  });

  afterEach(() => {
    cleanupProject();
    vi.resetModules();
    delete (global as Record<string, unknown>).__processManager;
    delete (global as Record<string, unknown>).__roadmapSessions;
  });

  // ── cancelRoadmapGeneration (roadmap) ─────────────────────────────────

  describe('cancelRoadmapGeneration — roadmap', () => {
    it('kills the child process and removes session from tracking map', async () => {
      const proc = mockChildProcess();

      const { cancelRoadmapGeneration } = await import('@/app/actions/roadmap');
      const pm = getPm();

      const sessionId = await pm.createSession({
        taskId: `roadmap::${projectDir}`,
        role: 'general',
        cwd: projectDir,
      });

      const roadmapMap = (global as Record<string, unknown>).__roadmapSessions as Map<string, string>;
      roadmapMap.set(`roadmap::${projectDir}`, sessionId);

      expect(pm.getSession(sessionId).status).toBe('running');

      await cancelRoadmapGeneration('roadmap');

      expect(proc.kill).toHaveBeenCalledWith('SIGTERM');
      expect(pm.getSession(sessionId).status).toBe('done');
      expect(roadmapMap.has(`roadmap::${projectDir}`)).toBe(false);
    });

    it('does not crash when cancelling with no active session (idempotent)', async () => {
      const { cancelRoadmapGeneration } = await import('@/app/actions/roadmap');
      await expect(cancelRoadmapGeneration('roadmap')).resolves.toBeUndefined();
    });
  });

  // ── cancelRoadmapGeneration (changelog) ──────────────────────────────

  describe('cancelRoadmapGeneration — changelog', () => {
    it('kills the child process and removes changelog session from tracking map', async () => {
      const proc = mockChildProcess();

      const { cancelRoadmapGeneration } = await import('@/app/actions/roadmap');
      const pm = getPm();

      const sessionId = await pm.createSession({
        taskId: `changelog::${projectDir}`,
        role: 'general',
        cwd: projectDir,
      });

      const roadmapMap = (global as Record<string, unknown>).__roadmapSessions as Map<string, string>;
      roadmapMap.set(`changelog::${projectDir}`, sessionId);

      await cancelRoadmapGeneration('changelog');

      expect(proc.kill).toHaveBeenCalledWith('SIGTERM');
      expect(pm.getSession(sessionId).status).toBe('done');
      expect(roadmapMap.has(`changelog::${projectDir}`)).toBe(false);
    });

    it('does not crash when cancelling changelog with no active session', async () => {
      const { cancelRoadmapGeneration } = await import('@/app/actions/roadmap');
      await expect(cancelRoadmapGeneration('changelog')).resolves.toBeUndefined();
    });
  });

  // ── Cancel + re-create ──────────────────────────────────────────────

  describe('cancel and re-create', () => {
    it('allows a new roadmap session after the previous one is cancelled', async () => {
      const { cancelRoadmapGeneration } = await import('@/app/actions/roadmap');
      const pm = getPm();
      const roadmapMap = (global as Record<string, unknown>).__roadmapSessions as Map<string, string>;

      const firstProc = mockChildProcess();
      const firstId = await pm.createSession({
        taskId: `roadmap::${projectDir}`,
        role: 'general',
        cwd: projectDir,
      });
      roadmapMap.set(`roadmap::${projectDir}`, firstId);

      await cancelRoadmapGeneration('roadmap');
      expect(firstProc.kill).toHaveBeenCalled();
      expect(roadmapMap.has(`roadmap::${projectDir}`)).toBe(false);

      const secondProc = mockChildProcess();
      const secondId = await pm.createSession({
        taskId: `roadmap::${projectDir}`,
        role: 'general',
        cwd: projectDir,
      });
      roadmapMap.set(`roadmap::${projectDir}`, secondId);

      expect(secondId).not.toBe(firstId);
      expect(pm.getSession(secondId).status).toBe('running');

      await cancelRoadmapGeneration('roadmap');
      expect(secondProc.kill).toHaveBeenCalled();
    });

    it('allows a new changelog session after the previous one is cancelled', async () => {
      const { cancelRoadmapGeneration } = await import('@/app/actions/roadmap');
      const pm = getPm();
      const roadmapMap = (global as Record<string, unknown>).__roadmapSessions as Map<string, string>;

      const firstProc = mockChildProcess();
      const firstId = await pm.createSession({
        taskId: `changelog::${projectDir}`,
        role: 'general',
        cwd: projectDir,
      });
      roadmapMap.set(`changelog::${projectDir}`, firstId);

      await cancelRoadmapGeneration('changelog');
      expect(firstProc.kill).toHaveBeenCalled();

      const secondProc = mockChildProcess();
      const secondId = await pm.createSession({
        taskId: `changelog::${projectDir}`,
        role: 'general',
        cwd: projectDir,
      });
      roadmapMap.set(`changelog::${projectDir}`, secondId);

      expect(secondId).not.toBe(firstId);
      expect(pm.getSession(secondId).status).toBe('running');

      await cancelRoadmapGeneration('changelog');
      expect(secondProc.kill).toHaveBeenCalled();
    });

    it('cancelling roadmap does not affect an active changelog session', async () => {
      const { cancelRoadmapGeneration } = await import('@/app/actions/roadmap');
      const pm = getPm();
      const roadmapMap = (global as Record<string, unknown>).__roadmapSessions as Map<string, string>;

      const rmProc = mockChildProcess();
      const rmId = await pm.createSession({
        taskId: `roadmap::${projectDir}`,
        role: 'general',
        cwd: projectDir,
      });
      roadmapMap.set(`roadmap::${projectDir}`, rmId);

      const clProc = mockChildProcess();
      const clId = await pm.createSession({
        taskId: `changelog::${projectDir}`,
        role: 'general',
        cwd: projectDir,
      });
      roadmapMap.set(`changelog::${projectDir}`, clId);

      await cancelRoadmapGeneration('roadmap');

      // Only the roadmap session should be killed
      expect(rmProc.kill).toHaveBeenCalledWith('SIGTERM');
      expect(clProc.kill).not.toHaveBeenCalled();
      expect(roadmapMap.has(`roadmap::${projectDir}`)).toBe(false);
      expect(roadmapMap.has(`changelog::${projectDir}`)).toBe(true);
      expect(pm.getSession(clId).status).toBe('running');
    });
  });

  // ── isRoadmapSessionAlive ───────────────────────────────────────────

  describe('isRoadmapSessionAlive', () => {
    it('returns true for a running session', async () => {
      const { isRoadmapSessionAlive } = await import('@/app/actions/roadmap');
      const pm = getPm();

      const sessionId = await pm.createSession({
        taskId: `roadmap::${projectDir}`,
        role: 'general',
        cwd: projectDir,
      });

      expect(await isRoadmapSessionAlive(sessionId)).toBe(true);
    });

    it('returns false for a cancelled session', async () => {
      const { cancelRoadmapGeneration, isRoadmapSessionAlive } = await import('@/app/actions/roadmap');
      const pm = getPm();
      const roadmapMap = (global as Record<string, unknown>).__roadmapSessions as Map<string, string>;

      mockChildProcess();
      const sessionId = await pm.createSession({
        taskId: `roadmap::${projectDir}`,
        role: 'general',
        cwd: projectDir,
      });
      roadmapMap.set(`roadmap::${projectDir}`, sessionId);

      expect(await isRoadmapSessionAlive(sessionId)).toBe(true);

      await cancelRoadmapGeneration('roadmap');

      expect(await isRoadmapSessionAlive(sessionId)).toBe(false);
    });

    it('returns false for a non-existent session ID', async () => {
      const { isRoadmapSessionAlive } = await import('@/app/actions/roadmap');
      expect(await isRoadmapSessionAlive('nonexistent-id')).toBe(false);
    });
  });

  // ── getActiveRoadmapSession ─────────────────────────────────────────

  describe('getActiveRoadmapSession', () => {
    it('returns the session ID for an active roadmap session', async () => {
      const { getActiveRoadmapSession } = await import('@/app/actions/roadmap');
      const pm = getPm();
      const roadmapMap = (global as Record<string, unknown>).__roadmapSessions as Map<string, string>;

      mockChildProcess();
      const sessionId = await pm.createSession({
        taskId: `roadmap::${projectDir}`,
        role: 'general',
        cwd: projectDir,
      });
      roadmapMap.set(`roadmap::${projectDir}`, sessionId);

      const result = await getActiveRoadmapSession('roadmap');
      expect(result).toBe(sessionId);
    });

    it('returns the session ID for an active changelog session', async () => {
      const { getActiveRoadmapSession } = await import('@/app/actions/roadmap');
      const pm = getPm();
      const roadmapMap = (global as Record<string, unknown>).__roadmapSessions as Map<string, string>;

      mockChildProcess();
      const sessionId = await pm.createSession({
        taskId: `changelog::${projectDir}`,
        role: 'general',
        cwd: projectDir,
      });
      roadmapMap.set(`changelog::${projectDir}`, sessionId);

      const result = await getActiveRoadmapSession('changelog');
      expect(result).toBe(sessionId);
    });

    it('returns null after the session is cancelled', async () => {
      const { cancelRoadmapGeneration, getActiveRoadmapSession } = await import('@/app/actions/roadmap');
      const pm = getPm();
      const roadmapMap = (global as Record<string, unknown>).__roadmapSessions as Map<string, string>;

      mockChildProcess();
      const sessionId = await pm.createSession({
        taskId: `roadmap::${projectDir}`,
        role: 'general',
        cwd: projectDir,
      });
      roadmapMap.set(`roadmap::${projectDir}`, sessionId);

      expect(await getActiveRoadmapSession('roadmap')).toBe(sessionId);

      await cancelRoadmapGeneration('roadmap');

      expect(await getActiveRoadmapSession('roadmap')).toBeNull();
    });
  });

  // ── SIGKILL fallback (5-second timer) ───────────────────────────────

  describe('SIGKILL fallback', () => {
    it('schedules a SIGKILL after 5s if roadmap process ignores SIGTERM', async () => {
      vi.useFakeTimers();
      const proc = mockChildProcess();
      const { cancelRoadmapGeneration } = await import('@/app/actions/roadmap');
      const pm = getPm();

      const sessionId = await pm.createSession({
        taskId: `roadmap::${projectDir}`,
        role: 'general',
        cwd: projectDir,
      });

      const roadmapMap = (global as Record<string, unknown>).__roadmapSessions as Map<string, string>;
      roadmapMap.set(`roadmap::${projectDir}`, sessionId);

      await cancelRoadmapGeneration('roadmap');

      expect(proc.kill).toHaveBeenCalledWith('SIGTERM');
      expect(proc.kill).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(5_000);

      expect(proc.kill).toHaveBeenCalledWith('SIGKILL');
      expect(proc.kill).toHaveBeenCalledTimes(2);

      vi.useRealTimers();
    });

    it('schedules a SIGKILL after 5s if changelog process ignores SIGTERM', async () => {
      vi.useFakeTimers();
      const proc = mockChildProcess();
      const { cancelRoadmapGeneration } = await import('@/app/actions/roadmap');
      const pm = getPm();

      const sessionId = await pm.createSession({
        taskId: `changelog::${projectDir}`,
        role: 'general',
        cwd: projectDir,
      });

      const roadmapMap = (global as Record<string, unknown>).__roadmapSessions as Map<string, string>;
      roadmapMap.set(`changelog::${projectDir}`, sessionId);

      await cancelRoadmapGeneration('changelog');

      expect(proc.kill).toHaveBeenCalledWith('SIGTERM');
      expect(proc.kill).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(5_000);

      expect(proc.kill).toHaveBeenCalledWith('SIGKILL');
      expect(proc.kill).toHaveBeenCalledTimes(2);

      vi.useRealTimers();
    });

    it('does not send SIGKILL if roadmap process already exited', async () => {
      vi.useFakeTimers();
      const proc = mockChildProcess();
      const { cancelRoadmapGeneration } = await import('@/app/actions/roadmap');
      const pm = getPm();

      const sessionId = await pm.createSession({
        taskId: `roadmap::${projectDir}`,
        role: 'general',
        cwd: projectDir,
      });

      const roadmapMap = (global as Record<string, unknown>).__roadmapSessions as Map<string, string>;
      roadmapMap.set(`roadmap::${projectDir}`, sessionId);

      await cancelRoadmapGeneration('roadmap');

      expect(proc.kill).toHaveBeenCalledWith('SIGTERM');
      expect(proc.kill).toHaveBeenCalledTimes(1);

      proc.exitCode = 0;
      proc._emitExit(0);

      vi.advanceTimersByTime(5_000);

      expect(proc.kill).toHaveBeenCalledTimes(1); // SIGTERM only

      vi.useRealTimers();
    });

    it('does not send SIGKILL if changelog process already exited', async () => {
      vi.useFakeTimers();
      const proc = mockChildProcess();
      const { cancelRoadmapGeneration } = await import('@/app/actions/roadmap');
      const pm = getPm();

      const sessionId = await pm.createSession({
        taskId: `changelog::${projectDir}`,
        role: 'general',
        cwd: projectDir,
      });

      const roadmapMap = (global as Record<string, unknown>).__roadmapSessions as Map<string, string>;
      roadmapMap.set(`changelog::${projectDir}`, sessionId);

      await cancelRoadmapGeneration('changelog');

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
