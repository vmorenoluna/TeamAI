import { createServer } from 'http';
import { parse } from 'url';
import next from 'next';
import { WebSocketServer, WebSocket } from 'ws';
import { processManager } from './src/lib/process-manager';
import { containerManager } from './src/lib/container-manager';
import { findInterruptedTasks } from './src/lib/recovery';

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
    const agentHandler = ({ sessionId, event }: any) => {
      const taskId = processManager.getSession(sessionId)?.taskId;
      ws.send(JSON.stringify({ sessionId, taskId, event }));
    };
    processManager.on('event', agentHandler);
    processManager.on('error', agentHandler);

    // PTY terminal data streaming
    const terminalHandler = ({ sessionId, data }: any) => {
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
      } catch { /* ignore malformed */ }
    });

    ws.on('close', () => {
      processManager.off('event', agentHandler);
      processManager.off('error', agentHandler);
      processManager.off('terminal-data', terminalHandler);
    });
  });

  // Broadcast phase-change events from the Orchestrator to all connected clients
  processManager.on('phase-change', (data: any) => {
    const msg = JSON.stringify({ type: 'phase-change', taskId: data.taskId, phase: data.phase });
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
  server.listen(3000, host, () => {
    console.log(`> Ready on http://${host}:3000`);
    // Detect tasks interrupted by previous server shutdown
    const interrupted = findInterruptedTasks();
    if (interrupted.length > 0) {
      console.log(`[recovery] ${interrupted.length} interrupted task(s) detected:`);
      for (const t of interrupted) {
        console.log(`  • ${t.title} (${t.phase}) in ${t.projectName}`);
      }
    }
  });
});
