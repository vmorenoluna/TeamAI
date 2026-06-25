# Spec: WebSocket Event Filtering by Project

## Problem

`server.ts` broadcasts `phase-change`, `container-state`, and `container-log` events to ALL connected WebSocket clients using `for (const client of wss.clients)`. In multi-project setups, every client receives events for projects they are not viewing, causing:

- **Wasted bandwidth** — clients receive irrelevant phase-change/container events
- **Unnecessary re-renders** — `usePhaseSync` calls `router.refresh()` on every phase-change, even for unrelated projects
- **Noisy logs** — container-log events from project B appear in project A's UI

## Solution

Filter WebSocket broadcasts by project scope. Each client declares which project it's viewing on connect. The server only sends events to clients whose declared project matches the event's originating project.

---

## Requirements

### R1: Client declares project on WebSocket connect

The client SHALL include the active project path as a query parameter when establishing the WebSocket connection.

**URL format:** `ws://host/ws?project=<encoded-project-path>`

### R2: Server stores project association per client

When a WebSocket connection is established, the server SHALL parse the `project` query parameter from the upgrade URL and store it on the client's WebSocket object. If the parameter is absent, the client receives ALL events (backwards-compatible fallback).

### R3: phase-change events include project root

The orchestrator SHALL include `projectRoot` in every `phase-change` event emission so the server can route the broadcast to the correct project's clients.

### R4: Server filters broadcasts by project

When broadcasting `phase-change`, `container-state`, and `container-log` events, the server SHALL only send to clients where:
- The client's declared `projectRoot` matches the event's `projectRoot`, OR
- The client has no `projectRoot` declared (backwards-compatible fallback)

### R5: Container events already carry projectRoot

`container-state` and `container-log` events already include `projectRoot` in their payload. No change is needed to the container-manager — only the server-side broadcast loop needs the filter.

---

## Acceptance Criteria

### AC1: Phase-change only reaches relevant project

**Given** two projects A and B are registered, and ClientX is viewing project A (connected via `/ws?project=/path/to/A`), and ClientY is viewing project B (connected via `/ws?project=/path/to/B`)

**When** a task in project A transitions to `implement` phase

**Then** ClientX receives the `phase-change` event AND ClientY does NOT receive it

### AC2: Container-state only reaches relevant project

**Given** ClientX is viewing project A, ClientY is viewing project B

**When** project A's container state changes to `running`

**Then** ClientX receives the `container-state` event AND ClientY does NOT receive it

### AC3: Container-log only reaches relevant project

**Given** ClientX is viewing project A, ClientY is viewing project B

**When** a container log message is emitted for project B

**Then** ClientY receives the `container-log` event AND ClientX does NOT receive it

### AC4: Clients without project param receive all events (backwards compatible)

**Given** ClientZ connects to `/ws` with no project query parameter

**When** any phase-change, container-state, or container-log event is emitted

**Then** ClientZ receives the event regardless of which project it originated from

### AC5: Client reconnecting after project switch receives correct events

**Given** ClientX was viewing project A, then switches to project B and reconnects with `/ws?project=/path/to/B`

**When** a task in project A transitions

**Then** ClientX does NOT receive the event for project A

### AC6: Agent event streaming is unaffected

**Given** an agent session message is emitted via the per-connection `agentHandler`

**When** the message is broadcast

**Then** the message reaches its connected client regardless of the project filter (agent events use per-connection handlers, not broadcast loops)

---

## Affected Files

| File | Change |
|------|--------|
| `server.ts` | Add project query param parsing; store `ws.projectRoot`; filter broadcast loops |
| `src/hooks/use-websocket.ts` | Accept optional `project` param; append `?project=...` to WebSocket URL |
| `src/hooks/use-phase-sync.ts` | Pass active project path to useWebSocket |
| `src/lib/orchestrator.ts` | Add `projectRoot` to phase-change event emissions |
| `src/components/kanban-board.tsx` | Pass project path to usePhaseSync |
| `src/components/phased-kanban.tsx` | Pass project path to usePhaseSync |

## Out of Scope

- Filtering agent event streams (these already are per-connection)
- Filtering terminal data streams (these already are per-connection)
- Multi-project viewing by a single client (a client declares ONE project; if a user has multiple tabs open, each tab is a separate WebSocket connection with its own project scope)
