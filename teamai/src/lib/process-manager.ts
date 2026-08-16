import { spawn, ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import { randomUUID } from 'crypto';
import { join } from 'path';
import * as pty from 'node-pty';
import { readFileSync, existsSync, appendFileSync } from 'fs';
import { containerManager, readContainerConfig, readContainerRemoteUser, hostToContainerPath } from './container-manager';
import { getToolPath } from './tool-checker';
import { log, warn } from './logger';


export interface TerminalSession {
  id: string;
  ptyProcess: pty.IPty;
  role: string;
  projectPath: string;
}

/**
 * True if a parsed stdout event is an assistant message dispatching at
 * least one tool call. The CLI's stream-json protocol emits this event the
 * moment a tool is invoked, then nothing further until that tool's result
 * comes back as part of the next event — so this is the signal that
 * explains an otherwise-suspicious stdout gap.
 */
function isToolDispatchEvent(event: unknown): boolean {
  if (!event || typeof event !== 'object') return false;
  const e = event as { type?: unknown; message?: { content?: unknown } };
  if (e.type !== 'assistant') return false;
  const content = e.message?.content;
  if (!Array.isArray(content)) return false;
  return content.some((b: unknown) => !!b && typeof b === 'object' && (b as { type?: unknown }).type === 'tool_use');
}

export interface AgentSession {
  id: string;
  process: ChildProcess;
  taskId: string;
  role: 'analyst' | 'planner' | 'coder' | 'qa-reviewer' | 'merger' | 'general';
  cwd: string;
  /** The project root this session belongs to. Set from createSession opts. */
  projectRoot?: string;
  status: 'running' | 'idle' | 'done' | 'error';
  /** Last time (epoch ms) the session produced stdout output. Used for stall detection. */
  lastOutputAt: number;
  /**
   * True when the most recent stdout event was an assistant message
   * dispatching a tool call whose result hasn't arrived yet. The CLI emits
   * nothing while a tool executes — a single Bash call (a cold `sbt
   * compile`/`sbt test`, a slow network request) can legitimately produce
   * no output for many minutes. Stall detection uses this to apply a much
   * more generous timeout while a tool is genuinely running, vs. a tight
   * one when the session is idle (no tool in flight, no new message —
   * silence there really is suspicious). See getStalledSessions.
   */
  toolInFlight: boolean;
  /**
   * Set by killSession's optional `reason` param. Lets a consumer of the
   * resulting SessionKilledError (see waitForCompletion) distinguish a
   * stall-detector kill (recoverable — the coder gets a chance to react)
   * from a deliberate stop (stopTask/cancelPipeline — must never trigger an
   * automatic retry). Undefined for any kill that doesn't pass a reason.
   */
  killReason?: 'stalled';
  /**
   * Set alongside `killReason` by killSession's optional `stallKind` param
   * when `reason` is `'stalled'`. Records WHICH of the two stall thresholds
   * actually fired (see getStalledSessions) so a consumer of the resulting
   * SessionKilledError can report the real cause instead of assuming one —
   * a session idle between tool calls for just over 15 minutes and a session
   * whose tool call has been running for 30+ minutes are very different
   * situations and must not be described identically.
   */
  stallKind?: 'idle' | 'tool';
  /**
   * Per-session EventEmitter scoped to this session only.
   * Used by {@link waitForCompletion} to avoid piling listeners
   * on the global {@link processManager} emitter (BUG-20 / T29).
   */
  events: EventEmitter;
}

/**
 * Resolve the role persona text to inject as a session's system prompt, or
 * null when there is nothing to inject. Looks in
 * `<projectRoot>/.claude/roles/<role>.md` first (the per-project,
 * user-customizable copy), then falls back to the TeamAI-shipped
 * `defaults/roles/<role>.md`. Only the five pipeline roles have role files —
 * 'general' sessions have none, so they get nothing injected.
 */
export function readRoleSystemPrompt(
  projectRoot: string | undefined,
  role: AgentSession['role'],
): string | null {
  if (!projectRoot || role === 'general') return null;
  const candidates = [
    join(projectRoot, '.claude', 'roles', `${role}.md`),
    join(process.cwd(), 'defaults', 'roles', `${role}.md`),
  ];
  for (const file of candidates) {
    try {
      if (existsSync(file)) {
        const content = readFileSync(file, 'utf-8');
        if (content.trim()) return content;
      }
    } catch { /* fall through to the next candidate */ }
  }
  return null;
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
      // ScheduleWakeup is an interactive-session tool (Claude Code's own
      // /loop dynamic mode) with no counterpart in this pipeline — every
      // session spawned here runs headless (-p), and nothing in the
      // orchestrator listens for it. The only real resume mechanism is the
      // subtask_wakeup-st<id>.json file (see coder.md). A tool call that
      // appears to succeed but is actually a no-op is a worse trap than one
      // that errors outright, so remove it from the session entirely rather
      // than relying on prose alone to keep it unused.
      '--disallowedTools', 'ScheduleWakeup',
    ];

    if (opts.model) claudeArgs.push('--model', opts.model);

    // Inject the role persona as a system prompt instead of telling the agent
    // to "read and adopt" .claude/roles/{role}.md as its first action. The old
    // flow cost every session a Read tool round-trip plus a re-adoption turn;
    // the system prompt is already in context before the first turn and is the
    // always-in-effect instruction layer. Mirrors createTerminalSession, which
    // has always passed the role this way. Only the five pipeline roles have
    // role files — 'general' sessions (insights, ideation, roadmap, changelog,
    // GitHub) get nothing injected and keep any role-adoption step their own
    // command template defines.
    const rolePrompt = readRoleSystemPrompt(opts.projectRoot, opts.role);
    if (rolePrompt) claudeArgs.push('--append-system-prompt', rolePrompt);

    let proc: ChildProcess;

    if (opts.projectRoot && readContainerConfig(opts.projectRoot).enabled) {
      const { containerId, remoteWorkspaceFolder } =
        await containerManager.ensureContainer(opts.projectRoot, opts.logFile);

      const containerCwd = hostToContainerPath(opts.cwd, opts.projectRoot, remoteWorkspaceFolder);
      const envFlags = Object.entries(opts.env ?? {}).flatMap(([k, v]) => ['-e', `${k}=${v}`]);

      // In container mode use --dangerously-skip-permissions (safe inside isolated container)
      claudeArgs.push('--dangerously-skip-permissions');

      const remoteUser = readContainerRemoteUser(opts.projectRoot);
      proc = spawn(getToolPath('docker'), [
        'exec', '-i',
        '-u', remoteUser,            // use the devcontainer's remoteUser from devcontainer.json
        '-w', containerCwd,
        ...envFlags,
        containerId,
        'claude',
        ...claudeArgs,
      ], { stdio: ['pipe', 'pipe', 'pipe'] });
    } else {
      if (opts.permissionMode) claudeArgs.push('--permission-mode', opts.permissionMode);

      const claudePath = getToolPath('claude');
      proc = spawn(claudePath, claudeArgs, {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, ...(opts.env ?? {}) },
        cwd: opts.cwd,
      });
    }

    // Catch spawn errors (ENOENT when Claude CLI is not installed, etc.)
    // to prevent uncaught exceptions from crashing the server.
    proc.on('error', (err) => {
      warn('process-manager', `Session ${id} spawn failed — ${err.message}`);
      this.emit('error', { sessionId: id, error: err.message });
      const session = this.sessions.get(id);
      if (session) session.status = 'error';
    });

    // Per-session EventEmitter so waitForCompletion doesn't pile listeners
    // on the global processManager emitter (BUG-20 / T29).
    const sessionEvents = new EventEmitter();

    // Parse NDJSON from stdout line by line
    const { logFile } = opts;
    let buffer = '';
    const now = Date.now();
    if (proc.stdout) {
    proc.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      const session = this.sessions.get(id);
      for (const line of lines) {
        if (line.trim()) {
          try {
            const event = JSON.parse(line);
            this.emit('event', { sessionId: id, event });
            sessionEvents.emit('event', { sessionId: id, event });
            if (logFile) this._appendToLog(logFile, event);
            if (session) session.toolInFlight = isToolDispatchEvent(event);
          } catch {
            this.emit('raw', { sessionId: id, data: line });
            sessionEvents.emit('raw', { sessionId: id, data: line });
          }
        }
      }
      // Update heartbeat on output
      if (session) session.lastOutputAt = Date.now();
    });

    }
    if (proc.stderr) {
    proc.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      if (logFile) {
        // Full date-time (YYYY-MM-DDTHH:MM:SS), not just HH:MM:SS — a task
        // whose logs span multiple days (retries, QA bounces) needs the
        // date to sort correctly. See _appendToLog for the matching write.
        const ts = new Date().toISOString().slice(0, 19);
        try {
          appendFileSync(logFile, `[${ts}] [STDERR] ${text}`);
        } catch (err) {
          // Guarded like _appendToLog — an uncaught throw in a stream
          // 'data' listener would crash the whole process.
          warn('process-manager', `Failed to append stderr to log for session ${id}`, err);
        }
      }
      this.emit('error', { sessionId: id, error: text });
    });

    }
    proc.on('exit', (code, signal) => {
      if (buffer.trim()) {
        try {
          const event = JSON.parse(buffer);
          this.emit('event', { sessionId: id, event });
          sessionEvents.emit('event', { sessionId: id, event });
        } catch {
          this.emit('raw', { sessionId: id, data: buffer });
          sessionEvents.emit('raw', { sessionId: id, data: buffer });
        }
      }
      const session = this.sessions.get(id);
      if (session) session.status = code === 0 ? 'done' : 'error';
      this.emit('exit', { sessionId: id, code, signal });
      sessionEvents.emit('exit', { sessionId: id, code, signal });
    });

    this.sessions.set(id, {
      id,
      process: proc,
      taskId: opts.taskId,
      role: opts.role,
      cwd: opts.cwd,
      projectRoot: opts.projectRoot,
      status: 'running',
      lastOutputAt: now,
      toolInFlight: false,
      events: sessionEvents,
    });

    return id;
  }

  private _appendToLog(logFile: string, event: Record<string, unknown>): void {
    try {
      let text = '';
      if (event.type === 'system' && event.subtype === 'init') {
        text = `◆ Session started — ${event.model}\n`;
      } else if (event.type === 'assistant') {
        const blocks: Record<string, unknown>[] = (event.message as Record<string, unknown>)?.content as Record<string, unknown>[] ?? [];
        for (const b of blocks) {
          if (b.type === 'text' && b.text) text += b.text;
          else if (b.type === 'tool_use') text += `▶ ${b.name}\n`;
        }
      } else if (event.type === 'result') {
        const cost = typeof event.total_cost_usd === 'number' ? ` — $${event.total_cost_usd.toFixed(4)}` : '';
        text = event.subtype === 'success'
          ? `\n✓ Done${cost} (${event.duration_ms}ms)\n`
          : `\n✗ Failed: ${event.result ?? 'unknown error'}\n`;
      } else if (event.type === 'error') {
        text = `\n⚠ ${event.error}\n`;
      }
      if (text) {
        // YYYY-MM-DDTHH:MM:SS — see the stderr handler above for why the
        // date matters, not just the time.
        const ts = new Date().toISOString().slice(0, 19);
        appendFileSync(logFile, `[${ts}] ${text}`);
      }
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
   *
   * @param reason When set to 'stalled' (only sweepStalledTasks' stall-detector kill
   * does this), the resulting SessionKilledError carries the same reason so
   * runSubtaskSession can offer the coder a recovery retry instead of
   * failing the task outright. Omit for a deliberate stop (stopTask /
   * cancelPipeline) — those must never trigger an automatic retry.
   * @param stallKind Only meaningful alongside reason 'stalled' — which
   * threshold fired (idle >15min vs tool-in-flight >30min). The caller
   * already knows this (it's `session.toolInFlight` at kill time); pass it
   * through rather than letting a downstream consumer guess or hardcode one.
   */
  killSession(sessionId: string, reason?: 'stalled', stallKind?: 'idle' | 'tool'): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      if (reason) session.killReason = reason;
      if (stallKind) session.stallKind = stallKind;
      session.process.kill('SIGTERM');
      // SIGKILL fallback after a grace period if the process ignores SIGTERM
      // Use exitCode instead of process.killed (killed is set synchronously by SIGTERM above)
      setTimeout(() => {
        const s = this.sessions.get(sessionId);
        if (s && s.process.exitCode === null) {
          s.process.kill('SIGKILL');
        }
      }, 5_000);
      session.status = session.status === 'error' ? 'error' : 'done';
    }
  }

  getSession(id: string): AgentSession | undefined {
    return this.sessions.get(id);
  }

  getAllSessions(): AgentSession[] {
    return Array.from(this.sessions.values());
  }

  /**
   * Return sessions whose child process has exited (exitCode !== null) or was
   * killed (process.killed === true).  These represent stale references left
   * after a server crash or unexpected shutdown.
   */
  getStaleSessions(): AgentSession[] {
    const stale: AgentSession[] = [];
    for (const session of this.sessions.values()) {
      if (session.process.exitCode !== null || session.process.killed) {
        stale.push(session);
      }
    }
    return stale;
  }

  /**
   * Remove a stale session from the in-memory map.  Does not attempt to kill
   * the child process (assumed already dead).
   */
  removeStaleSession(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  /**
   * Return sessions that have produced no output for longer than the
   * applicable threshold. These sessions may be stalled/hung and need
   * intervention (#8).
   *
   * Two thresholds, not one: a session with a tool call in flight
   * (`toolInFlight`) is expected to be silent for as long as that single
   * command takes — a cold compile, a full test run, a slow network call.
   * A session that is idle (no tool running, and hasn't sent a new message)
   * has no such excuse; silence there is a genuine stall signal and should
   * be caught quickly.
   *
   * @param resolveThresholds Called per-session to resolve the (idle, tool)
   *   timeout in milliseconds for that specific session. Receives the session
   *   so the caller can look up per-project config (e.g. pipeline.json
   *   idleStallMinutes / toolStallMinutes). Called once per running session,
   *   so it must be fast (no I/O — pre-resolve the config before calling).
   */
  getStalledSessions(
    resolveThresholds: (session: AgentSession) => { idleMs: number; toolMs: number },
  ): AgentSession[] {
    const now = Date.now();
    const stalled: AgentSession[] = [];
    for (const session of this.sessions.values()) {
      if (session.status !== 'running') continue;
      const { idleMs, toolMs } = resolveThresholds(session);
      const threshold = session.toolInFlight ? toolMs : idleMs;
      if (now - session.lastOutputAt > threshold) {
        stalled.push(session);
      }
    }
    return stalled;
  }

  /** Per-session EventEmitter — scoped to avoid listener pile-up on the global emitter. */
  getSessionEmitter(sessionId: string): EventEmitter | undefined {
    return this.sessions.get(sessionId)?.events;
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
    if (roleContent) {
      log(`terminal ${id}`, `Role persona loaded from ${roleFile} (${roleContent.length} chars)`);
    } else {
      warn(`terminal ${id}`, `Role file not found or empty: ${roleFile} — starting without role persona`);
    }
    const args = roleContent ? ['--append-system-prompt', roleContent] : [];
    if (opts.model) args.push('--model', opts.model);

    const claudeBin = getToolPath('claude');
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

/**
 * Returns the container-related session options for createSession().
 * When projectRoot is provided and container mode is enabled in
 * .teamai/container.json, the session runs inside the devcontainer with
 * --dangerously-skip-permissions. On the host, --permission-mode bypassPermissions
 * tells Claude to skip interactive permission prompts.
 *
 * This is the single source of truth for container session configuration,
 * used by both the orchestrator (ticket pipelines) and standalone commands
 * (roadmap, ideation, changelog, insights, GitHub issues).
 */
export function containerSessionOpts(projectRoot: string): {
  projectRoot: string;
  permissionMode: 'bypassPermissions';
} {
  return { projectRoot, permissionMode: 'bypassPermissions' };
}

// Store on global so server.ts and Next.js server actions share the same instance
// across module contexts (Next.js loads server actions in a separate module graph).
declare global {
  var __processManager: ProcessManager | undefined;
}

export const processManager: ProcessManager =
  global.__processManager ?? (global.__processManager = new ProcessManager());
