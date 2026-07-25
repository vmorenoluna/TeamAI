import { createServer } from 'http';
import { parse } from 'url';
import next from 'next';
import { WebSocketServer, WebSocket } from 'ws';
import { processManager } from './src/lib/process-manager';
import { containerManager } from './src/lib/container-manager';
import { startupCleanup, autoResumeInterruptedTasks, sweepStalledTasks } from './src/lib/recovery';
import { restoreAutoModeStates } from './src/lib/auto-mode';
import { error as logError } from './src/lib/logger';
import { checkAllTools } from './src/lib/tool-checker';

const app = next({ dev: process.env.NODE_ENV !== 'production' });
const handle = app.getRequestHandler();

app.prepare().then(() => {
  const server = createServer((req, res) => {
    // ── Test-only endpoint: inject a synthetic agent event for E2E testing ──
    if (process.env.NODE_ENV === 'test' && req.method === 'POST' && req.url === '/api/test/emit-agent-event') {
      let body = '';
      req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
      req.on('end', () => {
        try {
          const payload = JSON.parse(body);
          const msg = JSON.stringify(payload);
          for (const client of wss.clients) {
            if (client.readyState === WebSocket.OPEN) client.send(msg);
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, clients: wss.clients.size }));
        } catch (err) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: String(err) }));
        }
      });
      return;
    }
    handle(req, res, parse(req.url!, true));
  });

  // noServer: true so we handle upgrades manually and don't block Next.js HMR
  const wss = new WebSocketServer({ noServer: true });

  // Augment WebSocket type with projectRoot for broadcast filtering
  interface ProjectWebSocket extends WebSocket {
    projectRoot?: string;
  }

  /** Helper: only send to clients that match the event's project, or have no project set (backwards compat). */
  function broadcastToProject(event: { projectRoot?: string }, msg: string): void {
    const eventProject = typeof event.projectRoot === 'string' ? event.projectRoot : undefined;
    for (const client of wss.clients) {
      const pws = client as ProjectWebSocket;
      if (pws.readyState !== WebSocket.OPEN) continue;
      // Send if no project filter on client (backwards compat), or client's project matches event
      if (!pws.projectRoot || !eventProject || pws.projectRoot === eventProject) {
        pws.send(msg);
      }
    }
  }

  wss.on('connection', (ws) => {
    // Agent event streaming — filtered to the client's project
    const agentHandler = ({ sessionId, event }: { sessionId: string; event: Record<string, unknown> }) => {
      const session = processManager.getSession(sessionId);
      if (!session) return;
      const taskId = session.taskId;
      const pws = ws as ProjectWebSocket;
      // Filter: only send if the client has no project filter (backwards compat)
      // or the session's projectRoot matches the client's project
      if (pws.projectRoot && session.projectRoot && session.projectRoot !== pws.projectRoot) return;
      ws.send(JSON.stringify({ sessionId, taskId, event }));
    };
    processManager.on('event', agentHandler);
    processManager.on('error', agentHandler);

    // PTY terminal data streaming
    const terminalHandler = ({ sessionId, data }: { sessionId: string; data: string }) => {
      ws.send(JSON.stringify({ type: 'terminal', sessionId, data }));
    };
    processManager.on('terminal-data', terminalHandler);

    // Messages from browser → PTY input / resize
    ws.on('message', (msg: Buffer) => {
      try {
        const parsed = JSON.parse(msg.toString());
        if (parsed.type === 'terminal-input') {
          processManager.writeToTerminal(parsed.sessionId, parsed.data);
        } else if (parsed.type === 'terminal-resize') {
          processManager.resizeTerminal(parsed.sessionId, parsed.cols, parsed.rows);
        }
      } catch (err) { logError('ws', 'Failed to parse client message', err); }
    });

    ws.on('close', () => {
      processManager.off('event', agentHandler);
      processManager.off('error', agentHandler);
      processManager.off('terminal-data', terminalHandler);
    });
  });

  // Broadcast phase-change events from the Orchestrator to clients viewing the relevant project
  processManager.on('phase-change', (data: { taskId: string; phase: string; projectRoot?: string; prUrl?: string; platform?: string }) => {
    const msg = JSON.stringify({ type: 'phase-change', taskId: data.taskId, phase: data.phase, prUrl: data.prUrl, platform: data.platform });
    broadcastToProject(data, msg);
  });

  // Broadcast subtask-progress events so the kanban counter updates live during implement
  processManager.on('subtask-progress', (data: { taskId: string; completed: number; total: number; projectRoot?: string }) => {
    const msg = JSON.stringify({ type: 'subtask-progress', taskId: data.taskId, completed: data.completed, total: data.total });
    broadcastToProject(data, msg);
  });

  // Broadcast container lifecycle state changes to clients viewing the relevant project
  containerManager.on('container-state', (data: { projectRoot: string; state: string }) => {
    const msg = JSON.stringify({ type: 'container-state', projectRoot: data.projectRoot, state: data.state });
    broadcastToProject(data, msg);
  });

  // Broadcast container startup log messages to clients viewing the relevant project
  containerManager.on('container-log', (data: { projectRoot: string; message: string }) => {
    const msg = JSON.stringify({ type: 'container-log', projectRoot: data.projectRoot, message: data.message });
    broadcastToProject(data, msg);
  });

  // Broadcast container validation step updates
  containerManager.on('container-validation', (data: { projectRoot: string; step: unknown }) => {
    const msg = JSON.stringify({ type: 'container-validation', projectRoot: data.projectRoot, step: data.step });
    broadcastToProject(data, msg);
  });

  server.on('upgrade', (request, socket, head) => {
    const reqUrl = new URL(request.url!, `http://${request.headers.host || `127.0.0.1:${port}`}`);
    const pathname = reqUrl.pathname;
    const project = reqUrl.searchParams.get('project');
    if (pathname === '/ws') {
      wss.handleUpgrade(request, socket, head, (client) => {
        if (typeof project === 'string') {
          (client as ProjectWebSocket).projectRoot = project;
        }
        wss.emit('connection', client, request);
      });
    }
    // All other paths (e.g. /_next/webpack-hmr) fall through to Next.js
  });

  const port = parseInt(process.env.PORT || '3000', 10);
  const host = process.env.HOST || '0.0.0.0';
  // ── Global error handlers so unhandled rejections don't crash the server ──
  process.on('unhandledRejection', (reason: unknown) => {
    logError('server', 'Unhandled rejection', reason instanceof Error ? reason : String(reason));
  });

  process.on('uncaughtException', (err: Error) => {
    logError('server', 'Uncaught exception', err);
    // Don't exit — log and continue
  });

  server.listen(port, host, () => {
    console.log(`> Ready on http://${host}:${port}`);

    // ── Prerequisite tool check ────────────────────────────────────────
    const tools = checkAllTools();
    const missing = tools.filter(t => !t.found);
    if (missing.length > 0) {
      console.warn('[tools] Missing external tools detected:');
      for (const t of missing) {
        console.warn(`  • ${t.label}: ${t.error}`);
      }
      console.warn('[tools] Configure custom paths in Settings → Tool Paths.');
    } else {
      console.log('[tools] All prerequisite tools found');
    }

    // ── Startup crash recovery scan ─────────────────────────────────────
    const staleSessions = processManager.getStaleSessions();
    const report = startupCleanup(staleSessions.length);

    const parts: string[] = [];
    if (report.restoredWorktrees > 0) {
      parts.push(`${report.restoredWorktrees} worktree(s) restored from container-patched state`);
    }
    if (report.interruptedTasks.length > 0) {
      parts.push(`${report.interruptedTasks.length} interrupted task(s)`);
    }
    if (report.staleSessions > 0) {
      parts.push(`${report.staleSessions} stale session(s)`);
    }
    if (report.orphanedWorktrees.length > 0) {
      parts.push(`${report.orphanedWorktrees.length} orphaned worktree(s)`);
    }
    if (report.autoClearedRateLimits > 0) {
      parts.push(`${report.autoClearedRateLimits} expired rate limit(s) auto-cleared`);
    }
    if (report.artifactInconsistencies.length > 0) {
      parts.push(`${report.artifactInconsistencies.length} artifact inconsistency(s)`);
    }

    if (parts.length > 0) {
      console.log(`[recovery] ${parts.join(', ')} detected:`);
      for (const t of report.interruptedTasks) {
        console.log(`  • interrupted: ${t.title} (${t.phase}) in ${t.projectName}`);
      }
      for (const s of staleSessions) {
        console.log(`  • stale session: ${s.id.substring(0, 8)}… task=${s.taskId} role=${s.role}`);
        processManager.removeStaleSession(s.id);
      }
      for (const w of report.orphanedWorktrees) {
        console.log(`  • orphaned worktree: ${w.path}`);
      }
      for (const a of report.artifactInconsistencies) {
        console.log(`  • artifact inconsistency: ${a.title} (${a.phase}) in ${a.projectName} — ${a.issue}`);
      }
    } else {
      console.log('[recovery] clean — no stale state detected');
    }

    // ── Auto-resume interrupted tasks on startup ────────────────────────
    if (report.interruptedTasks.length > 0) {
      autoResumeInterruptedTasks().then(count => {
        console.log(`[auto-resume] Queued ${count} interrupted task(s) for resumption`);
      }).catch(err => {
        logError('auto-resume', 'Failed to auto-resume interrupted tasks', err);
      });
    }

    // ── Restore auto-mode state from disk (Bug 1) ──────────────────────
    // Auto-mode state is persisted to .teamai/auto-mode.json so it survives
    // server restarts (dev hot reload, crash, manual restart). Without this,
    // a rate-limit pause that spans a restart would silently disable auto mode.
    try {
      const restored = restoreAutoModeStates();
      if (restored > 0) {
        console.log(`[auto-mode] Restored auto mode for ${restored} project(s) from disk`);
      }
    } catch (err) {
      logError('auto-mode', 'Failed to restore auto-mode states from disk', err);
    }

    // ── Periodic stall-detection sweep ──────────────────────────────────
    // Every 5 minutes, scan all projects for tasks stuck in active phases
    // (expired rate-limit windows, silent session exits, etc.) and re-queue them.
    const SWEEP_INTERVAL_MS = 5 * 60_000; // 5 minutes
    const STALLED_SESSION_TIMEOUT_MS = 10 * 60_000; // 10 minutes
    setInterval(() => {
      sweepStalledTasks().then(count => {
        if (count > 0) {
          console.log(`[sweep] Re-queued ${count} stalled task(s)`);
        }
      }).catch(err => {
        logError('sweep', 'Periodic stall-detection sweep failed', err);
      });

      // Also detect and clean up hung agent sessions (no output for >10 min)
      const stalled = processManager.getStalledSessions(STALLED_SESSION_TIMEOUT_MS);
      for (const s of stalled) {
        console.log(`[sweep] Session ${s.id.substring(0, 8)}… task=${s.taskId} role=${s.role} stalled >10 min — killing`);
        processManager.killSession(s.id);
      }
      if (stalled.length > 0) {
        console.log(`[sweep] Killed ${stalled.length} stalled session(s)`);
      }
    }, SWEEP_INTERVAL_MS);
  });

  // ── Container availability listener: auto-resume when container becomes available ──
  containerManager.on('container-state', (data: { projectRoot: string; state: string }) => {
    if (data.state === 'running') {
      console.log(`[auto-resume] Container for ${data.projectRoot} became available — checking for interrupted tasks`);
      autoResumeInterruptedTasks().then(count => {
        if (count > 0) {
          console.log(`[auto-resume] Queued ${count} interrupted task(s) after container became available`);
        }
      }).catch(err => {
        logError('auto-resume', 'Failed to auto-resume after container became available', err);
      });
    }
  });
});
