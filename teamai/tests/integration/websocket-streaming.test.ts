/**
 * Integration tests for WebSocket streaming (agent events, terminal I/O, lifecycle).
 *
 * Tests verify the core streaming paths from server.ts:
 *  - Agent event delivery (processManager 'event' → client message)
 *  - Agent error delivery (processManager 'error' → client message)
 *  - Terminal data delivery (processManager 'terminal-data' → client message)
 *  - Client→server terminal input forwarding
 *  - Client→server terminal resize forwarding
 *  - Multi-client broadcast of agent events
 *  - Connection close removes listeners
 *  - Malformed / non-JSON message tolerance
 *  - Session ID → task ID resolution
 *
 * Uses a real WebSocketServer + ws clients with a mocked processManager.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { WebSocketServer, WebSocket } from 'ws';
import { createServer } from 'http';
import { parse } from 'url';
import type { AddressInfo } from 'net';

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Connect a ws client and collect all received messages. */
function connectClient(url: string): Promise<{
  ws: WebSocket;
  messages: unknown[];
}> {
  return new Promise((resolve, reject) => {
    const messages: unknown[] = [];
    const ws = new WebSocket(url);
    const timeout = setTimeout(() => {
      ws.close();
      reject(new Error(`WebSocket connection timed out: ${url}`));
    }, 5000);
    ws.on('open', () => {
      clearTimeout(timeout);
      resolve({ ws, messages });
    });
    ws.on('message', (data: Buffer | string) => {
      try {
        messages.push(JSON.parse(data.toString()));
      } catch {
        messages.push(data.toString());
      }
    });
    ws.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('WebSocket Streaming Integration', () => {
  let server: ReturnType<typeof createServer>;
  let wss: WebSocketServer;
  let port: number;
  let processManagerOnHandlers: Map<string, Array<(...args: unknown[]) => void>>;
  let processManagerOffCalls: Array<{ event: string; handler: unknown }>;
  let writtenToTerminal: Array<{ sessionId: string; data: string }>;
  let resizedTerminal: Array<{ sessionId: string; cols: number; rows: number }>;
  let getSessionResults: Map<string, { taskId: string } | undefined>;

  beforeEach(async () => {
    processManagerOnHandlers = new Map();
    processManagerOffCalls = [];
    writtenToTerminal = [];
    resizedTerminal = [];
    getSessionResults = new Map();

    const mockProcessManager = {
      on(event: string, handler: (...args: unknown[]) => void) {
        if (!processManagerOnHandlers.has(event)) {
          processManagerOnHandlers.set(event, []);
        }
        processManagerOnHandlers.get(event)!.push(handler);
      },
      off(event: string, handler: (...args: unknown[]) => void) {
        processManagerOffCalls.push({ event, handler });
        const handlers = processManagerOnHandlers.get(event);
        if (handlers) {
          const idx = handlers.indexOf(handler);
          if (idx >= 0) handlers.splice(idx, 1);
        }
      },
      emit(event: string, ...args: unknown[]) {
        const handlers = processManagerOnHandlers.get(event) ?? [];
        for (const h of handlers) h(...args);
      },
      getSession(sessionId: string) {
        return getSessionResults.get(sessionId);
      },
      writeToTerminal(sessionId: string, data: string) {
        writtenToTerminal.push({ sessionId, data });
      },
      resizeTerminal(sessionId: string, cols: number, rows: number) {
        resizedTerminal.push({ sessionId, cols, rows });
      },
    };

    server = createServer((_req, res) => {
      res.writeHead(404);
      res.end();
    });

    wss = new WebSocketServer({ noServer: true });

    // Replicate server.ts connection handler
    wss.on('connection', (ws) => {
      const agentHandler = ({
        sessionId,
        event,
      }: {
        sessionId: string;
        event: Record<string, unknown>;
      }) => {
        const taskId = mockProcessManager.getSession(sessionId)?.taskId;
        ws.send(JSON.stringify({ sessionId, taskId, event }));
      };
       
      mockProcessManager.on('event', agentHandler as any);
       
      mockProcessManager.on('error', agentHandler as any);

      const terminalHandler = ({
        sessionId,
        data,
      }: {
        sessionId: string;
        data: string;
      }) => {
        ws.send(JSON.stringify({ type: 'terminal', sessionId, data }));
      };
       
      mockProcessManager.on('terminal-data', terminalHandler as any);

      ws.on('message', (msg: Buffer) => {
        try {
          const parsed = JSON.parse(msg.toString()) as Record<string, unknown>;
          if (parsed.type === 'terminal-input') {
            mockProcessManager.writeToTerminal(
              parsed.sessionId as string,
              parsed.data as string,
            );
          } else if (parsed.type === 'terminal-resize') {
            mockProcessManager.resizeTerminal(
              parsed.sessionId as string,
              parsed.cols as number,
              parsed.rows as number,
            );
          }
        } catch {
          // silently ignore malformed — mirror server.ts behavior
        }
      });

      ws.on('close', () => {
         
        mockProcessManager.off('event', agentHandler as any);
         
        mockProcessManager.off('error', agentHandler as any);
         
        mockProcessManager.off('terminal-data', terminalHandler as any);
      });
    });

    // Handle WebSocket upgrades (replicate server.ts upgrade handler)
    server.on('upgrade', (request, socket, head) => {
      const { pathname } = parse(request.url!, true);
      if (pathname === '/ws') {
        wss.handleUpgrade(request, socket, head, (client) => {
          wss.emit('connection', client, request);
        });
      } else {
        socket.destroy();
      }
    });

    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        port = (server.address() as AddressInfo).port;
        resolve();
      });
    });
  });

  afterEach(async () => {
    for (const client of wss.clients) {
      client.close();
    }
    wss.close();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  });

  // ── Helper: emit processManager event ─────────────────────────────────

  function emitEvent(eventType: string, payload: unknown) {
    const handlers = processManagerOnHandlers.get(eventType) ?? [];
    for (const h of handlers) h(payload);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // AC1 — Agent Event Streaming
  // ═══════════════════════════════════════════════════════════════════════

  describe('agent event streaming (AC1)', () => {
    it('delivers agent event with sessionId, taskId, and full event object', async () => {
      getSessionResults.set('s1', { taskId: 'task-42' });

      const client = await connectClient(`ws://localhost:${port}/ws`);

      emitEvent('event', {
        sessionId: 's1',
        event: { type: 'assistant', message: { content: 'hello' } },
      });

      await new Promise((r) => setTimeout(r, 200));

      expect(client.messages).toHaveLength(1);
      const msg = client.messages[0] as Record<string, unknown>;
      expect(msg.sessionId).toBe('s1');
      expect(msg.taskId).toBe('task-42');
      expect(msg.event).toEqual({
        type: 'assistant',
        message: { content: 'hello' },
      });

      client.ws.close();
    });

    it('delivers system init events correctly', async () => {
      getSessionResults.set('s2', { taskId: 'task-sys' });

      const client = await connectClient(`ws://localhost:${port}/ws`);

      emitEvent('event', {
        sessionId: 's2',
        event: { type: 'system', subtype: 'init', model: 'claude-sonnet-4' },
      });

      await new Promise((r) => setTimeout(r, 200));

      const msg = client.messages[0] as Record<string, unknown>;
      expect(msg.sessionId).toBe('s2');
      expect(msg.taskId).toBe('task-sys');
      expect(msg.event).toEqual({
        type: 'system',
        subtype: 'init',
        model: 'claude-sonnet-4',
      });

      client.ws.close();
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // AC2 — Agent Error Streaming
  // ═══════════════════════════════════════════════════════════════════════

  describe('agent error streaming (AC2)', () => {
    it('delivers error messages with sessionId and taskId (event is undefined — error payloads lack an event field)', async () => {
      // server.ts reuses agentHandler for 'error' events. The handler destructures
      // { sessionId, event }, but error payloads carry { sessionId, error }.
      // This means `event` is undefined for error messages — documented behavior.
      getSessionResults.set('s-err', { taskId: 'task-error' });

      const client = await connectClient(`ws://localhost:${port}/ws`);

      emitEvent('error', {
        sessionId: 's-err',
        error: 'Connection refused',
      });

      await new Promise((r) => setTimeout(r, 200));

      expect(client.messages).toHaveLength(1);
      const msg = client.messages[0] as Record<string, unknown>;
      expect(msg.sessionId).toBe('s-err');
      expect(msg.taskId).toBe('task-error');
      // Error payloads don't have an 'event' property — the handler destructures undefined
      expect(msg.event).toBeUndefined();

      client.ws.close();
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // AC3 — Terminal Data Streaming
  // ═══════════════════════════════════════════════════════════════════════

  describe('terminal data streaming (AC3)', () => {
    it('delivers terminal data with type, sessionId, and data', async () => {
      const client = await connectClient(`ws://localhost:${port}/ws`);

      emitEvent('terminal-data', {
        sessionId: 'term-1',
        data: '$ claude\r\n\x1b[32mReady\x1b[0m\r\n',
      });

      await new Promise((r) => setTimeout(r, 200));

      expect(client.messages).toHaveLength(1);
      const msg = client.messages[0] as Record<string, unknown>;
      expect(msg.type).toBe('terminal');
      expect(msg.sessionId).toBe('term-1');
      expect(msg.data).toBe('$ claude\r\n\x1b[32mReady\x1b[0m\r\n');

      client.ws.close();
    });

    it('delivers ANSI escape sequences intact', async () => {
      const client = await connectClient(`ws://localhost:${port}/ws`);

      emitEvent('terminal-data', {
        sessionId: 'term-ansi',
        data:
          '\x1b[2J\x1b[H\x1b[1;34m=== Header ===\x1b[0m\n',
      });

      await new Promise((r) => setTimeout(r, 200));

      const msg = client.messages[0] as Record<string, unknown>;
      expect(msg.data).toBe(
        '\x1b[2J\x1b[H\x1b[1;34m=== Header ===\x1b[0m\n',
      );

      client.ws.close();
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // AC4 — Client→Server Terminal Input
  // ═══════════════════════════════════════════════════════════════════════

  describe('terminal input forwarding (AC4)', () => {
    it('forwards terminal-input messages to writeToTerminal', async () => {
      const client = await connectClient(`ws://localhost:${port}/ws`);

      client.ws.send(
        JSON.stringify({
          type: 'terminal-input',
          sessionId: 'term-1',
          data: 'ls -la\n',
        }),
      );

      await new Promise((r) => setTimeout(r, 200));

      expect(writtenToTerminal).toHaveLength(1);
      expect(writtenToTerminal[0]).toEqual({
        sessionId: 'term-1',
        data: 'ls -la\n',
      });

      client.ws.close();
    });

    it('forwards multiple terminal-input messages in sequence', async () => {
      const client = await connectClient(`ws://localhost:${port}/ws`);

      client.ws.send(
        JSON.stringify({ type: 'terminal-input', sessionId: 't', data: 'a' }),
      );
      client.ws.send(
        JSON.stringify({ type: 'terminal-input', sessionId: 't', data: 'b' }),
      );
      client.ws.send(
        JSON.stringify({ type: 'terminal-input', sessionId: 't', data: 'c' }),
      );

      await new Promise((r) => setTimeout(r, 200));

      expect(writtenToTerminal).toHaveLength(3);
      expect(writtenToTerminal[0].data).toBe('a');
      expect(writtenToTerminal[1].data).toBe('b');
      expect(writtenToTerminal[2].data).toBe('c');

      client.ws.close();
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // AC5 — Client→Server Terminal Resize
  // ═══════════════════════════════════════════════════════════════════════

  describe('terminal resize forwarding (AC5)', () => {
    it('forwards terminal-resize messages to resizeTerminal', async () => {
      const client = await connectClient(`ws://localhost:${port}/ws`);

      client.ws.send(
        JSON.stringify({
          type: 'terminal-resize',
          sessionId: 'term-1',
          cols: 120,
          rows: 40,
        }),
      );

      await new Promise((r) => setTimeout(r, 200));

      expect(resizedTerminal).toHaveLength(1);
      expect(resizedTerminal[0]).toEqual({
        sessionId: 'term-1',
        cols: 120,
        rows: 40,
      });

      client.ws.close();
    });

    it('forwards resize with different column/row values', async () => {
      const client = await connectClient(`ws://localhost:${port}/ws`);

      client.ws.send(
        JSON.stringify({
          type: 'terminal-resize',
          sessionId: 'term-2',
          cols: 80,
          rows: 24,
        }),
      );

      await new Promise((r) => setTimeout(r, 200));

      expect(resizedTerminal).toHaveLength(1);
      expect(resizedTerminal[0].cols).toBe(80);
      expect(resizedTerminal[0].rows).toBe(24);

      client.ws.close();
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // AC6 — Multiple Clients Receive Agent Events
  // ═══════════════════════════════════════════════════════════════════════

  describe('multi-client broadcast (AC6)', () => {
    it('sends the same agent event to all connected clients', async () => {
      getSessionResults.set('mc', { taskId: 'task-multi' });

      const client1 = await connectClient(`ws://localhost:${port}/ws`);
      const client2 = await connectClient(`ws://localhost:${port}/ws`);

      emitEvent('event', {
        sessionId: 'mc',
        event: { type: 'assistant', message: { content: [{ type: 'text', text: 'hello' }] } },
      });

      await new Promise((r) => setTimeout(r, 200));

      expect(client1.messages).toHaveLength(1);
      expect(client2.messages).toHaveLength(1);

      const msg1 = client1.messages[0] as Record<string, unknown>;
      const msg2 = client2.messages[0] as Record<string, unknown>;

      expect(msg1.sessionId).toBe('mc');
      expect(msg1.taskId).toBe('task-multi');
      expect(msg2.sessionId).toBe('mc');
      expect(msg2.taskId).toBe('task-multi');

      client1.ws.close();
      client2.ws.close();
    });

    it('broadcasts agent events to three concurrent clients', async () => {
      getSessionResults.set('mc3', { taskId: 'task-triple' });

      const clients = await Promise.all([
        connectClient(`ws://localhost:${port}/ws`),
        connectClient(`ws://localhost:${port}/ws`),
        connectClient(`ws://localhost:${port}/ws`),
      ]);

      emitEvent('event', {
        sessionId: 'mc3',
        event: { type: 'result', subtype: 'success' },
      });

      await new Promise((r) => setTimeout(r, 200));

      for (const c of clients) {
        expect(c.messages).toHaveLength(1);
        expect((c.messages[0] as Record<string, unknown>).sessionId).toBe(
          'mc3',
        );
      }

      for (const c of clients) c.ws.close();
    });

    it('does NOT broadcast agent events to a disconnected client', async () => {
      getSessionResults.set('mc-dis', { taskId: 'task-dis' });

      const client1 = await connectClient(`ws://localhost:${port}/ws`);
      const client2 = await connectClient(`ws://localhost:${port}/ws`);

      // Snapshot client2's message count before disconnect
      const client2MsgCountBefore = client2.messages.length;

      // Disconnect client2
      client2.ws.close();
      await new Promise((r) => setTimeout(r, 100));

      emitEvent('event', {
        sessionId: 'mc-dis',
        event: { type: 'assistant', message: {} },
      });

      await new Promise((r) => setTimeout(r, 200));

      // Client1 should receive, client2 should NOT receive new events
      expect(client1.messages).toHaveLength(1);
      expect(client2.messages).toHaveLength(client2MsgCountBefore);

      client1.ws.close();
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // AC7 — Connection Close Removes Listeners
  // ═══════════════════════════════════════════════════════════════════════

  describe('connection close cleanup (AC7)', () => {
    it('removes event, error, and terminal-data listeners on close', async () => {
      const client = await connectClient(`ws://localhost:${port}/ws`);

      // Reset offCalls so we only count this close event (not afterEach cleanup)
      processManagerOffCalls = [];

      client.ws.close();
      await new Promise((r) => setTimeout(r, 200));

      // processManager.off should have been called 3 times
      expect(processManagerOffCalls).toHaveLength(3);

      const offEvents = processManagerOffCalls.map((c) => c.event).sort();
      expect(offEvents).toEqual(['error', 'event', 'terminal-data']);
    });

    it('passes the same handler reference to off that was passed to on', async () => {
      const client = await connectClient(`ws://localhost:${port}/ws`);

      // The handlers were registered during ws.on('connection').
      // Capture snapshots of the handler function references now — before close
      // splices them out of the onHandlers array.
      const eventHandlerRef = (processManagerOnHandlers.get('event') ?? [])[0];
      const errorHandlerRef = (processManagerOnHandlers.get('error') ?? [])[0];
      const terminalHandlerRef = (processManagerOnHandlers.get('terminal-data') ?? [])[0];

      expect(eventHandlerRef).toBeDefined();
      expect(errorHandlerRef).toBeDefined();
      expect(terminalHandlerRef).toBeDefined();

      // Reset offCalls so we only count this close event
      processManagerOffCalls = [];

      client.ws.close();
      await new Promise((r) => setTimeout(r, 200));

      // Verify the exact handler references were passed to off
      const offByEvent = new Map<string, unknown[]>();
      for (const c of processManagerOffCalls) {
        if (!offByEvent.has(c.event)) offByEvent.set(c.event, []);
        offByEvent.get(c.event)!.push(c.handler);
      }

      expect(offByEvent.get('event')?.[0]).toBe(eventHandlerRef);
      expect(offByEvent.get('error')?.[0]).toBe(errorHandlerRef);
      expect(offByEvent.get('terminal-data')?.[0]).toBe(terminalHandlerRef);
    });

    it('each client gets its own handler references (not shared)', async () => {
      const client1 = await connectClient(`ws://localhost:${port}/ws`);
      const client2 = await connectClient(`ws://localhost:${port}/ws`);

      // Both clients registered handlers — should have 2 per event
      expect(processManagerOnHandlers.get('event')).toHaveLength(2);
      expect(processManagerOnHandlers.get('error')).toHaveLength(2);
      expect(processManagerOnHandlers.get('terminal-data')).toHaveLength(2);

      // Reset offCalls so we only count client1's close event
      processManagerOffCalls = [];

      // Close client1
      client1.ws.close();
      await new Promise((r) => setTimeout(r, 200));

      // client1's handlers removed, client2's remain
      expect(processManagerOnHandlers.get('event')).toHaveLength(1);
      expect(processManagerOnHandlers.get('error')).toHaveLength(1);
      expect(processManagerOnHandlers.get('terminal-data')).toHaveLength(1);

      // off should have been called exactly 3 times (once per event type for client1)
      expect(processManagerOffCalls).toHaveLength(3);

      client2.ws.close();
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // AC8 — Malformed Message Does Not Crash
  // ═══════════════════════════════════════════════════════════════════════

  describe('malformed message handling (AC8)', () => {
    it('does not crash when client sends incomplete JSON', async () => {
      const client = await connectClient(`ws://localhost:${port}/ws`);

      // Send malformed JSON — server should catch the parse error
      client.ws.send('{type: "terminal-input"'); // missing closing brace

      await new Promise((r) => setTimeout(r, 200));

      // Server should still be running — no crash
      // Client should still be connected
      expect(client.ws.readyState).toBe(WebSocket.OPEN);

      // No terminal input should have been forwarded
      expect(writtenToTerminal).toHaveLength(0);

      // Verify server is still functional — send a valid message
      client.ws.send(
        JSON.stringify({
          type: 'terminal-input',
          sessionId: 'survive',
          data: 'still works\n',
        }),
      );

      await new Promise((r) => setTimeout(r, 200));
      expect(writtenToTerminal).toHaveLength(1);

      client.ws.close();
    });

    it('does not crash when client sends an empty object string', async () => {
      const client = await connectClient(`ws://localhost:${port}/ws`);

      client.ws.send('{}');

      await new Promise((r) => setTimeout(r, 200));

      // Should not crash — no type match, so no action taken
      expect(client.ws.readyState).toBe(WebSocket.OPEN);

      client.ws.close();
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // AC9 — Non-JSON Data Does Not Crash
  // ═══════════════════════════════════════════════════════════════════════

  describe('non-JSON data handling (AC9)', () => {
    it('does not crash when client sends raw text', async () => {
      const client = await connectClient(`ws://localhost:${port}/ws`);

      client.ws.send('hello-not-json');

      await new Promise((r) => setTimeout(r, 200));

      expect(client.ws.readyState).toBe(WebSocket.OPEN);

      // Verify server is still functional
      client.ws.send(
        JSON.stringify({
          type: 'terminal-input',
          sessionId: 'raw-ok',
          data: 'alive\n',
        }),
      );

      await new Promise((r) => setTimeout(r, 200));
      expect(writtenToTerminal).toHaveLength(1);

      client.ws.close();
    });

    it('does not crash when client sends binary data', async () => {
      const client = await connectClient(`ws://localhost:${port}/ws`);

      // Send binary data (a Buffer with non-JSON content)
      const buf = Buffer.from('\x00\x01\x02\x03\x04');
      client.ws.send(buf);

      await new Promise((r) => setTimeout(r, 200));

      expect(client.ws.readyState).toBe(WebSocket.OPEN);

      // Verify server is still functional
      getSessionResults.set('binary-ok', { taskId: 't' });
      emitEvent('event', {
        sessionId: 'binary-ok',
        event: { type: 'ok' },
      });

      await new Promise((r) => setTimeout(r, 200));
      expect(client.messages).toHaveLength(1);

      client.ws.close();
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // AC10 — Session ID to Task ID Resolution
  // ═══════════════════════════════════════════════════════════════════════

  describe('session-to-task resolution (AC10)', () => {
    it('resolves taskId from getSession when session exists', async () => {
      getSessionResults.set('s-resolve', { taskId: 'task-resolved' });

      const client = await connectClient(`ws://localhost:${port}/ws`);

      emitEvent('event', {
        sessionId: 's-resolve',
        event: { type: 'ping' },
      });

      await new Promise((r) => setTimeout(r, 200));

      const msg = client.messages[0] as Record<string, unknown>;
      expect(msg.taskId).toBe('task-resolved');

      client.ws.close();
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // AC11 — Unknown Session ID
  // ═══════════════════════════════════════════════════════════════════════

  describe('unknown session handling (AC11)', () => {
    it('returns undefined taskId when getSession returns nothing', async () => {
      // Don't set any session for 's-gone' — getSession returns undefined

      const client = await connectClient(`ws://localhost:${port}/ws`);

      emitEvent('event', {
        sessionId: 's-gone',
        event: { type: 'assistant' },
      });

      await new Promise((r) => setTimeout(r, 200));

      const msg = client.messages[0] as Record<string, unknown>;
      expect(msg.sessionId).toBe('s-gone');
      expect(msg.taskId).toBeUndefined();

      client.ws.close();
    });
  });
});
