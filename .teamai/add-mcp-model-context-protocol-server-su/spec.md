# Spec: MCP Server Configuration for Pipeline Agents

## Overview

TeamAI pipeline agents run as Claude CLI subprocesses. The Claude CLI natively supports Model Context Protocol (MCP) servers that expose tools to agents — enabling browser automation (Playwright), database queries, GitHub operations, and arbitrary API calls. Today, TeamAI's root `.mcp.json` incidentally supplies the github and playwright servers to all sessions, but there is no per-project configuration, no UI to manage servers, and the config is not reliably propagated to worktree-based sessions. This feature adds a per-project MCP server registry: a settings UI where users add/edit/delete MCP servers, a server actions layer that reads/writes `.mcp.json` in the project root, and a change to `ProcessManager.createSession()` to pass `--mcp-config <absolute-path>` so that agents running in git worktrees still receive the correct server list.

---

## Requirements

1. Per-project MCP configuration is stored at `<projectRoot>/.mcp.json` following the schema `{ "mcpServers": { [name]: { type, command, args, env } } }`, matching the format already used by the Claude CLI and by the root `.mcp.json` in this repo.

2. `ProcessManager.createSession()` accepts an optional `mcpConfigPath: string` parameter and, when provided, appends `--mcp-config <mcpConfigPath>` to the Claude CLI arguments before spawning the subprocess (both native and container modes).

3. The orchestrator passes the resolved `mcpConfigPath` (absolute path to `<projectRoot>/.mcp.json`) to every `createSession()` call when the file exists at that path.

4. `projectStore.scaffold()` creates a minimal `<projectRoot>/.mcp.json` (`{ "mcpServers": {} }`) for newly registered projects when the file does not already exist, mirroring the existing pattern for `pipeline.json` and `providers.json`.

5. A new server actions module `src/app/actions/mcp.ts` exposes `getMcpConfig(): Promise<McpConfig>` and `saveMcpConfig(config: McpConfig): Promise<void>`, following the pattern of `providers.ts`.

6. The Settings page includes a new "MCP Servers" section rendered by a new `McpConfigEditor` component that lists existing servers and provides UI to add, edit, and delete entries.

7. Each MCP server entry in the editor has the following fields: **name** (string, unique identifier), **command** (string, the executable), **args** (string[], one per line or comma-separated), **env** (key-value pairs for environment variables). The `type` field is fixed to `"stdio"` in this version.

8. The editor prevents saving when: (a) any server name is empty, (b) any server command is empty, (c) two entries share the same name. Validation errors are displayed inline.

9. When container mode is enabled, `ProcessManager` translates the `mcpConfigPath` to the container path via `hostToContainerPath` before appending `--mcp-config` to the docker exec command.

10. Changes to `.mcp.json` take effect on the next pipeline session start; running sessions are not affected.

---

## Acceptance Criteria

**AC-1 — Settings UI renders MCP section**
Given a project is active, when the user navigates to `/settings`, then the page contains an "MCP Servers" section below the existing sections.

**AC-2 — Empty state**
Given a project with `{ "mcpServers": {} }`, when the MCP Servers section renders, then it shows a "No MCP servers configured" message and an "Add Server" button.

**AC-3 — Add server and save**
Given the MCP Servers section is open, when the user clicks "Add Server", fills in name=`"my-db"`, command=`"npx"`, args=`["-y","@org/db-mcp"]`, and clicks Save, then `<projectRoot>/.mcp.json` contains a `my-db` entry under `mcpServers` with the correct fields.

**AC-4 — Duplicate name validation**
Given two server entries with the same name `"github"`, when the user clicks Save, then a validation error appears next to the duplicate name field and the file is not written.

**AC-5 — Empty required field validation**
Given a server entry with an empty command field, when the user clicks Save, then an inline error appears on the command field and the file is not written.

**AC-6 — Delete server**
Given a project with a `playwright` server, when the user clicks Delete next to `playwright` and saves, then `.mcp.json` no longer contains `playwright` and the next Claude session spawned for that project does not receive `--mcp-config` pointing to a file with that server.

**AC-7 — ProcessManager passes --mcp-config**
Given `createSession()` is called with `mcpConfigPath: "/path/to/project/.mcp.json"`, when the Claude subprocess is spawned, then its argument list includes `--mcp-config /path/to/project/.mcp.json`.

**AC-8 — ProcessManager skips flag when path absent**
Given `createSession()` is called without `mcpConfigPath`, when the Claude subprocess is spawned, then `--mcp-config` does not appear in its argument list.

**AC-9 — Container mode path translation**
Given container mode is enabled and `mcpConfigPath` is `/host/project/.mcp.json`, when the docker exec command is built, then the `--mcp-config` value is the container-equivalent path (via `hostToContainerPath`), not the host path.

**AC-10 — New project scaffolding**
Given a project path that has no `.mcp.json`, when `projectStore.scaffold()` runs for that project, then `<projectRoot>/.mcp.json` is created containing `{ "mcpServers": {} }`.

**AC-11 — Env vars stored correctly**
Given a server entry with env var `GITHUB_TOKEN=abc123`, when saved, then `.mcp.json` contains `"env": { "GITHUB_TOKEN": "abc123" }` under that server.

**AC-12 — Malformed existing file**
Given `<projectRoot>/.mcp.json` contains invalid JSON, when `getMcpConfig()` is called, then it returns the default empty config `{ "mcpServers": {} }` without throwing.

---

## Files to Modify

| File | Rationale |
|------|-----------|
| `teamai/src/lib/process-manager.ts` | Add `mcpConfigPath?: string` to `createSession` opts; append `--mcp-config` to `claudeArgs` in both native and container branches |
| `teamai/src/lib/project-store.ts` | Scaffold `.mcp.json` for new projects in `scaffold()` |
| `teamai/src/lib/orchestrator.ts` | Resolve `<projectRoot>/.mcp.json` path and pass to `createSession()` calls when the file exists |
| `teamai/src/app/settings/page.tsx` | Import `getMcpConfig`, `McpConfigEditor`; add MCP Servers section |

---

## New Files to Create

| File | Purpose |
|------|---------|
| `teamai/src/app/actions/mcp.ts` | `getMcpConfig` / `saveMcpConfig` server actions; `McpConfig` / `McpServerEntry` TypeScript interfaces |
| `teamai/src/components/mcp-config.tsx` | `McpConfigEditor` client component — list, add, edit, delete MCP server entries with inline validation |
| `teamai/defaults/mcp.json` | Default empty MCP config (`{ "mcpServers": {} }`) used by `scaffold()` |
| `teamai/src/__tests__/mcp-actions.test.ts` | Unit tests for `getMcpConfig` / `saveMcpConfig` including malformed-JSON fallback |
| `teamai/src/__tests__/process-manager-mcp.test.ts` | Unit tests for `--mcp-config` flag presence/absence and container path translation |

---

## Dependencies & Risks

**Claude CLI flag availability**: The `--mcp-config` flag must be available in the installed Claude CLI version. The existing codebase already relies on specific CLI flags (`--input-format stream-json`, `--output-format stream-json`); the MCP config flag is documented in Claude CLI ≥ 1.x. If the flag is absent in the deployed version, sessions will fail with an unrecognised-flag error. Mitigation: document the minimum CLI version requirement in CLAUDE.md.

**Container MCP server availability**: MCP servers configured by the user (e.g., `npx -y @org/my-server`) must be resolvable inside the devcontainer. The container's `postCreateCommand` only installs `playwright-mcp`; custom servers installed via `npx -y` will be fetched at runtime, which requires network access inside the container. No change needed in this feature, but users should be aware.

**No per-phase filtering**: This spec does not add the ability to enable/disable specific MCP servers per pipeline phase. All configured servers are available to all phases. Per-phase filtering is deferred to a future iteration.

**SSE transport**: The `type` field is fixed to `"stdio"` in this version. SSE transport (remote MCP servers over HTTP) is deferred; the schema should remain extensible (keep the `type` field in the stored config).

**Sensitive env vars**: API keys stored in `.mcp.json` are plaintext on disk. This is consistent with how the Claude CLI itself handles MCP env vars. No masking or secrets management is added in this version.

**Backwards compatibility**: Existing projects that already have a hand-crafted `.mcp.json` (e.g., this repo's root) will not be overwritten by `scaffold()` due to the existing `if (!existsSync(dest))` guard.
