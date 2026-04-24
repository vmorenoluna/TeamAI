# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

TeamAI is a Next.js web app that orchestrates multi-agent Claude Code CLI workflows. It replaces an Electron-based approach with a browser UI that spawns and manages Claude CLI subprocesses, enabling parallel agent sessions (planner, coder, qa-reviewer, etc.) for automated software development pipelines.

All source code lives in the `teamai/` subdirectory. Run all commands from there.

## Commands

```bash
cd teamai
npm run dev      # Development server (tsx server.ts + Next.js hot reload)
npm run build    # Production build
npm run start    # Production server
npm run lint     # ESLint check
```

Run the process manager test script:
```bash
cd teamai
npx tsx scripts/test-process-manager.ts
```

## Architecture

### Custom Server (`server.ts`)
Wraps Next.js with a raw HTTP+WebSocket server (`ws` package). The browser connects via WebSocket for real-time agent event streaming; REST API routes handle task CRUD and pipeline orchestration.

### ProcessManager (`src/lib/process-manager.ts`)
Core engine. Extends `EventEmitter` and manages a `Map<string, AgentSession>`. Each session spawns a `claude -p --input-format stream-json --output-format stream-json` subprocess with piped stdio. Output is buffered and parsed line-by-line as NDJSON, then re-emitted as typed events (`event`, `error`, `exit`).

Key methods: `createSession(taskId, role, cwd)`, `writeToSession(id, data)`, `terminateSession(id)` (SIGTERM).

### Multi-Agent Pipeline
Defined in `defaults/roles/` (analyst, planner, coder, qa-reviewer, qa-fixer, merger) and `defaults/commands/` (spec, plan, implement, qa-review, qa-fix, merge, roadmap, ideation, changelog).

Each command template injects the role at runtime: the Claude subprocess is told to adopt a role persona from `.claude/roles/{role}.md`. Per-project customization lives in the target project's `.claude/` directory.

### Frontend
Next.js App Router (`src/app/`). shadcn/ui components go in `src/components/ui/`. Path alias `@/*` maps to `src/*`. Tailwind CSS 4. Terminal output will render via xterm.js (dependency already installed, not yet wired up).

## Key Design Decisions

- **NDJSON streaming**: Claude CLI outputs newline-delimited JSON; the buffer parser in ProcessManager handles chunks that split across multiple `data` events.
- **Git worktree isolation**: Each pipeline task will run in its own git worktree so parallel agents don't conflict (planned, not yet implemented).
- **node-pty** is installed for PTY support but not yet used — future terminal emulation feature.
- **Multi-project**: The app manages multiple target codebases. Each has its own `.teamai/` state directory and `.claude/` config.