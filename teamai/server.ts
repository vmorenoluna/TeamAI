import { createServer } from 'http';
import { parse } from 'url';
import next from 'next';
import { WebSocketServer, WebSocket } from 'ws';
import { processManager } from './src/lib/process-manager';

const app = next({ dev: process.env.NODE_ENV !== 'production' });
const handle = app.getRequestHandler();

app.prepare().then(() => {
  const server = createServer((req, res) => {
    handle(req, res, parse(req.url!, true));
  });

  // noServer: true so we handle upgrades manually and don't block Next.js HMR
  const wss = new WebSocketServer({ noServer: true });
  wss.on('connection', (ws) => {
    const handler = ({ sessionId, event }: any) => {
      const taskId = processManager.getSession(sessionId)?.taskId;
      ws.send(JSON.stringify({ sessionId, taskId, event }));
    };
    processManager.on('event', handler);
    processManager.on('error', handler);
    ws.on('close', () => {
      processManager.off('event', handler);
      processManager.off('error', handler);
    });
  });

  // Broadcast phase-change events from the Orchestrator to all connected clients
  processManager.on('phase-change', (data: any) => {
    const msg = JSON.stringify({ type: 'phase-change', taskId: data.taskId, phase: data.phase });
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
  });
});
