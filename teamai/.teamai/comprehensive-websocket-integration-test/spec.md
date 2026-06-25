# Spec: Comprehensive WebSocket Integration Tests

## Context
The `server.ts` WebSocket server streams agent events, terminal data, and phase-change broadcasts to connected clients. The existing test suite covers unit-level hook behavior (`use-phase-sync.test.ts`) and project filtering (`websocket-filtering.test.ts`) but lacks integration tests for the core streaming paths: agent events, terminal I/O, connection lifecycle, and error handling. These paths are currently tested only indirectly through E2E tests.

This spec defines the missing integration tests that verify the `/ws` endpoint end-to-end — using a real WebSocket server and clients, with a mocked `processManager` to emit controlled events.

---

## Acceptance Criteria

### AC1 — Agent Event Streaming
**Given** a WebSocket server with processManager mocks and a connected client  
**When** the processManager emits an `event` with `{ sessionId, event: { type: "assistant", ... } }`  
**Then** the client receives a JSON message with fields `sessionId`, `taskId` (resolved via `processManager.getSession`), and the full `event` object

### AC2 — Agent Error Streaming
**Given** a WebSocket server with processManager mocks and a connected client  
**When** the processManager emits an `error` with `{ sessionId, error: "..." }`  
**Then** the client receives a JSON message with `sessionId`, `taskId`, and the error detail

### AC3 — Terminal Data Streaming
**Given** a WebSocket server with processManager mocks and a connected client  
**When** the processManager emits `terminal-data` with `{ sessionId, data: "output\r\n" }`  
**Then** the client receives a JSON message with `type: "terminal"`, `sessionId`, and `data: "output\r\n"`

### AC4 — Client→Server Terminal Input
**Given** a connected WebSocket client  
**When** the client sends `{ type: "terminal-input", sessionId: "s1", data: "ls\n" }`  
**Then** `processManager.writeToTerminal("s1", "ls\n")` is called exactly once

### AC5 — Client→Server Terminal Resize
**Given** a connected WebSocket client  
**When** the client sends `{ type: "terminal-resize", sessionId: "s1", cols: 120, rows: 40 }`  
**Then** `processManager.resizeTerminal("s1", 120, 40)` is called exactly once

### AC6 — Multiple Clients Receive Agent Events
**Given** a WebSocket server and two connected clients  
**When** the processManager emits a single `event`  
**Then** both clients receive the same JSON message (agent events are broadcast to all clients, not filtered by project)

### AC7 — Connection Close Removes Listeners
**Given** a WebSocket server and a connected client  
**When** the client disconnects  
**Then** `processManager.off("event", handler)` and `processManager.off("error", handler)` and `processManager.off("terminal-data", handler)` are each called once with the same handler references

### AC8 — Malformed Message Does Not Crash
**Given** a WebSocket server with a connected client  
**When** the client sends `{not-valid-json` (incomplete / malformed JSON)  
**Then** the server does not crash, and no message is forwarded to processManager

### AC9 — Non-JSON Data Does Not Crash
**Given** a WebSocket server with a connected client  
**When** the client sends raw text `"hello-not-json"`  
**Then** the server does not crash

### AC10 — Session ID to Task ID Resolution
**Given** a processManager mock where `getSession("s1")` returns `{ taskId: "task-42" }`  
**When** the processManager emits an `event` with `sessionId: "s1"`  
**Then** the client receives a message with `taskId: "task-42"` (resolved from the session)

### AC11 — Unknown Session ID
**Given** a processManager mock where `getSession("unknown")` returns `undefined`  
**When** the processManager emits an `event` with `sessionId: "unknown"`  
**Then** the client receives a message with `taskId: undefined` (graceful handling)

---

## Out of Scope
- Phase-change project filtering (already covered by `websocket-filtering.test.ts`)
- Container state/log broadcasting (uses `broadcastToProject`, already pattern-tested)
- Reconnection behavior (this is client-side hook logic — tested in `use-phase-sync.test.ts` unit tests; a full reconnection integration test would require a real browser environment)
- E2E browser-level tests (these exist separately in the Playwright suite)
