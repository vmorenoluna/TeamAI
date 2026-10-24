# ADR 011: The Engine Runs in Its Own Child Process

**Date:** 2026-10-23

**Status:** Accepted

## Context

The orchestrator, auto mode and `ProcessManager` used to run in the same Node process as
the Next.js server and the WebSocket. Pipeline work is not all asynchronous: git
operations, synchronous file reads and writes, NDJSON parsing of busy agent streams and
recovery scans all occupy the event loop. While they ran, page renders, server actions and
WebSocket frames waited. Task 46d0e55a (background server actions) removed the blocking
that came from awaiting slow actions, but it did not move the work off the shared event
loop.

## Decision

Run everything that drives the pipeline in a separate **engine** child process. The API
server (`server.ts`) forks it, talks to it over Node's built-in IPC channel, and keeps
serving pages, server actions and the WebSocket regardless of what the engine is doing.

- `server.ts` calls `startEngine()` (`src/engine/engine-host.ts`) and parks the host on
  `globalThis.__teamaiEngine`. The child gets `TEAMAI_PROCESS_ROLE=engine`; the API process
  runs as `api`.
- The child entry is `engine.ts` (bundled as `engine.cjs` beside `server.cjs` in
  production, run through `tsx` in dev), which loads `src/engine/engine-main.ts`.
- Server actions in `src/app/actions/` are thin wrappers: they call
  `engineCall('<area>.<method>', [params])` (`src/engine/engine-client.ts`). The logic
  lives in `src/engine/handlers/`, merged into one method table in `handlers/index.ts`.
- `src/lib/process-role.ts` guards the boundary. `assertNotApiProcess(what)` throws
  `EngineBoundaryError` when engine-only work is attempted in the API process, and
  `getProcessRole()` reports `api` or `engine`, or `undefined` (tests and scripts).

### Alternatives rejected

- **`worker_threads`.** Threads would unblock the event loop, but they share a process:
  a crash or an out-of-memory in the engine takes the server down, `process.chdir` and
  `process.env` mutations leak between the two, and a native-module or `child_process`
  fault is not isolated. A separate process also lets the API server kill and restart the
  engine and reap its agents, which a thread cannot offer.
- **An HTTP or WebSocket API between the processes.** It would need a port, an
  authentication story, a second request/response framing and reconnect logic, all to
  carry messages that Node's IPC channel already carries between a parent and the child it
  forked. The channel also dies with the parent, so the engine cannot outlive the server.
- **Staying in-process and converting more of the pipeline to async.** That is the
  approach that was already in use. It cannot cover synchronous filesystem work, JSON
  parsing and git calls inside the orchestrator, and every new synchronous call silently
  reintroduces the stall. Isolation by process is the only guarantee that does not depend
  on every future line of code being non-blocking.

### Ownership

| Object | Owner | Notes |
|---|---|---|
| `processManager` (sessions, agent subprocesses) | engine | API sees only forwarded `agent-event` / `agent-error` |
| `getOrchestrator()` and the pipeline | engine | |
| Auto mode (`setAutoModeState`, tick loop, CI polling) | engine | |
| `runInBackground()` and its result registry, `isBackgroundPending` guards | engine | the work settles in the engine |
| `containerManager` and container validation | engine | |
| Terminals (node-pty sessions) | engine | browser terminal messages are relayed over IPC |
| Role-refinement analysis and watcher | engine | |
| Task state writes (`TaskStore`, `events.jsonl`, pipeline artifacts) | engine | the only writer |
| Boot sequence (default sync, recovery, auto-resume, sweeps, auto-mode restore) | engine | runs in `runEngineBoot()`, again after every restart |
| Next.js pages, server actions, `revalidatePath` | API | |
| WebSocket server and client filtering by project | API | `src/engine/ws-relay.ts` |
| `getAutoModeState()` | API | reads `.teamai/auto-mode.json` and the task store from disk |
| Reads of `.teamai/` (task lists, specs, QA reports) | API | read-only |
| `appEvents` in the API process | API | re-emits every engine `event` message |
| Engine supervisor (`startEngine()`) | API | fork, queue, restart, reap |

### IPC protocol (`src/engine/protocol.ts`)

Every payload is JSON-serializable.

| Direction | Message | Meaning |
|---|---|---|
| API → engine | `{type:'call', id, method, args}` | request that expects a `result` |
| API → engine | `{type:'notify', method, args}` | fire-and-forget (terminal input, resize) |
| API → engine | `{type:'shutdown'}` | clear the child registry and exit |
| engine → API | `{type:'ready'}` | engine finished recovery and is serving |
| engine → API | `{type:'result', id, ok, value \| error}` | answer to a `call`; errors carry `name`, `message`, `code` |
| engine → API | `{type:'event', name, args}` | `phase-change`, `action-result`, `agent-event`, `agent-error`, `terminal-data`, `task-updated`, `subtask-progress`, container and refinement events |

Calls made before `ready` are queued and flushed on `ready`. A method the engine does not
know yields an `EngineMethodNotFound` error. `EngineUnavailableError` and
`EngineTimeoutError` cover a missing engine and a call with `timeoutMs` that did not
answer. `engine-client.ts` imports only `protocol.ts` and types, so a server action never
pulls the orchestrator into the API process.

### Restart and crash policy

- If the engine exits while the server is not shutting down, every call in flight is
  rejected with `EngineUnavailableError` ("operation was interrupted; retry it") and the
  engine is restarted after 1 s. The boot sequence runs again, so interrupted tasks are
  recovered by the normal path and auto mode is restored from disk.
- More than `ENGINE_MAX_CRASHES` (3) crashes inside `ENGINE_CRASH_WINDOW_MS` (10 min)
  puts the host in `down`: new calls fail with `EngineUnavailableError` until TeamAI is
  restarted. An engine that sends no `ready` within 60 s is treated as a crash.
- **Reaping.** The engine records every agent and terminal pid it spawns in a registry file
  (`src/engine/child-registry.ts`, `<tmpdir>/teamai-engine-<PORT>-children.json`). On an
  unexpected exit the API process kills every pid in it (`taskkill /t /f` on Windows,
  `SIGKILL` elsewhere) before restarting, so a dead engine cannot leave orphaned agents
  writing into a worktree. A clean shutdown removes the file.
- **Container-mode limitation.** In container mode the agent's immediate child is a
  host-side `docker exec` client. Killing that client does not stop the process inside the
  container (Docker does not forward the kill), so after an engine crash a containerized
  agent can keep running until it finishes or its container is stopped. Only host-side
  processes are reliably reaped. The restarted engine's recovery scan treats those
  sessions as stale and the task resumes through the normal retry path.

### Shutdown semantics are unchanged

SIGINT / SIGTERM on the server still run the same graceful shutdown. It now awaits
`engineHost.shutdown()`, which sends `shutdown`, waits up to `ENGINE_SHUTDOWN_GRACE_MS`
(3 s) for the child to exit and then kills it, before the HTTP server closes. The engine
does not outlive the server, and the overall 5 s force-exit timer still applies.
Interrupted tasks resume on next start exactly as they did when everything shared a
process.

### Dev watch

`npm run dev` runs `tsx watch server.ts`, which watches only the module graph of
`server.ts`. The engine is a forked process and is not in that graph, so the dev watcher
must name the engine's sources explicitly (`--include` globs for `engine.ts`,
`src/engine/**` and `src/lib/**`) or editing orchestrator code would not restart it.
Restarting the watched server restarts the engine with it, because the engine is its child.

## Consequences

- A busy or stalled pipeline phase cannot delay a page render, a server action or a
  WebSocket frame.
- Anything a handler returns or an event carries must be JSON-serializable. Class
  instances, `Map`s and functions do not cross the boundary.
- Code reached from a server action must not import an engine-owned module; the
  process-role guard turns an accidental import-and-call into an immediate error instead of
  a silently split state.
- The in-memory background-operation registry is lost on an engine restart. Calls in
  flight fail with `EngineUnavailableError`, and the user retries through the single Retry
  action.

## References

- `src/engine/engine-host.ts`: supervisor, restart policy, reaping
- `src/engine/engine-main.ts`: dispatcher, event forwarding, boot sequence
- `src/engine/engine-client.ts`, `src/engine/protocol.ts`: API-side client and messages
- `src/engine/handlers/`: the engine's method table
- `src/engine/ws-relay.ts`: engine events to WebSocket, terminal messages to the engine
- `src/engine/child-registry.ts`: orphan registry
- `src/lib/process-role.ts`: process-role guard
- ADR 004: failure and retry policy
