# Specification: Replace 'any' Casts with Proper Types

## Overview
Replace all `any` type annotations and `as any` casts in production source code with proper TypeScript interfaces, type aliases, or `unknown` + type guards. Eliminate all `eslint-disable @typescript-eslint/no-explicit-any` comments.

## Requirements

### R1: Define shared event/message types
Currently, 6 components/hooks use `any` for Claude stream events:
- `agent-panel.tsx` — `event: any`, `blocks: any[]`, terminal/fitAddon
- `ideation-scanner.tsx` — `event: any`, `b: any`
- `insights-chat.tsx` — `event: any`, `blocks: any[]`
- `roadmap-view.tsx` — `event: any`, `b: any`
- `use-agent-stream.ts` — `event: any`
- `use-session-stream.ts` — `event: any`

Define a shared `StreamEvent` interface (or type) that captures the known shape of Claude stream-json events. Extract shared types into a new `src/lib/stream-types.ts` module.

### R2: Replace terminal/fitAddon `any` with proper types
`terminal-panel.tsx` and `agent-panel.tsx` use `any` for xterm.js `Terminal` and `FitAddon` instances. Import proper types from `@xterm/xterm` and `@xterm/addon-fit`.

### R3: Replace `as any` casts in production code
- `orchestrator.ts:374` — `(this.taskStore as any).update(...)` for `platform` field. Add `platform` to the Task interface or use a separate update method.
- `roadmap.ts:246,294,330` — `phaseKey as any` for `VALID_PHASES.includes()`. Type `VALID_PHASES` properly or use a type guard.

### R4: Replace `: any` variable declarations
- `tasks.ts:136,143` — `let plan: any`, `let qaReport: any`. Define proper interfaces for plan and QA report shapes.
- `roadmap.ts:143,337` — `let raw: any`, `let report: any`. Define proper interfaces.

### R5: Remove all `eslint-disable @typescript-eslint/no-explicit-any` comments
Production code only (not test files). The orchestrator.ts and tasks.ts disable comments should be removable after R1-R4 are complete.

## Acceptance Criteria

### AC1: No `any` in production source
**Given** the codebase is scanned with `rg "[:] any|as any" src/`  
**When** all changes are implemented  
**Then** zero matches remain in `src/` (excluding files that genuinely need `any`, documented with a comment explaining why)

### AC2: Stream events are typed
**Given** a Claude stream-json event is received  
**When** it flows through `use-agent-stream.ts` or any component  
**Then** the event is typed as `StreamEvent` with known fields, not `any`

### AC3: Terminal instances are typed
**Given** an xterm.js Terminal is created  
**When** it is stored in a ref or variable  
**Then** it is typed as `Terminal` from `@xterm/xterm`, not `any`

### AC4: No eslint-disable comments remain
**Given** the production src/ directory  
**When** lint is run  
**Then** no `@typescript-eslint/no-explicit-any` disable comments exist

### AC5: TypeScript compilation passes
**Given** all changes are applied  
**When** `npx tsc --noEmit` is run  
**Then** zero type errors

### AC6: Existing tests pass
**Given** all changes are applied  
**When** `npx vitest run` is run  
**Then** all 106 existing tests pass

## Files to Modify/Create

### Create:
- `src/lib/stream-types.ts` — Shared `StreamEvent`, `ContentBlock`, `ToolUseBlock` interfaces

### Modify:
- `src/lib/orchestrator.ts` — Remove `as any` cast, add `platform?` to Task
- `src/app/actions/roadmap.ts` — Type `VALID_PHASES`, replace `as any` and `: any`
- `src/app/actions/tasks.ts` — Define Plan/QAReport interfaces, replace `: any`
- `src/components/agent-panel.tsx` — Import StreamEvent, Terminal, FitAddon types
- `src/components/ideation-scanner.tsx` — Import StreamEvent types
- `src/components/insights-chat.tsx` — Import StreamEvent types
- `src/components/roadmap-view.tsx` — Import StreamEvent types
- `src/components/terminal-panel.tsx` — Import Terminal, FitAddon types
- `src/hooks/use-agent-stream.ts` — Use StreamEvent type
- `src/hooks/use-session-stream.ts` — Use StreamEvent type

## Dependencies / Risks
- **Risk**: Some `any` usages may be genuinely necessary (e.g., `JSON.parse` returns `any`). Document these cases with comments.
- **Risk**: xterm.js type exports may differ from what's currently installed. Verify with `@xterm/xterm` version in package.json.
- **Dependency**: None. All changes are internal to this codebase.
