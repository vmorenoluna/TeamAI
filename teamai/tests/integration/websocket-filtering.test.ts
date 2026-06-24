/**
 * Integration tests for WebSocket project filtering.
 *
 * Tests verify the broadcastToProject logic from server.ts:
 *  - Clients with matching projectRoot receive phase-change events for that project
 *  - Clients with a different projectRoot do NOT receive those events
 *  - Clients without a projectRoot receive ALL events (backwards compat)
 *  - Events without a projectRoot reach ALL clients
 *
 * Uses a real WebSocketServer + ws clients — no mocks for the transport layer.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { WebSocketServer, WebSocket } from 'ws';
import { createServer } from 'http';
import { parse } from 'url';
import type { AddressInfo } from 'net';

// ── Types (mirrors server.ts) ──────────────────────────────────────────────

interface ProjectWebSocket extends WebSocket {
  projectRoot?: string;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Replica of broadcastToProject from server.ts.
 * Sends a message only to clients whose projectRoot matches the event's
 * projectRoot, or to clients with no projectRoot set (backwards compat).
 */
function broadcastToProject(
  wss: WebSocketServer,
  event: { projectRoot?: string },
  msg: string,
): void {
  const eventProject =
    typeof event.projectRoot === 'string' ? event.projectRoot : undefined;
  for (const client of wss.clients) {
    const pws = client as ProjectWebSocket;
    if (pws.readyState !== WebSocket.OPEN) continue;
    if (!pws.projectRoot || !eventProject || pws.projectRoot === eventProject) {
      pws.send(msg);
    }
  }
}

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

/** Build a ws:// URL for a given port, path, and optional project query. */
function wsUrl(port: number, project?: string): string {
  const base = `ws://localhost:${port}/ws`;
  return project ? `${base}?project=${encodeURIComponent(project)}` : base;
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('WebSocket Project Filtering', () => {
  let server: ReturnType<typeof createServer>;
  let wss: WebSocketServer;
  let port: number;

  beforeEach(async () => {
    // Create an HTTP server + WSS with manual upgrade handling (same as server.ts)
    server = createServer((_req, res) => {
      res.writeHead(404);
      res.end();
    });

    wss = new WebSocketServer({ noServer: true });

    // Replicate the server.ts phase-change listener + broadcastToProject
    const phaseChangeHandler = (data: {
      taskId: string;
      phase: string;
      projectRoot?: string;
      prUrl?: string;
      platform?: string;
    }) => {
      const msg = JSON.stringify({
        type: 'phase-change',
        taskId: data.taskId,
        phase: data.phase,
        prUrl: data.prUrl,
        platform: data.platform,
      });
      broadcastToProject(wss, data, msg);
    };

    // Store the handler so tests can emit through it
    (wss as unknown as Record<string, unknown>)._phaseChangeHandler =
      phaseChangeHandler;

    // Handle WebSocket upgrades — parse ?project= and store on client
    server.on('upgrade', (request, socket, head) => {
      const { pathname, query } = parse(request.url!, true);
      if (pathname === '/ws') {
        wss.handleUpgrade(request, socket, head, (client) => {
          if (typeof query?.project === 'string') {
            (client as ProjectWebSocket).projectRoot = query.project;
          }
          wss.emit('connection', client, request);
        });
      } else {
        socket.destroy();
      }
    });

    // Start server on random port
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        port = (server.address() as AddressInfo).port;
        resolve();
      });
    });
  });

  afterEach(async () => {
    // Close all connected clients
    for (const client of wss.clients) {
      client.close();
    }
    wss.close();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  });

  // ── Primary filter behaviour ─────────────────────────────────────────

  describe('project-based filtering', () => {
    it('sends phase-change only to the client whose projectRoot matches the event', async () => {
      // Connect two clients with different projects
      const projectA = '/home/user/projects/alpha';
      const projectB = '/home/user/projects/beta';

      const clientA = await connectClient(wsUrl(port, projectA));
      const clientB = await connectClient(wsUrl(port, projectB));

      // Emit a phase-change for project A
      const handler = (wss as unknown as Record<string, unknown>)
        ._phaseChangeHandler as (data: {
        taskId: string;
        phase: string;
        projectRoot?: string;
      }) => void;

      handler({
        taskId: 'task-alpha-1',
        phase: 'implement',
        projectRoot: projectA,
      });

      // Wait briefly for message delivery
      await new Promise((r) => setTimeout(r, 200));

      // Client A should receive the phase-change
      const aMsgs = clientA.messages.filter(
        (m) =>
          typeof m === 'object' &&
          m !== null &&
          (m as Record<string, unknown>).type === 'phase-change',
      );
      expect(aMsgs).toHaveLength(1);
      expect((aMsgs[0] as Record<string, unknown>).taskId).toBe('task-alpha-1');
      expect((aMsgs[0] as Record<string, unknown>).phase).toBe('implement');

      // Client B should NOT receive any phase-change
      const bMsgs = clientB.messages.filter(
        (m) =>
          typeof m === 'object' &&
          m !== null &&
          (m as Record<string, unknown>).type === 'phase-change',
      );
      expect(bMsgs).toHaveLength(0);

      clientA.ws.close();
      clientB.ws.close();
    });

    it('only the matching client receives events when there are three clients with different projects', async () => {
      const projectA = '/a';
      const projectB = '/b';
      const projectC = '/c';

      const clientA = await connectClient(wsUrl(port, projectA));
      const clientB = await connectClient(wsUrl(port, projectB));
      const clientC = await connectClient(wsUrl(port, projectC));

      const handler = (wss as unknown as Record<string, unknown>)
        ._phaseChangeHandler as (data: {
        taskId: string;
        phase: string;
        projectRoot?: string;
      }) => void;

      // Emit for project B
      handler({
        taskId: 'task-b-1',
        phase: 'qa-review',
        projectRoot: projectB,
      });

      await new Promise((r) => setTimeout(r, 200));

      // Only B should get it
      const filterPhaseChange = (msgs: unknown[]) =>
        msgs.filter(
          (m) =>
            typeof m === 'object' &&
            m !== null &&
            (m as Record<string, unknown>).type === 'phase-change',
        );

      expect(filterPhaseChange(clientA.messages)).toHaveLength(0);
      expect(filterPhaseChange(clientB.messages)).toHaveLength(1);
      expect(filterPhaseChange(clientC.messages)).toHaveLength(0);

      // Emit a second event for project A
      handler({
        taskId: 'task-a-1',
        phase: 'spec',
        projectRoot: projectA,
      });

      await new Promise((r) => setTimeout(r, 200));

      expect(filterPhaseChange(clientA.messages)).toHaveLength(1);
      expect(filterPhaseChange(clientB.messages)).toHaveLength(1); // still has the B event
      expect(filterPhaseChange(clientC.messages)).toHaveLength(0);

      clientA.ws.close();
      clientB.ws.close();
      clientC.ws.close();
    });
  });

  // ── Backwards compatibility ───────────────────────────────────────────

  describe('backwards compatibility', () => {
    it('sends events with no projectRoot to ALL clients (backwards compat)', async () => {
      const clientA = await connectClient(wsUrl(port, '/project/a'));
      const clientB = await connectClient(wsUrl(port, '/project/b'));

      const handler = (wss as unknown as Record<string, unknown>)
        ._phaseChangeHandler as (data: {
        taskId: string;
        phase: string;
        projectRoot?: string;
      }) => void;

      // Emit an event WITHOUT projectRoot (old-style event)
      handler({
        taskId: 'task-old',
        phase: 'merge',
        // no projectRoot
      });

      await new Promise((r) => setTimeout(r, 200));

      const filterPhaseChange = (msgs: unknown[]) =>
        msgs.filter(
          (m) =>
            typeof m === 'object' &&
            m !== null &&
            (m as Record<string, unknown>).type === 'phase-change',
        );

      // Both clients should receive it
      expect(filterPhaseChange(clientA.messages)).toHaveLength(1);
      expect(filterPhaseChange(clientB.messages)).toHaveLength(1);

      clientA.ws.close();
      clientB.ws.close();
    });

    it('sends events to clients without a projectRoot regardless of event projectRoot', async () => {
      // Client C connects WITHOUT a project param (legacy client)
      const clientC = await connectClient(wsUrl(port)); // no ?project=
      const clientA = await connectClient(wsUrl(port, '/project/a'));

      const handler = (wss as unknown as Record<string, unknown>)
        ._phaseChangeHandler as (data: {
        taskId: string;
        phase: string;
        projectRoot?: string;
      }) => void;

      // Emit for project A
      handler({
        taskId: 'task-a-legacy',
        phase: 'done',
        projectRoot: '/project/a',
      });

      await new Promise((r) => setTimeout(r, 200));

      const filterPhaseChange = (msgs: unknown[]) =>
        msgs.filter(
          (m) =>
            typeof m === 'object' &&
            m !== null &&
            (m as Record<string, unknown>).type === 'phase-change',
        );

      // Client A matches by project → receives
      expect(filterPhaseChange(clientA.messages)).toHaveLength(1);
      // Client C has no projectRoot → receives ALL (backwards compat)
      expect(filterPhaseChange(clientC.messages)).toHaveLength(1);

      clientA.ws.close();
      clientC.ws.close();
    });
  });

  // ── Multiple events in sequence ───────────────────────────────────────

  describe('multiple sequential events', () => {
    it('correctly routes multiple events for different projects', async () => {
      const clientA = await connectClient(wsUrl(port, '/a'));
      const clientB = await connectClient(wsUrl(port, '/b'));

      const handler = (wss as unknown as Record<string, unknown>)
        ._phaseChangeHandler as (data: {
        taskId: string;
        phase: string;
        projectRoot?: string;
      }) => void;

      // Sequence: A → B → A → no project → B
      handler({ taskId: 'a1', phase: 'spec', projectRoot: '/a' });
      handler({ taskId: 'b1', phase: 'plan', projectRoot: '/b' });
      handler({ taskId: 'a2', phase: 'implement', projectRoot: '/a' });
      handler({ taskId: 'global', phase: 'done' }); // no projectRoot
      handler({ taskId: 'b2', phase: 'qa-review', projectRoot: '/b' });

      await new Promise((r) => setTimeout(r, 200));

      const filterId = (msgs: unknown[], taskId: string) =>
        msgs.filter(
          (m) =>
            typeof m === 'object' &&
            m !== null &&
            (m as Record<string, unknown>).taskId === taskId,
        );

      // Client A: should get a1, a2, global (3 phase-change events)
      expect(filterId(clientA.messages, 'a1')).toHaveLength(1);
      expect(filterId(clientA.messages, 'a2')).toHaveLength(1);
      expect(filterId(clientA.messages, 'global')).toHaveLength(1);
      expect(filterId(clientA.messages, 'b1')).toHaveLength(0);
      expect(filterId(clientA.messages, 'b2')).toHaveLength(0);

      // Client B: should get b1, b2, global
      expect(filterId(clientB.messages, 'b1')).toHaveLength(1);
      expect(filterId(clientB.messages, 'b2')).toHaveLength(1);
      expect(filterId(clientB.messages, 'global')).toHaveLength(1);
      expect(filterId(clientB.messages, 'a1')).toHaveLength(0);
      expect(filterId(clientB.messages, 'a2')).toHaveLength(0);

      clientA.ws.close();
      clientB.ws.close();
    });
  });

  // ── Edge cases ────────────────────────────────────────────────────────

  describe('edge cases', () => {
    it('treats empty-string projectRoot like a legacy client (receives all events)', async () => {
      // Connect with project= (empty string query param)
      // Empty string is falsy, so `!pws.projectRoot` is true in the filter —
      // the client behaves like a legacy client and receives everything.
      const clientEmpty = await connectClient(wsUrl(port, ''));
      const clientA = await connectClient(wsUrl(port, '/a'));

      const handler = (wss as unknown as Record<string, unknown>)
        ._phaseChangeHandler as (data: {
        taskId: string;
        phase: string;
        projectRoot?: string;
      }) => void;

      handler({
        taskId: 'task-a-empty',
        phase: 'spec',
        projectRoot: '/a',
      });

      await new Promise((r) => setTimeout(r, 200));

      const phaseA = clientA.messages.filter(
        (m) => (m as Record<string, unknown>)?.taskId === 'task-a-empty',
      );
      const phaseEmpty = clientEmpty.messages.filter(
        (m) => (m as Record<string, unknown>)?.taskId === 'task-a-empty',
      );

      // Client A gets it (matches by projectRoot)
      expect(phaseA).toHaveLength(1);
      // Empty string is falsy → clientEmpty receives everything like a legacy client
      expect(phaseEmpty).toHaveLength(1);

      clientEmpty.ws.close();
      clientA.ws.close();
    });

    it('does not crash when emitting to a WSS with no connected clients', async () => {
      const handler = (wss as unknown as Record<string, unknown>)
        ._phaseChangeHandler as (data: {
        taskId: string;
        phase: string;
        projectRoot?: string;
      }) => void;

      expect(() => {
        handler({
          taskId: 'task-no-clients',
          phase: 'done',
          projectRoot: '/nowhere',
        });
      }).not.toThrow();
    });

    it('ignores closed clients during broadcast', async () => {
      const clientA = await connectClient(wsUrl(port, '/a'));
      const clientB = await connectClient(wsUrl(port, '/a')); // same project

      // Close clientB but keep clientA
      clientB.ws.close();
      await new Promise((r) => setTimeout(r, 100));

      const handler = (wss as unknown as Record<string, unknown>)
        ._phaseChangeHandler as (data: {
        taskId: string;
        phase: string;
        projectRoot?: string;
      }) => void;

      handler({
        taskId: 'task-closed-check',
        phase: 'implement',
        projectRoot: '/a',
      });

      await new Promise((r) => setTimeout(r, 200));

      // Client A should receive it
      const aMsgs = clientA.messages.filter(
        (m) =>
          (m as Record<string, unknown>)?.taskId === 'task-closed-check',
      );
      expect(aMsgs).toHaveLength(1);

      // Client B was closed before emit — should receive nothing
      const bMsgs = clientB.messages.filter(
        (m) =>
          (m as Record<string, unknown>)?.taskId === 'task-closed-check',
      );
      expect(bMsgs).toHaveLength(0);

      clientA.ws.close();
    });

    it('preserves prUrl and platform fields in the broadcast message', async () => {
      const client = await connectClient(wsUrl(port, '/project/x'));

      const handler = (wss as unknown as Record<string, unknown>)
        ._phaseChangeHandler as (data: {
        taskId: string;
        phase: string;
        projectRoot?: string;
        prUrl?: string;
        platform?: string;
      }) => void;

      handler({
        taskId: 'task-pr',
        phase: 'done',
        projectRoot: '/project/x',
        prUrl: 'https://github.com/org/repo/pull/42',
        platform: 'github',
      });

      await new Promise((r) => setTimeout(r, 200));

      const prEvents = client.messages.filter(
        (m) => (m as Record<string, unknown>)?.taskId === 'task-pr',
      );
      expect(prEvents).toHaveLength(1);
      const msg = prEvents[0] as Record<string, unknown>;
      expect(msg.type).toBe('phase-change');
      expect(msg.phase).toBe('done');
      expect(msg.prUrl).toBe('https://github.com/org/repo/pull/42');
      expect(msg.platform).toBe('github');

      client.ws.close();
    });

    it('does not leak between parallel connections to the same project', async () => {
      // Two clients for the SAME project should both receive phase-change events
      const client1 = await connectClient(wsUrl(port, '/shared'));
      const client2 = await connectClient(wsUrl(port, '/shared'));

      const handler = (wss as unknown as Record<string, unknown>)
        ._phaseChangeHandler as (data: {
        taskId: string;
        phase: string;
        projectRoot?: string;
      }) => void;

      handler({
        taskId: 'task-shared',
        phase: 'spec',
        projectRoot: '/shared',
      });

      await new Promise((r) => setTimeout(r, 200));

      const filterShared = (msgs: unknown[]) =>
        msgs.filter(
          (m) => (m as Record<string, unknown>)?.taskId === 'task-shared',
        );

      // Both clients should receive since they share the same project
      expect(filterShared(client1.messages)).toHaveLength(1);
      expect(filterShared(client2.messages)).toHaveLength(1);

      client1.ws.close();
      client2.ws.close();
    });
  });

  // ── projectRoot extraction from query param ───────────────────────────

  describe('query param parsing', () => {
    it('sets projectRoot on client when ?project= is provided', async () => {
      const client = await connectClient(wsUrl(port, '/my-project'));

      // Find the client in the WSS and check its projectRoot
      let foundProjectRoot: string | undefined;
      for (const c of wss.clients) {
        const pws = c as ProjectWebSocket;
        if (pws.readyState === WebSocket.OPEN) {
          foundProjectRoot = pws.projectRoot;
          break;
        }
      }

      expect(foundProjectRoot).toBe('/my-project');

      client.ws.close();
    });

    it('leaves projectRoot undefined when ?project= is omitted', async () => {
      const client = await connectClient(wsUrl(port)); // no query param

      let foundProjectRoot: string | undefined = '__NOT_FOUND__';
      for (const c of wss.clients) {
        const pws = c as ProjectWebSocket;
        if (pws.readyState === WebSocket.OPEN) {
          foundProjectRoot = pws.projectRoot;
          break;
        }
      }

      expect(foundProjectRoot).toBeUndefined();

      client.ws.close();
    });
  });
});
