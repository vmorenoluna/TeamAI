# TeamAI

TeamAI is a desktop app that runs several [Claude Code](https://docs.anthropic.com/en/docs/claude-code) agents at once, each handling one step of building software: writing a spec, planning the work, writing the code, reviewing it, and merging it. It's built with Electron, so it runs as a regular desktop app on Windows, macOS, and Linux.

![TeamAI kanban board](docs/images/board.jpg)

## Features

### Sidebar sections (currently visible)

| Section | Route | Description |
|---|---|---|
| **Kanban** | `/` | Drag-and-drop task board spanning all pipeline phases (`backlog` → `done`) with task detail, review, and retry actions |
| **Workflow** | `/workflow` | Pipeline orchestration view showing how tasks advance through spec → plan → implement → QA review → merge |
| **Terminals** | `/terminals` | Unified terminal UI streaming live output from every agent session |
| **Roadmap** | `/roadmap` | Long-horizon roadmap planning view |
| **Settings** | `/settings` | Project configuration: LLM providers, pipeline phases, auto mode, and the Role Refinement Assistant |

### Core platform features

- **Multi-agent pipeline**: specialized Claude agents (analyst, planner, coder, qa-reviewer, merger) move each task through spec, plan, implement, QA review, and merge.
- **Auto Mode**: automatically advances tasks. It picks up backlog tasks, approves reviews for you, opens pull requests, checks CI status, and merges once everything passes. This setting survives restarts.
- **Role Refinement Assistant**: when a task fails, this looks at what went wrong and suggests fixes to the agents' instructions (you can turn on auto-apply and auto-retry if you want it fully hands-off).
- **Git worktree isolation**: each agent works in its own copy of your repo (a "git worktree"), so parallel agents never step on each other's files.
- **Multi-project support**: manage more than one codebase at a time. Each project keeps its own settings in a `.teamai/` folder and its own agent config in `.claude/`.
- **Crash recovery**: if a task gets interrupted, or an agent session hits a rate limit, it picks back up automatically after a restart.

## Install

Download the latest build for your platform from [Releases](https://github.com/vmorenoluna/TeamAI/releases): Windows (`.exe` installer), macOS (`.dmg`), or Linux (`.AppImage` / `.deb`). Installed builds check for updates automatically; see [Auto-Updates](#auto-updates) below for which platforms support that, plus the unsigned-binary warnings you'll see the first time you open the app.

Either way you install it (packaged build, or from source below), TeamAI needs the Claude Code CLI and a Claude account to actually run anything. See Prerequisites.

To build and run from source instead, see [Quick Start](#quick-start).

## Prerequisites

Required no matter how you install:

- **A Claude account** (or a Claude API key). TeamAI runs the `claude` command-line tool behind the scenes to power its agents; without an account, nothing runs.
- **Claude Code CLI**: install it with `npm install -g @anthropic-ai/claude-code`

Only needed if you're building and running from source (not needed for a packaged download):

- **Node.js** version 20 or newer
- **Git**
- **Docker** (optional, only needed if you want agent sessions to run inside a sandboxed container)

## Safety & Privacy

TeamAI's agents run shell commands with the same file access as whichever user account is running the app. That's not a bug: an autonomous coding agent needs that access to edit files, run tests, and use git. Everything happens locally on your machine; nothing is sent anywhere except to the LLM provider you've configured.

If you're pointing TeamAI at a repository you don't fully trust (code you didn't write and haven't reviewed), turn on the optional Docker sandbox (`container.json`, see [Configuration](#configuration)) so agent sessions run isolated from your normal file system instead of directly on it.

## Quick Start

```bash
git clone https://github.com/vmorenoluna/TeamAI.git
cd TeamAI

# Set up git hooks
git config core.hooksPath .husky

# Install and run
cd teamai
npm install
npm run dev          # start dev server (React HMR on :3002)
npm run electron:dev  # launch Electron app (separate terminal)
```

Open `http://localhost:3002` in a browser, or run `npm run electron:dev` to open the Electron app (both connect to the same dev server on port 3002).

### Demo Project

TeamAI ships with a demo project (`demo/`) that already has tasks seeded across every pipeline phase, handy for exploring the UI without setting up a real project. The demo is hidden by default in production. It only shows up when the server is started with the `--with-demo` flag:

```bash
# Start the dev server with the demo project
cd teamai
npm run dev -- -- --with-demo

# Start the production server with the demo project
npm run start -- -- --with-demo
```

`npm run electron:dev` already passes `--with-demo` for you, so the demo appears automatically while developing in Electron. In production builds (`npm run electron:start`), the demo stays hidden unless you add it yourself using the "+" button in the project selector.

## Auto-Updates

Packaged builds from [Releases](https://github.com/vmorenoluna/TeamAI/releases) check for updates automatically and show an in-app prompt when one is ready to install. Not every platform and format supports this:

| Platform | Format | Auto-updates? |
|---|---|---|
| Windows | NSIS installer (`.exe`) | ✅ |
| Windows | Portable zip | ❌ (re-download manually) |
| macOS | `.dmg` / `.zip` | ✅ |
| Linux | AppImage | ✅ |
| Linux | `.deb` | ❌ (re-download manually) |

Builds aren't code-signed yet, so the first time you open one you may see a warning:
- **Windows**: SmartScreen. Click "More info", then "Run anyway".
- **macOS**: Gatekeeper. Right-click the app and choose "Open" instead of double-clicking.

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
| **E2E** | Playwright | `tests/e2e/` | No (uses seeded fixture data) | No |

#### E2E test strategy

The end-to-end (E2E) tests cover roughly 270 user interactions across 33 spec files. They don't call the real Claude Code CLI or Docker. Instead, they run against a Next.js server loaded with fixed sample data, so they're fast and don't need real agents or API keys.

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

**Route mocking**: some error-path tests use `page.route()` to intercept the app's server-action requests and force an error response (for example, making `InsightsChat` show its error banner when starting a session fails).

**What E2E tests cover**: everything the user sees, including the kanban board, task detail panel, settings, workflow view, roadmap, insights dashboard, terminal UI, error banners, sidebar navigation, responsive layout, drag-and-drop, and search/filter.

**What E2E tests don't cover**: anything that needs the real CLI, such as actually running the pipeline, live terminal output, WebSocket streaming from agents, Docker container management, GitHub PR creation, or auto-mode processing.

**Port isolation**: the E2E server runs on port **3001**, separate from the dev server (**3002**) and the production server (**3000**), so `npm run dev` and `npm run test:e2e` can run side by side without conflicts.

**UI selectors**: components use `data-component="..."` attributes instead of `data-testid` for stable test selectors. Playwright and Testing Library are both configured to look for `data-component`.

**Parallel isolation**: the seed data is copied separately for each Playwright worker, so parallel test files can't corrupt each other's data.

#### Running E2E tests locally

```bash
# Run a single spec (always run E2E by file, never all at once: they take too long)
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

Build each platform on that platform: native dependencies (`sharp`, `esbuild`, `node-pty`) are platform-specific, and electron-builder can't cross-compile them from a different OS. `npm run electron:build:all` runs all three build targets on the current host, but only produces a working build for the host's own platform (the native modules for the other platforms aren't available); use separate per-platform CI jobs for real multi-platform releases. Outputs land in `dist-electron/`.

**How the packaged app runs Node:** the packaged app doesn't bundle a separate Node runtime. Production Electron runs its custom server (`dist-server/server.cjs`) by spawning its own Electron binary with `ELECTRON_RUN_AS_NODE=1` (see `electron/main.js`), which makes Electron behave like a plain Node process. The build also disables asar packing (`"asar": false` in `package.json`'s `build` config) so the packaged app's files sit directly on the real filesystem, where normal Node module resolution works.

One consequence of that: Next's build marks the native-addon dependency (`node-pty`) as a server external via a symlink with an absolute path, which doesn't survive being copied into the package. `npm run build:electron` runs `scripts/fix-external-symlinks.mjs` after `next build` to replace that symlink with a portable proxy under `external-shims/` (a generated folder, not checked into git); see that script's comments for the full explanation.

### Release

```bash
# 1. Update teamai/CHANGELOG.md with changes since last release
# 2. Run the release script
./scripts/release.sh 0.2.0

# 3. Push (the tag triggers CI to build installers and create a GitHub Release)
git push origin main && git push origin v0.2.0
```

The CI workflow (`.github/workflows/release.yml`):

- Validates the tag matches `package.json`'s version
- Builds Windows, macOS, and Linux installers in parallel
- Creates a GitHub Release with the changelog section and auto-generated PR notes
- Marks `0.x` versions as prereleases automatically
- Uploads `latest.yml` metadata for [electron-updater](https://www.electron.build/auto-update)'s auto-update support

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

**Pipeline:** each task moves through a configurable series of phases: spec, plan, implement, QA review, and merge. Specialized Claude agents (analyst, planner, coder, qa-reviewer, merger) handle each phase.

**Commands vs. roles:** agent instructions live in two places under `defaults/`, both copied into each project's `.claude/` directory. **Commands** (`commands/*.md`) are the parts the pipeline depends on to actually work: file formats, output formats, and environment rules. These are re-synced into every project automatically (overwriting any local edits), with a banner shown when that happens. **Roles** (`roles/*.md`) are each agent's persona and your project's own conventions. These are set up once and then left for you to customize. You can rewrite a role however you like; the pipeline logic itself lives in the commands, so it won't break.

**ProcessManager:** runs `claude -p --input-format stream-json --output-format stream-json` as a subprocess for each agent. Its output is parsed and streamed to the UI over a WebSocket connection.

**Git worktree isolation:** parallel agents each get their own git worktree (an isolated working copy of the repo) at `worktrees/<task-slug>/`, so they can't step on each other's files.

**Auto mode:** optionally moves tasks through the pipeline automatically: picks up backlog tasks, approves reviews, opens pull requests, checks CI, and merges. This setting survives restarts.

**Recovery:** on startup, TeamAI checks for tasks that were interrupted or sessions that went stale. Sessions that hit a rate limit resume automatically, with a countdown shown in the UI.

**Electron:** in dev mode, press `Ctrl+Shift+U` to simulate an update download, so you can test the update banner without waiting for a real release.

## Configuration

Per-project `.teamai/` directory:

| File | Purpose |
|---|---|
| `providers.json` | LLM backend per role (Anthropic, Bedrock, Vertex, OpenAI, Gemini, Ollama) |
| `pipeline.json` | Phase order and max QA retry attempts |
| `container.json` | Enable/disable Docker devcontainer sandboxing |

Default configs live in `defaults/` and are synced to projects on startup.

## TODO

Features temporarily hidden from the sidebar (routes still exist and can be re-enabled by adding them back to the nav list in `src/components/sidebar.tsx`):

- [ ] **GitHub** (`/github`): import tasks from GitHub issues
- [ ] **Analytics** (`/analytics`): dashboard for agent performance, pipeline bottlenecks, and QA trends
- [ ] **Insights** (`/insights`): pipeline analytics (completion rate, phase distribution) plus a project chat
- [ ] **Ideation** (`/ideation`): scans the codebase for improvements, vulnerabilities, and tech debt

Not yet built:

- [ ] **Remote access & notifications**: Tailscale for remote access to the app; Web Push or a Telegram webhook for review-ready notifications

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). See `teamai/CLAUDE.md` for AI coding guidance and `teamai/AGENTS.md` for dev shortcuts.
