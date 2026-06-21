/**
 * Unit tests for insights server actions.
 *
 * Tests cover getOrCreateInsightsSession() (session creation, reuse,
 * reconnection when dead) and sendInsightsMessage() (dispatches to
 * processManager). Uses createTestProject() helper and mocked
 * processManager.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Hoisted mocks ───────────────────────────────────────────────────────────

const mockCreateSession = vi.fn();
const mockSendMessage = vi.fn();
const mockGetSession = vi.fn();
const mockKillSession = vi.fn();

vi.mock('@/lib/process-manager', () => ({
  processManager: {
    createSession: (...args: unknown[]) => mockCreateSession(...args),
    sendMessage: (...args: unknown[]) => mockSendMessage(...args),
    getSession: (...args: unknown[]) => mockGetSession(...args),
    killSession: (...args: unknown[]) => mockKillSession(...args),
  },
}));

const mockGetActiveProjectPath = vi.fn();

vi.mock('@/app/actions/projects', () => ({
  getActiveProjectPath: (...args: unknown[]) => mockGetActiveProjectPath(...args),
}));

// ── Imports (must be after mocks) ───────────────────────────────────────────

import { createTestProject } from '../utils/test-project';

// ── Helpers ─────────────────────────────────────────────────────────────────

let root: string;
let clean: () => void;

/**
 * We must reset the global __insightsSessions Map between tests
 * so session state from one test doesn't leak into the next.
 * The insights module uses `global.__insightsSessions` — we need
 * to clear it and reset modules for each test.
 */
function resetGlobalSessions() {
  // Delete the global sessions map so each re-import creates a fresh Map
  // (avoids cross-test contamination via shared Map instance)
  delete (globalThis as Record<string, unknown>).__insightsSessions;
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('insights server actions', () => {
  beforeEach(() => {
    const project = createTestProject();
    root = project.root;
    clean = project.clean;
    vi.resetAllMocks();
    mockGetActiveProjectPath.mockResolvedValue(root);
    resetGlobalSessions();
  });

  afterEach(() => {
    clean();
    vi.clearAllMocks();
    vi.resetModules();
    resetGlobalSessions();
  });

  // ── getOrCreateInsightsSession ───────────────────────────────────────

  describe('getOrCreateInsightsSession', () => {
    it('creates a new session when none exists', async () => {
      mockCreateSession.mockResolvedValue('session-new');

      const { getOrCreateInsightsSession } = await import('@/app/actions/insights');
      const id = await getOrCreateInsightsSession();

      expect(id).toBe('session-new');
      expect(mockCreateSession).toHaveBeenCalledTimes(1);
      expect(mockCreateSession).toHaveBeenCalledWith({
        taskId: `insights::${root}`,
        role: 'general',
        cwd: root,
      });
    });

    it('returns existing session when it is still running', async () => {
      // First call: creates a session
      mockCreateSession.mockResolvedValueOnce('session-1');
      mockGetSession.mockReturnValueOnce({ status: 'running' });

      const { getOrCreateInsightsSession } = await import('@/app/actions/insights');
      const id1 = await getOrCreateInsightsSession();
      expect(id1).toBe('session-1');
      expect(mockCreateSession).toHaveBeenCalledTimes(1);

      // Second call: reuses existing session (still running)
      const id2 = await getOrCreateInsightsSession();

      expect(id2).toBe('session-1');
      // Should NOT have created a new session
      expect(mockCreateSession).toHaveBeenCalledTimes(1);
      expect(mockGetSession).toHaveBeenCalledWith('session-1');
    });

    it('creates a new session when the existing one is dead', async () => {
      // First: create a session
      mockCreateSession.mockResolvedValueOnce('session-1');

      const { getOrCreateInsightsSession } = await import('@/app/actions/insights');
      const id1 = await getOrCreateInsightsSession();
      expect(id1).toBe('session-1');

      // Simulate the first session dying
      mockGetSession.mockReturnValueOnce({ status: 'exited' });
      mockCreateSession.mockResolvedValueOnce('session-2');

      // Second call: should create a new session since the old one is dead
      const id2 = await getOrCreateInsightsSession();

      expect(id2).toBe('session-2');
      expect(mockCreateSession).toHaveBeenCalledTimes(2);
    });

    it('creates a new session when existing session is not found (getSession returns nullish)', async () => {
      // First: create a session
      mockCreateSession.mockResolvedValueOnce('session-1');

      const { getOrCreateInsightsSession } = await import('@/app/actions/insights');
      await getOrCreateInsightsSession();

      // Simulate getSession returning null (session removed)
      mockGetSession.mockReturnValueOnce(null);
      mockCreateSession.mockResolvedValueOnce('session-2');

      const id2 = await getOrCreateInsightsSession();

      expect(id2).toBe('session-2');
      expect(mockCreateSession).toHaveBeenCalledTimes(2);
    });

    it('uses the correct project path from getActiveProjectPath', async () => {
      mockCreateSession.mockResolvedValue('session-proj');

      const { getOrCreateInsightsSession } = await import('@/app/actions/insights');
      await getOrCreateInsightsSession();

      expect(mockGetActiveProjectPath).toHaveBeenCalledTimes(1);
      expect(mockCreateSession).toHaveBeenCalledWith(
        expect.objectContaining({ cwd: root }),
      );
    });

    it('sessions are keyed per project (different projects get different sessions)', async () => {
      mockCreateSession.mockResolvedValueOnce('session-A');

      const { getOrCreateInsightsSession } = await import('@/app/actions/insights');
      const idA = await getOrCreateInsightsSession();
      expect(idA).toBe('session-A');

      // Simulate a different project
      const otherRoot = root + '-other';
      mockGetActiveProjectPath.mockResolvedValue(otherRoot);
      mockCreateSession.mockResolvedValueOnce('session-B');

      const idB = await getOrCreateInsightsSession();
      expect(idB).toBe('session-B');
      expect(mockCreateSession).toHaveBeenCalledTimes(2);

      // Switch back to first project — should still be session-A
      mockGetActiveProjectPath.mockResolvedValue(root);
      mockGetSession.mockReturnValueOnce({ status: 'running' });

      const idA2 = await getOrCreateInsightsSession();
      expect(idA2).toBe('session-A');
      expect(mockCreateSession).toHaveBeenCalledTimes(2); // no new creation
    });
  });

  // ── sendInsightsMessage ──────────────────────────────────────────────

  // ── Error propagation ──────────────────────────────────────────────

  describe('error propagation', () => {
    it('propagates error when createSession fails', async () => {
      mockCreateSession.mockRejectedValue(new Error('process unavailable'));

      const { getOrCreateInsightsSession } = await import('@/app/actions/insights');
      await expect(getOrCreateInsightsSession()).rejects.toThrow('process unavailable');
    });

    it('propagates error when getActiveProjectPath fails', async () => {
      mockGetActiveProjectPath.mockRejectedValue(new Error('no project selected'));

      const { getOrCreateInsightsSession } = await import('@/app/actions/insights');
      await expect(getOrCreateInsightsSession()).rejects.toThrow('no project selected');
    });
  });

  // ── sendInsightsMessage ──────────────────────────────────────────────

  describe('sendInsightsMessage', () => {
    it('calls processManager.sendMessage with the session ID and message', async () => {
      const { sendInsightsMessage } = await import('@/app/actions/insights');

      await sendInsightsMessage('session-abc', 'What is this codebase?');

      expect(mockSendMessage).toHaveBeenCalledTimes(1);
      expect(mockSendMessage).toHaveBeenCalledWith('session-abc', 'What is this codebase?');
    });

    it('passes empty messages through to processManager', async () => {
      const { sendInsightsMessage } = await import('@/app/actions/insights');

      await sendInsightsMessage('session-empty', '');

      expect(mockSendMessage).toHaveBeenCalledWith('session-empty', '');
    });

    it('passes multi-line messages through to processManager', async () => {
      const { sendInsightsMessage } = await import('@/app/actions/insights');

      await sendInsightsMessage('session-multi', 'Line 1\nLine 2\nLine 3');

      expect(mockSendMessage).toHaveBeenCalledWith('session-multi', 'Line 1\nLine 2\nLine 3');
    });
  });

  // ── cancelInsightsSession ───────────────────────────────────────────

  describe('cancelInsightsSession', () => {
    it('kills the active session and removes it from the tracking map', async () => {
      mockCreateSession.mockResolvedValueOnce('session-to-kill');

      const { getOrCreateInsightsSession, cancelInsightsSession } =
        await import('@/app/actions/insights');

      // Create a session first
      await getOrCreateInsightsSession();

      await cancelInsightsSession();

      expect(mockKillSession).toHaveBeenCalledWith('session-to-kill');

      // After cancel, creating a new session should make a fresh one
      mockCreateSession.mockResolvedValueOnce('session-after-kill');
      const newId = await getOrCreateInsightsSession();
      expect(newId).toBe('session-after-kill');
      expect(mockCreateSession).toHaveBeenCalledTimes(2);
    });

    it('does not crash when cancelling with no active session (idempotent)', async () => {
      const { cancelInsightsSession } = await import('@/app/actions/insights');
      await expect(cancelInsightsSession()).resolves.toBeUndefined();
      expect(mockKillSession).not.toHaveBeenCalled();
    });

    it('removes the session from the tracking map after kill', async () => {
      mockCreateSession.mockResolvedValueOnce('session-rm');

      const { getOrCreateInsightsSession, cancelInsightsSession } =
        await import('@/app/actions/insights');

      await getOrCreateInsightsSession();

      await cancelInsightsSession();
      expect(mockKillSession).toHaveBeenCalledWith('session-rm');

      // Session map entry should be gone — next call creates a new session
      mockCreateSession.mockResolvedValueOnce('session-fresh');
      mockGetSession.mockReturnValueOnce(undefined); // force fresh lookup
      const newId = await getOrCreateInsightsSession();
      expect(newId).toBe('session-fresh');
    });
  });

  // ── Session lifecycle integration ────────────────────────────────────

  describe('session lifecycle', () => {
    it('full flow: create session, send messages, reconnect', async () => {
      mockCreateSession.mockResolvedValueOnce('session-lifecycle');

      const { getOrCreateInsightsSession, sendInsightsMessage } =
        await import('@/app/actions/insights');

      // Create initial session
      const id1 = await getOrCreateInsightsSession();
      expect(id1).toBe('session-lifecycle');

      // Send a message
      await sendInsightsMessage(id1, 'First question');
      expect(mockSendMessage).toHaveBeenCalledWith('session-lifecycle', 'First question');

      // Simulate the session still running
      mockGetSession.mockReturnValueOnce({ status: 'running' });

      // Reconnect — should get the same session
      const id2 = await getOrCreateInsightsSession();
      expect(id2).toBe('session-lifecycle');

      // Send another message on the reconnected session
      await sendInsightsMessage(id2, 'Follow-up question');
      expect(mockSendMessage).toHaveBeenLastCalledWith('session-lifecycle', 'Follow-up question');

      // Only one session was ever created
      expect(mockCreateSession).toHaveBeenCalledTimes(1);
    });
  });
});
