# TeamAI — UI Specification & User Journeys

> Design reference for Google Stitch iteration.  
> Describes every screen, component, and click-by-click user flow.

---

## 1. Application Shell

### Layout
The app has a two-column shell that fills the entire viewport:

```
┌─────────────────────────────────────────────────────────┐
│  SIDEBAR (240px)  │  MAIN CONTENT (flex-1)              │
│                   │                                     │
│  TeamAI logo      │  Page content varies by route       │
│  Collapse ←       │                                     │
│  ─────────────    │                                     │
│  PROJECTS         │                                     │
│  · Sample-project   ×    │                                     │
│  · TeamAI    ×    │                                     │
│  + Add            │                                     │
│  ─────────────    │                                     │
│  ☾ Dark mode      │                                     │
│  ▦ Kanban         │                                     │
│  ◎ Insights       │                                     │
│  ◈ Ideation       │                                     │
│  ▶ Terminals      │                                     │
│  ◉ Roadmap        │                                     │
│  ⚙ Settings       │                                     │
└─────────────────────────────────────────────────────────┘
```

### Sidebar — Expanded State
- **Header**: "TeamAI" branding + `←` collapse button
- **Projects section**: label "PROJECTS" + "+ Add" button; list of added projects, each with a name button (activates it) and `×` remove button; active project is visually highlighted
- **Navigation**: vertical list of icon + label links; dark mode toggle at top; active link is highlighted

### Sidebar — Collapsed State
- Sidebar narrows to ~48px icon strip
- Header shows only `→` expand button
- Navigation shows icon-only buttons (no labels)
- Projects list is hidden
- More horizontal space for main content — board shows more columns

### Dark Mode Toggle
- Button at top of nav: `☾ Dark mode` (when in light mode) / `☀ Light mode` (when in dark mode)
- Clicking toggles the entire app's color scheme
- Preference persisted to `localStorage` — survives page reload
- No flash on load (inline `<script>` applies class before paint)
- Sidebar background always stays dark regardless of mode

---

## 2. Pages / Routes

| Route | Page | Description |
|---|---|---|
| `/` | Kanban Board | Main working view |
| `/insights` | Insights | Chat with Claude about the active codebase |
| `/ideation` | Ideation | AI brainstorming for new tasks |
| `/terminals` | Terminals | Interactive PTY Claude sessions pre-loaded with a role persona |
| `/roadmap` | Roadmap | Two-tab view: Roadmap (phased AI-generated items) + Changelog (release notes from git history) |
| `/settings` | Settings | Project configuration: container isolation, pipeline phases, providers, agent roles |

---

## 3. Kanban Board (`/`)

### Empty state (no project selected)
- Centered message: "Select or add a project from the sidebar to get started."

### Board header
- Left: "Board" heading
- Right: "+ New Task" button (dark pill)

### Columns
Nine fixed columns in order, each 240px wide, scrollable horizontally:

| Column | Phase value(s) |
|---|---|
| Backlog | `backlog` |
| Spec | `spec` |
| Planning | `plan` |
| In Progress | `implement` |
| QA | `qa-review`, `qa-fix` |
| Review | `awaiting-review` |
| Merging | `merge`, `create-pr` |
| Failed | `failed` |
| Done | `done` |

Each column has:
- Header: uppercase label + count badge
- Scrollable card list

### Task Card
```
┌──────────────────────────────────┐
│  Task title text            [▶]  │  ← play button (only if interrupted)
│  Description preview…  more      │  ← truncated at 80 chars; "more/less" toggle
│  [PHASE badge]       4d ago      │
│  ● moving                        │  ← blue pulsing dot (only during drag transition)
└──────────────────────────────────┘
```

- **Play button** `▶`: green circle overlay, top-right corner. Only shown on tasks that were interrupted mid-pipeline (process crashed / app restarted). Clicking resumes the pipeline immediately without opening the panel.
- **Phase badge**: color-coded pill per phase (blue=spec, indigo=plan, amber=implement, orange=qa, purple=awaiting-review, teal=merge, red=failed, green=done)
- **Timestamp**: relative time since creation ("just now", "4m ago", "2h ago", "3d ago")
- **Moving indicator**: blue pulsing dot + "moving" label appears on the card after a drag-and-drop until the WebSocket confirms the phase change. Card shows `pointer-events-none` and reduced opacity during transition.
- **Clicking the card body** opens the Task Detail Panel

### Drag-and-Drop

Tasks can be dragged from any column to any other column. On drop, the orchestrator determines the correct pipeline starting phase based on existing artifacts:

| Drop target | Prerequisites checked | Behavior |
|---|---|---|
| Backlog / Review / Failed / Done | None | Phase updates immediately; no pipeline spawned |
| Spec | None | Clears stale spec.md; runs spec from scratch |
| Planning | spec.md exists? | Runs Planning if spec exists, else starts from Spec |
| In Progress | plan.json exists? | Runs Implement if plan exists, else starts from Plan (or Spec) |
| QA | plan.json exists? | Clears QA artifacts; runs Implement if plan exists, else falls back |
| Merging | worktree + branch exist? | Merges if both exist; falls back to Implement → Plan → Spec as needed |

**Pipeline cancellation**: If a task is already mid-pipeline when dropped again, the running session is killed before starting the new one — no duplicate agents.

**Optimistic UI**: The card immediately appears in the target column on drop. A 10-second safety timeout clears the optimistic placement if the WebSocket confirmation never arrives. When the server confirms via WebSocket `phase-change`, the card transitions from optimistic to confirmed (pulse animation stops, moving indicator disappears).

**Visual feedback during drag**:
- **Dragged card**: `opacity-40` + `scale-95` — visually lifts out of the source column
- **Valid drop target column**: blue background glow (`ring-2 ring-blue-400`) + slight scale up (`scale-[1.02]`), count badge turns blue — only if the target is a different column
- **Same column**: no glow effect (drop to same column is a no-op)
- **Moving card**: `animate-pulse` on the card wrapper + blue pulsing dot + "moving" label until WebSocket confirms
- **Cursor**: `cursor: grab` on all draggable cards

---

## 4. New Task Modal

Triggered by: "+ New Task" button in board header.

```
┌─────────────────────────────────────────┐
│  New Task                               │
│                                         │
│  Title *                                │
│  [________________________________]     │
│                                         │
│  Description                            │
│  [________________________________]     │
│  [                                ]     │
│  [________________________________]     │
│                                         │
│  Reference images (optional)            │
│  [Choose Files]  No file chosen         │
│                                         │
│                   [Cancel] [Create Task]│
└─────────────────────────────────────────┘
```

- Backdrop: semi-transparent black overlay; clicking it cancels
- Title field: required
- Description field: multi-line textarea
- Reference images: multi-file image upload (accepts `image/*`)
- "Create Task" button: disabled + shows "Creating..." while submitting
- On success: modal closes, board refreshes, new task appears in Backlog column

---

## 5. Task Detail Panel

Clicking a task card opens a split-view panel on the right. The kanban board compresses to ~55% width; the panel takes ~45%.

```
┌──────────────────────────────────────────────────────────┐
│  KANBAN (55%)           │  TASK PANEL (45%)              │
│                         │  ─────────────── [×]           │
│  [board columns...]     │  ← Board        [PHASE BADGE]  │
│                         │  Task Title                    │
│                         │  Description text              │
│                         │  Created … · Updated …         │
│                         │  Agent: [Auto (pipeline) ▾]    │
│                         │  ────────────────────────────  │
│                         │  Overview Terminal Spec Plan QA│
│                         │  ────────────────────────────  │
│                         │  [tab content]                 │
└──────────────────────────────────────────────────────────┘
```

### Panel Header
- `×` close button (top-right strip) — collapses panel, restores full-width kanban
- `← Board` breadcrumb link
- Phase badge (color-coded, same as card)
- Task title (large heading)
- Description text
- Created / Updated timestamps
- **Agent dropdown**: "Auto (pipeline default)" or any named role — overrides which AI agent persona handles the next pipeline step for this task. Options: Product Analyst, Senior Developer, Git Integration Specialist, Implementation Planner, Bug Fix Specialist, QA Reviewer

### Tabs

#### Overview tab
Default tab. Content varies by task phase:

**All tasks — Dependencies section:**
```
[+ Depends on]  [+ Blocks]

DEPENDS ON
  [Task name]  [PHASE]  ×

BLOCKS
  [Task name]  [PHASE]  ×

No dependencies set.   ← shown when empty
```
- "+ Depends on" opens a searchable picker showing all other tasks; selecting one links them bidirectionally
- "+ Blocks" opens the same picker but sets the reverse relationship
- Pills show the linked task name + its phase badge; hover reveals `×` to remove
- Removing from either side automatically updates both tasks

**Awaiting-review tasks — Review panel (shown above dependencies):**
```
┌─────────────────────────────────────────────────────┐
│  QA Report — ✓ PASS                            [▾]  │
├─────────────────────────────────────────────────────┤
│  Spec                                          [▾]  │
├─────────────────────────────────────────────────────┤
│  [Merge Locally]  [Open Pull Request]  [Reject...]  │
└─────────────────────────────────────────────────────┘
```
- Collapsible "QA Report" section (✓ PASS or ✗ FAIL)
- Collapsible "Spec" section
- Three action buttons:
  - **Merge Locally** (green): merges the worktree branch into the main branch
  - **Open Pull Request** (blue): creates a GitHub PR
  - **Reject with Feedback** (gray): sends feedback back to the agent and re-queues

**Rate-limited tasks — Amber banner:**
```
⚠ Rate limited · Retrying at 3:45 PM
```
Shown when Claude API rate limit was hit; app auto-retries at the displayed time.

#### Terminal tab
- Full-height xterm.js terminal
- Header: "AGENT OUTPUT  N events"
- Shows live streaming output from the Claude CLI subprocess as it runs
- Replays buffered events when switching to this tab
- Empty when no pipeline has run yet for this task

#### Spec tab
- Renders the `spec.md` file content for this task
- Monospace font, full scrollable text
- Badge on tab shows "1" when spec exists

#### Plan tab
- Renders `plan.json` as formatted text
- Empty when no plan generated yet

#### QA tab
- Renders `qa_report.json`
- Badge on tab shows "1" when QA report exists

---

## 5a. Ideation Page (`/ideation`)

Header: "Ideation" title + "Scan the codebase for improvements, vulnerabilities, and tech debt." subtitle.

Below: `IdeationScanner` component:
- **"Run Scan"** button — triggers a Claude agent scan of the active codebase
- While scanning: button changes to "Scanning…" (disabled)
- After scan: results appear in a scrollable monospace pre-formatted block; "Scan complete" badge shown
- Empty state: "Click 'Run Scan' to analyse the codebase."

Dark mode: `bg-white dark:bg-slate-900` on page root; result block uses `bg-slate-50 dark:bg-slate-900` with border.

---

## 5b. Insights Page (`/insights`)

Header: "Insights" title + "Chat with Claude about the active project." subtitle.

Below: full-height chat interface (`InsightsChat` component):
- **Message area**: scrollable list of chat bubbles. User messages are dark pill (right-aligned); assistant replies are light card with border (left-aligned). Streaming replies show an animated cursor.
- **Input bar** (pinned bottom): multi-line textarea + "Send" button. Press Enter to send (Shift+Enter for new line). Placeholder: "Ask about the codebase… (Enter to send)". Disabled while connecting or waiting for response.

Dark mode: `bg-white dark:bg-slate-900` on root; input area has a top border separator.

---

## 5c. Terminals Page (`/terminals`)

Header: "Terminals" title + subtitle + **"+ New Terminal"** button (top-right).

Clicking "+ New Terminal" opens a modal:
- **Role** dropdown (all available agent roles)
- **Model** text field (optional override, defaults to project provider setting)
- Cancel / Open buttons

Once opened, terminals appear in a responsive grid (1 column for 1 terminal, 2 columns for 2+). Each terminal panel is a dark xterm.js instance pre-loaded with the chosen role's system prompt. Multiple terminals can run simultaneously.

Dark mode: `bg-slate-50 dark:bg-slate-950` on root content area; terminal panels are always `bg-slate-950` (terminals are inherently dark).

---

## 5d. Roadmap Page (`/roadmap`)

Two-tab layout: **Roadmap** and **Changelog**.

Dark mode: `bg-white dark:bg-slate-900` on page root; card areas use `bg-slate-50 dark:bg-slate-900` with border.

Spec: `.teamai/roadmap-changelog/spec.md`

### Page Header
```
┌──────────────────────────────────────────────────────────┐
│  Roadmap  │  Changelog                                   │
│  ─────────────────────────────────────────────────────── │
│  [tab content area]                                      │
└──────────────────────────────────────────────────────────┘
```

No active project → both tabs show: "Select or add a project from the sidebar to get started."

---

### Roadmap Tab

#### Controls bar (top)
```
☐ Skip competitor research        [Generate Roadmap ▶]

History: [Select a previous run ▾]
```
- **Skip competitor research** checkbox: when checked, appends `--skip-competitors` to the `/roadmap` command sent to the agent.
- **"Generate Roadmap"** button: dark pill (same style as "Run Scan" in Ideation). While running, shows "Generating…" (disabled). Returns to "Generate Roadmap" after completion.
- **History dropdown**: populated by `getRoadmapReports()` — lists `roadmap-{date}.json` files newest-first. Selecting one calls `getRoadmapReport(filename)` and renders that report without spawning a new session.

#### Empty state (no report generated)
```
No roadmap generated yet. Click 'Generate Roadmap' to start.
```

#### Streaming output (while agent is running)
Scrollable pre-formatted block identical to IdeationScanner — latest text from `event.type === 'assistant'` messages via `useSessionStream`:
```
┌─────────────────────────────────────────────────────────┐
│ Phase 1: Codebase Audit...                              │
│ Reading README.md...                                     │
│ Running ideation scan...                                 │
│  ...                                                     │
└─────────────────────────────────────────────────────────┘
```
Monospace font, `text-xs`, `bg-slate-50 dark:bg-slate-900`, `border border-slate-200 dark:border-slate-700`.

#### Phased card view (after completion or on mount)
Triggered by `result` event after generation, or **auto-loaded on page mount** if `roadmap-{date}.json` files already exist in `.teamai/roadmap/` — the most recent one is loaded automatically without running the agent. If a generation is still in-flight (session ID persisted in `sessionStorage`), the component reconnects to the active session and resumes streaming output.

**Executive summary** paragraph rendered above the four phase sections (sourced from `RoadmapReport.executive_summary`).

Four sections rendered top-to-bottom (each collapsible; section header shows item count):

```
── Phase 1 — Now ──────────────────────────── (N items) ──
  ┌──────────────────────────────────────────────────────┐
  │  [P0]  Title of item                    [Critical Fix]│
  │  Complexity: ●●●○○  (3/5)                            │
  │  Description text here (2-3 sentences)               │
  │  Source: ideation                                    │
  └──────────────────────────────────────────────────────┘
  ...

── Phase 2 — Next ─────────────────────────── (N items) ──
── Phase 3 — Later ────────────────────────── (N items) ──
── Icebox ─────────────────────────────────── (N items) ──
```

**Roadmap item card fields:**
- Priority badge: `P0` (red), `P1` (orange), `P2` (amber), `P3` (gray) — consistent light/dark
- Title (bold, `text-sm`)
- Category label (right-aligned, `text-xs`, slate)
- Complexity: 5 filled/empty dots (● = filled, ○ = empty) matching the numeric value
- Description (`text-xs text-slate-600 dark:text-slate-400`)
- Source: "ideation" | "competitor-analysis" (`text-xs italic`)
- Competitive context (if present): italic note below source

---

### Changelog Tab

#### Controls bar
```
[Generate Changelog ▶]

Previous changelogs: [Select ▾]
```
- **"Generate Changelog"** button: same dark-pill style. Shows "Generating…" while running.
- **Previous changelogs** dropdown: populated by `getChangelogReports()` — lists `changelog-{date}.md` files newest-first. Selecting one loads that file via `getLatestChangelog(filename)` without re-running.

#### Streaming output (while running)
Same scrollable pre-formatted block as Roadmap tab.

#### Changelog result (after completion)
The agent writes `changelog-{date}.md` to `.teamai/roadmap/`. The UI reads it on `result` event and renders it inside a `<pre className="whitespace-pre-wrap font-mono text-xs">` block. (`@tailwindcss/typography` is not installed; use `<pre>` rather than `prose` classes.)

```
┌────────────────────────────────────────────────────────┐
│ ## [Unreleased] — 2026-05-01                           │
│                                                        │
│ ### Added                                              │
│ - feat(roadmap): implement roadmap and changelog page  │
│ - feat(insights): streaming chat with codebase         │
│                                                        │
│ ### Fixed                                              │
│ - fix(qa): handle empty QA report gracefully           │
└────────────────────────────────────────────────────────┘
```

The most recent changelog is **auto-loaded on page mount** (no agent needed) if a file already exists. Changelog generation sessions also persist their session ID in `sessionStorage` so a mid-run changelog can be reconnected if the user navigates away and returns.

#### Empty state (no changelog generated)
```
No changelog generated yet. Click 'Generate Changelog' to start.
```

---

### Server Actions (`src/app/actions/roadmap.ts`)

| Action | Returns | Description |
|---|---|---|
| `startRoadmapGeneration(skipCompetitors)` | `Promise<string>` | Spawns session, sends `/roadmap [--skip-competitors]`; stores session ID in `global.__roadmapSessions` under key `roadmap::<projectPath>` |
| `startChangelogGeneration()` | `Promise<string>` | Spawns session, sends `/changelog`; stores session ID under key `changelog::<projectPath>` |
| `getRoadmapReports()` | `Promise<{filename,date}[]>` | Lists `roadmap-*.json` newest-first |
| `getRoadmapReport(filename)` | `Promise<RoadmapReport>` | Reads + normalizes JSON; validates filename against `/^roadmap-\d{4}-\d{2}-\d{2}\.json$/`; throws `"Malformed roadmap JSON: ${filename}"` if JSON is invalid |
| `getChangelogReports()` | `Promise<{filename,date}[]>` | Lists `changelog-*.md` newest-first |
| `getLatestChangelog(filename)` | `Promise<string>` | Reads raw markdown; validates filename against `/^changelog-\d{4}-\d{2}-\d{2}\.md$/` |
| `getActiveRoadmapSession(type)` | `Promise<string \| null>` | Looks up `global.__roadmapSessions` for `${type}::<projectPath>`; returns session ID if `processManager.getSession(id)?.status === 'running'`, otherwise `null`. Used for reconnect on page mount. |

All filename-accepting actions validate against strict regex before filesystem access (path traversal prevention).

Session globals follow the `global.__roadmapSessions` pattern used by ideation and insights.

### Type Definitions (exported from `src/app/actions/roadmap.ts`)

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
  generated_at: string;          // ISO 8601
  executive_summary: string;
  competitor_analysis_run: boolean;
  phases: {
    now: RoadmapItem[];          // Phase 1: P0 + quick P1 (complexity ≤ 2)
    next: RoadmapItem[];         // Phase 2: remaining P1 + high-impact P2
    later: RoadmapItem[];        // Phase 3: P2 + P3
    icebox: RoadmapItem[];
  };
}
```

`getRoadmapReport` normalizes two fallback shapes: flat `{ items: RoadmapItem[] }` (partition by priority/complexity rules) and `{ items: (RoadmapItem & { phase })[] }` (group by item.phase).

**Known gaps (command files — both must be fixed as part of this feature):**
- `defaults/commands/roadmap.md` §3b is missing the `category` field and has typo "pority" → "priority". Without the fix, agents will not emit `category` and card category labels will be blank. Already-scaffolded projects need their `.claude/commands/roadmap.md` updated manually.
- `defaults/commands/changelog.md` has typo "changog" and lacks a file-write step. Without the fix, changelog output is only printed to stdout and the UI's auto-load on mount will find no files. Already-scaffolded projects need their `.claude/commands/changelog.md` updated manually.

### Components
- `src/app/roadmap/page.tsx` — replaces placeholder; thin wrapper around `RoadmapView`
- `src/components/roadmap-view.tsx` — `'use client'` — tabs, generate buttons, streaming block, phased card view, history selectors, markdown rendering

---

### User Journey — Generating a Roadmap

1. Navigate to **Roadmap** (`◉` in sidebar)
2. Optionally check **"Skip competitor research"**
3. Click **"Generate Roadmap"**
4. Button shows "Generating…"; streaming output block appears with live agent text
5. Agent finishes (may take several minutes for full competitor analysis)
6. Phased card view renders automatically; executive summary appears above Phase 1
7. History dropdown adds today's date as the latest option

### User Journey — Viewing Past Roadmaps

1. Navigate to **Roadmap**
2. Open the **History** dropdown
3. Select a previous date
4. Phased card view updates to show that run's items (no agent spawned)

### User Journey — Generating a Changelog

1. Navigate to **Roadmap**, click **Changelog** tab
2. Click **"Generate Changelog"**
3. Agent runs `git log` and streams release notes to stdout and writes `changelog-{date}.md`
4. On `result` event, markdown is rendered in the result area
5. Previous changelogs dropdown adds today's entry

---

## 6. Settings Page (`/settings`)

Dark mode: `bg-white dark:bg-slate-900` on page root (covers both the header strip and the scrollable content area below it).

Four sections, rendered top-to-bottom:

### Container Isolation
```
┌──────────────────────────────────────────────────────────┐
│  Run agents in devcontainer                    [ ○──]    │
│  Requires .devcontainer/devcontainer.json.               │
│  All tasks share one long-lived container;               │
│  worktrees go to .worktrees/.                            │
├──────────────────────────────────────────────────────────┤
│  Container status:  [STOPPED]                            │  ← only shown when enabled
└──────────────────────────────────────────────────────────┘
```
- **Toggle**: enables/disables container mode for all pipeline agents on this project
- **Status badge**: appears below the toggle row when enabled; updates live via WebSocket without page reload
  - `STOPPED` (gray) — no container running yet
  - `STARTING…` (blue) — `devcontainer up` in progress (first task triggered it)
  - `RUNNING` (green) — container is up, agents will use `docker exec`
  - `RESTARTING…` (amber) — container died mid-task, one restart attempt underway
- Requires the project to have a `.devcontainer/devcontainer.json`
- The TeamAI devcontainer (`javascript-node:20` image) automatically installs:
  - `@anthropic-ai/claude-code` — Claude CLI for agent sessions
  - `playwright-mcp` — Playwright MCP server
  - `gh` (GitHub CLI) — for PR creation
- Host credentials mounted automatically: `~/.claude`, `~/.gitconfig`, `~/.ssh` (read-only)
- Git worktrees are created **inside** the container at `<workspace>/.worktrees/<slug>` so git metadata uses container-relative paths

### Pipeline Configuration
- Checkboxes for active phases: Spec, Plan, Implement, QA Review, Merge
- Max QA attempts spinner (default 3)
- Parallel subtasks checkbox
- "Save Pipeline Config" button

### Providers
- Default model + backend (anthropic / bedrock / vertex / ollama) for all roles
- Per-role overrides: Planner, Coder, QA Reviewer, QA Fixer, Merger
- "Save Provider Config" button

### Agent Roles
- Expandable accordion per role (analyst, coder, merger, planner, qa-fixer, qa-reviewer)
- Edit the system prompt / persona for each agent
- Changes take effect on the next pipeline run

---

## 7. User Journeys

### Journey 1 — First-time Setup

1. Open `http://localhost:3000`
2. See: empty main area, "Select or add a project from the sidebar to get started."
3. Click **"+ Add"** in sidebar Projects section
4. In the input that appears, type the path to your project (e.g. `/Users/me/myproject`)
5. Press Enter or click Add
6. Project appears in the sidebar list
7. Click the project name button → board loads, showing 9 empty columns

---

### Journey 2 — Creating and Launching a Task

1. On the Kanban board, click **"+ New Task"**
2. Modal appears
3. Type a title: e.g. "Add user authentication"
4. Type a description: e.g. "Implement JWT-based auth with login and register pages"
5. Optionally attach reference images (drag-and-drop mockups, screenshots)
6. Click **"Create Task"**
7. Button shows "Creating..." briefly
8. Modal closes; new card appears in **Backlog** column
9. Click the card to open the Task Detail Panel
10. Optionally change the Agent dropdown from "Auto" to a specific role
11. Close the panel
12. The pipeline starts automatically or can be resumed via play button

---

### Journey 3 — Monitoring a Running Task

1. A task moves from Backlog → Spec → Planning → In Progress automatically as the pipeline runs
2. Click the task card to open the panel
3. Click the **Terminal** tab
4. Watch live agent output stream in the xterm.js terminal
5. Click **Spec** tab to read the generated specification
6. Click **Plan** tab to review the implementation plan
7. Click **Overview** tab to see dependency relationships

---

### Journey 4 — Reviewing and Merging a Task

1. Task card moves to the **Review** column (phase: `awaiting-review`)
2. Card no longer has a ▶ play button (it's awaiting human decision)
3. Click the card to open the panel
4. On **Overview** tab, see:
   - QA Report accordion (expand to read pass/fail details)
   - Spec accordion (expand to re-read what was built)
5. Click **QA** tab to read the full QA report
6. Click **Terminal** tab to review the agent's work log
7. Decision:
   - Click **Merge Locally** → branch merged, task moves to Done
   - Click **Open Pull Request** → GitHub PR created, task stays in Review
   - Click **Reject with Feedback** → type feedback text, agent re-runs QA fix

---

### Journey 5 — Resuming an Interrupted Task

1. App was restarted while a task was mid-pipeline
2. Reopen app; task card has a **green ▶ button** in its top-right corner
3. Hover over the ▶ to see tooltip "Resume pipeline"
4. Click ▶ — pipeline resumes from where it left off
5. Play button disappears; task progresses through columns again

---

### Journey 6 — Handling a Rate-Limited Task

1. Claude API rate limit is hit during a pipeline run
2. Amber banner appears in the task's Overview tab: "⚠ Rate limited · Retrying at 3:45 PM"
3. No action needed — app automatically retries at the displayed time
4. When limit clears, pipeline resumes automatically

---

### Journey 7 — Setting Up Task Dependencies

1. Open a task's detail panel
2. On **Overview** tab, click **"+ Depends on"**
3. A searchable dropdown appears listing all other tasks
4. Type to filter by name
5. Click a task to select it (checkbox ticks)
6. Close the picker (click outside)
7. The selected task appears as a pill under "DEPENDS ON"
8. The other task automatically shows this task under its "BLOCKS" section
9. To remove: hover the pill → click `×`

---

### Journey 8 — Overriding Agent Role

1. Open a task's detail panel
2. In the header area, find the **Agent** dropdown (default: "Auto (pipeline default)")
3. Click to open dropdown; options:
   - Auto (pipeline default)
   - Product Analyst
   - Senior Developer
   - Git Integration Specialist
   - Implementation Planner
   - Bug Fix Specialist
   - QA Reviewer
4. Select a role (e.g. "Senior Developer")
5. Selection saves immediately
6. Next pipeline step for this task will use the chosen role's persona and system prompt

---

### Journey 9 — Toggling Dark / Light Mode

1. In sidebar, click **"☾ Dark mode"** (or **"☀ Light mode"**)
2. Entire app color scheme switches instantly
3. Preference remembered — same mode on next visit
4. Sidebar always stays dark regardless of mode

---

### Journey 10 — Collapsing the Sidebar

1. Click the **"←"** button in the sidebar header
2. Sidebar shrinks to a narrow icon strip (~48px)
3. Nav links become icon-only; project list hides
4. Kanban board gains horizontal space, showing more columns
5. Click **"→"** to expand sidebar again

---

### Journey 12 — Enabling Container Isolation

1. Ensure the project has a `.devcontainer/devcontainer.json`
2. Navigate to **Settings** (`⚙` in sidebar)
3. At the top, find the **Container Isolation** section
4. Click the toggle next to "Run agents in devcontainer"
5. Toggle flips on; "Container status: **STOPPED**" badge appears below
6. Create or start a new task — the status badge transitions: `STOPPED → STARTING… → RUNNING`
7. While `STARTING…`, the app is waiting for `devcontainer up` to finish building the image
8. Once `RUNNING`, all pipeline agents for this project run inside the container
9. To disable: click the toggle again — status badge disappears, future sessions run directly

**If container dies mid-task:**
- Affected task card moves to **Failed**
- Status badge briefly shows `RESTARTING…` then returns to `RUNNING` (one automatic restart)
- Resume the failed task manually via its ▶ play button

---

### Journey 11 — Adding Multiple Projects

1. Click **"+ Add"** in the Projects section
2. Enter a project path
3. Repeat for additional projects
4. Each project appears in the sidebar list
5. Click a project name to switch active project — board reloads with that project's tasks
6. Click `×` next to a project name to remove it from the list

---

## 7. Component Inventory

| Component | Location | Description |
|---|---|---|
| Sidebar | Always visible | Navigation, projects, dark mode |
| KanbanBoard | `/` | 9-column board with horizontal scroll |
| TaskCard | Board columns | Card with play button, phase badge, timestamps |
| TaskPanel | Board right side | Slide-in detail panel, 45% width |
| TaskDetail | Inside panel | Tabbed content: Overview/Terminal/Spec/Plan/QA |
| DepPicker | Overview tab | Searchable task picker for dependencies |
| DarkModeToggle | Sidebar nav | ☾/☀ toggle with localStorage persistence |
| NewTaskModal | Board header | Create task form with image upload |
| ReviewPanel | Overview tab (awaiting-review only) | Merge/PR/Reject actions |
| RateLimitBanner | Overview tab (when rate limited) | Amber warning with retry time |
| TerminalPane | Terminal tab | xterm.js terminal with event replay |
| ContainerConfigEditor | Settings — Container Isolation | Toggle + live status badge (stopped/starting/running/restarting) |
| RoadmapView | `/roadmap` | Tabbed roadmap+changelog page: generate buttons, streaming output, phased card view, history selectors |

---

## 8. Color & Phase Palette

| Phase | Badge color (light) | Badge color (dark) |
|---|---|---|
| backlog | gray | gray |
| spec | blue | blue |
| plan | indigo | indigo |
| implement | amber | amber |
| qa-review / qa-fix | orange | orange |
| awaiting-review | purple | purple |
| merge / create-pr | teal | teal |
| failed | red | red |
| done | green | green |

---

## 9. Key Interaction Patterns

- **Split view**: clicking a card → 55/45 kanban+panel; clicking `×` → back to full-width kanban
- **Live updates**: WebSocket pushes phase-change events → cards move between columns in real time without page reload
- **Optimistic UI**: task creation shows "Creating…" spinner; board refreshes after server confirms. Drag-and-drop shows card in target column immediately, confirmed by WebSocket phase-change event with 10-second safety timeout
- **Drag-and-drop**: cards are draggable between all columns; drop triggers smart pipeline resumption (skips completed phases, kills running sessions before restarting); valid drop targets glow blue with scale animation; dragged cards show reduced opacity + scale-95; moving cards show blue pulsing dot + "moving" label + animate-pulse until WebSocket confirms
- **Persistent sidebar**: sidebar state (collapsed/expanded, active project) survives navigation between routes
- **Tab badges**: Spec and QA tabs show a numeric badge when content exists (e.g. "Spec 1", "QA 1")
- **Breadcrumb**: "← Board" link in panel header navigates back to `/` (for future deep-link support)
- **Container status badge**: live updates via WebSocket `container-state` events — no page refresh needed; transitions between stopped/starting/running/restarting as the devcontainer lifecycle progresses