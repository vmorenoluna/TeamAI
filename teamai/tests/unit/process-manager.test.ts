import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ProcessManager } from '../../src/lib/process-manager';

 
type AnySession = any; // We are testing internal private state — use any cast sparingly

// Minimal mock process object that satisfies the shape ProcessManager expects
function mockProcess(overrides: Partial<{
  exitCode: number | null;
  killed: boolean;
  stdin: { writable: boolean };
  kill?: ReturnType<typeof vi.fn>;
}> = {}) {
  return {
    kill: overrides.kill ?? vi.fn(),
    exitCode: overrides.exitCode ?? null,
    killed: overrides.killed ?? false,
    stdin: overrides.stdin ?? { writable: true },
  };
}

describe('ProcessManager', () => {
  let pm: ProcessManager;

  beforeEach(() => {
    pm = new ProcessManager();
    // Clear any stale state
    (pm as AnySession).sessions.clear();
    (pm as AnySession).terminalSessions.clear();
  });

  describe('getSession', () => {
    it('returns undefined for unknown session ID', () => {
      expect(pm.getSession('nonexistent')).toBeUndefined();
    });
  });

  describe('getAllSessions', () => {
    it('returns empty array initially', () => {
      expect(pm.getAllSessions()).toEqual([]);
    });

    it('returns sessions that were added to the internal map', () => {
      const session = {
        id: 'session-1',
        process: mockProcess(),
        taskId: 'task-1',
        role: 'coder' as const,
        cwd: '/test',
        status: 'running' as const,
      };
      (pm as AnySession).sessions.set('session-1', session);

      expect(pm.getAllSessions()).toHaveLength(1);
      expect(pm.getAllSessions()[0].id).toBe('session-1');
    });
  });

  describe('getStaleSessions', () => {
    it('returns empty when all sessions are running', () => {
      const session = {
        id: 'session-1',
        process: mockProcess({ exitCode: null, killed: false }),
        taskId: 'task-1',
        role: 'coder' as const,
        cwd: '/test',
        status: 'running' as const,
      };
      (pm as AnySession).sessions.set('session-1', session);

      expect(pm.getStaleSessions()).toEqual([]);
    });

    it('returns sessions with non-null exitCode', () => {
      const session = {
        id: 'session-1',
        process: mockProcess({ exitCode: 1, killed: false }),
        taskId: 'task-1',
        role: 'coder' as const,
        cwd: '/test',
        status: 'error' as const,
      };
      (pm as AnySession).sessions.set('session-1', session);

      const stale = pm.getStaleSessions();
      expect(stale).toHaveLength(1);
      expect(stale[0].id).toBe('session-1');
    });

    it('returns sessions whose process was killed', () => {
      const session = {
        id: 'session-1',
        process: mockProcess({ exitCode: null, killed: true }),
        taskId: 'task-1',
        role: 'coder' as const,
        cwd: '/test',
        status: 'done' as const,
      };
      (pm as AnySession).sessions.set('session-1', session);

      const stale = pm.getStaleSessions();
      expect(stale).toHaveLength(1);
      expect(stale[0].id).toBe('session-1');
    });

    it('returns both exitCode and killed sessions', () => {
      const session1 = {
        id: 's1',
        process: mockProcess({ exitCode: 0, killed: false }),
        taskId: 't1', role: 'coder' as const, cwd: '/test', status: 'done' as const,
      };
      const session2 = {
        id: 's2',
        process: mockProcess({ exitCode: null, killed: true }),
        taskId: 't2', role: 'planner' as const, cwd: '/test', status: 'done' as const,
      };
      (pm as AnySession).sessions.set('s1', session1);
      (pm as AnySession).sessions.set('s2', session2);

      expect(pm.getStaleSessions()).toHaveLength(2);
    });
  });

  describe('removeStaleSession', () => {
    it('removes a session from the map', () => {
      const session = {
        id: 'session-1',
        process: mockProcess({ exitCode: 1 }),
        taskId: 'task-1',
        role: 'coder' as const,
        cwd: '/test',
        status: 'error' as const,
      };
      (pm as AnySession).sessions.set('session-1', session);
      expect(pm.getAllSessions()).toHaveLength(1);

      pm.removeStaleSession('session-1');
      expect(pm.getAllSessions()).toHaveLength(0);
    });

    it('does not throw when removing nonexistent session', () => {
      expect(() => pm.removeStaleSession('does-not-exist')).not.toThrow();
    });
  });

  describe('getTerminalSessions', () => {
    it('returns empty array initially', () => {
      expect(pm.getTerminalSessions()).toEqual([]);
    });

    it('returns terminal sessions from internal map', () => {
      const mockTerm = {
        id: 'term-1',
        ptyProcess: { write: vi.fn(), kill: vi.fn(), resize: vi.fn() },
        role: 'general',
        projectPath: '/test',
      };
      (pm as AnySession).terminalSessions.set('term-1', mockTerm);

      const terms = pm.getTerminalSessions();
      expect(terms).toHaveLength(1);
      expect(terms[0].id).toBe('term-1');
    });
  });

  describe('killTerminalSession', () => {
    it('kills and removes a terminal session', () => {
      const killFn = vi.fn();
      const mockTerm = {
        id: 'term-1',
        ptyProcess: { write: vi.fn(), kill: killFn, resize: vi.fn() },
        role: 'general',
        projectPath: '/test',
      };
      (pm as AnySession).terminalSessions.set('term-1', mockTerm);

      pm.killTerminalSession('term-1');

      expect(killFn).toHaveBeenCalled();
      expect(pm.getTerminalSessions()).toHaveLength(0);
    });

    it('does not throw for nonexistent terminal session', () => {
      expect(() => pm.killTerminalSession('does-not-exist')).not.toThrow();
    });
  });

  // ── killSession SIGKILL fallback ────────────────────────────────

  describe('killSession — SIGKILL fallback', () => {
    beforeEach(() => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('schedules SIGKILL after grace period if process has not exited', async () => {
      const killFn = vi.fn();
      const session = {
        id: 'session-1',
        process: mockProcess({ exitCode: null, killed: false, kill: killFn }),
        taskId: 'task-1',
        role: 'coder' as const,
        cwd: '/test',
        status: 'running' as const,
      };
      (pm as AnySession).sessions.set('session-1', session);

      pm.killSession('session-1');

      expect(killFn).toHaveBeenCalledWith('SIGTERM');
      expect(killFn).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(5500);

      expect(killFn).toHaveBeenCalledWith('SIGKILL');
      expect(killFn).toHaveBeenCalledTimes(2);
    });

    it('does not send SIGKILL if process already exited before grace period', async () => {
      const killFn = vi.fn();
      const proc = mockProcess({ exitCode: null, killed: false, kill: killFn });
      const session = {
        id: 'session-1',
        process: proc,
        taskId: 'task-1',
        role: 'coder' as const,
        cwd: '/test',
        status: 'running' as const,
      };
      (pm as AnySession).sessions.set('session-1', session);

      pm.killSession('session-1');
      expect(killFn).toHaveBeenCalledWith('SIGTERM');

      // Simulate process exiting during grace period
      proc.exitCode = 0;

      await vi.advanceTimersByTimeAsync(5500);

      // SIGKILL should NOT have been called
      const sigKillCalls = killFn.mock.calls.filter(
        (call: any) => call[0] === 'SIGKILL'
      );
      expect(sigKillCalls.length).toBe(0);
    });

    it('does not schedule SIGKILL if session does not exist', () => {
      expect(() => pm.killSession('nonexistent')).not.toThrow();
    });

    it('sets status to done after kill', () => {
      const session = {
        id: 'session-1',
        process: mockProcess(),
        taskId: 'task-1',
        role: 'coder' as const,
        cwd: '/test',
        status: 'running' as const,
      };
      (pm as AnySession).sessions.set('session-1', session);

      pm.killSession('session-1');

      expect(session.status).toBe('done');
    });
  });

  // ── sendMessage edge cases ─────────────────────────────────────

  describe('sendMessage — edge cases', () => {
    it('throws when session does not exist', () => {
      expect(() => pm.sendMessage('nonexistent', 'hello')).toThrow('not available');
    });

    it('throws when stdin is not writable', () => {
      const session = {
        id: 'session-1',
        process: mockProcess({ stdin: { writable: false } }),
        taskId: 'task-1',
        role: 'coder' as const,
        cwd: '/test',
        status: 'running' as const,
      };
      (pm as AnySession).sessions.set('session-1', session);

      expect(() => pm.sendMessage('session-1', 'hello')).toThrow('not available');
    });
  });

  // ── PTY terminal edge cases ────────────────────────────────────

  describe('PTY terminal edge cases', () => {
    it('writeToTerminal no-ops when session does not exist', () => {
      expect(() => pm.writeToTerminal('nonexistent', 'echo hello')).not.toThrow();
    });

    it('resizeTerminal no-ops when session does not exist', () => {
      expect(() => pm.resizeTerminal('nonexistent', 120, 40)).not.toThrow();
    });
  });

  describe('EventEmitter functionality', () => {
    it('emits and receives events', () => {
      const handler = vi.fn();
      pm.on('test-event', handler);
      pm.emit('test-event', { data: 'hello' });
      expect(handler).toHaveBeenCalledWith({ data: 'hello' });
    });

    it('removes listener with off', () => {
      const handler = vi.fn();
      pm.on('test-event', handler);
      pm.off('test-event', handler);
      pm.emit('test-event', { data: 'hello' });
      expect(handler).not.toHaveBeenCalled();
    });
  });
});
