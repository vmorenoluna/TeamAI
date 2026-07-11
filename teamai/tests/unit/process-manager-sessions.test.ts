/**
 * Full coverage tests for ProcessManager.
 *
 * Covers the remaining uncovered lines:
 *   - findExecutable (via createTerminalSession)
 *   - createSession (stdout NDJSON parsing, stderr, exit handler, _appendToLog)
 *   - createTerminalSession (node-pty, role file, findExecutable)
 *   - Global singleton pattern
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Module-level mocks (must be before any imports from the file under test) ──

const { mockSpawn, mockExecFileSync, mockPtySpawn, mockAppendFileSync, mockReadFileSync, mockExistsSync } = vi.hoisted(() => ({
  mockSpawn: vi.fn(),
  mockExecFileSync: vi.fn(),
  mockPtySpawn: vi.fn(),
  mockAppendFileSync: vi.fn(),
  mockReadFileSync: vi.fn(),
  mockExistsSync: vi.fn(),
}));

vi.mock('child_process', () => ({
  spawn: mockSpawn,
  execFile: vi.fn(),
  execFileSync: mockExecFileSync,
  ChildProcess: class MockChildProcess {},
}));

vi.mock('node-pty', () => ({
  spawn: mockPtySpawn,
}));

vi.mock('fs', () => ({
  appendFileSync: mockAppendFileSync,
  readFileSync: mockReadFileSync,
  existsSync: mockExistsSync,
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

// ── Import after mocks ──

import { ProcessManager } from '../../src/lib/process-manager';

// ── Helpers ──

type AnyPM = {
  sessions: Map<string, any>;
  terminalSessions: Map<string, any>;
  _appendToLog: (logFile: string, event: Record<string, unknown>) => void;
};

/** Create a mock child process with controllable stdout/stderr/exit */
 
interface MockProcess {
  kill: ReturnType<typeof vi.fn>;
  exitCode: number | null;
  killed: boolean;
  stdin: { writable: boolean; write: ReturnType<typeof vi.fn> };
  stdout: { on: (...args: any[]) => void };
  stderr: { on: (...args: any[]) => void };
  on: (...args: any[]) => void;
  _emitStdout: (chunk: string) => void;
  _emitStderr: (chunk: string) => void;
  _emitExit: (code: number | null) => void;
}

function mockChildProcess(): MockProcess {
  const stdoutHandlers: Map<string, (...args: any[]) => void> = new Map();
  const stderrHandlers: Map<string, (...args: any[]) => void> = new Map();
  const exitHandlers: Array<(code: number | null) => void> = [];

  const proc = {
    kill: vi.fn(),
    exitCode: null as number | null,
    killed: false,
    stdin: { writable: true, write: vi.fn() },
    stdout: {
      on: (event: string, handler: (...args: any[]) => void) => {
        stdoutHandlers.set(event, handler);
      },
    },
    stderr: {
      on: (event: string, handler: (...args: any[]) => void) => {
        stderrHandlers.set(event, handler);
      },
    },
    on: (event: string, handler: (...args: any[]) => void) => {
      if (event === 'exit') {
        exitHandlers.push(handler);
      }
    },
    // Test helpers to simulate events
    _emitStdout: (chunk: string) => {
      const h = stdoutHandlers.get('data');
      if (h) h(Buffer.from(chunk));
    },
    _emitStderr: (chunk: string) => {
      const h = stderrHandlers.get('data');
      if (h) h(Buffer.from(chunk));
    },
    _emitExit: (code: number | null) => {
      for (const h of exitHandlers) h(code);
    },
  };

  mockSpawn.mockReturnValue(proc);
  return proc;
}

// ── Tests ──

describe('ProcessManager — Full Coverage', () => {
  let pm: ProcessManager;

  beforeEach(() => {
    vi.clearAllMocks();
    pm = new ProcessManager();
    (pm as unknown as AnyPM).sessions.clear();
    (pm as unknown as AnyPM).terminalSessions.clear();
  });

  // ── createSession: NDJSON stdout parsing ─────────────────────────────────

  describe('createSession — stdout NDJSON parsing', () => {
    it('parses a single NDJSON line and emits event', async () => {
      const proc = mockChildProcess();
      const eventSpy = vi.fn();
      pm.on('event', eventSpy);

      const sessionId = await pm.createSession({
        taskId: 'task-1',
        role: 'coder',
        cwd: '/test',
      });

      proc._emitStdout(JSON.stringify({ type: 'assistant', content: 'hello' }) + '\n');

      expect(eventSpy).toHaveBeenCalledWith({
        sessionId,
        event: { type: 'assistant', content: 'hello' },
      });
    });

    it('parses multiple NDJSON lines in one chunk', async () => {
      const proc = mockChildProcess();
      const eventSpy = vi.fn();
      pm.on('event', eventSpy);

      await pm.createSession({
        taskId: 'task-1', role: 'coder', cwd: '/test',
      });

      const line1 = JSON.stringify({ type: 'assistant', content: 'first' });
      const line2 = JSON.stringify({ type: 'result', content: 'second' });
      proc._emitStdout(line1 + '\n' + line2 + '\n');

      expect(eventSpy).toHaveBeenCalledTimes(2);
    });

    it('handles partial chunk that splits across data events', async () => {
      const proc = mockChildProcess();
      const eventSpy = vi.fn();
      pm.on('event', eventSpy);

      const sessionId = await pm.createSession({
        taskId: 'task-1', role: 'coder', cwd: '/test',
      });

      // Send first half
      proc._emitStdout('{"type": "assistant", "content": "hel');
      expect(eventSpy).not.toHaveBeenCalled();

      // Send second half that completes the JSON
      proc._emitStdout('lo"}\n');

      expect(eventSpy).toHaveBeenCalledWith({
        sessionId,
        event: { type: 'assistant', content: 'hello' },
      });
    });

    it('emits raw event for non-JSON lines', async () => {
      const proc = mockChildProcess();
      const rawSpy = vi.fn();
      pm.on('raw', rawSpy);

      await pm.createSession({
        taskId: 'task-1', role: 'coder', cwd: '/test',
      });

      proc._emitStdout('This is not JSON\n');

      expect(rawSpy).toHaveBeenCalledWith({
        sessionId: expect.any(String),
        data: 'This is not JSON',
      });
    });

    it('emits raw event for broken JSON in middle of chunk', async () => {
      const proc = mockChildProcess();
      const rawSpy = vi.fn();
      pm.on('raw', rawSpy);

      await pm.createSession({
        taskId: 'task-1', role: 'coder', cwd: '/test',
      });

      // Valid JSON followed by invalid
      proc._emitStdout(JSON.stringify({ type: 'text', text: 'ok' }) + '\nnot json\n');

      expect(rawSpy).toHaveBeenCalledWith({
        sessionId: expect.any(String),
        data: 'not json',
      });
    });
  });

  // ── createSession: stderr ─────────────────────────────────────────────────

  describe('createSession — stderr handling', () => {
    it('emits error events from stderr', async () => {
      const proc = mockChildProcess();
      const errorSpy = vi.fn();
      pm.on('error', errorSpy);

      const sessionId = await pm.createSession({
        taskId: 'task-1', role: 'coder', cwd: '/test',
      });

      proc._emitStderr('some error output');

      expect(errorSpy).toHaveBeenCalledWith({
        sessionId,
        error: 'some error output',
      });
    });
  });

  // ── createSession: exit handler ───────────────────────────────────────────

  describe('createSession — exit handler', () => {
    it('sets status to done on zero exit code', async () => {
      const proc = mockChildProcess();

      const sessionId = await pm.createSession({
        taskId: 'task-1', role: 'coder', cwd: '/test',
      });

      proc._emitExit(0);

      const session = pm.getSession(sessionId);
      expect(session?.status).toBe('done');
    });

    it('sets status to error on non-zero exit code', async () => {
      const proc = mockChildProcess();

      const sessionId = await pm.createSession({
        taskId: 'task-1', role: 'coder', cwd: '/test',
      });

      proc._emitExit(1);

      const session = pm.getSession(sessionId);
      expect(session?.status).toBe('error');
    });

    it('emits exit event with code', async () => {
      const proc = mockChildProcess();
      const exitSpy = vi.fn();
      pm.on('exit', exitSpy);

      const sessionId = await pm.createSession({
        taskId: 'task-1', role: 'coder', cwd: '/test',
      });

      proc._emitExit(0);

      expect(exitSpy).toHaveBeenCalledWith({ sessionId, code: 0 });
    });

    it('flushes remaining buffer on exit', async () => {
      const proc = mockChildProcess();
      const eventSpy = vi.fn();
      pm.on('event', eventSpy);

      await pm.createSession({
        taskId: 'task-1', role: 'coder', cwd: '/test',
      });

      // Send a line without newline — stays in buffer
      proc._emitStdout(JSON.stringify({ type: 'assistant', content: 'flushed' }));
      expect(eventSpy).not.toHaveBeenCalled();

      // Exit triggers buffer flush
      proc._emitExit(0);

      expect(eventSpy).toHaveBeenCalledWith({
        sessionId: expect.any(String),
        event: { type: 'assistant', content: 'flushed' },
      });
    });

    it('emits raw for unparseable buffer on exit flush', async () => {
      const proc = mockChildProcess();
      const rawSpy = vi.fn();
      pm.on('raw', rawSpy);

      await pm.createSession({
        taskId: 'task-1', role: 'coder', cwd: '/test',
      });

      // Non-JSON buffer without newline
      proc._emitStdout('not-json');
      expect(rawSpy).not.toHaveBeenCalled();

      // Exit flush should emit raw
      proc._emitExit(0);

      expect(rawSpy).toHaveBeenCalledWith({
        sessionId: expect.any(String),
        data: 'not-json',
      });
    });

    it('ignores empty buffer on exit', async () => {
      const proc = mockChildProcess();
      const eventSpy = vi.fn();
      const rawSpy = vi.fn();
      pm.on('event', eventSpy);
      pm.on('raw', rawSpy);

      await pm.createSession({
        taskId: 'task-1', role: 'coder', cwd: '/test',
      });

      // Don't send any data — buffer is empty
      proc._emitExit(0);

      expect(eventSpy).not.toHaveBeenCalled();
      expect(rawSpy).not.toHaveBeenCalled();
    });
  });

  // ── _appendToLog ──────────────────────────────────────────────────────────

  describe('_appendToLog (via private method access)', () => {
    it('formats init event with timestamp', () => {
      (pm as unknown as AnyPM)._appendToLog('/tmp/test.log', {
        type: 'system',
        subtype: 'init',
        model: 'claude-sonnet-4',
      });
      expect(mockAppendFileSync).toHaveBeenCalledWith(
        '/tmp/test.log',
        expect.stringMatching(/^\[\d{2}:\d{2}:\d{2}\] ◆ Session started — claude-sonnet-4\n$/),
      );
    });

    it('formats assistant event with text blocks and timestamp', () => {
      (pm as unknown as AnyPM)._appendToLog('/tmp/test.log', {
        type: 'assistant',
        message: {
          content: [
            { type: 'text', text: 'Hello world' },
            { type: 'tool_use', name: 'bash' },
          ],
        },
      });
      expect(mockAppendFileSync).toHaveBeenCalledWith(
        '/tmp/test.log',
        expect.stringMatching(/^\[\d{2}:\d{2}:\d{2}\] Hello world▶ bash\n$/),
      );
    });

    it('formats result success event with timestamp', () => {
      (pm as unknown as AnyPM)._appendToLog('/tmp/test.log', {
        type: 'result',
        subtype: 'success',
        total_cost_usd: 0.0123,
        duration_ms: 1500,
      });
      expect(mockAppendFileSync).toHaveBeenCalledWith(
        '/tmp/test.log',
        expect.stringMatching(/^\[\d{2}:\d{2}:\d{2}\] \n✓ Done — \$0\.0123 \(1500ms\)\n$/),
      );
    });

    it('formats result failure event with timestamp', () => {
      (pm as unknown as AnyPM)._appendToLog('/tmp/test.log', {
        type: 'result',
        subtype: 'error',
        result: 'Invalid API key',
        duration_ms: 500,
      });
      expect(mockAppendFileSync).toHaveBeenCalledWith(
        '/tmp/test.log',
        expect.stringMatching(/^\[\d{2}:\d{2}:\d{2}\] \n✗ Failed: Invalid API key\n$/),
      );
    });

    it('formats result failure with unknown error with timestamp', () => {
      (pm as unknown as AnyPM)._appendToLog('/tmp/test.log', {
        type: 'result',
        subtype: 'error',
        duration_ms: 500,
      });
      expect(mockAppendFileSync).toHaveBeenCalledWith(
        '/tmp/test.log',
        expect.stringMatching(/^\[\d{2}:\d{2}:\d{2}\] \n✗ Failed: unknown error\n$/),
      );
    });

    it('handles assistant event with empty blocks gracefully', () => {
      (pm as unknown as AnyPM)._appendToLog('/tmp/test.log', {
        type: 'assistant',
        message: { content: [] },
      });
      // appendFileSync should not have been called because text is empty
      expect(mockAppendFileSync).not.toHaveBeenCalled();
    });

    it('handles assistant event with no message field', () => {
      (pm as unknown as AnyPM)._appendToLog('/tmp/test.log', {
        type: 'assistant',
      });
      // Should not throw, and no text to write
      expect(mockAppendFileSync).not.toHaveBeenCalled();
    });

    it('does not throw on appendFileSync failure (best-effort)', () => {
      mockAppendFileSync.mockImplementationOnce(() => { throw new Error('Disk full'); });
      expect(() =>
        (pm as unknown as AnyPM)._appendToLog('/tmp/test.log', {
          type: 'system',
          subtype: 'init',
          model: 'test',
        }),
      ).not.toThrow();
    });

    it('handles result event without total_cost_usd, with timestamp', () => {
      (pm as unknown as AnyPM)._appendToLog('/tmp/test.log', {
        type: 'result',
        subtype: 'success',
        duration_ms: 100,
      });
      expect(mockAppendFileSync).toHaveBeenCalledWith(
        '/tmp/test.log',
        expect.stringMatching(/^\[\d{2}:\d{2}:\d{2}\] \n✓ Done \(100ms\)\n$/),
      );
    });
  });

  // ── createSession with logFile option (exercises _appendToLog via stdout) ─

  describe('createSession — logFile integration', () => {
    it('calls appendFileSync when logFile is provided and valid JSON arrives', async () => {
      const proc = mockChildProcess();
      mockAppendFileSync.mockClear();

      await pm.createSession({
        taskId: 'task-1', role: 'coder', cwd: '/test', logFile: '/tmp/test.log',
      });

      proc._emitStdout(JSON.stringify({ type: 'result', subtype: 'success', duration_ms: 100 }) + '\n');

      expect(mockAppendFileSync).toHaveBeenCalled();
    });
  });

  // ── createTerminalSession ─────────────────────────────────────────────────

  describe('createTerminalSession', () => {
    beforeEach(() => {
      // Default: findExecutable returns 'claude'
      mockExecFileSync.mockReturnValue('claude');
      // Default: no role file exists
      mockExistsSync.mockReturnValue(false);
      // Default: pty spawn returns a mock
      mockPtySpawn.mockReturnValue({
        onData: vi.fn(),
        onExit: vi.fn(),
        write: vi.fn(),
        resize: vi.fn(),
        kill: vi.fn(),
      });
    });

    it('creates a PTY session and returns an ID', () => {
      const id = pm.createTerminalSession({
        projectPath: '/test/project',
        role: 'coder.md',
      });

      expect(id).toBeDefined();
      expect(typeof id).toBe('string');
      expect(pm.getTerminalSessions()).toHaveLength(1);
      expect(pm.getTerminalSessions()[0].id).toBe(id);
    });

    it('uses default claude binary name for PTY session', () => {
      pm.createTerminalSession({
        projectPath: '/test/project',
        role: 'coder.md',
      });

      expect(mockPtySpawn.mock.calls[0][0]).toBe('claude');
    });

    it('uses role file content when it exists', () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue('You are a coding expert.');
      mockPtySpawn.mockReset();
      mockPtySpawn.mockReturnValue({
        onData: vi.fn(),
        onExit: vi.fn(),
        write: vi.fn(),
        resize: vi.fn(),
        kill: vi.fn(),
      });

      pm.createTerminalSession({
        projectPath: '/test/project',
        role: 'coder.md',
      });

      const callArgs = mockPtySpawn.mock.calls[0];
      expect(callArgs[1]).toContain('--append-system-prompt');
      expect(callArgs[1]).toContain('You are a coding expert.');
    });

    it('does not add --append-system-prompt when role file is missing', () => {
      mockExistsSync.mockReturnValue(false);

      pm.createTerminalSession({
        projectPath: '/test/project',
        role: 'coder.md',
      });

      const callArgs = mockPtySpawn.mock.calls[0];
      expect(callArgs[1]).not.toContain('--append-system-prompt');
    });

    it('passes model option to PTY', () => {
      mockExistsSync.mockReturnValue(false);

      pm.createTerminalSession({
        projectPath: '/test/project',
        role: 'coder.md',
        model: 'claude-sonnet-4',
      });

      const callArgs = mockPtySpawn.mock.calls[0];
      expect(callArgs[1]).toContain('--model');
      expect(callArgs[1]).toContain('claude-sonnet-4');
    });

    it('sets correct PTY options (cols, rows, cwd)', () => {
      mockExistsSync.mockReturnValue(false);

      pm.createTerminalSession({
        projectPath: '/test/project',
        role: 'coder.md',
      });

      const ptyOptions = mockPtySpawn.mock.calls[0][2];
      expect(ptyOptions.cols).toBe(120);
      expect(ptyOptions.rows).toBe(40);
      expect(ptyOptions.cwd).toBe('/test/project');
      expect(ptyOptions.name).toBe('xterm-color');
    });

    it('emits terminal-data events from PTY data', () => {
      const dataSpy = vi.fn();
      let ptyDataHandler: ((data: string) => void) | null = null;
      mockPtySpawn.mockReturnValue({
        onData: (handler: (data: string) => void) => { ptyDataHandler = handler; },
        onExit: vi.fn(),
        write: vi.fn(),
        resize: vi.fn(),
        kill: vi.fn(),
      });

      pm.on('terminal-data', dataSpy);
      pm.createTerminalSession({ projectPath: '/test', role: 'coder.md' });

      expect(ptyDataHandler).toBeDefined();
      ptyDataHandler!('Hello from PTY');
      expect(dataSpy).toHaveBeenCalledWith({ sessionId: expect.any(String), data: 'Hello from PTY' });
    });

    it('emits terminal-exit on PTY exit and removes session', () => {
      const exitSpy = vi.fn();
      let ptyExitHandler: (() => void) | null = null;
      mockPtySpawn.mockReturnValue({
        onData: vi.fn(),
        onExit: (handler: () => void) => { ptyExitHandler = handler; },
        write: vi.fn(),
        resize: vi.fn(),
        kill: vi.fn(),
      });

      pm.on('terminal-exit', exitSpy);
      pm.createTerminalSession({ projectPath: '/test', role: 'coder.md' });

      expect(ptyExitHandler).toBeDefined();
      expect(pm.getTerminalSessions()).toHaveLength(1);
      ptyExitHandler!();
      expect(pm.getTerminalSessions()).toHaveLength(0);
      expect(exitSpy).toHaveBeenCalledWith({ sessionId: expect.any(String) });
    });

    it('uses getToolPath for claude binary name', () => {
      // getToolPath returns 'claude' by default (no tools.json config)
      pm.createTerminalSession({
        projectPath: '/test', role: 'coder.md',
      });

      expect(mockPtySpawn.mock.calls[0][0]).toBe('claude');
    });

    it('falls back to default claude binary name', () => {
      pm.createTerminalSession({
        projectPath: '/test', role: 'coder.md',
      });

      expect(mockPtySpawn.mock.calls[0][0]).toBe('claude');
    });
  });

  // ── Global singleton ──────────────────────────────────────────────────────

  // Global singleton is covered by the module-level import at the top of this file.
  // The `const processManager = global.__processManager ?? ...` code runs when the
  // module is first loaded (import at line ~31).

  // ── createSession edge cases ──────────────────────────────────────────────

  describe('createSession — edge cases', () => {
    it('creates session with model option', async () => {
      mockChildProcess();

      await pm.createSession({
        taskId: 'task-1', role: 'planner', cwd: '/test',
        model: 'claude-sonnet-4',
      });

      const spawnArgs = mockSpawn.mock.calls[0];
      expect(spawnArgs[0]).toBe('claude');
      expect(spawnArgs[1]).toContain('--model');
      expect(spawnArgs[1]).toContain('claude-sonnet-4');
    });

    it('creates session with permissionMode option', async () => {
      mockChildProcess();

      await pm.createSession({
        taskId: 'task-1', role: 'coder', cwd: '/test',
        permissionMode: 'someMode',
      });

      const spawnArgs = mockSpawn.mock.calls[0];
      expect(spawnArgs[1]).toContain('--permission-mode');
      expect(spawnArgs[1]).toContain('someMode');
    });

    it('stores the session internally with correct metadata', async () => {
      mockChildProcess();

      const sessionId = await pm.createSession({
        taskId: 'task-42', role: 'qa-reviewer', cwd: '/project/path',
      });

      const session = pm.getSession(sessionId);
      expect(session).toBeDefined();
      expect(session!.taskId).toBe('task-42');
      expect(session!.role).toBe('qa-reviewer');
      expect(session!.cwd).toBe('/project/path');
      expect(session!.status).toBe('running');
    });

    it('forwards env vars to spawned process', async () => {
      mockChildProcess();

      await pm.createSession({
        taskId: 'task-1', role: 'coder', cwd: '/test',
        env: { CUSTOM_KEY: 'custom_value' },
      });

      const spawnOpts = mockSpawn.mock.calls[0][2];
      expect(spawnOpts.env).toBeDefined();
      expect(spawnOpts.env!.CUSTOM_KEY).toBe('custom_value');
    });
  });

  // ── createSession: non-container mode verification ─────────────────────────

  describe('createSession — non-container mode', () => {
    it('calls claude spawn with pipe stdio in non-container mode', async () => {
      mockChildProcess();

      await pm.createSession({
        taskId: 'task-1', role: 'coder', cwd: '/test',
      });

      expect(mockSpawn).toHaveBeenCalledWith('claude', expect.any(Array), expect.objectContaining({
        stdio: ['pipe', 'pipe', 'pipe'],
        cwd: '/test',
      }));
    });
  });
});
