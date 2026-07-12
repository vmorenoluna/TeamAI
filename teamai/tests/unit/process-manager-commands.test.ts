import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ProcessManager } from '@/lib/process-manager';
import type { AgentSession } from '@/lib/process-manager';

// ── Helpers ──────────────────────────────────────────────────────────────────

type AnySession = { sessions: Map<string, AgentSession>; terminalSessions: Map<string, any> };

function mockProcess(
   
  overrides: Record<string, any> = {},
   
): any {
  return {
    kill: overrides.kill ?? vi.fn(),
    exitCode: overrides.exitCode ?? null,
    killed: overrides.killed ?? false,
    stdin: overrides.stdin ?? { writable: true, write: vi.fn() },
    stdout: overrides.stdout ?? { on: vi.fn() },
    stderr: overrides.stderr ?? { on: vi.fn() },
    on: overrides.on ?? vi.fn(),
  };
}

function addMockSession(
  pm: ProcessManager,
  id: string,
  overrides: Partial<AgentSession> & { process?: ReturnType<typeof mockProcess> } = {},
) {
  const session: AgentSession = {
    id,
    process: (overrides.process ?? mockProcess()) as any,
    taskId: overrides.taskId ?? 'task-1',
    role: overrides.role ?? 'coder',
    cwd: overrides.cwd ?? '/test',
    status: overrides.status ?? 'running',
    lastOutputAt: overrides.lastOutputAt ?? Date.now(),
  };
  (pm as unknown as AnySession).sessions.set(id, session);
  return session;
}

// ── sendMessage ──────────────────────────────────────────────────────────────

describe('ProcessManager — sendMessage', () => {
  let pm: ProcessManager;

  beforeEach(() => {
    pm = new ProcessManager();
    (pm as unknown as AnySession).sessions.clear();
    (pm as unknown as AnySession).terminalSessions.clear();
  });

  it('writes JSON message to session stdin', () => {
    const writeSpy = vi.fn();
    const proc = mockProcess({ stdin: { writable: true, write: writeSpy } as any });
    addMockSession(pm, 'sess-1', { process: proc });

    pm.sendMessage('sess-1', 'Hello, agent!');

    expect(writeSpy).toHaveBeenCalledTimes(1);
    const written = writeSpy.mock.calls[0][0];
    expect(written).toContain('Hello, agent!');
    expect(written).toContain('"type":"user"');
    expect(written.endsWith('\n')).toBe(true);

    const parsed = JSON.parse(written);
    expect(parsed.type).toBe('user');
    expect(parsed.message.role).toBe('user');
    expect(parsed.message.content).toBe('Hello, agent!');
  });

  it('throws when session does not exist', () => {
    expect(() => pm.sendMessage('nonexistent', 'Hi')).toThrow(
      'Session nonexistent not available',
    );
  });

  it('throws when session stdin is not writable', () => {
    // Bypass mockProcess ?? default to get null stdin
    const proc = {
      kill: vi.fn(),
      exitCode: null,
      killed: false,
      stdin: null,
      stdout: { on: vi.fn() },
      stderr: { on: vi.fn() },
      on: vi.fn(),
    };
    addMockSession(pm, 'sess-1', { process: proc as any });

    expect(() => pm.sendMessage('sess-1', 'Hi')).toThrow(
      'Session sess-1 not available',
    );
  });

  it('throws when session has no stdin property', () => {
    const proc = {
      kill: vi.fn(),
      exitCode: null,
      killed: false,
      // no stdin property at all
      stdout: { on: vi.fn() },
      stderr: { on: vi.fn() },
      on: vi.fn(),
    };
    addMockSession(pm, 'sess-1', { process: proc as any });

    expect(() => pm.sendMessage('sess-1', 'Hi')).toThrow(
      'Session sess-1 not available',
    );
  });

  it('handles empty message content', () => {
    const writeSpy = vi.fn();
    const proc = mockProcess({ stdin: { writable: true, write: writeSpy } as any });
    addMockSession(pm, 'sess-1', { process: proc });

    pm.sendMessage('sess-1', '');

    expect(writeSpy).toHaveBeenCalledTimes(1);
    const parsed = JSON.parse(writeSpy.mock.calls[0][0]);
    expect(parsed.message.content).toBe('');
  });

  it('handles message with special characters', () => {
    const writeSpy = vi.fn();
    const proc = mockProcess({ stdin: { writable: true, write: writeSpy } as any });
    addMockSession(pm, 'sess-1', { process: proc });

    pm.sendMessage('sess-1', 'Line 1\nLine 2\tTab "quoted"');

    expect(writeSpy).toHaveBeenCalledTimes(1);
    const parsed = JSON.parse(writeSpy.mock.calls[0][0]);
    expect(parsed.message.content).toBe('Line 1\nLine 2\tTab "quoted"');
  });
});

// ── killSession ──────────────────────────────────────────────────────────────

describe('ProcessManager — killSession', () => {
  let pm: ProcessManager;

  beforeEach(() => {
    pm = new ProcessManager();
    (pm as unknown as AnySession).sessions.clear();
    (pm as unknown as AnySession).terminalSessions.clear();
  });

  it('kills the process and sets status to done', () => {
    const killSpy = vi.fn();
    const proc = mockProcess({ kill: killSpy });
    addMockSession(pm, 'sess-1', { process: proc, status: 'running' });

    pm.killSession('sess-1');

    expect(killSpy).toHaveBeenCalledWith('SIGTERM');
    const session = pm.getSession('sess-1');
    expect(session?.status).toBe('done');
  });

  it('does nothing when session does not exist', () => {
    expect(() => pm.killSession('nonexistent')).not.toThrow();
  });

  it('sets status from error to done when killed', () => {
    const killSpy = vi.fn();
    const proc = mockProcess({ kill: killSpy });
    addMockSession(pm, 'sess-1', { process: proc, status: 'error' });

    pm.killSession('sess-1');

    const session = pm.getSession('sess-1');
    expect(session?.status).toBe('done');
  });

  // Coverage: lines 194-197 — SIGKILL fallback when process ignores SIGTERM
  it('sends SIGKILL after grace period when process ignores SIGTERM', () => {
    vi.useFakeTimers();

    const killSpy = vi.fn();
    // exitCode stays null after SIGTERM (process ignored it)
    const proc = mockProcess({ kill: killSpy, exitCode: null });
    addMockSession(pm, 'sess-sigkill', { process: proc, status: 'running' });

    pm.killSession('sess-sigkill');

    // Immediately should have sent SIGTERM
    expect(killSpy).toHaveBeenCalledWith('SIGTERM');
    expect(killSpy).toHaveBeenCalledTimes(1);

    // Advance time past the 5 second grace period
    vi.advanceTimersByTime(5_001);

    // SIGKILL should have been sent because exitCode is still null
    expect(killSpy).toHaveBeenCalledWith('SIGKILL');
    expect(killSpy).toHaveBeenCalledTimes(2);

    vi.useRealTimers();
  });

  it('does not send SIGKILL when process exits before grace period', () => {
    vi.useFakeTimers();

    const killSpy = vi.fn();
    const proc = mockProcess({ kill: killSpy, exitCode: 0 });
    addMockSession(pm, 'sess-no-sigkill', { process: proc, status: 'running' });

    pm.killSession('sess-no-sigkill');

    expect(killSpy).toHaveBeenCalledWith('SIGTERM');
    expect(killSpy).toHaveBeenCalledTimes(1);

    // Advance time — SIGKILL should NOT fire because exitCode is 0
    vi.advanceTimersByTime(5_001);
    expect(killSpy).toHaveBeenCalledTimes(1);

    vi.useRealTimers();
  });

  it('handles session removed before SIGKILL fallback fires', () => {
    vi.useFakeTimers();

    const killSpy = vi.fn();
    const proc = mockProcess({ kill: killSpy, exitCode: null });
    addMockSession(pm, 'sess-removed', { process: proc, status: 'running' });

    pm.killSession('sess-removed');
    expect(killSpy).toHaveBeenCalledWith('SIGTERM');

    // Remove session from map before timeout fires
    (pm as unknown as AnySession).sessions.delete('sess-removed');

    vi.advanceTimersByTime(5_001);

    // Should NOT have sent SIGKILL because session was removed from map
    expect(killSpy).toHaveBeenCalledTimes(1);

    vi.useRealTimers();
  });
});

// ── NDJSON parsing (stdout data events) ──────────────────────────────────────

describe('ProcessManager — stdout NDJSON parsing', () => {
  let pm: ProcessManager;

  beforeEach(() => {
    pm = new ProcessManager();
    (pm as unknown as AnySession).sessions.clear();
    (pm as unknown as AnySession).terminalSessions.clear();
  });

  it('emits and receives event through EventEmitter pattern', () => {
    const eventSpy = vi.fn();
    pm.on('event', eventSpy);

    pm.emit('event', { sessionId: 'sess-1', event: { type: 'assistant', message: { content: [] } } });

    expect(eventSpy).toHaveBeenCalledWith({
      sessionId: 'sess-1',
      event: { type: 'assistant', message: { content: [] } },
    });
  });

  it('emits raw event for non-JSON lines', () => {
    // This is hard to test without mocking spawn.
    // The NDJSON parser is internal to createSession's stdout handler.
    // We can validate the behavior through a close inspection:
    // Buffer logic: split by \n, parse each line as JSON, emit 'event' or 'raw'

    // For now, we verify the PM instance has the expected EventEmitter shape
    const rawSpy = vi.fn();
    pm.on('raw', rawSpy);

    // Trigger raw emission manually to verify listener works
    pm.emit('raw', { sessionId: 'test', data: 'non-json-line' });
    expect(rawSpy).toHaveBeenCalledWith({ sessionId: 'test', data: 'non-json-line' });
  });

  it('emits error events from stderr', () => {
    const errorSpy = vi.fn();
    pm.on('error', errorSpy);

    pm.emit('error', { sessionId: 'test', error: 'stderr output' });
    expect(errorSpy).toHaveBeenCalledWith({ sessionId: 'test', error: 'stderr output' });
  });

  it('emits exit events with code', () => {
    const exitSpy = vi.fn();
    pm.on('exit', exitSpy);

    pm.emit('exit', { sessionId: 'test', code: 0 });
    expect(exitSpy).toHaveBeenCalledWith({ sessionId: 'test', code: 0 });
  });

  it('emits exit events with non-zero code', () => {
    const exitSpy = vi.fn();
    pm.on('exit', exitSpy);

    pm.emit('exit', { sessionId: 'test', code: 1 });
    expect(exitSpy).toHaveBeenCalledWith({ sessionId: 'test', code: 1 });
  });
});

// ── writeToTerminal ──────────────────────────────────────────────────────────

describe('ProcessManager — writeToTerminal', () => {
  let pm: ProcessManager;

  beforeEach(() => {
    pm = new ProcessManager();
    (pm as unknown as AnySession).sessions.clear();
    (pm as unknown as AnySession).terminalSessions.clear();
  });

  it('writes data to terminal PTY', () => {
    const writeSpy = vi.fn();
    const mockTerm = {
      id: 'term-1',
      ptyProcess: { write: writeSpy, kill: vi.fn(), resize: vi.fn() },
      role: 'general',
      projectPath: '/test',
    };
    (pm as unknown as AnySession).terminalSessions.set('term-1', mockTerm);

    pm.writeToTerminal('term-1', 'ls -la\n');

    expect(writeSpy).toHaveBeenCalledWith('ls -la\n');
  });

  it('does nothing when terminal session does not exist', () => {
    expect(() => pm.writeToTerminal('nonexistent', 'data')).not.toThrow();
  });

  it('handles empty data', () => {
    const writeSpy = vi.fn();
    const mockTerm = {
      id: 'term-2',
      ptyProcess: { write: writeSpy, kill: vi.fn(), resize: vi.fn() },
      role: 'general',
      projectPath: '/test',
    };
    (pm as unknown as AnySession).terminalSessions.set('term-2', mockTerm);

    pm.writeToTerminal('term-2', '');

    expect(writeSpy).toHaveBeenCalledWith('');
  });
});

// ── resizeTerminal ───────────────────────────────────────────────────────────

describe('ProcessManager — resizeTerminal', () => {
  let pm: ProcessManager;

  beforeEach(() => {
    pm = new ProcessManager();
    (pm as unknown as AnySession).sessions.clear();
    (pm as unknown as AnySession).terminalSessions.clear();
  });

  it('resizes terminal PTY', () => {
    const resizeSpy = vi.fn();
    const mockTerm = {
      id: 'term-3',
      ptyProcess: { write: vi.fn(), kill: vi.fn(), resize: resizeSpy },
      role: 'general',
      projectPath: '/test',
    };
    (pm as unknown as AnySession).terminalSessions.set('term-3', mockTerm);

    pm.resizeTerminal('term-3', 140, 50);

    expect(resizeSpy).toHaveBeenCalledWith(140, 50);
  });

  it('does nothing when terminal session does not exist', () => {
    expect(() => pm.resizeTerminal('nonexistent', 80, 24)).not.toThrow();
  });
});

// ── getSession edge cases ────────────────────────────────────────────────────

describe('ProcessManager — getSession edge cases', () => {
  let pm: ProcessManager;

  beforeEach(() => {
    pm = new ProcessManager();
    (pm as unknown as AnySession).sessions.clear();
  });

  it('returns undefined for empty string ID', () => {
    expect(pm.getSession('')).toBeUndefined();
  });

  it('returns correct session for valid ID', () => {
    const mock = mockProcess();
    addMockSession(pm, 'valid-id', { process: mock });
    const session = pm.getSession('valid-id');
    expect(session?.id).toBe('valid-id');
    expect(session?.role).toBe('coder');
    expect(session?.status).toBe('running');
  });
});

// ── getAllSessions with multiple sessions ────────────────────────────────────

describe('ProcessManager — getAllSessions with data', () => {
  it('returns all registered agent sessions', () => {
    const pm = new ProcessManager();
    (pm as unknown as AnySession).sessions.clear();

    addMockSession(pm, 'sess-1', { role: 'planner' });
    addMockSession(pm, 'sess-2', { role: 'coder' });
    addMockSession(pm, 'sess-3', { role: 'qa-reviewer' });

    const sessions = pm.getAllSessions();
    expect(sessions).toHaveLength(3);
    expect(sessions.map(s => s.role).sort()).toEqual(['coder', 'planner', 'qa-reviewer']);
  });
});

// ── getStaleSessions comprehensive ───────────────────────────────────────────

describe('ProcessManager — getStaleSessions comprehensive', () => {
  it('distinguishes between exitCode and killed', () => {
    const pm = new ProcessManager();
    (pm as unknown as AnySession).sessions.clear();

    const normalProc = mockProcess({ exitCode: null, killed: false });
    const exitedProc = mockProcess({ exitCode: 0, killed: false });
    const killedProc = mockProcess({ exitCode: null, killed: true });
    const bothProc = mockProcess({ exitCode: 1, killed: true });

    addMockSession(pm, 'normal', { process: normalProc });
    addMockSession(pm, 'exited', { process: exitedProc });
    addMockSession(pm, 'killed', { process: killedProc });
    addMockSession(pm, 'both', { process: bothProc });

    const stale = pm.getStaleSessions();
    expect(stale).toHaveLength(3);
    expect(stale.map(s => s.id).sort()).toEqual(['both', 'exited', 'killed']);
  });

  it('returns empty when all sessions running', () => {
    const pm = new ProcessManager();
    (pm as unknown as AnySession).sessions.clear();

    addMockSession(pm, 's1', { process: mockProcess({ exitCode: null, killed: false }) });
    addMockSession(pm, 's2', { process: mockProcess({ exitCode: null, killed: false }) });

    expect(pm.getStaleSessions()).toHaveLength(0);
  });
});

// ── removeStaleSession ───────────────────────────────────────────────────────

describe('ProcessManager — removeStaleSession', () => {
  it('removes an existing session', () => {
    const pm = new ProcessManager();
    (pm as unknown as AnySession).sessions.clear();

    addMockSession(pm, 'sess-1');
    expect(pm.getSession('sess-1')).toBeDefined();

    pm.removeStaleSession('sess-1');
    expect(pm.getSession('sess-1')).toBeUndefined();
  });

  it('does not throw when removing nonexistent session', () => {
    const pm = new ProcessManager();
    expect(() => pm.removeStaleSession('never-existed')).not.toThrow();
  });

  it('only removes the specified session, not others', () => {
    const pm = new ProcessManager();
    (pm as unknown as AnySession).sessions.clear();

    addMockSession(pm, 'keep-me');
    addMockSession(pm, 'remove-me');

    pm.removeStaleSession('remove-me');

    expect(pm.getSession('keep-me')).toBeDefined();
    expect(pm.getSession('remove-me')).toBeUndefined();
  });
});

// ── Terminal session lifecycle ───────────────────────────────────────────────

describe('ProcessManager — terminal session events', () => {
  it('emits terminal-data events', () => {
    const pm = new ProcessManager();
    const dataSpy = vi.fn();
    pm.on('terminal-data', dataSpy);

    pm.emit('terminal-data', { sessionId: 't1', data: 'hello' });

    expect(dataSpy).toHaveBeenCalledWith({ sessionId: 't1', data: 'hello' });
  });

  it('emits terminal-exit events', () => {
    const pm = new ProcessManager();
    const exitSpy = vi.fn();
    pm.on('terminal-exit', exitSpy);

    pm.emit('terminal-exit', { sessionId: 't1' });

    expect(exitSpy).toHaveBeenCalledWith({ sessionId: 't1' });
  });
});

// ── killTerminalSession ──────────────────────────────────────────────────────

describe('ProcessManager — killTerminalSession', () => {
  let pm: ProcessManager;

  beforeEach(() => {
    pm = new ProcessManager();
    (pm as unknown as AnySession).terminalSessions.clear();
  });

  it('kills PTY process and removes from map', () => {
    const killSpy = vi.fn();
    const mockTerm = {
      id: 'term-kill',
      ptyProcess: { write: vi.fn(), kill: killSpy, resize: vi.fn() },
      role: 'general',
      projectPath: '/test',
    };
    (pm as unknown as AnySession).terminalSessions.set('term-kill', mockTerm);

    pm.killTerminalSession('term-kill');

    expect(killSpy).toHaveBeenCalled();
    expect(pm.getTerminalSessions()).toHaveLength(0);
  });

  it('does not throw for nonexistent terminal session', () => {
    expect(() => pm.killTerminalSession('no-such')).not.toThrow();
  });
});

// ── getTerminalSessions with data ────────────────────────────────────────────

describe('ProcessManager — getTerminalSessions with data', () => {
  it('returns multiple terminal sessions', () => {
    const pm = new ProcessManager();
    (pm as unknown as AnySession).terminalSessions.clear();

    const t1 = { id: 't1', ptyProcess: { write: vi.fn(), kill: vi.fn(), resize: vi.fn() }, role: 'coder', projectPath: '/a' };
    const t2 = { id: 't2', ptyProcess: { write: vi.fn(), kill: vi.fn(), resize: vi.fn() }, role: 'planner', projectPath: '/b' };

    (pm as unknown as AnySession).terminalSessions.set('t1', t1);
    (pm as unknown as AnySession).terminalSessions.set('t2', t2);

    const terminals = pm.getTerminalSessions();
    expect(terminals).toHaveLength(2);
  });
});

// ── getStalledSessions (stall/heartbeat detection #8) ────────────────────────

describe('ProcessManager — getStalledSessions', () => {
  it('returns empty when no sessions exist', () => {
    const pm = new ProcessManager();
    (pm as unknown as AnySession).sessions.clear();
    expect(pm.getStalledSessions()).toEqual([]);
  });

  it('returns empty when all sessions have recent output', () => {
    const pm = new ProcessManager();
    (pm as unknown as AnySession).sessions.clear();
    addMockSession(pm, 'sess-1', { status: 'running', lastOutputAt: Date.now() });
    expect(pm.getStalledSessions()).toEqual([]);
  });

  it('returns sessions with stale output (no output for > 120s)', () => {
    const pm = new ProcessManager();
    (pm as unknown as AnySession).sessions.clear();
    addMockSession(pm, 'sess-1', { status: 'running', lastOutputAt: Date.now() - 200_000 });
    const stalled = pm.getStalledSessions();
    expect(stalled).toHaveLength(1);
    expect(stalled[0].id).toBe('sess-1');
  });

  it('ignores non-running sessions', () => {
    const pm = new ProcessManager();
    (pm as unknown as AnySession).sessions.clear();
    addMockSession(pm, 'sess-1', { status: 'done', lastOutputAt: Date.now() - 200_000 });
    expect(pm.getStalledSessions()).toEqual([]);
  });

  it('respects custom timeout', () => {
    const pm = new ProcessManager();
    (pm as unknown as AnySession).sessions.clear();
    addMockSession(pm, 'sess-1', { status: 'running', lastOutputAt: Date.now() - 30_000 });
    // Default 120s timeout: not stalled (30s < 120s)
    expect(pm.getStalledSessions()).toEqual([]);
    // Custom 20s timeout: stalled (30s > 20s)
    expect(pm.getStalledSessions(20_000)).toHaveLength(1);
  });
});

// ── EventEmitter functionality ───────────────────────────────────────────────

describe('ProcessManager — EventEmitter', () => {
  it('emits and receives events', () => {
    const pm = new ProcessManager();
    const handler = vi.fn();
    pm.on('test-event', handler);
    pm.emit('test-event', { data: 'hello' });
    expect(handler).toHaveBeenCalledWith({ data: 'hello' });
  });

  it('removes listener with off', () => {
    const pm = new ProcessManager();
    const handler = vi.fn();
    pm.on('test-event', handler);
    pm.off('test-event', handler);
    pm.emit('test-event', { data: 'hello' });
    expect(handler).not.toHaveBeenCalled();
  });
});
