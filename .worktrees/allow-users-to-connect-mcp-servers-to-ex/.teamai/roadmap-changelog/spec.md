# Spec: Roadmap & Changelog Page

## Overview

The `/roadmap` page is currently a placeholder stub. This spec defines a fully functional two-tab page that: (1) lets the user trigger the `/roadmap` agent command and stream its output live, (2) reads the persisted `roadmap-{date}.json` artifacts and renders them as a phased card view (Phase 1 Now / Phase 2 Next / Phase 3 Later / Icebox) with an executive summary above, and (3) includes a **Changelog** tab that runs `/changelog`, streams release notes, and persists results as markdown. The implementation reaches feature parity with Aperant's roadmap screen. The user-facing design follows `teamai-ui-spec.md §5d` exactly.

---

## Requirements

1. The roadmap page MUST show a "Generate Roadmap" button that spawns a Claude CLI session with the `/roadmap` command against the active project's working directory.
2. The page MUST offer a "Skip competitor research" checkbox that, when checked, appends `--skip-competitors` to the command sent via `processManager.sendMessage`.
3. While the agent is running, the page MUST stream live output in a scrollable pre-formatted block matching the IdeationScanner pattern: `useSessionStream` hook, accumulate latest text from `event.type === 'assistant'` messages.
4. The "Generate Roadmap" button MUST be disabled and show "Generating…" while a run is in progress (`running && !done`); after completion it returns to "Generate Roadmap".
5. When the agent emits a `result` event the run is considered complete; the UI MUST automatically load and display the phased roadmap view by calling `getRoadmapReports()` and then `getRoadmapReport()` on the newest entry.
6. The phased roadmap view MUST group items into four collapsible sections rendered top-to-bottom: **Phase 1 — Now**, **Phase 2 — Next**, **Phase 3 — Later**, **Icebox**. Each section header MUST show the item count.
7. An **executive summary** paragraph MUST be rendered above the four phase sections, sourced from `RoadmapReport.executive_summary`.
8. Each roadmap item card MUST display: title (bold `text-sm`), priority badge (P0–P3), complexity visualization (5 filled/empty dots), category label (right-aligned `text-xs`), description (`text-xs text-slate-600 dark:text-slate-400`), source label ("ideation" | "competitor-analysis", italic), and competitive context when present.
9. Priority badges MUST be color-coded: P0=red, P1=orange, P2=amber, P3=gray. Colors MUST work in both light and dark mode.
10. A **History** dropdown MUST list all `roadmap-{date}.json` files (newest first) found via `getRoadmapReports()`; selecting one renders that report immediately without spawning a new agent session.
11. The page MUST include a **Changelog** tab alongside the Roadmap tab. The Changelog tab MUST have a "Generate Changelog" button that spawns a session with `/changelog` and streams its output.
12. Changelog output MUST be persisted to `.teamai/roadmap/changelog-{date}.md` (written by the updated `defaults/commands/changelog.md`); the UI reads this file after the `result` event and renders it as formatted markdown using `prose` Tailwind classes.
13. A **Previous changelogs** dropdown on the Changelog tab MUST list `changelog-{date}.md` files newest-first via a `getChangelogReports()` server action; selecting one loads that file's contents without re-running.
14. If no active project is selected, both tabs MUST show the message: "Select or add a project from the sidebar to get started." (same as other pages).
15. If no roadmap has been generated yet, the Roadmap tab MUST show: "No roadmap generated yet. Click 'Generate Roadmap' to start."
16. If no changelog has been generated yet, the Changelog tab MUST show: "No changelog generated yet. Click 'Generate Changelog' to start."
17. The page MUST support dark mode using the existing `bg-white dark:bg-slate-900` (page root) / `bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700` (card/block areas) pattern.
18. Server action `startRoadmapGeneration(skipCompetitors: boolean): Promise<string>` MUST create a session via `processManager.createSession` with `taskId: \`roadmap::${projectPath}\`` and send the appropriate command — mirroring `startIdeationScan`.
19. Server action `startChangelogGeneration(): Promise<string>` MUST create a session with `taskId: \`changelog::${projectPath}\`` and send `/changelog`.
20. Server action `getRoadmapReports(): Promise<{ filename: string; date: string }[]>` MUST read `.teamai/roadmap/`, filter `roadmap-*.json` files, and return them sorted newest-first.
21. Server action `getRoadmapReport(filename: string): Promise<RoadmapReport>` MUST validate the filename matches `/^roadmap-\d{4}-\d{2}-\d{2}\.json$/` before reading from disk, and MUST normalize both flat-array and nested-phases JSON shapes to `RoadmapReport`. If JSON parsing fails, it MUST throw a typed error (not silently return empty data).
22. Server action `getChangelogReports(): Promise<{ filename: string; date: string }[]>` MUST read `.teamai/roadmap/`, filter `changelog-*.md` files, and return them sorted newest-first.
23. Server action `getLatestChangelog(filename: string): Promise<string>` MUST validate filename matches `/^changelog-\d{4}-\d{2}-\d{2}\.md$/` and return raw markdown content.
24. Server action `getActiveRoadmapSession(type: 'roadmap' | 'changelog'): Promise<string | null>` MUST look up `global.__roadmapSessions` (keyed by `\`${type}::${projectPath}\``) and return the session ID if `processManager.getSession(id)?.status === 'running'`, otherwise `null`. This enables reconnect on page mount.
25. `defaults/commands/changelog.md` MUST be updated: (a) fix typo "changog" → "changelog" in the print step; (b) add a step that writes the changelog to `.teamai/roadmap/changelog-{date}.md` before printing to stdout.
26. `defaults/commands/roadmap.md` MUST be updated: (a) fix typo "pority" → "priority" in §3b; (b) add `category` field to the roadmap item definition in §3b.
27. On page mount, if `roadmap-{date}.json` files exist in `.teamai/roadmap/`, the most recent one MUST be automatically loaded and rendered in the phased view without spawning an agent session.
28. On page mount (or when the Changelog tab first becomes active), if `changelog-{date}.md` files exist in `.teamai/roadmap/`, the most recent one MUST be automatically loaded and rendered without spawning an agent session.
29. On `RoadmapView` mount, the component MUST call `getActiveRoadmapSession('roadmap')` (and similarly for changelog). If a session ID is returned, the component MUST initialize `useSessionStream` with that ID, set `running = true`, and resume displaying live output.

---

## Acceptance Criteria

### AC1 — Generate button triggers agent
**Given** a project is active and no generation is in progress,
**When** the user clicks "Generate Roadmap" (optionally with "Skip competitor research" checked),
**Then** a Claude CLI session is spawned, `sendMessage` sends `/roadmap` or `/roadmap --skip-competitors`, and the button shows "Generating…" (disabled).

### AC2 — Live streaming output
**Given** a roadmap generation is running,
**When** the agent emits assistant text events via WebSocket,
**Then** the latest text appears in a scrollable `<pre>` block (`text-xs font-mono`) in real time; earlier intermediate outputs may be replaced by the final streamed text (same behavior as IdeationScanner).

### AC3 — Phased view renders after completion
**Given** the agent completes and writes `roadmap-{date}.json`,
**When** the `result` event arrives,
**Then** the UI automatically calls `getRoadmapReports()` + `getRoadmapReport()`, and renders the executive summary plus four phase sections with all item card fields visible.

### AC4 — Executive summary visible
**Given** a roadmap report is loaded,
**When** the user views the Roadmap tab,
**Then** the `executive_summary` string is rendered as a paragraph above Phase 1.

### AC5 — Priority color coding
**Given** a phased roadmap view is displayed,
**When** the user views roadmap item cards in any lighting mode,
**Then** P0 badge is red, P1 is orange, P2 is amber, P3 is gray — consistent between light and dark themes.

### AC6 — Complexity dots
**Given** a roadmap item card with a complexity value of N (1–5),
**When** the card is displayed,
**Then** N filled dots (●) followed by (5−N) empty dots (○) are shown.

### AC7 — History selector
**Given** multiple `roadmap-{date}.json` files exist,
**When** the user opens the History dropdown and selects a past date,
**Then** the phased view updates to show that run's items without spawning any agent session.

### AC8 — Changelog generation and streaming
**Given** the Changelog tab is active and no generation is running,
**When** the user clicks "Generate Changelog",
**Then** a session runs `/changelog`, streaming output appears in the same pre-block pattern as Roadmap, and on completion the rendered markdown is shown.

### AC9 — Changelog persistence across navigation
**Given** a changelog was previously generated,
**When** the user navigates away and returns to the Changelog tab,
**Then** the most recent `changelog-{date}.md` is loaded and rendered without re-running the agent.

### AC10 — Previous changelogs selector
**Given** multiple `changelog-{date}.md` files exist,
**When** the user selects a past date from the "Previous changelogs" dropdown,
**Then** that changelog's markdown is displayed without spawning an agent.

### AC11 — No active project empty state
**Given** no project is selected,
**When** the user visits `/roadmap` on either tab,
**Then** both tabs show "Select or add a project from the sidebar to get started."

### AC12 — No roadmap empty state
**Given** a project is active but `.teamai/roadmap/` contains no `roadmap-*.json` files,
**When** the user views the Roadmap tab,
**Then** the message "No roadmap generated yet. Click 'Generate Roadmap' to start." is shown.

### AC13 — Dark mode
**Given** dark mode is enabled,
**When** the user views the roadmap page in any state (empty, streaming, phased view, changelog),
**Then** all backgrounds, text, borders, priority badges, and dots render correctly in dark mode.

### AC14 — Path traversal prevention
**Given** a malicious filename such as `../../../../etc/passwd` is passed to `getRoadmapReport` or `getLatestChangelog`,
**When** the server action validates the filename,
**Then** it throws a typed error without reading any file outside `.teamai/roadmap/`.

### AC15 — Roadmap auto-load on mount
**Given** a project is active and `roadmap-{date}.json` files exist in `.teamai/roadmap/`,
**When** the user navigates to the `/roadmap` page,
**Then** the most recent roadmap report is automatically loaded and the phased view is rendered without clicking "Generate Roadmap".

### AC16 — In-flight roadmap session reconnect
**Given** a roadmap generation was started and the user navigated away mid-run,
**When** the user returns to `/roadmap`,
**Then** `getActiveRoadmapSession('roadmap')` returns the active session ID, `useSessionStream` connects to it, and live output continues displaying.

### AC17 — In-flight changelog session reconnect
**Given** a changelog generation was started and the user navigated away mid-run,
**When** the user returns to `/roadmap` and switches to the Changelog tab,
**Then** `getActiveRoadmapSession('changelog')` returns the active session ID and live output continues.

---

## Files to Modify

| File | Rationale |
|---|---|
| `teamai/src/app/roadmap/page.tsx` | Replace placeholder stub with full two-tab roadmap+changelog page |
| `teamai/defaults/commands/changelog.md` | Add file-write step; fix "changog" typo |
| `teamai/defaults/commands/roadmap.md` | Add `category` field to §3b item schema; fix "pority" → "priority" typo |
| `teamai-ui-spec.md` | Add `getActiveRoadmapSession` to server actions table in §5d |

---

## New Files to Create

| File | Purpose |
|---|---|
| `teamai/src/app/actions/roadmap.ts` | Server actions: `startRoadmapGeneration`, `startChangelogGeneration`, `getRoadmapReports`, `getRoadmapReport`, `getChangelogReports`, `getLatestChangelog`, `getActiveRoadmapSession`. Uses `global.__roadmapSessions` pattern. |
| `teamai/src/components/roadmap-view.tsx` | `'use client'` component — tabs, generate buttons, streaming block, phased card view, history selectors, changelog markdown, auto-load on mount, session reconnect via `getActiveRoadmapSession` |

---

## Roadmap JSON Schema

The `/roadmap` command writes `roadmap-{date}.json`. The `getRoadmapReport` action normalizes it before handing it to the client. Expected shape:

```typescript
export interface RoadmapItem {
  title: string;
  priority: 'P0' | 'P1' | 'P2' | 'P3';
  complexity: 1 | 2 | 3 | 4 | 5;
  category: 'Critical Fix' | 'Security' | 'Performance' | 'DX' | 'New Feature' | 'Competitive Response' | 'Infrastructure';
  description: string;
  affected_files: string[];
  source: 'ideation' | 'competitor-analysis';
  competitive_context?: string;
}

export interface RoadmapReport {
  generated_at: string;           // ISO date string
  executive_summary: string;
  competitor_analysis_run: boolean;
  phases: {
    now: RoadmapItem[];           // Phase 1: P0 + quick P1 (complexity ≤ 2)
    next: RoadmapItem[];          // Phase 2: remaining P1 + high-impact P2
    later: RoadmapItem[];         // Phase 3: P2 + P3
    icebox: RoadmapItem[];
  };
}
```

`getRoadmapReport` MUST handle two fallback shapes:
1. **Flat array**: `{ items: RoadmapItem[] }` — partition into phases using priority/complexity rules.
2. **Phase field on items**: `{ items: (RoadmapItem & { phase: 'now'|'next'|'later'|'icebox' })[] }` — group by `item.phase`.

If JSON parsing throws, the action must re-throw with message `"Malformed roadmap JSON: ${filename}"`.

---

## Dependencies & Risks

### External Dependencies
- **ProcessManager** (`src/lib/process-manager.ts`) — `createSession` and `sendMessage` are already implemented; no changes needed.
- **`useSessionStream` hook** (`src/hooks/use-session-stream.ts`) — reuse without modification.
- **`/roadmap` command** — exists in `defaults/commands/roadmap.md`; must be updated for `category` field.
- **`/changelog` command** — exists but only prints to stdout; must be updated to also write a file (Req 25).

### Schema Risk — Category Field Gap
`defaults/commands/roadmap.md` §3b is missing the `category` field in its item definition (and has a typo "pority"). The command MUST be updated to include `category` in the output, otherwise the agent will not emit it and card rendering will fall back to an empty label. This is a **blocker for AC3** — `category` display is required by the UI spec. **Already-scaffolded projects** will need their `.claude/commands/roadmap.md` updated manually or via a future "Reset to Default" per-command action in Settings.

### Reconnect Mechanism
The `getActiveRoadmapSession` server action checks `global.__roadmapSessions` (same pattern as `global.__ideationSessions`). On page mount, the React component calls this action and initializes the stream hook with the returned session ID if non-null. The server map uses keys `roadmap::<projectPath>` and `changelog::<projectPath>` to avoid collisions.

### Changelog Command File Propagation
Adding a write step to `defaults/commands/changelog.md` is non-breaking for all future scaffolds, but already-scaffolded project `.claude/commands/changelog.md` files will NOT be automatically updated. Document as a tooltip on the Changelog tab: "Note: if your project's changelog command predates this update, check `.claude/commands/changelog.md` and verify it writes output to `.teamai/roadmap/`."

### Tailwind Typography Plugin Not Installed
`@tailwindcss/typography` (`prose` classes) is **not** in `teamai/package.json`. The changelog tab MUST fall back to a `<pre className="whitespace-pre-wrap font-mono text-xs">` block for markdown rendering — do not install the plugin as part of this feature. The `prose` mention in `teamai-ui-spec.md §5d` is aspirational; `<pre>` is the correct implementation choice for now.

### Breaking Changes
None. The roadmap page is a placeholder with no existing users or callers. All new code is additive.

### Path Traversal
`getRoadmapReport(filename)` and `getLatestChangelog(filename)` accept user-supplied filenames. Both MUST validate against strict regex patterns before calling `readFileSync`. Rejection MUST throw (not silently return empty).

---

## Out of Scope (Future)

- Import individual roadmap items as Kanban tasks.
- Diff view between two roadmap runs.
- Roadmap item status tracking (done / in-progress / not-started).
- Competitor analysis structured panel (agent streams it as text; no separate card rendering needed).
- Auto-refresh: polling for new reports while the page is open but no session is active.
- "Reset to Default" per-command in Settings (to update already-scaffolded `changelog.md` files).
