// Must be the first import: static imports evaluate before any of this
// file's own top-level statements run, so an imperative polyfill placed
// here in source order would still lose the race against the `next` import
// below. Putting the polyfill in its own module and importing it first
// guarantees it runs before `next`'s module graph does. See that module for
// why this is needed.
import './src/lib/node-environment-polyfill';

import { createServer } from 'http';
import { writeFileSync, unlinkSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { parse } from 'url';
import next from 'next';
import { WebSocketServer, WebSocket } from 'ws';
import { processManager } from './src/lib/process-manager';
import { containerManager } from './src/lib/container-manager';
import { startupCleanup, autoResumeInterruptedTasks, sweepStalledTasks } from './src/lib/recovery';
import { restoreAutoModeStates } from './src/lib/auto-mode';
import { startRoleRefinementWatcher } from './src/lib/role-refinement-watcher';
import { error as logError } from './src/lib/logger';
import { checkAllTools } from './src/lib/tool-checker';
import { projectStore } from './src/lib/project-store';
import { prewarmModelsCache } from './src/app/actions/providers';

const app = next({ dev: process.env.NODE_ENV !== 'production' });
const handle = app.getRequestHandler();

app.prepare().then(async () => {
  const server = createServer((req, res) => {
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

    // Messages from browser → PTY input / resize, plus replay when a terminal
    // panel reconnects after route navigation. The PTY remains alive while
    // the page is unmounted, so replay the buffered conversation before new
    // output is streamed to the returning panel.
    ws.on('message', (msg: Buffer) => {
      try {
        const parsed = JSON.parse(msg.toString());
        if (parsed.type === 'terminal-attach') {
          const output = processManager.getTerminalOutput(parsed.sessionId);
          if (output && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'terminal', sessionId: parsed.sessionId, data: output }));
          }
        } else if (parsed.type === 'terminal-input') {
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

  // Broadcast role-refinement events so open task panels / the /task page
  // refresh when a failure analysis completes.
  processManager.on('refinement-update', (data: { taskId: string; projectRoot?: string }) => {
    const msg = JSON.stringify({ type: 'refinement-update', taskId: data.taskId });
    broadcastToProject(data, msg);
  });

  // Broadcast generic task mutations from TaskStore (title/description edits,
  // dependency changes, artifact clearing, human-feedback routing, pause
  // state, etc.) so every UI surface refreshes on any orchestrator-driven
  // state change — not only the phase transitions that happen when an agent
  // session starts. Carries no data beyond the taskId; consumers just re-fetch.
  processManager.on('task-updated', (data: { taskId: string; projectRoot?: string }) => {
    const msg = JSON.stringify({ type: 'task-updated', taskId: data.taskId });
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

  // Broadcast container-docker-missing events so the UI can show a warning dialog
  processManager.on('container-docker-missing', (data: { projectRoot: string }) => {
    const msg = JSON.stringify({ type: 'container-docker-missing', projectRoot: data.projectRoot });
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

  // ── Port cleanup ─────────────────────────────────────────────────────
  // Previous runs (including E2E) can leave orphaned server processes on
  // port 3001 because Playwright's SIGTERM to the webServer shell doesn't
  // propagate to grandchild Node.js processes on Windows.  By cleaning up
  // here (before listen()), the server can safely restart.
  try {
    const { clearPort } = await import('./scripts/clear-port-3001.mjs');
    if (typeof clearPort === 'function') {
      await clearPort(String(port));
    }
  } catch {
    // clear-port script not available (e.g. production build) — skip
  }

  // ── PID file for zombie detection ────────────────────────────────────
  // On Windows, Playwright spawns the webServer through cmd.exe.  When
  // Playwright kills the webServer, the signal reaches cmd.exe but NOT the
  // Node.js grandchild — our server becomes a zombie occupying port 3001.
  //
  // We write our PID to a known file AFTER port cleanup and successful
  // bind, so the next run's clear-port can target-kill us by PID instead
  // of scanning netstat.  Clean shutdown (SIGINT/SIGTERM/SIGBREAK) deletes
  // the file; force-killed zombies leave it behind for detection.
  //
  // NOTE: written AFTER clearPort() to avoid a self-kill — clearPort
  // checks the PID file and would kill us if we wrote it first.
  // Port-specific: prod (3000) and test (3001) use separate PID files
  // so they never kill each other.
  const PID_FILE = join(tmpdir(), `teamai-server-${port}.pid`);

  function removePidFile() {
    try {
      if (existsSync(PID_FILE)) {
        unlinkSync(PID_FILE);
        console.log(`[server] Removed PID file ${PID_FILE}`);
      }
    } catch { /* best-effort */ }
  }

  // ── Global error handlers so unhandled rejections don't crash the server ──
  process.on('unhandledRejection', (reason: unknown) => {
    logError('server', 'Unhandled rejection', reason instanceof Error ? reason : String(reason));
  });

  process.on('uncaughtException', (err: Error) => {
    logError('server', 'Uncaught exception', err);
    // Don't exit — log and continue
  });

  // ── Graceful shutdown ──────────────────────────────────────────────────
  // When Playwright kills the webServer (SIGTERM) or the user hits Ctrl+C,
  // close connections cleanly so the port is immediately reusable.  Without
  // this, a force-killed server can leave the socket in a zombie state that
  // blocks the next test run from binding to port 3001.
  let shuttingDown = false;
  function shutdown(signal: string) {
    if (shuttingDown) return;  // ignore duplicate signals (e.g. double Ctrl+C)
    shuttingDown = true;
    console.log(`[server] Received ${signal} — shutting down gracefully…`);

    removePidFile();

    // Stop accepting new connections, then close existing ones
    wss.close();
    server.close(() => {
      console.log('[server] HTTP server closed');
      process.exit(0);
    });

    // If we haven't exited within 5 seconds, force-quit.
    // Handles stuck keep-alive connections and zombie WebSocket clients.
    setTimeout(() => {
      console.warn('[server] Graceful shutdown timed out — forcing exit');
      process.exit(1);
    }, 5_000).unref();
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Windows: taskkill sends a console CTRL event that Node.js surfaces as
  // SIGBREAK on some Windows shells.  Not all Windows terminals support it,
  // but it's the best shot at catching Playwright's process termination.
  process.on('SIGBREAK', () => shutdown('SIGBREAK'));

  server.listen(port, host, () => {
    console.log(`> Ready on http://${host}:${port}`);

    // Write the PID file AFTER the port is bound, so clearPort() doesn't
    // self-kill (it checks the PID file before we start listening).
    writeFileSync(PID_FILE, String(process.pid));
    console.log(`[server] PID ${process.pid} written to ${PID_FILE}`);

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

    // ── Model list prefetch (warms the Settings model dropdowns) ────────
    // Fetch the Anthropic model list once at boot into an in-memory prewarm
    // cache so the first Settings visit serves live data instead of a
    // loading spinner + fresh fetch (or CURATED_MODELS as a "first paint"
    // fallback). Project-agnostic by design: the model list is provider-
    // global data, so no per-project cache files are created here (see
    // prewarmModelsCache in src/app/actions/providers.ts). Fire-and-forget —
    // a network error, missing API key, or timeout is caught inside
    // prewarmModelsCache and must never block or fail startup.
    prewarmModelsCache('anthropic')
      .then(result => {
        if (result.ok) {
          console.log(`[providers] Prefetched ${result.modelCount} Anthropic model(s) at startup`);
        } else {
          console.log(`[providers] Startup model prefetch skipped: ${result.error ?? 'unknown error'}`);
        }
      })
      .catch(err => logError('providers', 'Startup model prefetch failed', err));

    // ── Demo project registration ──────────────────────────────────────
    // The demo ships for development: it registers automatically whenever
    // the server runs outside production mode (npm run dev, and
    // electron:dev, which also passes --with-demo). Production runs
    // (npm run start, the packaged app, E2E) set NODE_ENV=production and
    // leave the demo out so it never clutters a real install; pass
    // --with-demo there if you want it anyway.
    const DEMO_PATH = resolve(process.cwd(), '..', 'demo');
    const WITH_DEMO =
      process.argv.includes('--with-demo') || process.env.NODE_ENV !== 'production';
    const existingDemo = projectStore.getByPath(DEMO_PATH);
    if (WITH_DEMO && !existingDemo) {
      try {
        projectStore.add(DEMO_PATH, 'ShopForge Demo');
        console.log('[demo] Demo project registered (dev mode)');
      } catch (err) {
        logError('demo', 'Failed to register demo project', err);
      }
    } else if (!WITH_DEMO && existingDemo) {
      projectStore.remove(DEMO_PATH);
      console.log('[demo] Demo project removed (production mode)');
    }

    // ── Force-sync default commands at startup ──────────────────────────
    // Commands are the pipeline's orchestration contract and must match the
    // shipped defaults before any session runs (auto-resume below can spawn
    // sessions immediately). Customized commands are overwritten — TeamAI
    // owns the commands; only roles are user-owned and never auto-synced.
    try {
      const syncReport = projectStore.syncAllProjectsDefaults();
      if (syncReport.projects.length > 0) {
        console.log(`[defaults] Auto-synced default commands for ${syncReport.projects.length} project(s):`);
        for (const p of syncReport.projects) {
          console.log(`  • ${p.projectName}: ${p.updatedFiles.length} file(s) — ${p.updatedFiles.slice(0, 3).join(', ')}${p.updatedFiles.length > 3 ? ', …' : ''}`);
        }
      } else {
        console.log('[defaults] All projects already up to date');
      }
    } catch (err) {
      logError('defaults', 'Failed to auto-sync default commands at startup', err);
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

    // ── Role Refinement watcher (Phase 2) ─────────────────────────────
    // Independent of auto-mode: when a project is in 'auto' mode it listens
    // for failed tasks and auto-triggers a failure analysis on recurrence
    // (still human-approved to apply). Fires on live phase-change events
    // only — no boot-time adoption of already-failed tasks.
    try {
      startRoleRefinementWatcher();
      console.log('[role-refinement] Watcher started (auto-analysis on recurrence)');
    } catch (err) {
      logError('role-refinement', 'Failed to start role-refinement watcher', err);
    }

    // ── Periodic stall-detection sweep ──────────────────────────────────
    // Every 5 minutes, scan all projects for tasks stuck in active phases
    // (expired rate-limit windows, silent session exits, etc.) and re-queue them.
    // sweepStalledTasks() is the SOLE owner of session stall-kills — do not add
    // another inline kill loop here. It must stay the only place that decides a
    // session has stalled because: (1) it reads each project's configured
    // per-project idle/tool-stall thresholds, so a second hardcoded timeout here
    // would silently override those settings; (2) it passes the 'stalled' reason
    // to killSession, which gates the stall-recovery retry classification in
    // implement.ts — a kill from any other call site breaks that classification.
    const SWEEP_INTERVAL_MS = 5 * 60_000; // 5 minutes
    setInterval(() => {
      sweepStalledTasks().then(count => {
        if (count > 0) {
          console.log(`[sweep] Re-queued ${count} stalled task(s)`);
        }
      }).catch(err => {
        logError('sweep', 'Periodic stall-detection sweep failed', err);
      });
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
