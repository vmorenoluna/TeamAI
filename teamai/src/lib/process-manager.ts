import { spawn, ChildProcess, execSync } from 'child_process';
import { EventEmitter } from 'events';
import { randomUUID } from 'crypto';
import { join } from 'path';
import * as pty from 'node-pty';
import { readFileSync, existsSync, appendFileSync } from 'fs';
import { containerManager, readContainerConfig, hostToContainerPath } from './container-manager';

function findExecutable(name: string): string {
  try {
    const cmd = process.platform === 'win32' ? `where ${name}` : `which ${name}`;
    return execSync(cmd, { encoding: 'utf-8' }).trim().split(/\r?\n/)[0].trim();
  } catch {
    return name;
  }
}

export interface TerminalSession {
  id: string;
  ptyProcess: pty.IPty;
  role: string;
  projectPath: string;
}

export interface AgentSession {
  id: string;
  process: ChildProcess;
  taskId: string;
  role: 'planner' | 'coder' | 'qa-reviewer' | 'qa-fixer' | 'merger' | 'general';
  cwd: string;
  status: 'running' | 'idle' | 'done' | 'error';
}

export class ProcessManager extends EventEmitter {
  private sessions: Map<string, AgentSession> = new Map();
  private terminalSessions: Map<string, TerminalSession> = new Map();

  /**
   * Spawn a new Claude CLI subprocess for an agent session.
   * When projectRoot is provided and container mode is enabled, the session
   * runs via `docker exec` inside the project's devcontainer.
   */
  async createSession(opts: {
    taskId: string;
    role: AgentSession['role'];
    cwd: string;
    model?: string;
    permissionMode?: string;
    env?: Record<string, string>;
    projectRoot?: string;
    logFile?: string;   // append formatted agent output here for cross-phase persistence
  }): Promise<string> {
    const id = randomUUID();

    const claudeArgs = [
      '-p',
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--verbose',
    ];

    if (opts.model) claudeArgs.push('--model', opts.model);

    let proc: ChildProcess;

    if (opts.projectRoot && readContainerConfig(opts.projectRoot).enabled) {
      const { containerId, remoteWorkspaceFolder } =
        await containerManager.ensureContainer(opts.projectRoot);

      const containerCwd = hostToContainerPath(opts.cwd, opts.projectRoot, remoteWorkspaceFolder);
      const envFlags = Object.entries(opts.env ?? {}).flatMap(([k, v]) => ['-e', `${k}=${v}`]);

      // In container mode use --dangerously-skip-permissions (safe inside isolated container)
      claudeArgs.push('--dangerously-skip-permissions');

      proc = spawn('docker', [
        'exec', '-i',
        '-u', 'node',            // run as the devcontainer remote user
        '-w', containerCwd,
        ...envFlags,
        containerId,
        'claude',
        ...claudeArgs,
      ], { stdio: ['pipe', 'pipe', 'pipe'] });
    } else {
      if (opts.permissionMode) claudeArgs.push('--permission-mode', opts.permissionMode);

      proc = spawn('claude', claudeArgs, {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, ...(opts.env ?? {}) },
        cwd: opts.cwd,
      });
    }

    // Parse NDJSON from stdout line by line
    const { logFile } = opts;
    let buffer = '';
    proc.stdout!.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        if (line.trim()) {
          try {
            const event = JSON.parse(line);
            this.emit('event', { sessionId: id, event });
            if (logFile) this._appendToLog(logFile, event);
          } catch {
            this.emit('raw', { sessionId: id, data: line });
          }
        }
      }
    });

    proc.stderr!.on('data', (chunk: Buffer) => {
      this.emit('error', { sessionId: id, error: chunk.toString() });
    });

    proc.on('exit', (code) => {
      if (buffer.trim()) {
        try {
          const event = JSON.parse(buffer);
          this.emit('event', { sessionId: id, event });
        } catch {
          this.emit('raw', { sessionId: id, data: buffer });
        }
      }
      const session = this.sessions.get(id);
      if (session) session.status = code === 0 ? 'done' : 'error';
      this.emit('exit', { sessionId: id, code });
    });

    this.sessions.set(id, {
      id,
      process: proc,
      taskId: opts.taskId,
      role: opts.role,
      cwd: opts.cwd,
      status: 'running',
    });

    return id;
  }

  private _appendToLog(logFile: string, event: any): void {
    try {
      let text = '';
      if (event.type === 'system' && event.subtype === 'init') {
        text = `◆ Session started — ${event.model}\n`;
      } else if (event.type === 'assistant') {
        const blocks: any[] = event.message?.content ?? [];
        for (const b of blocks) {
          if (b.type === 'text' && b.text) text += b.text;
          else if (b.type === 'tool_use') text += `▶ ${b.name}\n`;
        }
      } else if (event.type === 'result') {
        const cost = typeof event.total_cost_usd === 'number' ? ` — $${event.total_cost_usd.toFixed(4)}` : '';
        text = event.subtype === 'success'
          ? `\n✓ Done${cost} (${event.duration_ms}ms)\n`
          : `\n✗ Failed: ${event.result ?? 'unknown error'}\n`;
      }
      if (text) appendFileSync(logFile, text);
    } catch { /* best-effort */ }
  }

  /**
   * Send a message to an existing session.
   */
  sendMessage(sessionId: string, content: string): void {
    const session = this.sessions.get(sessionId);
    if (!session || !session.process.stdin?.writable) {
      throw new Error(`Session ${sessionId} not available`);
    }
    const msg = { type: 'user', message: { role: 'user', content } };
    session.process.stdin.write(JSON.stringify(msg) + '\n');
  }

  /**
   * Kill a session's subprocess.
   */
  killSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.process.kill('SIGTERM');
      session.status = 'done';
    }
  }

  getSession(id: string): AgentSession | undefined {
    return this.sessions.get(id);
  }

  getAllSessions(): AgentSession[] {
    return Array.from(this.sessions.values());
  }

  // ── PTY terminal sessions ──────────────────────────────────────────────────

  createTerminalSession(opts: {
    projectPath: string;
    role: string;
    model?: string;
  }): string {
    const id = randomUUID();
    const roleFile = join(opts.projectPath, '.claude', 'roles', opts.role);
    // Read content inline to avoid Windows path issues with --append-system-prompt-file
    const roleContent = existsSync(roleFile) ? readFileSync(roleFile, 'utf-8') : '';
    const args = roleContent ? ['--append-system-prompt', roleContent] : [];
    if (opts.model) args.push('--model', opts.model);

    const claudeBin = findExecutable('claude');
    const ptyProcess = pty.spawn(claudeBin, args, {
      name: 'xterm-color',
      cols: 120,
      rows: 40,
      cwd: opts.projectPath,
      env: process.env as Record<string, string>,
    });

    ptyProcess.onData((data) => {
      this.emit('terminal-data', { sessionId: id, data });
    });

    ptyProcess.onExit(() => {
      this.terminalSessions.delete(id);
      this.emit('terminal-exit', { sessionId: id });
    });

    this.terminalSessions.set(id, { id, ptyProcess, role: opts.role, projectPath: opts.projectPath });
    return id;
  }

  writeToTerminal(sessionId: string, data: string): void {
    this.terminalSessions.get(sessionId)?.ptyProcess.write(data);
  }

  resizeTerminal(sessionId: string, cols: number, rows: number): void {
    this.terminalSessions.get(sessionId)?.ptyProcess.resize(cols, rows);
  }

  killTerminalSession(sessionId: string): void {
    const s = this.terminalSessions.get(sessionId);
    if (s) {
      s.ptyProcess.kill();
      this.terminalSessions.delete(sessionId);
    }
  }

  getTerminalSessions(): TerminalSession[] {
    return Array.from(this.terminalSessions.values());
  }
}

// Store on global so server.ts and Next.js server actions share the same instance
// across module contexts (Next.js loads server actions in a separate module graph).
declare global {
  // eslint-disable-next-line no-var
  var __processManager: ProcessManager | undefined;
}

export const processManager: ProcessManager =
  global.__processManager ?? (global.__processManager = new ProcessManager());
