import { createServer } from 'http';
import { parse } from 'url';
import next from 'next';
import { WebSocketServer, WebSocket } from 'ws';
import { processManager } from './src/lib/process-manager';
import { containerManager } from './src/lib/container-manager';
import { startupCleanup, autoResumeInterruptedTasks } from './src/lib/recovery';
import { error as logError } from './src/lib/logger';

const app = next({ dev: process.env.NODE_ENV !== 'production' });
const handle = app.getRequestHandler();

app.prepare().then(() => {
  const server = createServer((req, res) => {
    handle(req, res, parse(req.url!, true));
  });

  // noServer: true so we handle upgrades manually and don't block Next.js HMR
  const wss = new WebSocketServer({ noServer: true });
  wss.on('connection', (ws) => {
    // Agent event streaming
    const agentHandler = ({ sessionId, event }: { sessionId: string; event: Record<string, unknown> }) => {
      const taskId = processManager.getSession(sessionId)?.taskId;
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

  // Broadcast phase-change events from the Orchestrator to all connected clients
  processManager.on('phase-change', (data: { taskId: string; phase: string; prUrl?: string; platform?: string }) => {
    const msg = JSON.stringify({ type: 'phase-change', taskId: data.taskId, phase: data.phase, prUrl: data.prUrl, platform: data.platform });
    for (const client of wss.clients) {
      if (client.readyState === WebSocket.OPEN) client.send(msg);
    }
  });

  // Broadcast container lifecycle state changes to all connected clients
  containerManager.on('container-state', (data: { projectRoot: string; state: string }) => {
    const msg = JSON.stringify({ type: 'container-state', projectRoot: data.projectRoot, state: data.state });
    for (const client of wss.clients) {
      if (client.readyState === WebSocket.OPEN) client.send(msg);
    }
  });

  // Broadcast container startup log messages to all connected clients
  containerManager.on('container-log', (data: { projectRoot: string; message: string }) => {
    const msg = JSON.stringify({ type: 'container-log', projectRoot: data.projectRoot, message: data.message });
    for (const client of wss.clients) {
      if (client.readyState === WebSocket.OPEN) client.send(msg);
    }
  });

  server.on('upgrade', (request, socket, head) => {
    const { pathname } = parse(request.url!, true);
    if (pathname === '/ws') {
      wss.handleUpgrade(request, socket, head, (client) => {
        wss.emit('connection', client, request);
      });
    }
    // All other paths (e.g. /_next/webpack-hmr) fall through to Next.js
  });

  const host = process.env.HOST || '0.0.0.0';
  // ── Global error handlers so unhandled rejections don't crash the server ──
  process.on('unhandledRejection', (reason: unknown) => {
    logError('server', 'Unhandled rejection', reason instanceof Error ? reason : String(reason));
  });

  process.on('uncaughtException', (err: Error) => {
    logError('server', 'Uncaught exception', err);
    // Don't exit — log and continue
  });

  server.listen(3000, host, () => {
    console.log(`> Ready on http://${host}:3000`);

    // ── Startup crash recovery scan ─────────────────────────────────────
    const staleSessions = processManager.getStaleSessions();
    const report = startupCleanup(staleSessions.length);

    const parts: string[] = [];
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
