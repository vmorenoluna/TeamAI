# TeamAI

TeamAI is a desktop app that runs several [Claude Code](https://docs.anthropic.com/en/docs/claude-code) agents at once, each handling one step of building software: writing a spec, planning the work, writing the code, reviewing it, and merging it. Built with Electron, it runs as a regular desktop app on Windows, macOS, and Linux.

![TeamAI kanban board](docs/images/board.jpg)

## Features

### In the app

| Section | Route | Description |
|---|---|---|
| **Kanban** | `/` | Drag-and-drop task board covering all pipeline phases, with task detail, review, and retry actions |
| **Workflow** | `/workflow` | How tasks advance through spec → plan → implement → QA review → merge |
| **Terminals** | `/terminals` | Live terminal output from every agent session |
| **Roadmap** | `/roadmap` | Long-horizon roadmap planning |
| **Settings** | `/settings` | LLM providers, pipeline phases, auto mode, and the Role Refinement Assistant |

### How it works

- **Multi-agent pipeline**: specialized Claude agents (analyst, planner, coder, qa-reviewer, merger) move each task through spec, plan, implement, QA review, and merge.
- **Auto Mode**: picks up backlog tasks, approves reviews for you, opens pull requests, checks CI, and merges once everything passes. Survives restarts.
- **Role Refinement Assistant**: when a task fails, it studies what went wrong and suggests fixes to the agents' instructions. Optional auto-apply and auto-retry make it fully hands-off.
- **Git worktree isolation**: each agent works in its own copy of your repo, so parallel agents never conflict.
- **Multi-project support**: manage several codebases from one window. Each project keeps its settings in `.teamai/` and its agent config in `.claude/`.
- **Crash recovery**: interrupted tasks and rate-limited sessions resume automatically.
- **Self-maintaining backlog**: every agent that can file tickets judges the whole open board first, and the orchestrator verifies it did. Duplicates aren't filed. Tickets a task makes obsolete are held back and then deleted. Tickets whose premise a task changes wait and are re-specced. Agent-filed tickets are verified by the analyst before any work is planned. See `teamai/adr/010-verified-backlog-check.md`.

## Install

Download a build from [Releases](https://github.com/vmorenoluna/TeamAI/releases): Windows (`.exe` installer), macOS (`.dmg`, Apple Silicon), or Linux (`.AppImage`). See [Auto-Updates](#auto-updates) for which platforms update themselves, and for the first-launch warnings you'll see on unsigned builds.

To run from source instead, see [Quick Start](#quick-start).

### Requirements

Needed no matter how you install:

- **A Claude account** (or a Claude API key). TeamAI drives its agents through the `claude` command-line tool; without an account, nothing runs.
- **Claude Code CLI**: install it with `npm install -g @anthropic-ai/claude-code`
- **Git**
- **Docker** (optional): only if you want agent sessions to run sandboxed in a container

Only needed for building from source:

- **Node.js** version 20 or newer

## Safety & Privacy

Agents run shell commands with the same file access as your user account. That's deliberate: an autonomous coding agent needs that access to edit files, run tests, and use git. Everything happens locally, and nothing is sent anywhere except to the LLM provider you've configured.

Pointing TeamAI at a repository you don't fully trust? Turn on the Docker sandbox (`container.json`, see [Configuration](#configuration)) so agent sessions run isolated from your normal file system.

## Quick Start

```bash
git clone https://github.com/vmorenoluna/TeamAI.git
cd TeamAI

# Set up git hooks
git config core.hooksPath .husky

# Install and run
cd teamai
npm install
npm run dev           # dev server on :3002
npm run electron:dev  # in a second terminal: launch the Electron app
```

Open `http://localhost:3002` in a browser or use the Electron app. Both connect to the same dev server.

### Demo Project

A demo project (`demo/`) ships with tasks already seeded across every pipeline phase, handy for exploring the UI without setting up a real project. It's included automatically whenever the app runs in development (`npm run dev` or `npm run electron:dev`). Production runs leave it out, so it never clutters a real install; add any folder as a project with the "+" button in the project selector instead.

## Auto-Updates

Packaged builds from [Releases](https://github.com/vmorenoluna/TeamAI/releases) check for updates where supported. Unsigned macOS builds cannot use the in-app updater; download each new macOS release manually. Not every platform supports automatic updates:

| Platform | Format | Auto-updates? |
|---|---|---|
| Windows | NSIS installer (`.exe`) | ✅ |
| Windows | Portable zip | ❌ (re-download manually) |
| macOS (unsigned, Apple Silicon) | `.dmg` / `.zip` | ❌ (download each release manually) |
| Linux | AppImage | ✅ |

Builds aren't code-signed or notarized yet, so macOS may block the first launch. macOS builds are for Apple Silicon (M-series) Macs; Intel Macs are not supported yet. Unsigned builds do not support in-app updates; download new releases manually.

- **Windows**: SmartScreen. Click "More info", then "Run anyway".
- **macOS — unidentified developer / Apple can't check the app**: Control-click the app and choose **Open**, then confirm.
- **macOS — “TeamAI is damaged and can't be opened. You should move it to the Bin/Trash”**: this can occur with downloaded unsigned builds, but can also indicate that the app was altered or corrupted. Only if you downloaded it from the official [TeamAI Releases](https://github.com/vmorenoluna/TeamAI/releases) page and trust that copy, you can try removing the quarantine attribute from that one app bundle in Terminal:

  ```bash
  sudo xattr -dr com.apple.quarantine "/Applications/TeamAI.app"
  ```

  If you installed TeamAI somewhere else, replace the path with the actual `TeamAI.app` location. This removes macOS quarantine metadata from that app bundle; it does **not** verify the download, sign or notarize the app, or make other apps trusted. Do not disable Gatekeeper globally. If the app still will not open, stop and contact the project maintainer rather than bypassing additional security checks.

A proper fix for these warnings is Developer ID code signing and Apple notarization; until those are configured, these manual steps may be needed for each downloaded release.

## Development

All commands run from `teamai/`.

### Everyday commands

| Command | Description |
|---|---|
| `npm run dev` | Next.js dev server with HMR |
| `npm run electron:dev` | Launch the Electron app against the dev server |
| `npm run start` | Production server |
| `npm run electron:start` | Electron app in production mode |
| `npm run lint` | ESLint with zero warnings enforced |
| `npm run typecheck` | TypeScript checking (`tsc --noEmit`) |

### Testing

| Command | Description |
|---|---|
| `npm test` | All unit + integration tests (Vitest) |
| `npm run test:unit` | Unit tests only |
| `npm run test:integration` | Integration tests only |
| `npm run test:e2e` | Playwright E2E tests |
| `npm run test:all` | Full suite: typecheck, lint, vitest, e2e, changelog |
| `npm run test:watch` | Vitest in watch mode |

**How the tests work**: unit and integration tests (Vitest, `tests/unit/` and `tests/integration/`) mock the Claude CLI and Docker. E2E tests (Playwright, `tests/e2e/`) run against a server loaded with fixed sample data, so they're fast and need no API keys. They cover everything the UI does (board, task detail, settings, terminals, drag-and-drop, and more) but not real agent runs. The E2E server uses port **3001**, so it can run next to dev (**3002**) and production (**3000**). Components use `data-component` attributes as stable test selectors.

```bash
# Run a single E2E spec (run by file: the full E2E suite is slow)
npx playwright test tests/e2e/kanban-behaviors.spec.ts

# Full CI-equivalent suite
npm run test:all
```

### Building

| Command | Description |
|---|---|
| `npm run build` | Production Next.js build |
| `npm run build:server` | Bundle the custom server with esbuild |
| `npm run electron:build` | Windows installer (NSIS + zip) |
| `npm run electron:build:mac` | macOS installer (DMG + zip) |
| `npm run electron:build:linux` | Linux package (AppImage) |
| `npm run electron:build:all` | All three targets on this machine |

Build each platform on that platform: native dependencies (`sharp`, `esbuild`, `node-pty`) can't be cross-compiled, so `electron:build:all` only produces a working build for the host OS. Use separate per-platform CI jobs for real multi-platform releases. The build also replaces Next's absolute-path symlink for `node-pty` with a portable proxy under `external-shims/` so the packaged app can resolve it. Outputs land in `dist-electron/`.

### Release

```bash
# 1. Update teamai/CHANGELOG.md with changes since the last release
# 2. Bump the version and tag
./scripts/release.sh 0.2.0

# 3. Push: the tag triggers CI to build installers and create the GitHub Release
git push origin main && git push origin v0.2.0
```

CI (`.github/workflows/release.yml`) validates the tag, builds all three platforms in parallel, creates the GitHub Release with changelog notes, and uploads `latest.yml` for [electron-updater](https://www.electron.build/auto-update).

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

| File | Purpose                                                      |
|---|--------------------------------------------------------------|
| `providers.json` | LLM backend per role (only Anthropic is currently supported) |
| `pipeline.json` | Phase order, max QA retry attempts, and the backlog check (`backlogCheck`, `backlogCheckEvidencePaths`; see ADR 010) |
| `container.json` | Enable/disable Docker devcontainer sandboxing                |

Default configs live in `defaults/` and are synced to projects on startup.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). See `teamai/CLAUDE.md` for AI coding guidance and `teamai/AGENTS.md` for dev shortcuts.
