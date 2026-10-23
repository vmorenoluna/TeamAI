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
import { error as logError } from './src/lib/logger';
import { checkAllTools } from './src/lib/tool-checker';
import { projectStore } from './src/lib/project-store';
import { prewarmModelsCache } from './src/app/actions/providers';
import { getBuildInfo } from './src/lib/build-info';
import { appEvents } from './src/lib/app-events';
import { startEngine } from './src/engine/engine-host';
import { attachWsRelay, handleClientMessage, type RelayClient } from './src/engine/ws-relay';

// Mark this process as the API server before Next loads anything that reads the role.
process.env.TEAMAI_PROCESS_ROLE = 'api';

const app = next({ dev: process.env.NODE_ENV !== 'production' });
const handle = app.getRequestHandler();

void app.prepare().then(async () => {
  const server = createServer((req, res) => {
    handle(req, res, parse(req.url!, true)).catch(err => {
      logError('server', 'Request handler failed', err);
    });
  });

  // noServer: true so we handle upgrades manually and don't block Next.js HMR
  const wss = new WebSocketServer({ noServer: true });

  // Augment WebSocket type with projectRoot for broadcast filtering
  interface ProjectWebSocket extends WebSocket {
    projectRoot?: string;
  }

  // Engine events (re-emitted on appEvents by the engine host) -> browser messages
  attachWsRelay(appEvents, () => wss.clients as Set<ProjectWebSocket> as Iterable<RelayClient>);

  // Browser -> engine: terminal input / resize, plus replay when a terminal
  // panel reconnects after route navigation.
  wss.on('connection', (ws) => {
    ws.on('message', (msg: Buffer) => {
      void handleClientMessage(ws as RelayClient, msg.toString());
    });
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
  async function shutdown(signal: string) {
    if (shuttingDown) return;  // ignore duplicate signals (e.g. double Ctrl+C)
    shuttingDown = true;
    console.log(`[server] Received ${signal} — shutting down gracefully…`);

    removePidFile();

    // Stop accepting new connections, then close existing ones
    wss.close();
    try {
      await engineHost.shutdown();
    } catch (err) {
      logError('server', 'Engine shutdown failed', err);
    }
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

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  // Windows: taskkill sends a console CTRL event that Node.js surfaces as
  // SIGBREAK on some Windows shells.  Not all Windows terminals support it,
  // but it's the best shot at catching Playwright's process termination.
  process.on('SIGBREAK', () => void shutdown('SIGBREAK'));

  // Start the pipeline engine (orchestrator, auto mode, process manager) in its own child process
  const engineHost = startEngine();
  globalThis.__teamaiEngine = engineHost;

  // Compute the build version/SHA once so the root layout never spawns git per render
  getBuildInfo();

  server.listen(port, host, () => {
    console.log(`> Ready on http://${host}:${port}`);

    // Write the PID file AFTER the port is bound, so clearPort() doesn't
    // self-kill (it checks the PID file before we start listening).
    writeFileSync(PID_FILE, String(process.pid));
    console.log(`[server] PID ${process.pid} written to ${PID_FILE}`);

    // ── Prerequisite tool check ────────────────────────────────────────
    // Fire-and-forget: the probes spawn child processes and must not delay
    // the rest of startup; a rejection is logged, never thrown.
    void checkAllTools()
      .then(tools => {
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
      })
      .catch(err => {
        console.warn('[tools] Prerequisite tool check failed:', err);
      });

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
  });
});
