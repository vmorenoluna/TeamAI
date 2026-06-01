# TeamAI — UI Specification & User Journeys

> Design reference for Google Stitch iteration.  
> Describes every screen, component, and click-by-click user flow.

---

## 1. Application Shell

### Design System — “Midnight” Dark-First Theme

TeamAI uses a deep "midnight" dark mode palette inspired by Google Stitch, optimized for high-fidelity engineering workflows:

| Token | Value | Usage |
|---|---|---|
| `#11131b` | Deep navy/slate | Primary surface: sidebar, page backgrounds |
| `#1a1f2e` | Surface bright | Secondary surfaces, hover states |
| `#1e2333` | Surface card | Cards, panels, modals |
| `#2563eb` | Royal blue accent | Active states, primary buttons, nav highlights |
| `#1d4ed8` | Accent hover | Button hover states |
| `#1e293b` | Border | Card/panel borders |
| `#334155` | Border light | Input borders, scrollbar thumbs |
| `#ffffff` | Text primary | Titles, headings |
| `#cbd5e1` | Text secondary | Body text (slate-300) |
| `#94a3b8` | Text muted | Secondary labels (slate-400) |
| `#64748b` | Text dim | Timestamps, hints (slate-500) |
| `#34d399` | Emerald-400 | Streaming agent output on black terminals |

**Typography:** Inter (sans-serif) for UI, Geist Mono for code. Text hierarchy: `text-lg font-bold` for page titles, `text-xs font-semibold` for badges, `text-[10px]` for dense metadata.

**Borders & Radius:** Every card, button, and modal uses `rounded-lg` (8px). Consistent 1px borders (`border-[#1e293b]`). Cards are flat — no shadows except on hover (`hover:shadow-md`).

**Dark-only:** The UI is permanently dark. There is no light mode toggle — the midnight palette is the only theme.

### Layout
The app has a two-column shell that fills the entire viewport:

```
┌─────────────────────────────────────────────────────────┐
│  SIDEBAR (240px)  │  MAIN CONTENT (flex-1)              │
│                   │                                     │
│  TeamAI logo      │  [Project tabs row] ← top of main   │
│  Collapse ←       │  ─────────────────────────────      │
│  ─────────────    │                                     │
│  ▦ Kanban         │  Page content varies by route       │
│  ◎ Insights       │                                     │
│  ◈ Ideation       │                                     │
│  ▶ Terminals      │                                     │
│  ◉ Roadmap        │                                     │
│  📊 Analytics      │                                     │
│  ⎇ GitHub         │                                     │
│  ⚙ Settings       │                                     │
│                   │                                     │
└─────────────────────────────────────────────────────────┘
```

### Sidebar — Expanded State
- **Header**: "TeamAI" branding + `←` collapse button
- **Background**: `bg-[#11131b]` (deep navy) — permanently dark
- **Navigation**: vertical list of icon + label links; fills remaining space with `flex-1 overflow-y-auto`. Active link highlighted with `bg-[#2563eb]/15` + `border-r-2 border-[#2563eb]`. Inactive: `text-slate-400`, hover shows `bg-[#1a1f2e] text-white`. Kanban nav also highlighted on `/task/[id]` routes. No dark mode toggle.
- **Project tabs row is NOT in the sidebar** — it appears at the top of the main content area (see below)

### Sidebar — Collapsed State
- Sidebar narrows to ~48px icon strip
- Header shows only `→` expand button
- Project tabs row is hidden entirely
- Navigation shows icon-only buttons (no labels) with a `border-t` separator from the header
- More horizontal space for main content — board shows more columns

### Theme
- **Dark-only** — no light mode toggle exists. The midnight palette (`#11131b`, `#1a1f2e`, `#1e2333`) is the permanent UI theme.

### Project Tabs (Main Content Header)
- Horizontal scrollable row of project tabs positioned at the **top of the main content area**, above the page content
- **Tab styling** (not button/pill): flat appearance with bottom border indicator
  - Active tab: `text-white border-b-2 border-[#2563eb]` (white text, blue bottom border)
  - Inactive tab: `text-slate-500 border-b-2 border-transparent hover:text-slate-300 hover:border-[#334155]`
  - No `rounded-md` — tabs are flat with a bottom underline style
- **Sizing**: `px-4 py-2.5 text-sm` (larger than before: text-sm instead of text-xs, more padding)
- Max width per tab: `max-w-[140px]` (longer project names fit)
- Remove button (×): circular overlay at top-right, hidden by default, appears on hover (`group-hover:opacity-100`)
- `+` button at end opens the Add Project modal (same dialog as before)
- When collapsed sidebar has no effect on project tabs row visibility

---

## 2. Pages / Routes

| Route | Page | Description |
|---|---|---|
| `/` | Kanban Board | Main working view with 6 columns, search, filter, bulk ops, drag-and-drop, undo |
| `/task/[id]` | Task Detail | Full-page tabbed detail: Overview, Terminal, Spec, Plan, QA |
| `/insights` | Insights | Chat with Claude about the active codebase |
| `/ideation` | Ideation | AI brainstorming for new tasks |
| `/terminals` | Terminals | Interactive PTY Claude sessions pre-loaded with a role persona |
| `/roadmap` | Roadmap | Two-tab view: Roadmap (phased AI-generated items) + Changelog (release notes from git history) |
| `/settings` | Settings | Project configuration: container isolation, pipeline phases, providers, agent roles |
| `/analytics` | Analytics | Project metrics and pipeline insights dashboard |
| `/github` | GitHub | Import GitHub issues as tasks, manage pull requests |

---

## 3. Kanban Board (`/`)

### Empty state (no project selected)
- Centered message: "Select or add a project from the sidebar to get started."

### Board header
- Left: "Board" heading
- Right: "+ New Task" button (dark pill)

### Board Surface
- Background: `bg-[#11131b]` (primary surface)
- Column headers: uppercase label (`text-xs font-semibold text-slate-400`) + count badge (`bg-[#1e293b] text-slate-300`, rounded-full)
- Empty column filler: `min-h-[120px]`

### Columns
Six fixed columns in order, each 240px wide, scrollable horizontally:

| Column | Phase value(s) |
|---|---|
| Backlog | `backlog` |
| Analysis | `spec`, `plan` |
| In Progress | `implement` |
| Review | `qa-review`, `qa-fix`, `awaiting-review`, `merge`, `create-pr`, `pr-open` |
| Failed | `failed` |
| Done | `done` |

Each column has:
- Header: uppercase label + count badge
- Scrollable card list

### Board Header
- Left: "Board" heading + **Connection Indicator** (green dot = connected, amber dot = connecting/disconnected)
- Right: "+ New Task" button (royal blue pill)

### Filter Toolbar (below board header)
- **Search**: text input with magnifying glass icon, full-text search across task titles and descriptions
- **Phase filter**: dropdown with checkbox multi-select for all 6 columns, badge shows active filter count
- **Source filter**: dropdown to filter by origin (All / Ideation / Competitor Analysis)
- **Sort**: dropdown to sort by Newest first, Oldest first, A→Z, Z→A
- **Reset**: clears all active filters (only visible when filters applied)

### Bulk Operations
- **Ctrl+Click** toggles individual card selection
- **Shift+Click** selects a range of cards
- **Bulk action bar** appears above columns: shows count, Deselect, Move to (phase dropdown), Delete selected
- Selected cards show blue ring + checkmark overlay

### Undo
- **Ctrl+Z** after a card move undoes the move
- **Toast notification** appears at bottom-center: "Moved \"Task Name\" to {phase}" with Undo button (5-second auto-dismiss)
- Undo stack holds up to 20 actions

### Task Card
```
┌──────────────────────────────────┐
│  Task title text            [▶]  │  ← play button (only if interrupted)
│  Description preview…  more      │  ← truncated at 80 chars; "more/less" toggle
│  [PHASE badge]       4d ago      │
│  ● moving                        │  ← blue pulsing dot (only during drag transition)
└──────────────────────────────────┘
```

- **Card styling**: `bg-[#1e2333]` surface with `border border-[#1e293b]`, `rounded-lg` (8px), no shadow. Flat design with subtle hover shadow (`hover:shadow-md`).
- **Play button** `▶`: green circle overlay, top-right corner. Only shown on tasks that were interrupted mid-pipeline (process crashed / app restarted). Clicking resumes the pipeline immediately without opening the panel.
- **Phase badge**: color-coded pill per phase (blue=spec, indigo=plan, amber=implement, orange=qa, purple=awaiting-review, teal=merge, red=failed, green=done)
- **Description text**: `text-slate-300` — neutral body text, never blue or link-colored. Truncated at 80 chars with a "more"/"less" toggle. The toggle button has no underline (to avoid looking like a link).
- **Timestamp**: relative time since creation ("just now", "4m ago", "2h ago", "3d ago") — `text-slate-500`
- **Moving indicator**: blue pulsing dot + "moving" label appears on the card after a drag-and-drop until the WebSocket confirms the phase change. Card shows `pointer-events-none` and reduced opacity during transition.
- **Clicking the card body** opens the Task Detail Window (floating overlay over the kanban board)

### Drag-and-Drop

Tasks can be dragged from any column to any other column. On drop, the orchestrator determines the correct pipeline starting phase based on existing artifacts:

| Drop target | Prerequisites checked | Behavior |
|---|---|---|
| Backlog / Failed / Done | None | Phase updates immediately; no pipeline spawned |
| Analysis | None | Clears stale spec.md; runs spec from scratch |
| In Progress | plan.json exists? | Runs Implement if plan exists, else starts from Plan (or Spec) |
| Review | plan.json exists? | Clears QA artifacts; runs Implement if plan exists, else falls back |

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

## 5. Task Detail Window

Clicking a task card opens a **floating window overlay** on top of the kanban board. The kanban board remains at full width behind a semi-transparent blurred backdrop.

```
┌──────────────────────────────────────────────────────────┐
│  KANBAN BOARD (full width, dimmed)                       │
│  ┌ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ┐  │
│  │  TASK WINDOW (centered, 90% height, max-w-4xl)       │  │
│  │  ┌─────────────────────────────────────────────────┐ │  │
│  │  │ Task Title              [PHASE BADGE]        [×]│ │  │  ← title bar
│  │  │─────────────────────────────────────────────────│ │  │
│  │  │ ← Board                                    [🗑] │ │  │
│  │  │ Task Title (heading)                            │ │  │
│  │  │ Description text                                │ │  │
│  │  │ Created … · Updated …      Agent: [Auto ▾]      │ │  │
│  │  │─────────────────────────────────────────────────│ │  │
│  │  │ Overview  Terminal  Spec  Plan  QA              │ │  │  ← tabs
│  │  │─────────────────────────────────────────────────│ │  │
│  │  │ [tab content — scrollable]                      │ │  │
│  │  │                                                 │ │  │
│  │  └─────────────────────────────────────────────────┘ │  │
│  └ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ┘  │
└──────────────────────────────────────────────────────────┘
```

### Window Behavior

- **Backdrop**: semi-transparent black overlay (`bg-black/40`) with `backdrop-blur-sm` applied to the kanban board area only
- **Window sizing**: `max-w-4xl` width, `h-[90%]` height (capped at `max-h-[900px]`), centered vertically and horizontally with `p-6` padding
- **Window styling**: `rounded-xl shadow-2xl border border-[#1e293b] bg-[#1e2333]` — matching the midnight card surface
- **Animation**: `animate-modal-in` (150ms zoom-in-95 + fade-in keyframes)
- **Backdrop click**: clicking the dimmed backdrop area closes the window
- **Escape key**: pressing Escape closes the window
- **Click propagation**: clicking inside the window itself does NOT close it (`e.stopPropagation()`)
- **Background lock**: while the window is open, the kanban board behind it is non-interactive (`pointer-events-none select-none`) and scrolling is disabled (`overflow-hidden`)
- **Title bar**: shows the task title (truncated), a color-coded phase badge, and an `×` close button with hover background (`hover:bg-[#1e293b]`). During loading, the title shows "Loading…"
- **Multiple windows**: only one task window can be open at a time; opening a different card replaces the current window

### Window Header (inside the scrollable content area)

Layout (top to bottom):
1. **Row 1:** `← Board` breadcrumb (left, `text-slate-400 hover:text-slate-200`) + **Phase badge** + **🗑 Delete button** (right, `text-slate-500 hover:text-red-400`)
2. **Row 2:** Task title (large heading, `text-white`)
3. **Row 3:** Description text (`text-slate-300`, never blue)
4. **Row 4:** `Created … · Updated …` timestamps + **Agent** dropdown

**Source info (for roadmap-converted tasks):** Below the description, if the task was created from a roadmap item, a source section appears:
```
Source: [Ideation] or [Competitor Analysis]   ← colored badge
Competitive context: (if applicable)           ← amber italic text
```
- "Ideation" badge: blue (`bg-blue-900/30 text-blue-400`)
- "Competitor Analysis" badge: amber (`bg-amber-900/30 text-amber-400`)
- Competitive context text shown in amber italic below the badge if `competitiveContext` exists

**Tabs:** Horizontal tab bar with bottom-border active indicator (`border-b-2 border-[#2563eb]`). Active tab: `text-white`. Inactive tab: `text-slate-500 hover:text-slate-300`. Tab badges (e.g., "1") shown on Spec/QA tabs when content exists.

**Terminal tab:** xterm.js with pure black background (`#000000`) and emerald foreground (`#34d399`) for streaming agent output.

**Individual elements:**
- `×` close button (title bar, far right) — closes the window, kanban returns to full-width interactive state
- `← Board` breadcrumb link
- Phase badge (color-coded, same as card)
- Task title (large heading)
- Description text — neutral body color, not link-colored
- **Created / Updated timestamps**: both always shown (there is no "Run Pipeline" button in the panel header). Even newly created tasks where `createdAt === updatedAt` show both timestamps with identical values.
- **Agent dropdown**: "Auto (pipeline default)" or any named role — overrides which AI agent persona handles the next pipeline step for this task. Options: Product Analyst, Senior Developer, Git Integration Specialist, Implementation Planner, Bug Fix Specialist, QA Reviewer
- **🗑 Delete button** (trash icon, right side of header): slate color, turns red on hover. On click, `window.confirm('Delete "{title}"? This cannot be undone.')` dialog appears. On confirm: shows disabled state, calls `deleteTask(taskId)` server action. On success: **window closes immediately** (if opened from kanban overlay) or **navigates to `/`** (if on the dedicated `/task/[id]` page). The kanban board refreshes to remove the deleted card. The button is always present but disabled via `isPending` during the operation.

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
- **"Run Scan"** button — dark pill (`bg-[#2563eb] hover:bg-[#1d4ed8] text-white rounded-lg`), triggers a Claude agent scan of the active codebase
- While scanning: button changes to "Scanning…" (disabled, `opacity-40`)
- After scan: results appear in a scrollable monospace pre-formatted block (`bg-[#1a1f2e] border border-[#1e293b] rounded-lg`, monospace `text-xs`); "Scan complete" badge shown
- Empty state: "Click 'Run Scan' to analyse the codebase."

Dark mode: `bg-[#11131b]` on page root (always dark-first). No light mode variant.

---

## 5b. Insights Page (`/insights`)

Header: "Insights" title + "Chat with Claude about the active project." subtitle.

Below: full-height chat interface (`InsightsChat` component):
- **Message area**: scrollable list of chat bubbles on `bg-[#11131b]`. User messages are dark pill (`bg-[#2563eb] text-white`, right-aligned); assistant replies are card with border (`bg-[#1e2333] border border-[#1e293b]`, left-aligned). Streaming replies show an animated cursor.
- **Input bar** (pinned bottom): multi-line textarea (`bg-[#1a1f2e] border border-[#1e293b] rounded-lg text-slate-200`) + "Send" button (`bg-[#2563eb]`). Press Enter to send (Shift+Enter for new line). Placeholder: "Ask about the codebase… (Enter to send)". Disabled while connecting or waiting for response.

Dark mode: `bg-[#11131b]` on root (always dark-first). Input area has a top border separator (`border-[#1e293b]`).

---

## 5c. Terminals Page (`/terminals`)

Header: "Terminals" title + subtitle + **"+ New Terminal"** button (top-right, `bg-[#2563eb]`).

Clicking "+ New Terminal" opens a modal (`bg-[#1e2333] border-[#1e293b]`):
- **Role** dropdown (all available agent roles)
- **Model** text field (optional override, defaults to project provider setting)
- Cancel (`text-slate-300 hover:text-white`) / Open buttons

Once opened, terminals appear in a responsive grid (1 column for 1 terminal, 2 columns for 2+). Each terminal panel is a dark xterm.js instance (`bg-[#000000]` with `#34d399` emerald foreground) pre-loaded with the chosen role's system prompt. Multiple terminals can run simultaneously.

Dark mode: `bg-[#11131b]` on root content area (always dark-first). No project message: `text-slate-500`.

---

## 5d. Analytics Page (`/analytics`)

Header: "Analytics" title + "Project metrics and pipeline insights." subtitle.

Dashboard layout showing:
- Task counts by phase (summary cards or chart)
- Pipeline run statistics
- Agent session history
- Recent activity timeline

Dark mode: `bg-[#11131b]` on page root (always dark-first).

---

## 5e. GitHub Page (`/github`)

Header: "GitHub" title + "Import issues and manage pull requests." subtitle.

Content:
- Connected repository status indicator
- Issue list with import-to-task buttons
- PR management interface

Requires: GitHub MCP server configured, `GITHUB_TOKEN` env var.

Dark mode: `bg-[#11131b]` on page root (always dark-first).

---

## 5f. Roadmap Page (`/roadmap`)

Two-tab layout: **Roadmap** and **Changelog**.

Dark mode: `bg-slate-50 dark:bg-slate-950` on page root (matching the kanban board). Card areas inside the phased kanban use `bg-white dark:bg-slate-800` with `border-slate-200 dark:border-slate-700`.

Spec: `.teamai/roadmap-changelog/spec.md`

### Page Header
```
┌──────────────────────────────────────────────────────────┐
│  Roadmap  │  Changelog                                   │
│  ─────────────────────────────────────────────────────── │
│  [tab content area]                                      │
└──────────────────────────────────────────────────────────┘
```

No active project → both tabs show: "Select or add a project from the sidebar to get started." (in `text-slate-400 dark:text-slate-500`).

---

### Roadmap Tab

#### Controls bar (top)
```
☐ Skip competitor research        [Generate Roadmap ▶]

History: [Select a previous run ▾]
```
- **Skip competitor research** checkbox: when checked, appends `--skip-competitors` to the `/roadmap` command sent to the agent. The checkbox is **disabled while a generation is running** — it cannot be toggled mid-generation. Its value is only read when the "Generate Roadmap" button is clicked.
- **"Generate Roadmap"** button: dark pill (same style as "Run Scan" in Ideation). While running, shows "Generating…" (disabled). Returns to "Generate Roadmap" after completion.
- **History dropdown**: populated by `getRoadmapReports()` — lists `roadmap-{date}.json` files newest-first. Selecting one calls `getRoadmapReport(filename)` and renders that report without spawning a new session. While loading the selected report, the current kanban view remains visible — there is no loading spinner; the phasing data simply swaps when the fetch completes. If the selected file is corrupt or missing, the current view remains unchanged (silent error — no alert or error message).

#### Empty state (no report generated)
```
No roadmap generated yet. Click 'Generate Roadmap' to start.
```
Text color: `text-slate-400 dark:text-slate-500`.

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

#### Phased Kanban View (after completion or on mount)
Triggered by `result` event after generation, or **auto-loaded on page mount** if `roadmap-{date}.json` files already exist in `.teamai/roadmap/` — the most recent one is loaded automatically without running the agent. If a generation is still in-flight (session ID persisted in `sessionStorage`), the component reconnects to the active session and resumes streaming output. **Reconnect UX:** When reconnecting to an in-flight session, the "Generate Roadmap" button immediately shows "Generating…" (disabled), the streaming output block reappears with any accumulated text from the agent, and new events stream in live — the user sees no interruption or "Reconnecting…" indicator.

**Executive summary** paragraph rendered above the kanban columns (sourced from `RoadmapReport.executive_summary`). If `competitor_analysis_run` is true, a small note "Competitor analysis was run for this roadmap." appears in amber below.

Four columns in a horizontal scrollable kanban layout (mirroring the main kanban board), each 288px wide (`w-72`):

```
┌─ Phase 1 — Now ───┬─ Phase 2 — Next ──┬─ Phase 3 — Later ─┬─ Icebox ──────────┐
│ (N)               │ (N)               │ (N)               │ (N)               │
│ ┌───────────────┐ │ ┌───────────────┐ │ ┌───────────────┐ │ ┌───────────────┐ │
│ │[P0] Title     │ │ │[P1] Title     │ │ │[P2] Title     │ │ │[P3] Title     │ │
│ │Complex:●●●○○ │ │ │Complex:●●○○○ │ │ │Complex:●○○○○ │ │ │Complex:●●○○○ │ │
│ │Description…  │ │ │Description…  │ │ │Description…  │ │ │Description…  │ │
│ │              │ │ │              │ │ │              │ │ │              │ │
│ │Source: …     │ │ │Source: …     │ │ │Source: …     │ │ │Source: …     │ │
│ │[+ Convert]  ✕│ │ │[spec badge] ✕│ │ │[+ Convert]  ✕│ │ │[+ Convert]  ✕│ │
│ └───────────────┘ │ └───────────────┘ │ └───────────────┘ │ └───────────────┘ │
└───────────────────┴───────────────────┴───────────────────┴───────────────────┘
```

Each column has a header with the phase label (uppercase, `text-xs font-semibold`) and an item count badge (rounded-full, slate background). Columns with no items show "No items" in italic. Empty kanban columns have `min-h-[120px]`.

---

### Roadmap Item Card — Click Behavior

**Unlinked card click:** Opens the **Roadmap Item Detail Overlay** (see below). No expand/collapse.

**Linked card click:** Opens the task detail in a floating window overlay (same pattern as the kanban board). The roadmap content behind the window is non-interactive (`pointer-events-none select-none`) and scrolling is disabled (`overflow-hidden`). Clicking the backdrop, pressing Escape, or clicking the `×` button closes the window.

**✕ Delete button** (on any card):
- Subtle: `opacity-40` by default, `opacity-100` on card hover (`group-hover/card:opacity-100`)
- 11px, slate color, turns red on hover
- On click: `window.confirm('Remove this item from the roadmap?')` dialog appears
- On confirm: shows "…" (disabled), calls `deleteRoadmapItem(filename, itemIndex, phaseKey)`
- On success: item is removed from the JSON, kanban refreshes
- On failure: red error text "Action failed — please try again." appears for 5 seconds, then auto-clears
- Click propagation is stopped (`e.stopPropagation()`) — deleting does NOT open detail overlay
- If the card was linked to a kanban ticket, the ticket is NOT deleted — only the roadmap reference is removed

### Roadmap Item Detail Overlay

Opened by clicking any roadmap item card (linked or unlinked). A floating window overlay appears over the roadmap with a semi-transparent blurred backdrop.

```
┌────────────────────────────────────────────────────────────┐
│  [P0]  Add user authentication         [Security]    [×]   │  ← title bar with priority + category
│  ──────────────────────────────────────────────────────────│
│  Source: Ideation                           ●●●○○ (3/5)    │  ← source badge + complexity dots
│                                                            │
│  Description                                               │
│  Full description text here...                             │
│                                                            │
│  Competitive context (if applicable)                       │  ← amber italic, only if present
│  Amazon's new feature requires response...                 │
│                                                            │
│  Affected Files                                            │
│  src/auth/login.ts                                         │  ← monospace paths
│  src/auth/register.ts                                      │
│                                                            │
│  Phase: Now                                                │
│                                                            │
│                    [Close]  [Convert to Ticket ▶]          │  ← action bar
└────────────────────────────────────────────────────────────┘
```

**Title bar:** Priority badge + title + category (right-aligned) + `×` close button.

**Source info:** Badge showing "Ideation" (blue) or "Competitor Analysis" (amber) + competitive context text in amber italic below (only shown if `competitive_context` exists).

**Complexity dots:** Filled/empty circles with `aria-label="Complexity N out of 5"`.

**Description:** Full description text (not truncated).

**Affected Files:** Monospace list of file paths (only shown if `affected_files` array has entries).

**Phase info:** Shows which phase the item is in (Now/Next/Later/Icebox).

**Action bar:**
- **Close button**: closes the overlay, returns to roadmap
- **Convert to Ticket button** (blue, primary):
  - For unlinked items: creates a kanban task in Backlog, writes `linkedTaskId` back to roadmap JSON, then opens the newly created task's detail
  - On failure: red error text "Action failed — please try again." appears for 5 seconds

**Note:** This overlay is only shown for **unlinked** roadmap items. **Linked** items (already converted to a kanban ticket) open the kanban task detail directly when clicked — they bypass this overlay.

**Mutual exclusivity with task panel:** Opening a roadmap item detail closes any open task panel (`setSelectedTaskId(null)`).

**Stale link auto-cleanup:** If a linked roadmap item's kanban task was deleted (server returns "not found"), the `linkedTaskId` is automatically cleared from the roadmap JSON via `clearLinkedTaskId()`. The user sees the roadmap item detail instead of a "failed to load task" error. No manual unlink action needed.

---

### Changelog Tab

#### Controls bar
```
[Generate Changelog ▶]

Previous changelogs: [Select ▾]
```
- **"Generate Changelog"** button: same dark-pill style. Shows "Generating…" while running.
- **Previous changelogs** dropdown: populated by `getChangelogReports()` — lists `changelog-{date}.md` files newest-first. Selecting one calls `getLatestChangelog(filename)` and renders it without re-running. While loading, the current markdown (if any) remains visible — there is no loading spinner; the text simply swaps when the fetch completes. If the selected file is corrupt or missing, the current view remains unchanged (silent error — no alert or error message).

#### Streaming output (while running)
Same scrollable pre-formatted block as Roadmap tab.

#### Changelog result (after completion)
The agent writes `changelog-{date}.md` to `.teamai/roadmap/`. The UI reads it on `result` event and renders it inside a `<pre className="whitespace-pre-wrap font-mono text-xs text-slate-700 dark:text-slate-300">` block inside a bordered container (`bg-slate-50 dark:bg-slate-900 rounded-lg border border-slate-200 dark:border-slate-700`). (`@tailwindcss/typography` is not installed; use `<pre>` rather than `prose` classes.)

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

The most recent changelog is **auto-loaded on page mount** (no agent needed) if a file already exists. Changelog generation sessions also persist their session ID in `sessionStorage` so a mid-run changelog can be reconnected if the user navigates away and returns. **Reconnect UX:** When reconnecting to an in-flight session, the "Generate Changelog" button immediately shows "Generating…" (disabled), the streaming output block reappears with any accumulated text from the agent, and new events stream in live — the user sees no interruption or "Reconnecting…" indicator.

#### Changelog error state
If the agent session exits with an error (non-zero exit code) or the `startChangelogGeneration` server action throws, the streaming block remains visible with the last agent text. No separate error UI is rendered — the user sees whatever the agent output before crashing. The "Generate Changelog" button returns to its normal state so the user can retry.

#### Changelog empty file handling
If a changelog `.md` file exists but contains only whitespace or is empty, the `<pre>` block renders as an empty box (no visible text). The file is still listed in the history dropdown for consistency.

#### Empty state (no changelog generated)
```
No changelog generated yet. Click 'Generate Changelog' to start.
```
Text color: `text-slate-400 dark:text-slate-500`.

**Previous changelogs dropdown** is always visible (even before any changelog has been generated). When no changelogs exist yet, the dropdown is `disabled` with a single option: "None generated yet".

---

### Server Actions (`src/app/actions/roadmap.ts`)

| Action | Returns | Description |
|---|---|---|
| `startRoadmapGeneration(skipCompetitors)` | `Promise<string>` | Spawns session, sends `/roadmap [--skip-competitors]`; stores session ID in `global.__roadmapSessions` under key `roadmap::<projectPath>` |
| `startChangelogGeneration()` | `Promise<string>` | Spawns session, sends `/changelog`; stores session ID under key `changelog::<projectPath>` |
| `getRoadmapReports()` | `Promise<{filename,date}[]>` | Lists `roadmap-*.json` newest-first from `.teamai/roadmap/` |
| `getRoadmapReport(filename)` | `Promise<RoadmapReport>` | Reads + normalizes JSON; validates filename against `/^roadmap-\d{4}-\d{2}-\d{2}\.json$/`; throws `"Malformed roadmap JSON: ${filename}"` if JSON is invalid; normalizes flat-item and phased-item shapes |
| `getChangelogReports()` | `Promise<{filename,date}[]>` | Lists `changelog-*.md` newest-first from `.teamai/roadmap/` |
| `getLatestChangelog(filename)` | `Promise<string>` | Reads raw markdown; validates filename against `/^changelog-\d{4}-\d{2}-\d{2}\.md$/` |
| `getActiveRoadmapSession(type)` | `Promise<string \| null>` | Looks up `global.__roadmapSessions` for `${type}::<projectPath>`; returns session ID if `processManager.getSession(id)?.status === 'running'`, otherwise `null`. Used for reconnect on page mount. |
| `convertToTask(filename, itemIndex, phaseKey)` | `Promise<{ taskId: string }>` | Creates a kanban Board task from a roadmap item. Validates `phaseKey` against `['now','next','later','icebox']`; reads the roadmap JSON, gets the item, checks for existing `linkedTaskId` (idempotent — returns existing ID if already converted). Creates task via `TaskStore.create()` in Backlog phase, writes `linkedTaskId` back to JSON. Revalidates `/` and `/roadmap` paths. |
| `deleteRoadmapItem(filename, itemIndex, phaseKey)` | `Promise<void>` | Removes an item from the roadmap JSON by index. Validates filename and phaseKey. Splices the item from the phase array, writes back JSON, revalidates paths. Does NOT delete the linked kanban ticket if one exists. |
| `getLinkedTaskStatuses(linkedTaskIds)` | `Promise<Record<string, { phase: string; title: string } \| null>>` | Batch-looks up kanban task statuses. For each taskId, returns `{ phase, title }` if the task exists, or `null` if it was deleted. Used on mount and after refresh to populate linked card phase badges. |
| `clearLinkedTaskId(filename, itemIndex, phaseKey)` | `Promise<void>` | Clears the `linkedTaskId` from a roadmap item. Called automatically when a linked kanban task is not found (task was deleted) — no user action needed. |

All filename-accepting actions validate against strict regex before filesystem access (path traversal prevention: `/^roadmap-\d{4}-\d{2}-\d{2}\.json$/` and `/^changelog-\d{4}-\d{2}-\d{2}\.md$/`).

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
  linkedTaskId?: string;         // set when user converts this item to a kanban ticket
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

// Task interface (from task-store.ts)
export interface Task {
  id: string;
  title: string;
  description: string;
  phase: string;
  source?: 'ideation' | 'competitor-analysis';   // set when converted from roadmap
  competitiveContext?: string;                     // set when converted from roadmap
  // ... other fields
}
```

`getRoadmapReport` normalizes two fallback shapes: flat `{ items: RoadmapItem[] }` (partition by priority/complexity rules) and `{ items: (RoadmapItem & { phase })[] }` (group by item.phase).

`convertToTask` is idempotent: if `item.linkedTaskId` is already set, it returns the existing taskId without creating a duplicate.

**Note:** The following command file issues were fixed (both in `defaults/commands/` for fresh scaffolding and in `.claude/commands/` for this project):
- `defaults/commands/roadmap.md` §3b — `category` field added, "pority" → "priority"
- `defaults/commands/changelog.md` — "changog" → "changelog", file-write step added
- `defaults/commands/implement.md` — "indentunation" → "indentation"
- `.claude/commands/roadmap.md` — "pority" → "Priority", "ideintation" → "ideation", "we don' much" → "we don't have"
- `.claude/commands/changelog.md` — "changog" → "changelog"
- `.claude/commands/implement.md` — "indentunation" → "indentation"

### Components
- `src/app/roadmap/page.tsx` — thin wrapper around `RoadmapView`, passes `noProject` prop from project context
- `src/components/roadmap-view.tsx` — `'use client'` — full roadmap/changelog page with:
  - **RoadmapView**: parent component managing tab state (persisted to `sessionStorage`), roadmap/changelog generation sessions, history dropdowns (always visible; disabled with "None generated yet" when empty), session reconnect on mount, streaming output display via `useSessionStream`
  - **PhasedKanban**: horizontal 4-column kanban layout (Now/Next/Later/Icebox), linked status fetching via `getLinkedTaskStatuses`, real-time WebSocket status sync via `usePhaseSync`, convert/delete/expand actions with loading + error states
  - **RoadmapCard**: individual item card with priority badge, complexity dots (accessible: `role="img" aria-label="Complexity N out of 5"` wrapper with `aria-hidden` dots), description, source info, "Click to convert & view task" hint, "✕" delete button (hover-revealed), phase badge for linked items, error display. Clicking any card opens the detail overlay (no expand/collapse).
  - **StreamingBlock**: re-usable monospace streaming output block for agent text

---

### User Journey — Generating a Roadmap

1. Navigate to **Roadmap** (`◉` in sidebar)
2. Optionally check **"Skip competitor research"**
3. Click **"Generate Roadmap"**
4. Button shows "Generating…"; streaming output block appears with live agent text
5. Agent finishes (may take several minutes for full competitor analysis)
6. Phased kanban view renders automatically; executive summary appears above the four columns
7. History dropdown adds today's date as the latest option

### User Journey — Viewing Past Roadmaps

1. Navigate to **Roadmap**
2. Open the **History** dropdown
3. Select a previous date
4. Phased kanban view updates to show that run's items (no agent spawned)

### User Journey — Viewing Roadmap Item Details

1. Navigate to **Roadmap** tab with a loaded report
2. Hover over any card — note the cursor changes to pointer, border + shadow highlight on hover
3. Click any card (linked or unlinked) — the **Roadmap Item Detail Overlay** opens
4. View the full description, source info (Ideation or Competitor Analysis badge + context), complexity dots, affected files, and phase
5. Click **Close** or click the backdrop or press Escape to return to the roadmap
6. For **unlinked** items: click **Convert to Ticket** to create a kanban task and open its detail
7. For **linked** items: the phase badge shows the current kanban status; click "Already converted" to navigate to the task detail directly

### User Journey — Converting a Roadmap Item to a Kanban Ticket

1. Navigate to **Roadmap** tab with a loaded report
2. Find an unlinked card (showing "+ Convert to ticket" button at bottom-left)
3. Click **"+ Convert to ticket"**
4. Button changes to "Converting…" (disabled, `opacity-40`)
5. On success (typically <1s): the card refreshes — the convert button is replaced by a phase badge (e.g., `BACKLOG`) showing the linked kanban task's current phase
6. The card now shows "Click to view task" instead of "Click to expand details"
7. Navigate to the **Kanban Board** (`/`) — the new task appears in the **Backlog** column
8. Navigate back to **Roadmap** — the card still shows its linked phase badge (persisted in JSON)
9. If the server action fails: red error text "Action failed — please try again." appears for 5 seconds

### User Journey — Real-Time Phase Sync on Linked Cards

1. Convert a roadmap item to a ticket (see above)
2. Open the roadmap in one tab; open the kanban board in another (or keep both visible)
3. On the kanban board, start the task's pipeline — the card moves from Backlog → Spec → Planning → In Progress
4. Switch back to the roadmap tab — the roadmap card's phase badge updates in real time: `BACKLOG` → `SPEC` → `PLAN` → `IMPLEMENT`
5. No page refresh required — status syncs via WebSocket `phase-change` events

### User Journey — Deleting a Roadmap Item

1. Navigate to **Roadmap** tab with a loaded report
2. Hover over any card — the **✕** delete button becomes visible (opacity transition from 40% → 100%)
3. Click the **✕** button
4. A browser `confirm()` dialog appears: "Remove this item from the roadmap?"
5. Click **Cancel** — nothing happens, card remains
6. Click **OK** — the button shows "…" (loading), the item is removed from the roadmap JSON
7. On success: the kanban refreshes, the card disappears from its column
8. On failure: red error text appears on the card for 5 seconds
9. **Note:** If the card was linked to a kanban ticket, the ticket is NOT deleted — only the roadmap reference is removed

### User Journey — Generating a Changelog

1. Navigate to **Roadmap**, click **Changelog** tab
2. Click **"Generate Changelog"**
3. Agent runs `git log` and streams release notes to stdout and writes `changelog-{date}.md`
4. On `result` event, markdown is rendered in the result area
5. Previous changelogs dropdown adds today's entry

---

## 6. Settings Page (`/settings`)

Dark mode: `bg-[#11131b]` on page root (covers both the header strip and the scrollable content area below it). Cards/panels use `bg-[#1e2333] border border-[#1e293b] rounded-lg`. Inputs use `bg-[#1a1f2e] border-[#334155] text-slate-200`.

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
7. Click the project name button → board loads, showing 6 empty columns

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
9. Click the card to open the Task Detail Window (floating overlay)
10. Optionally change the Agent dropdown from "Auto" to a specific role
11. Close the window (click backdrop, press Escape, or click `×`)
12. The pipeline starts automatically or can be resumed via play button

---

### Journey 3 — Monitoring a Running Task

1. A task moves from Backlog → Analysis → In Progress automatically as the pipeline runs
2. Click the task card to open the floating task window
3. Click the **Terminal** tab
4. Watch live agent output stream in the xterm.js terminal
5. Click **Spec** tab to read the generated specification
6. Click **Plan** tab to review the implementation plan
7. Click **Overview** tab to see dependency relationships

---

### Journey 4 — Reviewing and Merging a Task

1. Task card moves to the **Review** column (phase: `awaiting-review`)
2. Card no longer has a ▶ play button (it's awaiting human decision)
3. Click the card to open the floating task window
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

1. Open a task's detail window
2. On **Overview** tab, click **"+ Depends on"**
3. A searchable dropdown appears listing all other tasks
4. Type to filter by name
5. Click a task to select it (checkbox ticks)
6. Close the picker (click outside)
7. The selected task appears as a pill under "DEPENDS ON"
8. The other task automatically shows this task under its "BLOCKS" section
9. To remove: hover the pill → click `×`

---

### Journey 8 — Deleting a Task from the Kanban Board

1. On the Kanban board, click a task card to open the Task Detail Window (floating overlay with blurred backdrop)
2. In the window header (right side, next to the phase badge), find the **🗑 delete button**
3. Click the **🗑** button
4. A browser `confirm()` dialog appears: "Delete \"{title}\"? This cannot be undone."
5. Click **Cancel** — nothing happens, window stays open, task remains
6. Click the same card again to reopen the window, click **🗑** again
7. Click **OK** — the button is briefly disabled
8. On success: the **window closes immediately** (backdrop disappears, kanban returns to interactive), the board refreshes, and the card disappears from its column
9. **Alternate path — dedicated task page:** Navigate directly to `/task/{id}` (no kanban visible). Click **🗑**, confirm, and the page navigates back to `/` (the kanban board) after deletion
10. If the server action fails: a network error may appear in the console; the task remains in its column

### Journey 8b — Overriding Agent Role

1. Open a task's detail window
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
| Sidebar | Always visible | Collapsible icon + label nav, project selector |
| KanbanBoard | `/` | 6-column board with search, filter (phase/source), sort, bulk select (Ctrl/Shift+Click), bulk move/delete, undo, connection indicator, drag-and-drop |
| TaskCard | Board columns | Card with play button (interrupted tasks), phase badge, description toggle (more/less), timestamps, moving indicator |
| TaskPanel | Window overlay | Floating window frame with title bar, backdrop blur, Escape key handling. Receives `onClose` from KanbanBoard |
| TaskDetail | Inside panel or `/task/[id]` page | Tabbed content: Overview/Terminal/Spec/Plan/QA. Accepts optional `onClose` prop |
| DepPicker | Overview tab | Searchable task picker for dependencies |
| NewTaskModal | Board header | Create task form with templates (Bug Fix, Feature, Refactor, Docs) + image upload |
| ReviewPanel | Overview tab (awaiting-review only) | Merge/PR/Reject actions |
| RateLimitBanner | Overview tab (when rate limited) | Amber warning with retry time |
| TerminalPane | Terminal tab | xterm.js terminal with event replay |
| ContainerConfigEditor | Settings — Container Isolation | Toggle + live status badge (stopped/starting/running/restarting) |
| PipelineConfigEditor | Settings — Pipeline Config | Max QA attempts spinner, parallel subtasks checkbox, Save button |
| ProviderConfigEdit | Settings — Providers | Default model + per-role provider/model overrides |
| RoleEditor | Settings — Agent Roles | Expandable accordion per role with editable textarea |
| RoadmapView | `/roadmap` | Tabbed roadmap+changelog page with phased kanban (Now/Next/Later/Icebox) |
| PhasedKanban | Inside RoadmapView | Horizontal 4-column kanban with linked status badges, real-time WebSocket sync, convert/delete actions |
| RoadmapCard | Inside PhasedKanban | Per-item card with priority badge, complexity dots, source info, convert/delete buttons |
| IdeationScanner | `/ideation` | Run Scan button + streaming output |
| InsightsChat | `/insights` | Streaming chat bubbles with message history |
| TerminalsView | `/terminals` | Responsive grid of PTY terminal panels with color-coded borders |
| ConnectionIndicator | Board header | Green/amber dot showing WebSocket connection status |

---

## 8. Design Tokens & Color Palette

### Midnight Theme Tokens

| Token | Hex | Tailwind Equivalent | Usage |
|---|---|---|---|
| Surface | `#11131b` | — | Primary: sidebar, page backgrounds |
| Surface Bright | `#1a1f2e` | — | Secondary: hover states, secondary panels |
| Surface Card | `#1e2333` | — | Cards, modals, panels |
| Accent | `#2563eb` | blue-600 | Active states, primary buttons, nav highlight |
| Accent Hover | `#1d4ed8` | blue-700 | Button hover states |
| Border | `#1e293b` | slate-800 | Card/panel borders |
| Border Input | `#334155` | slate-700 | Input borders, scrollbar |
| Text Primary | `#ffffff` | white | Titles, headings |
| Text Secondary | `#cbd5e1` | slate-300 | Body text |
| Text Muted | `#94a3b8` | slate-400 | Secondary labels |
| Text Dim | `#64748b` | slate-500 | Timestamps, hints |
| Terminal BG | `#000000` | black | xterm.js terminal background |
| Terminal FG | `#34d399` | emerald-400 | Streaming agent output |

### Phase Badge Palette

| Phase | Background | Text |
|---|---|---|
| backlog | `bg-slate-800` | `text-slate-300` |
| spec | `bg-blue-900/30` | `text-blue-400` |
| plan | `bg-indigo-900/30` | `text-indigo-400` |
| implement | `bg-amber-900/30` | `text-amber-400` |
| qa-review / qa-fix | `bg-orange-900/30` | `text-orange-400` |
| awaiting-review | `bg-purple-900/30` | `text-purple-400` |
| merge / create-pr | `bg-teal-900/30` | `text-teal-400` |
| failed | `bg-red-900/30` | `text-red-400` |
| done | `bg-green-900/30` | `text-green-400` |

### Roadmap Priority Badges

| Priority | Background | Text |
|---|---|---|
| P0 | `bg-red-900/30` | `text-red-400` |
| P1 | `bg-orange-900/30` | `text-orange-400` |
| P2 | `bg-amber-900/30` | `text-amber-400` |
| P3 | `bg-slate-800` | `text-slate-400` |

### Container Status Badges

| Status | Background | Text |
|---|---|---|
| Stopped | `bg-slate-800` | `text-slate-400` |
| Starting | `bg-blue-900/30` | `text-blue-300` |
| Running | `bg-green-900/30` | `text-green-300` |
| Restarting | `bg-amber-900/30` | `text-amber-300` |

---

## 9. Key Interaction Patterns

- **Floating window overlay**: clicking a card → full-width kanban with centered floating window overlay (backdrop-blur, shadow-2xl, rounded-xl); clicking backdrop / Escape key / `×` button → window closes, kanban returns to normal; deleting a task from the window → window closes automatically, board refreshes
- **Delete task**: 🗑 button in window header. `confirm()` dialog before deletion. In window overlay mode, deletion closes the window via `onClose` callback. In page mode (`/task/[id]`), deletion navigates to `/`. The `deleteTask` server action removes the task from the TaskStore and revalidates the board path.
- **Live updates**: WebSocket pushes phase-change events → cards move between columns in real time without page reload
- **Optimistic UI**: task creation shows "Creating…" spinner; board refreshes after server confirms. Drag-and-drop shows card in target column immediately, confirmed by WebSocket phase-change event with 10-second safety timeout
- **Drag-and-drop**: cards are draggable between all columns; drop triggers smart pipeline resumption (skips completed phases, kills running sessions before restarting); valid drop targets glow blue with scale animation; dragged cards show reduced opacity + scale-95; moving cards show blue pulsing dot + "moving" label + animate-pulse until WebSocket confirms
- **Persistent sidebar**: sidebar state (collapsed/expanded, active project) survives navigation between routes
- **Tab badges**: Spec and QA tabs show a numeric badge when content exists (e.g. "Spec 1", "QA 1")
- **Breadcrumb**: "← Board" link in panel header navigates back to `/` (for future deep-link support)
- **Container status badge**: live updates via WebSocket `container-state` events — no page refresh needed; transitions between stopped/starting/running/restarting as the devcontainer lifecycle progresses