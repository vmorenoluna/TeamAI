import { spawn, ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import { randomUUID } from 'crypto';

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

  /**
   * Spawn a new Claude CLI subprocess for an agent session.
   * The process stays alive for multi-turn conversation.
   */
  createSession(opts: {
    taskId: string;
    role: AgentSession['role'];
    cwd: string;
    model?: string;
    permissionMode?: string;
  }): string {
    const id = randomUUID();

    const args = [
      '-p',
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--verbose',
      '--cwd', opts.cwd,
    ];

    if (opts.model) {
      args.push('--model', opts.model);
    }

    if (opts.permissionMode) {
      args.push('--permission-mode', opts.permissionMode);
    }

    const proc = spawn('claude', args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
    });

    // Parse NDJSON from stdout line by line
    let buffer = '';
    proc.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        if (line.trim()) {
          try {
            const event = JSON.parse(line);
            this.emit('event', { sessionId: id, event });
          } catch {
            this.emit('raw', { sessionId: id, data: line });
          }
        }
      }
    });

    proc.stderr.on('data', (chunk: Buffer) => {
      this.emit('error', { sessionId: id, error: chunk.toString() });
    });

    proc.on('exit', (code) => {
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

  getSession(id: string): AgentSession | undefined {
    return this.sessions.get(id);
  }

  getallSessions(): AgentSession[] {
    return Array.from(this.sessions.values());
  }

  terminateSession(id: string): void {
    const session = this.sessions.get(id);
    if (session) {
      session.process.kill();
      this.sessions.delete(id);
    }
  }
}

export const processManager = new ProcessManager();
