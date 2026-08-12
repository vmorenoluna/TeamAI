# TeamAI

Multi-agent [Claude Code](https://docs.anthropic.com/en/docs/claude-code) orchestrator — an Electron desktop app that runs parallel Claude CLI agents through automated software development pipelines.

## Prerequisites

- **Node.js** ≥ 20
- **Claude Code CLI** — `npm install -g @anthropic-ai/claude-code`
- **Git**
- **Docker** (optional — for container-isolated agent sessions)

## Quick Start

```bash
git clone <repo-url>
cd TeamAI

# Set up git hooks
git config core.hooksPath .husky

# Install and run
cd teamai
npm install
npm run dev          # start dev server (React HMR on :3002)
npm run electron:dev  # launch Electron app (separate terminal)
```

Open `http://localhost:3002` in a browser, or run `npm run electron:dev` to open the Electron app (both connect to the dev server on :3002).

### Demo Project

TeamAI ships with a demo project (`demo/`) that includes pre-seeded tasks across all pipeline phases. The demo is **not shown by default** in production — it only appears when the server is started with the `--with-demo` flag:

```bash
# Start the dev server with the demo project
cd teamai
npm run dev -- -- --with-demo

# Start the production server with the demo project
npm run start -- -- --with-demo
```

`npm run electron:dev` already passes `--with-demo` internally, so the demo is visible when developing in Electron. For production builds (`npm run electron:start`), the demo is hidden unless you explicitly add it via the "+" button in the project selector.

## Commands

All commands run from `teamai/`.

### Development

| Command | Description |
|---|---|
| `npm run dev` | Start Next.js dev server with HMR |
| `npm run electron:dev` | Launch Electron app pointing at the dev server |
| `npm run start` | Start production server |
| `npm run electron:start` | Launch Electron app in production mode |

### Testing

#### Quick reference

| Command | Description |
|---|---|
| `npm test` | Run all unit + integration tests (Vitest) |
| `npm run test:unit` | Run only unit tests |
| `npm run test:integration` | Run only integration tests |
| `npm run test:e2e` | Run Playwright E2E tests |
| `npm run test:all` | Full suite: typecheck + lint + vitest + e2e + changelog |
| `npm run test:changelog` | Run CHANGELOG parsing tests |
| `npm run test:watch` | Run tests in watch mode |
| `npx playwright test tests/e2e/update-banner.spec.ts` | Run a single E2E spec |

#### Test layers

| Layer | Framework | Location | Runs real CLI? | Runs Docker? |
|---|---|---|---|---|
| **Unit** | Vitest + jsdom/happy-dom | `tests/unit/` | No | No |
| **Integration** | Vitest | `tests/integration/` | No (mocked) | No |
| **E2E** | Playwright | `tests/e2e/` | No — uses seeded fixture data | No |

#### E2E test strategy

The E2E tests cover ~270 UI interactions across 33 spec files. They **do not** invoke the real Claude Code CLI or Docker — instead they run against a Next.js server with pre-seeded static fixture data.

**Seed data** (`tests/e2e/seed.ts`) creates a fake project with 16 tasks spanning all pipeline phases (`backlog` → `done`). Each task includes pre-written artifacts that simulate real pipeline output:

| Artifact | Simulates |
|---|---|
| `task.json` | Task metadata, phase, timestamps |
| `spec.md` | Specification written by the analyst agent |
| `plan.json` | Subtask plan written by the planner agent |
| `qa_report.json` | QA review results (pass/fail) |
| `completion_summary.md` | Final summary after pipeline completion |
| `events.jsonl` | Phase-change event history |
| `session_map.json` | Active pipeline session marker |

**Route mocking** — `page.route()` intercepts server action POSTs in error-path tests (e.g., forcing `InsightsChat` to show error banners when session creation fails).

**What E2E tests cover** — everything the user sees: kanban board, task detail panel, settings, workflow view, roadmap, insights dashboard, terminal UI, error banners, sidebar navigation, responsive viewport, drag-and-drop, search/filter, and more.

**What E2E tests don't cover** — anything requiring the real CLI: pipeline execution, live terminal output, WebSocket streaming from agents, Docker container management, GitHub PR creation, auto-mode processing.

**Port isolation** — the E2E server runs on port **3001**, separate from the dev server (**3002**) and production server (**3000**), so `npm run dev` and `npm run test:e2e` can run side by side.

**UI selectors** — components use `data-component="..."` attributes for stable test selectors instead of `data-testid`. Playwright and Testing Library are both configured to use `data-component` via `testIdAttribute`.

**Parallel isolation** — the seed data is cloned per Playwright worker to prevent mutation races between parallel test files.

#### Running E2E tests locally

```bash
# Run a single spec (always run E2E by file — never all at once, they take too long)
npx playwright test tests/e2e/kanban-behaviors.spec.ts

# Run with visible browser for debugging
npx playwright test tests/e2e/sidebar.spec.ts --headed

# Run a specific test within a file
npx playwright test tests/e2e/settings.spec.ts -g "Updates"
```

#### Full suite (CI equivalent)

```bash
npm run test:all
# Runs: typecheck → lint → vitest (unit + integration) → e2e → changelog
```

### Linting & Type Checking

| Command | Description |
|---|---|
| `npm run lint` | ESLint with zero-warnings enforcement |
| `npm run typecheck` | TypeScript type checking (`tsc --noEmit`) |

### Building

| Command | Description |
|---|---|
| `npm run build` | Production Next.js build |
| `npm run build:server` | Bundle the custom server with esbuild |
| `npm run electron:build` | Build Windows installer (NSIS + zip) |
| `npm run electron:build:mac` | Build macOS installer (DMG + zip) |
| `npm run electron:build:linux` | Build Linux packages (AppImage + deb) |
| `npm run electron:build:all` | Build all three platforms |

### Release

```bash
# 1. Update teamai/CHANGELOG.md with changes since last release
# 2. Run the release script
./scripts/release.sh 0.2.0

# 3. Push — the tag triggers CI to build installers + create a GitHub Release
git push origin main && git push origin v0.2.0
```

The CI workflow (`.github/workflows/release.yml`):

- Validates the tag matches `package.json` version
- Builds Windows, macOS, and Linux installers in parallel
- Creates a GitHub Release with the changelog section + auto-generated PR notes
- Marks `0.x` versions as prereleases automatically
- Uploads `latest.yml` metadata for [electron-updater](https://www.electron.build/auto-update) auto-update support

See `scripts/release.sh` for the version-bump-and-tag helper.

## Project Structure

```
teamai/
├── electron/              # Electron main process + preload
│   ├── main.js            # App lifecycle, server spawn, auto-updater
│   └── preload.js         # IPC bridge (contextBridge)
├── src/
│   ├── app/               # Next.js pages + server actions
│   ├── components/        # React components (kanban, task panel, terminals)
│   ├── hooks/             # Custom hooks
│   ├── lib/               # Core logic (orchestrator, process manager, task store)
│   └── constants/         # Phase labels, colours
├── defaults/              # Pipeline configs, command templates, role personas
├── tests/
│   ├── unit/              # Vitest unit tests
│   ├── integration/       # Vitest integration tests
│   └── e2e/               # Playwright E2E tests
├── scripts/               # Utility scripts (release.sh, test helpers)
├── server.ts              # Custom HTTP + WebSocket server
├── package.json
├── tsconfig.json
├── eslint.config.mjs
└── vitest.workspace.ts
```

## Architecture

**Pipeline:** Each task flows through configurable phases — spec → plan → implement → QA review → merge. Role-specialized Claude agents (analyst, planner, coder, qa-reviewer, merger) handle each phase.

**ProcessManager:** Spawns `claude -p --input-format stream-json --output-format stream-json` subprocesses. NDJSON output is parsed and streamed to the UI via WebSocket.

**Git worktree isolation:** Parallel agents run in isolated git worktrees at `worktrees/<task-slug>/`, preventing file conflicts.

**Auto mode:** Optionally auto-advances tasks through the pipeline — picks backlog tasks, auto-approves reviews, creates PRs, polls CI, and auto-merges. State persists across restarts.

**Recovery:** On startup, detects interrupted tasks and stale sessions. Rate-limited sessions auto-resume with a countdown timer.

**Electron:** In dev mode, `Ctrl+Shift+U` simulates the update download → ready flow for testing the update banner.

## Configuration

Per-project `.teamai/` directory:

| File | Purpose |
|---|---|
| `providers.json` | LLM backend per role (Anthropic, Bedrock, Vertex, OpenAI, Gemini, Ollama) |
| `pipeline.json` | Phase order and max QA retry attempts |
| `container.json` | Enable/disable Docker devcontainer sandboxing |

Default configs live in `defaults/` and are synced to projects on startup.

## Contributing

1. Fork and create a feature branch
2. Make changes following existing conventions
3. Run `npm run lint && npm run typecheck && npm test`
4. Submit a Pull Request

See `teamai/CLAUDE.md` for AI coding guidance. See `teamai/AGENTS.md` for dev shortcuts.
