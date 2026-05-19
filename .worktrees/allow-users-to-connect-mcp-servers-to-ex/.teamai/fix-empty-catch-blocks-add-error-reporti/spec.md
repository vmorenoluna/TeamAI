# Spec: Fix Empty Catch Blocks — Add Error Reporting

## Scope

Audit all empty/silent catch blocks in production source code and add structured error logging. Create a reusable `ErrorBoundary` React component and a global unhandled rejection handler in `server.ts`.

## Background

Currently, ~20 catch blocks in production code silently swallow errors:
- `container-manager.ts`: 4 empty catches (Docker checks, JSON parse, spawn)
- `orchestrator.ts`: 4 empty/silent catches (JSON parse, file I/O, git commands)
- `projects.ts`: 1 empty catch (directory read)
- `task-panel.tsx`: 1 silent catch (WebSocket JSON parse)
- `server.ts`: 1 silent catch (WebSocket message parse)

This makes debugging failures nearly impossible in production.

## Requirements

### R1: Structured Logger (`src/lib/logger.ts`)
- Create a lightweight, structured logger utility
- Support `[module]` prefixed messages matching existing convention
- Export `log`, `warn`, `error` functions
- Each accepts a `module` string, a `message` string, and optional `details` (Error or unknown)
- In production, `log`/`warn` should be quiet (only `error` logs)
- In development, all levels log to console

### R2: Fix Empty Catch Blocks
- Add `logger.error(module, message, err)` to every empty/silent catch
- Use descriptive module tags: `[container]`, `[orchestrator]`, `[projects]`, `[task-panel]`, `[ws]`
- Preserve existing behavior — just add logging, don't change control flow

### R3: ErrorBoundary Component (`src/components/error-boundary.tsx`)
- React error boundary using `componentDidCatch`
- Renders a fallback UI with error details in dev mode
- Renders a minimal "Something went wrong" in production
- Includes a "Try Again" button that resets the error boundary
- Use `'use client'` directive

### R4: Global Unhandled Rejection Handler
- Add `process.on('unhandledRejection', ...)` in `server.ts`
- Log the rejection with `[server]` tag
- Do NOT crash the process — just log
- Add `process.on('uncaughtException', ...)` for unexpected synchronous errors

## Non-Goals
- Not changing error control flow or adding retry logic
- Not integrating with external logging services (Sentry, etc.)
- Not modifying `.catch(() => null)` patterns in roadmap-view — those are intentional "silent fallback" patterns

## Acceptance Criteria
- Zero empty catch blocks in production `src/` and `server.ts`
- `tsc --noEmit` passes cleanly
- All 106 existing tests still pass
- ErrorBoundary renders correctly in the browser
- Server logs unhandled rejections without crashing
