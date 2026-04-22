import { createServer } from 'http';
import { parse } from 'url';
import next from 'next';
import { WebSocketServer } from 'ws';
import { processManager } from './src/lib/process-manager';

const app = next({ dev: process.env.NODE_ENV !== 'production' });
const handle = app.getRequestHandler();

app.prepare().then(() => {
  const server = createServer((req, res) => {
    handle(req, res, parse(req.url!, true));
  });

  const wss = new WebSocketServer({ server, path: '/ws' });
  wss.on('connection', (ws) => {
    const handler = ({ sessionId, event }: any) => {
      ws.send(JSON.stringify({ sessionId, event }));
    };
    processManager.on('event', handler);
    processManager.on('error', handler);
    ws.on('close', () => {
      process					processManager.off('event', handler);
      processManager.off('error', handler);
    });
  });

  const host = process.env.HOST || '0.0.0.0';
  server.listen(3000, host, () => {
    console.log(`> Ready on http://${host}:3000`);
  });
});
