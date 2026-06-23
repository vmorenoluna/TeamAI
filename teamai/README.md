# TeamAI — Multi-Agent Claude Code Orchestrator

TeamAI is a Next.js web application that orchestrates multi-agent [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI workflows. It replaces manual CLI usage with a browser UI that spawns and manages parallel Claude subprocesses, enabling automated software development pipelines across spec, plan, implement, and QA phases.

## Features

- **Multi-Agent Pipeline** — Run spec, plan, implement, QA review, and merge phases with role-specialized Claude agents (analyst, planner, coder, qa-reviewer, merger)
- **Kanban Board** — Drag-and-drop task management with real-time phase tracking and QA report summaries
- **Roadmap View** — Product roadmap with phased kanban columns, competitor analysis, changelog generation, and ticket conversion
- **Ideation Scanner** — Analyse your codebase for feature opportunities and improvement suggestions
- **GitHub Issues Import** — Fetch and import open GitHub issues as kanban tasks via MCP integration
- **Insights Chat** — Interactive AI chat for codebase questions with streaming responses
- **Interactive Terminals** — Open PTY-based Claude sessions pre-loaded with role personas
- **Reusable UI Components** — Shared RateLimitBanner, StreamingOutput, LoadingSpinner, and phased RoadmapCard/PhasedKanban for consistent UX
- **Dark Mode UI** — Full dark mode with shadcn/ui components and Tailwind CSS v4
- **Multi-Provider Support** — Anthropic, Bedrock, Vertex, OpenAI, Gemini, and Ollama backends
- **Container Isolation** — Optional devcontainer sandboxing for agent sessions
- **Session Recovery** — Auto-detect interrupted tasks and stale sessions on server restart
- **Rate-Limit Auto-Resume** — Detects Claude Code session limits and auto-resumes with a countdown timer
- **Real-time Streaming** — WebSocket-based agent event streaming with tool-call visibility
- **Spec Revision Workflow** — Human-gated spec revision when QA identifies specification-level issues

## Prerequisites

- **Node.js** ≥ 20
- **Claude Code CLI** — Install via `npm install -g @anthropic-ai/claude-code`
- **Git** — Required for worktree-based parallel agent isolation
- **Docker** (optional) — For container-isolated agent sessions

## Quick Start

```bash
# Clone and install
git clone <repo-url>
cd TeamAI/teamai
npm install

# Set the git hooks path (required for pre-commit checks)
git config core.hooksPath .husky

# Start development server
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) in your browser.

## Project Structure

```
TeamAI/
├── .husky/                    # Git hooks (pre-commit lint/typecheck)
├── .teamai/                   # Per-project state (tasks, roadmap, pipeline config)
│   ├── providers.json         # LLM provider configuration
│   ├── pipeline.json          # Pipeline phase configuration
│   └── <task-slug>/           # Per-task directory (spec.md, plan.json, qa_report.json)
├── teamai/
│   ├── src/
│   │   ├── app/               # Next.js App Router pages
│   │   │   ├── actions/       # Server actions (tasks, pipeline, providers, etc.)
│   │   │   ├── ideation/      # Ideation scanner page
│   │   │   ├── insights/      # Insights/chat page
│   │   │   ├── roadmap/       # Product roadmap page
│   │   │   ├── settings/      # Provider/pipeline configuration page
│   │   │   ├── task/[id]/     # Task detail page
│   │   │   └── terminals/     # Interactive terminal page
│   │   ├── components/        # React components (kanban, task panel, streaming output, rate-limit banners, etc.)
│   │   ├── hooks/             # Custom hooks (useAgentStream, usePhaseSync, etc.)
│   │   ├── lib/               # Core business logic
│   │   │   ├── orchestrator.ts    # Multi-agent pipeline orchestrator
│   │   │   ├── process-manager.ts # Claude CLI subprocess management
│   │   │   ├── task-store.ts      # Task persistence (JSON file store)
│   │   │   ├── providers.ts       # LLM provider configuration resolver
│   │   │   ├── recovery.ts        # Crash recovery (stale sessions, orphaned worktrees)
│   │   │   └── container-manager.ts # Devcontainer lifecycle management
│   │   └── app/globals.css    # Global styles + Tailwind CSS v4
│   ├── defaults/              # Default pipeline configuration
│   │   ├── commands/          # Command templates (spec, plan, implement, etc.)
│   │   ├── roles/             # Role persona definitions (planner, coder, etc.)
│   │   └── pipeline.json      # Default pipeline phases
│   ├── scripts/               # Utility scripts
│   ├── tests/                 # Unit and E2E tests (Vitest + Playwright)
│   ├── server.ts              # Custom HTTP + WebSocket server
│   └── package.json
└── CLAUDE.md                  # Claude Code guidance
```

## Architecture

### Custom Server (`server.ts`)

Wraps Next.js with a raw HTTP + WebSocket server (`ws` package). The browser connects via WebSocket at `/ws` for real-time agent event streaming. REST API routes handle task CRUD and pipeline orchestration.

### ProcessManager (`src/lib/process-manager.ts`)

The core engine. Extends `EventEmitter` and manages a `Map<string, AgentSession>`. Each session spawns a `claude -p --input-format stream-json --output-format stream-json` subprocess with piped stdio. Output is buffered and parsed line-by-line as NDJSON, then re-emitted as typed events.

Also manages PTY terminal sessions via `node-pty` for the interactive Terminals page.

### Orchestrator (`src/lib/orchestrator.ts`)

Manages multi-agent pipelines. Each task progresses through configurable phases:

1. **Spec** — Planner agent writes `spec.md`
2. **Plan** — Planner agent writes `plan.json` with subtask breakdown
3. **Implement** — Coder agent(s) implement changes in parallel within git worktrees
4. **QA Review** — QA Reviewer agent inspects changes and writes `qa_report.json`
5. **QA Fix** (if needed) — QA Fixer agent addresses issues
6. **Awaiting Review** — Paused for human approval
7. **Merge** / **Create PR** — Merger agent merges or opens a PR

### Pipeline Commands & Roles

Commands (`defaults/commands/`) define the agent prompts for each phase. Roles (`defaults/roles/`) define the persona and instructions for each agent type:

| Role | File | Purpose |
|------|------|---------|
| Analyst | `analyst.md` | Codebase analysis and ideation |
| Planner | `planner.md` | Spec writing and implementation planning |
| Coder | `coder.md` | Code implementation |
| QA Reviewer | `qa-reviewer.md` | Code review and quality assessment |
| QA Fixer | `qa-fixer.md` | Fixes issues found in QA review |
| Merger | `merger.md` | Git merge and PR creation |

### Git Worktree Isolation

Parallel agents run in isolated git worktrees so they don't conflict on file edits. Each task gets a worktree at `worktrees/<task-slug>/`.

## Configuration

### Providers (`providers.json`)

Configure which LLM backend each agent role uses:

```json
{
  "default": { "provider": "anthropic", "model": "claude-sonnet-4-6" },
  "roles": {
    "coder": { "provider": "anthropic", "model": "claude-sonnet-4-6" },
    "qa-reviewer": { "provider": "vertex", "model": "claude-sonnet-4-6" }
  }
}
```

Supported providers: `anthropic`, `bedrock`, `vertex`, `openai`, `gemini`, `ollama`.

### Pipeline (`pipeline.json`)

Customize which pipeline phases run and how many QA retry attempts to allow:

```json
{
  "phases": ["spec", "plan", "implement", "qa-review", "merge"],
  "maxQaAttempts": 3,
  "parallelSubtasks": true
}
```

### Container Isolation

Set `container.json` in `.teamai/` to enable devcontainer sandboxing for agent sessions:

```json
{ "enabled": true }
```

When enabled, all agent subprocesses run inside a Docker devcontainer, providing filesystem and network isolation.

## Development

### Commands

```bash
cd teamai
npm run dev       # Development server (tsx server.ts + Next.js HMR)
npm run build     # Production build
npm run start     # Production server
npm run lint      # ESLint check
npm run typecheck # TypeScript type checking
npm test          # Run unit tests (Vitest)
```

### Running Tests

```bash
# Unit tests
cd teamai && npm test

# E2E tests (requires dev server running)
npx playwright test
```

### Pre-commit Hooks

The project uses Husky + lint-staged for pre-commit checks. On every commit, staged TypeScript files are checked with ESLint and TypeScript type checking.

## Recovery

TeamAI detects interrupted state on server startup:

- **Interrupted tasks** — Tasks stuck in in-progress phases are shown in the recovery banner
- **Stale sessions** — Orphaned ProcessManager sessions are detected and cleaned up
- **Orphaned worktrees** — Git worktrees without active tasks are reported

## Contributing

1. Fork the repository
2. Create a feature branch (`feat/my-feature`)
3. Make changes following existing code conventions
4. Run `npm run lint && npm run typecheck`
5. Submit a Pull Request

See `CLAUDE.md` for AI coding guidance and conventions used in this project.

## License

MIT
