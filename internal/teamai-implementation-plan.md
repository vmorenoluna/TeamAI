# TeamAI — Implementation Plan

> **Purpose:** This document is a complete implementation blueprint. A Claude Code instance should be able to read this file, understand the full context, and build the entire system step by step.
>
> **Architecture decision:** All AI interactions go through the Claude Code CLI as a subprocess. The UI spawns `claude -p --output-format stream-json --input-format stream-json` processes and communicates via stdin/stdout JSON. This keeps everything on a flat-rate Pro/Max subscription (no API keys, no per-token billing).

---

## 1. What We're Building

A web-based UI that replicates the full agentic workflow of [Aperant](https://github.com/AndyMik90/Aperant) (formerly Auto-Claude), an autonomous multi-agent coding framework. Aperant is an Electron app that wraps Claude Code in an orchestration layer. We're replacing the Electron shell with a Next.js web app that drives Claude Code CLI subprocesses.

### 1.1 Feature Set

| # | Feature | What It Does | Status |
|---|---|---|---|
| 1 | **Kanban Board** | Visual task management with 6 columns: Backlog → Analysis → In Progress → Review → Failed → Done | ✅ |
| 2 | **Multi-Agent Pipeline** | Spec → Plan → Implement → QA Review → QA Fix → **Human Review** → Merge or PR | ✅ |
| 3 | **Parallel Agent Terminals** | Up to 12 concurrent Claude sessions working on different subtasks | ✅ |
| 4 | **Git Worktree Isolation** | Every task gets its own worktree; main branch is never touched | ✅ |
| 5 | **Spec Creation Pipeline** | Gather requirements → Research codebase → Write spec → Self-critique | ✅ |
| 6 | **Complexity Assessment** | AI scores complexity to decide parallelism strategy | ✅ |
| 7 | **QA Validation Loop** | Review → Fix → Re-review cycle (max 3 iterations) | ✅ |
| 8 | **Merge or PR** | After human approval: semantic merge locally, or open a Pull Request on GitHub | ✅ |
| 9 | **Memory / Knowledge Graph** | Cross-session learning via Claude Code's built-in Auto Memory (+ Auto Dream when available) | ✅ |
| 10 | **GitHub Integration** | GitHub import page, PR review/creation via GitHub MCP server | ✅ |
| 11 | **Codebase Insights** | Chat interface for exploring and understanding the codebase | ✅ |
| 12 | **Roadmap Generation** | AI-assisted feature planning with code audit, optional competitor analysis, audience targeting, and phased prioritization | ✅ |
| 13 | **Changelog Generation** | Generate release notes from git history | ✅ |
| 14 | **Session Management** | Resume, fork, and track conversation history | ✅ |
| 15 | **Customizable Pipeline Phases** | Users can skip, reorder, or add phases to the build pipeline per project | ✅ |
| 16 | **Ideation / Vulnerability Discovery** | Dedicated scan for improvements, performance issues, and security vulnerabilities | ✅ |
| 17 | **Reference Images on Tasks** | Attach screenshots or design mockups to tasks for agents to reference during implementation | ✅ |
| 18 | **Session Recovery** | If the server restarts mid-pipeline, detect and resume in-progress tasks | ✅ |
| 19 | **Collapsible Sidebar** | Toggle sidebar visibility for more screen space | ✅ |
| 20 | **Expandable Task Descriptions** | Collapse/expand long descriptions in the Kanban view | ✅ |
| 21 | **Multi-Provider Support** | Route agents to different LLM backends (Anthropic, Bedrock, Vertex, Azure, Ollama) via CLI flags | ✅ |
| 22 | **Search, Filter & Bulk Operations** | Search tasks, filter by phase/source, sort, bulk select/move/delete, undo | ✅ |
| 23 | **Analytics Dashboard** | Project metrics and pipeline insights | ✅ |
| 24 | **Agent Terminal Sessions** | Open an interactive terminal session pre-loaded with any user-defined role as the system prompt | ✅ |
| 25 | **Container Isolation** | Run agents inside a devcontainer with host credential mounting | ✅ |
| 26 | **Drag-and-Drop** | Drag tasks between columns with optimistic UI, WebSocket confirmation, and safety timeout | ✅ |
| 27 | **Undo** | Ctrl+Z undo for task moves with 5-second toast | ✅ |
| 28 | **Remote Access (Mobile)** | Access the full TeamAI UI from your phone via Tailscale; ad-hoc terminal via Claude Code Remote Control | ⏭ |
| 29 | **Push Notifications** | Get notified on your phone when tasks need human review (Web Push or Telegram/Discord) | ⏭ |

---

## 2. Architecture

### 2.1 System Diagram

This is a **single Next.js application** — not a backend/frontend split. Next.js App Router runs server-side code (API routes, server actions) in the same process as the React frontend. The only addition is a small custom server wrapper that adds WebSocket support for real-time agent streaming, since Next.js API routes can't hold persistent connections.

```
┌──────────────────────────────────────────────────────────┐
│           SINGLE NEXT.JS PROCESS (custom server.ts)       │
│                                                           │
│  ┌─ React Frontend (browser) ──────────────────────────┐ │
│  │                                                      │ │
│  │  ┌──────────┐  ┌───────────┐  ┌──────────────────┐ │ │
│  │  │  Kanban   │  │  Agent    │  │  File Explorer   │ │ │
│  │  │  Board    │  │  Panels   │  │  + Git View      │ │ │
│  │  └──────────┘  └───────────┘  └──────────────────┘ │ │
│  │                                                      │ │
│  │  Connects to same server via:                        │ │
│  │  - fetch() for API routes (tasks CRUD, run, approve) │ │
│  │  - WebSocket for real-time agent event streaming      │ │
│  └──────────────────────────────────────────────────────┘ │
│                                                           │
│  ┌─ Server-Side (same Node.js process) ────────────────┐ │
│  │                                                      │ │
│  │  ┌──────────────────────────────────────────┐       │ │
│  │  │  Next.js Server Actions + Server Comps    │       │ │
│  │  │  createTask()                (create)     │       │ │
│  │  │  runTask(id)                 (pipeline)   │       │ │
│  │  │  approveTask(id, strategy)   (merge/PR)   │       │ │
│  │  │  rejectTask(id, feedback)    (feedback)   │       │ │
│  │  └───────────────┬──────────────────────────┘       │ │
│  │                  │ imports                           │ │
│  │  ┌───────────────▼──────────────────────────┐       │ │
│  │  │  Shared Modules (src/lib/)                │       │ │
│  │  │                                           │       │ │
│  │  │  ProcessManager  — spawns Claude CLI      │       │ │
│  │  │  Orchestrator    — pipeline state machine  │       │ │
│  │  │  TaskStore       — file-based (.teamai/)    │       │ │
│  │  └───────────────┬──────────────────────────┘       │ │
│  │                  │ spawns                            │ │
│  │  ┌───────────────▼──────────────────────────┐       │ │
│  │  │  Claude CLI Subprocesses                  │       │ │
│  │  │  ┌─────────┐ ┌─────────┐ ┌─────────┐    │       │ │
│  │  │  │Session 1│ │Session 2│ │Session N│    │       │ │
│  │  │  │(Planner)│ │(Coder)  │ │(QA)     │    │       │ │
│  │  │  └────┬────┘ └────┬────┘ └────┬────┘    │       │ │
│  │  │       │  stdin/stdout  (NDJSON)│         │       │ │
│  │  └───────┼────────────────────────┼─────────┘       │ │
│  │          │                        │                  │ │
│  │  ┌───────▼────────────────────────▼─────────┐       │ │
│  │  │  WebSocket Server (ws)                    │       │ │
│  │  │  Broadcasts agent events to browser       │       │ │
│  │  └──────────────────────────────────────────┘       │ │
│  └──────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────┘
                        │
        ┌───────────────┼───────────────┐
        │               │               │
   ┌────▼────┐    ┌─────▼─────┐   ┌────▼────┐
   │  Git    │    │  MCP      │   │  File   │
   │Worktrees│    │  Servers  │   │  System │
   │         │    │(memory,   │   │         │
   │         │    │ github)   │   │         │
   └─────────┘    └───────────┘   └─────────┘
```

**Why a custom server wrapper?** Next.js App Router doesn't support persistent WebSocket connections in API routes. The standard pattern is a `server.ts` that creates an HTTP server, attaches both the Next.js request handler and a `ws` WebSocket server to it, and runs on a single port. This is ~30 lines of code:

```typescript
// server.ts — custom server wrapper (runs everything on one port)
import { createServer } from 'http';
import { parse } from 'url';
import next from 'next';
import { WebSocketServer } from 'ws';
import { processManager } from './src/lib/process-manager';

const app = next({ dev: process.env.NODE_ENV !== 'production' });
const handle = app.getRequestHandler();

app.prepare().then(() => {
  const server = createServer((req, res) => {
    handle(req, res, parse(req.url!, true));
  });

  // Attach WebSocket server to the same HTTP server
  const wss = new WebSocketServer({ server, path: '/ws' });
  wss.on('connection', (ws) => {
    const handler = ({ sessionId, event }: any) => {
      ws.send(JSON.stringify({ sessionId, event }));
    };
    processManager.on('event', handler);
    ws.on('close', () => processManager.off('event', handler));
  });

  // Bind to 0.0.0.0 so the app is accessible from other devices
  // (e.g., phone via Tailscale). Use HOST env var to restrict if needed.
  const host = process.env.HOST || '0.0.0.0';
  const port = process.env.PORT || '3000';
  server.listen(port, host, () => {
    console.log(`> Ready on http://${host}:${port}`);
  });
});
```

### 2.2 How the CLI Subprocess Interface Works

The Claude Code CLI supports bidirectional streaming JSON communication:

```bash
claude -p \
  --input-format stream-json \
  --output-format stream-json \
  --verbose \
  --cwd /path/to/project
```

**Sending a message** (write NDJSON to stdin):
```json
{"type": "user", "content": "Analyze the auth module"}
```

**Receiving events** (read NDJSON from stdout, one per line):
```json
{"type": "text_delta", "text": "The auth module"}
{"type": "tool_use", "name": "Read", "input": {"file_path": "src/auth.ts"}}
{"type": "tool_result", "content": "...file contents..."}
{"type": "text_delta", "text": " uses JWT tokens for..."}
{"type": "message_stop"}
```

**Key properties:**
- Context is preserved across messages within the same subprocess
- All MCP servers configured in the project load automatically
- All slash commands and skills from `.claude/commands/` and `.claude/skills/` are available
- The CLI handles its own authentication (Pro/Max subscription)
- Multiple subprocesses can run in parallel (one per agent session)

### 2.3 Why This Architecture

| Concern | Answer |
|---|---|
| **Cost** | Flat-rate Pro/Max subscription. No API keys, no per-token billing. |
| **Auth restrictions** | CLI subprocess uses the official Claude Code binary — fully permitted under Anthropic's ToS. The Agent SDK would require API keys. |
| **Feature parity** | The CLI exposes everything: tools, MCP servers, skills, commands, sessions, hooks. |
| **Parallelism** | Each subprocess is independent. Spawn as many as your machine and subscription allow. |
| **Complexity** | The backend is just a process manager + state machine. No AI SDK integration code needed. |

### 2.4 Multi-Project Design

The UI app is a **stateless control plane** that can manage multiple target projects. It follows Aperant's pattern: the app itself is project-agnostic; all project-specific state lives inside each target project's directory.

```
~/.teamai/                  # App-level config (lives outside any project)
└── projects.json               # List of registered projects: [{name, path, addedAt}]

/path/to/project-a/             # Target project A
├── .claude/
│   ├── roles/                  # Agent personas (per-project, editable)
│   ├── commands/               # Pipeline commands (per-project)
│   └── settings.json           # MCP server config
├── .teamai/                     # Task state, specs, plans, QA reports
│   ├── add-dark-mode/
│   │   ├── task.json
│   │   ├── spec.md
│   │   └── ...
│   └── fix-auth-bug/
│       └── ...
└── CLAUDE.md                   # Project instructions for Claude

/path/to/project-b/             # Target project B (completely independent)
├── .claude/
│   ├── roles/                  # Different roles for this project
│   ├── commands/
│   └── settings.json
├── .teamai/
└── CLAUDE.md
```

**Key properties:**
- The UI app stores only a list of project paths in `~/.teamai/projects.json`. Everything else lives in the project.
- Each project has its own roles, commands, specs, and MCP configuration. A game project's QA reviewer can care about different things than a fintech project's.
- When you register a project for the first time, the app **scaffolds** the defaults: copies the default role files into `.claude/roles/`, copies the command files into `.claude/commands/`, and creates the `.teamai/` directory.
- Switching projects in the UI just changes which `--cwd` path is passed to spawned Claude CLI subprocesses.
- Deleting a project from the UI doesn't touch the project's files — it just removes the entry from `projects.json`.

### 2.5 Installation & Setup

**Prerequisites:**
- Node.js 20+
- Git
- Claude Code CLI installed and authenticated
- A Claude Pro or Max subscription

**Install:**
```bash
git clone https://github.com/your-org/teamai.git
cd teamai
npm install
npm run dev
# Open http://localhost:3002 (dev, configurable via PORT env var)
```

**First-time use:**
1. Open the app in your browser.
2. Click **"Add Project"** and select a local git repository directory.
3. The app detects whether `.claude/roles/`, `.claude/commands/`, and `.teamai/` exist:
   - If **missing**: scaffolds them with the defaults from Section 3 and 4. Shows a confirmation dialog listing what will be created.
   - If **already present**: uses the existing files. No changes.
4. The project appears in the sidebar. Click it to see its Kanban board.
5. Optionally configure MCP servers for the project (GitHub, Playwright, etc.) from the Settings page — or run `claude mcp add` in the project's terminal.

**Switching projects:** Click any project in the sidebar. The Kanban board, roles, insights, and roadmap views all switch to that project's context.

**Uninstalling from a project:** Click "Remove Project" in settings. This only removes the project from the UI's list — it does **not** delete `.claude/`, `.teamai/`, or any files from the project directory. To fully clean up, manually delete those directories.

---

## 3. Agent Roles (Editable Personas)

Each agent in the pipeline has a **role definition** — a persona file that describes who the agent is, how it thinks, and what standards it holds. These live in each target project's `.claude/roles/` as markdown files.

**The user can edit these** from the UI settings page or by directly editing the files on disk. Both paths write to the same file. This lets you tailor agent behavior to the project — a game project's QA reviewer should care about different things than a fintech project's QA reviewer.

The slash commands (Section 4) reference these roles dynamically: each command starts with `Read and adopt the role defined in .claude/roles/{role}.md` so the persona is injected at runtime.

### 3.1 Default Role Definitions

#### `.claude/roles/analyst.md`

```markdown
# Role: Product Analyst

You are a senior product analyst and requirements engineer.

## Personality
- You think like a product manager who also understands engineering constraints.
- You ask "what if?" constantly — edge cases, error states, and misuse scenarios.
- You write specifications that are precise enough for an engineer to implement without ambiguity.
- You push back on vague requirements rather than filling in gaps with assumptions.

## Standards
- Every requirement must be testable. If you can't write a test for it, rewrite it.
- Acceptance criteria use Given/When/Then format.
- You always consider: accessibility, error handling, backwards compatibility, and data migration.
- You scope aggressively — if something can be deferred, flag it as "future" rather than bloating the spec.

## Context Awareness
- Before writing anything, read the project's CLAUDE.md, README, and existing specs for conventions.
- Match the project's terminology and naming patterns.
- Reference existing code patterns rather than inventing new ones.
```

#### `.claude/roles/planner.md`

```markdown
# Role: Implementation Planner

You are a senior software architect who breaks complex work into deliverable subtasks.

## Personality
- You think in dependency graphs — what must happen before what.
- You look for opportunities to parallelize work across independent modules.
- You're realistic about complexity — you don't underestimate, but you also don't gold-plate.
- You give each subtask enough context that an engineer with no background can pick it up.

## Standards
- Every subtask must be self-contained: clear goal, specific files, acceptance criteria.
- Subtasks should be small enough to complete in a single session (no multi-day epics).
- You identify shared dependencies early and sequence them first.
- You flag risks explicitly rather than hoping things will work out.

## Output Style
- Structured JSON output matching the plan schema exactly.
- Subtask descriptions read like assignments, not wishlists.
```

#### `.claude/roles/coder.md`

```markdown
# Role: Senior Developer

You are a pragmatic senior developer who writes production-quality code.

## Personality
- You read existing code thoroughly before changing anything.
- You match the codebase's style exactly — indentation, naming, patterns, abstractions.
- You write code that is boring and predictable. Cleverness is a bug.
- You test your changes before committing. If tests exist, you run them. If they don't, you write them.

## Standards
- Minimal changes only. Do exactly what the task asks for, nothing more.
- No refactoring unrelated code, no "while I'm here" improvements.
- Every function you add or modify gets at least one test.
- Error handling is mandatory, not optional.
- Commit messages follow Conventional Commits: `feat(scope): description`.

## Guardrails
- If the task description is ambiguous, read the spec for clarification rather than guessing.
- If you need to modify files outside your assigned scope, explain why in the commit message.
- If tests fail after your changes, fix them before committing.
```

#### `.claude/roles/qa-reviewer.md`

```markdown
# Role: QA Reviewer

You are a meticulous QA engineer who finds problems before users do.

## Personality
- You are skeptical by default. You assume code is broken until proven otherwise.
- You check edge cases, error paths, and boundary conditions — not just the happy path.
- You verify that the implementation actually matches the spec, word for word.
- You are fair but strict. A near-miss is still a FAIL.

## Standards
- Every acceptance criterion from the spec gets an explicit PASS or FAIL with evidence.
- You check for: correctness, error handling, test coverage, style consistency, regressions.
- You read the actual git diff, not just the final state of the files.
- You flag security concerns, performance issues, and accessibility gaps even if they're not in the spec.

## Output Style
- Structured JSON report with per-criterion status and evidence.
- Failure descriptions are specific enough for a developer to fix without asking questions.
- You never say "looks good" without showing what you checked.
```

#### `.claude/roles/qa-fixer.md`

```markdown
# Role: Bug Fix Specialist

You are a focused developer who fixes specific issues identified in QA reviews.

## Personality
- You read the QA report carefully and fix exactly what's listed. Nothing more.
- You run the relevant tests after each fix to confirm the issue is resolved.
- You don't refactor or improve code that isn't mentioned in the QA report.
- If a fix requires a significant approach change, you note it in the commit message.

## Standards
- One commit per logical fix, with a message referencing the QA criterion: `fix(qa): description`.
- Re-run tests after every fix.
- If a fix introduces a new issue, fix that too before committing.
```

#### `.claude/roles/merger.md`

```markdown
# Role: Git Integration Specialist

You are a git expert who resolves merge conflicts with semantic understanding.

## Personality
- You read both sides of every conflict to understand the intent behind each change.
- You don't blindly pick one side — you merge the intents together.
- When intents are contradictory, you prefer the feature branch (that's the new work).
- You run the full test suite after resolving conflicts.

## Standards
- The merged code must compile, pass tests, and preserve the intent of both branches.
- You never leave conflict markers in the code.
- You commit with a message explaining how conflicts were resolved.
```

---

## 4. Slash Commands (The Agent Pipeline)

These are the procedural prompts that drive each phase of the pipeline. They live in `.claude/commands/` as markdown files and are invoked via `/command-name` in the CLI.

**Each command starts by reading its role file**, so persona and procedure are cleanly separated. The user edits roles to change *how* agents think; commands define *what* they do.

### 4.1 `/spec` — Specification Creation

```markdown
<!-- .claude/commands/spec.md -->
Read and adopt the role defined in .claude/roles/analyst.md before proceeding.

You are creating a complete specification for a feature. Follow these steps exactly:

## Step 1: Requirements Gathering
Analyze the feature request: $ARGUMENTS
Think through:
- What is the user trying to achieve?
- What are the acceptance criteria? List at least 5 testable criteria.
- What are the edge cases and error states?
- What are the dependencies on existing code?

## Step 2: Codebase Research
Use Glob and Grep to find:
- Related existing code (patterns, naming conventions, similar features)
- Test files that cover adjacent functionality
- Configuration files that may need updates
- API routes, database schemas, or types that are relevant

## Step 3: Write Specification
Create the file `.teamai/{feature-slug}/spec.md` containing:
- **Overview**: One paragraph describing the feature and its motivation
- **Requirements**: Numbered list of specific, unambiguous requirements
- **Acceptance Criteria**: Testable conditions (Given/When/Then format)
- **Files to Modify**: List each file with a one-line rationale
- **New Files to Create**: List with purpose
- **Dependencies & Risks**: External dependencies, breaking changes, migration needs

## Step 4: Self-Critique
Review your own spec. Check for:
- Missing edge cases
- Vague or untestable acceptance criteria
- Scope creep beyond the original request
- Missing files in the modification list
Revise the spec to fix any issues found.

## Step 5: Output
Print the path to the spec file and a one-paragraph summary.
```

### 4.2 `/plan` — Implementation Planning

```markdown
<!-- .claude/commands/plan.md -->
Read and adopt the role defined in .claude/roles/planner.md before proceeding.

You are creating an implementation plan from a specification.

Read the spec at: $ARGUMENTS

## Output
Create `.teamai/{same-slug}/plan.json` with this exact structure:

```json
{
  "complexity": 1-5,
  "estimated_subtasks": N,
  "parallel_safe": true/false,
  "subtasks": [
    {
      "id": 1,
      "title": "Short description",
      "description": "Detailed implementation instructions",
      "files": ["src/path/to/file.ts"],
      "depends_on": [],
      "acceptance_criteria": ["criterion from spec"],
      "parallel_group": "A"
    }
  ]
}
```

Rules:
- Subtasks with the same `parallel_group` letter can run concurrently.
- Subtasks with `depends_on` entries must wait for those IDs to complete.
- Each subtask must be self-contained enough for an independent agent to implement.
- Include ALL files that need to change, not just the primary ones.
- Order subtasks so dependencies are resolved top-down.
```

### 4.3 `/implement` — Subtask Implementation

```markdown
<!-- .claude/commands/implement.md -->
Read and adopt the role defined in .claude/roles/coder.md before proceeding.

You are implementing a single subtask from an implementation plan.

$ARGUMENTS

## Instructions
1. Read the subtask description and acceptance criteria carefully.
2. Read ALL files listed in the subtask before making any changes.
3. Implement the changes. Follow existing code patterns and conventions.
4. Run any existing tests related to the changed files (`npm test`, `pytest`, etc.).
5. If tests fail, fix the issues before proceeding.
6. Commit your changes with a descriptive message: `feat(scope): description`
7. Print a summary of what was changed and the test results.

## Rules
- Only modify files listed in the subtask unless absolutely necessary.
- If you must modify additional files, explain why.
- Do NOT modify files belonging to other subtasks.
- Match existing code style exactly (indentation, naming, patterns).
- Add or update tests for any new functionality.
```

### 4.4 `/qa-review` — Quality Assurance Review

```markdown
<!-- .claude/commands/qa-review.md -->
Read and adopt the role defined in .claude/roles/qa-reviewer.md before proceeding.

You are a QA reviewer validating an implementation against its specification.

Read the spec at: $ARGUMENTS

## Review Process
1. Read the spec's acceptance criteria.
2. Read every file listed in the spec's "Files to Modify" section.
3. Check the git diff to see what actually changed: `git diff main...HEAD`
4. For each acceptance criterion, determine PASS or FAIL with evidence.
5. Check for:
   - Correctness: Does the code do what the spec says?
   - Edge cases: Are error states handled?
   - Tests: Are there tests for the new functionality?
   - Style: Does it match existing code conventions?
   - Regressions: Could this break existing functionality?

## Output
Create `.teamai/{slug}/qa_report.json`:

```json
{
  "overall": "PASS" | "FAIL",
  "criteria": [
    {
      "criterion": "text from spec",
      "status": "PASS" | "FAIL",
      "evidence": "what you found",
      "fix_needed": "description of fix if FAIL"
    }
  ],
  "additional_issues": [
    {
      "severity": "critical" | "warning" | "suggestion",
      "description": "issue found",
      "file": "path",
      "fix_needed": "how to fix"
    }
  ]
}
```
```

### 4.5 `/qa-fix` — Fix QA Issues

```markdown
<!-- .claude/commands/qa-fix.md -->
Read and adopt the role defined in .claude/roles/qa-fixer.md before proceeding.

You are fixing issues found during QA review.

Read the QA report at: $ARGUMENTS

## Instructions
1. Read the QA report and identify all FAIL criteria and critical issues.
2. For each failure, read the relevant code and the fix description.
3. Implement the fix.
4. Run tests to verify the fix doesn't introduce regressions.
5. Commit with message: `fix(qa): description of fix`
6. Print a summary of fixes applied.

## Rules
- Only fix issues identified in the QA report.
- Do not add new features or refactor unrelated code.
- If a fix requires changing the approach significantly, note this in your summary.
```

### 4.6 `/merge` — AI-Powered Merge

```markdown
<!-- .claude/commands/merge.md -->
Read and adopt the role defined in .claude/roles/merger.md before proceeding.

You are merging a feature branch back to the target branch.

## Instructions
1. Run `git merge {branch} --no-commit` to attempt the merge.
2. If there are conflicts, resolve each one semantically:
   - Read both versions of the conflicted code.
   - Understand the intent of each change.
   - Produce a merged version that preserves both intents.
   - If intents are contradictory, prefer the feature branch.
3. Run the project's test suite after resolving conflicts.
4. If tests pass, commit the merge.
5. If tests fail, fix the issues and re-run.
6. Print a summary of conflicts resolved and test results.
```

### 4.7 `/roadmap` — Strategic Feature Planning

```markdown
<!-- .claude/commands/roadmap.md -->
Read and adopt the role defined in .claude/roles/analyst.md before proceeding.

You are a product strategist generating a prioritized feature roadmap.

The user may provide arguments in two forms:
- `/roadmap` — full analysis including auto-discovered competitor analysis
- `/roadmap --skip-competitors` — internal analysis only (skip competitor research)

Competitor analysis is **included by default** — the AI discovers competitors automatically
from the codebase and product domain. The user only needs a flag to opt *out*.

Parse $ARGUMENTS to detect the `--skip-competitors` flag.

---

## Phase 1: Codebase Audit (via Ideation)

Run the `/ideation` command to produce the codebase scan. If an ideation report from
the last 24 hours already exists in `.teamai/ideation/`, read it instead of re-running.

Also read the project's README, CLAUDE.md, and package.json (or equivalent) to understand:
- What the product does and who it's for (target audience)
- The problem it solves and the domain it operates in
- Current feature set
- Tech stack and architecture patterns
- Project maturity (early prototype vs production)

---

## Phase 2: Competitor Analysis (skip only if --skip-competitors flag is present)

### 2a. Competitor Discovery
Using the project understanding from Phase 1, identify competitors automatically:

1. Determine the project's **category** from its README and feature set
   (e.g., "task management app", "API gateway", "e-commerce platform").
2. Use web search to find competitors:
   - Search: "{category} alternatives {year}"
   - Search: "best {category} tools"
   - Search: "open source {category}"
   - Search: "{product name} vs" (if the project has a known product name)
3. Select the **top 3-5 most relevant competitors** based on:
   - Overlap in target audience
   - Overlap in feature set
   - Market presence (stars, downloads, pricing pages)
4. List the discovered competitors with a one-line rationale for each selection.

### 2b. Research
For each discovered competitor, use web search to find:
- The competitor's website, docs, and recent blog posts / changelogs
- Their pricing page and feature comparison tables
- Recent product announcements (last 6 months)
- Public GitHub repos (if open source) — scan for feature set and architecture

### 2c. Feature Comparison Matrix
Build a table:

| Feature | Our Project | Competitor A | Competitor B |
|---------|-------------|-------------|-------------|
| Feature X | ✅ / ❌ / Partial | ✅ / ❌ / Partial | ... |

### 2d. Competitive Positioning
For each competitor, identify:
- **Where they're ahead**: features they have that we don't
- **Where we're ahead**: features we have that they don't
- **Their target audience**: who they're building for (and how it differs from ours)
- **Their recent direction**: what their last 3-5 releases/announcements signal about their strategy
- **Gaps they're ignoring**: underserved needs in the market that neither product addresses

### 2e. Audience Targeting Insights
Based on the competitor analysis:
- Who are the users that competitors are NOT serving well?
- What positioning angle would differentiate us most clearly?
- What features would make the strongest case for switching?

---

## Phase 3: Roadmap Generation

### 3a. Collect All Findings
Combine the ideation scan (Phase 1) with competitor insights (Phase 2, if available).
The ideation scan provides the tactical findings (bugs, security issues, performance problems).
The competitor analysis provides the strategic findings (feature gaps, positioning opportunities).

### 3b. Generate Roadmap Items
For each finding, create a roadmap item with:
- **Title**: concise feature/fix name
- **Category**: one of: Critical Fix | Security | Performance | DX (Developer Experience) | New Feature | Competitive Response | Infrastructure
- **Priority**: P0 (urgent) / P1 (high) / P2 (medium) / P3 (low)
- **Complexity**: 1 (trivial) to 5 (major effort)
- **Description**: 2-3 sentences explaining what and why
- **Affected files**: list of files/modules involved
- **Source**: "ideation" or "competitor-analysis" — where this finding came from
- **Competitive context** (if applicable): which competitor has this, or which gap this fills

### 3c. Prioritization Logic
Rank by this priority order:
1. P0: Security vulnerabilities, data loss risks, broken core functionality
2. P1: Features that close competitive gaps or address the largest user pain points
3. P2: Performance improvements, DX improvements, missing tests
4. P3: Nice-to-haves, polish, exploratory features

### 3d. Group into Phases
Organize items into implementation phases:
- **Phase 1 (Now)**: P0 items + quick P1 wins (complexity ≤ 2)
- **Phase 2 (Next)**: Remaining P1 items + high-impact P2 items
- **Phase 3 (Later)**: P2 items + P3 items
- **Icebox**: Ideas worth tracking but not yet prioritized

---

## Output

Save the roadmap to `.teamai/roadmap/roadmap-{date}.md` with:
1. Executive summary (3-5 sentences)
2. Ideation findings summary (from Phase 1, with link to full ideation report)
3. Competitor comparison matrix (if competitor analysis was run)
4. Phased roadmap with all items

Also save `.teamai/roadmap/roadmap-{date}.json` with structured data so the UI
can render the roadmap items as cards on the Kanban board.

Print a summary of the top 10 highest-priority items to stdout.
```

### 4.8 `/changelog` — Release Notes

```markdown
<!-- .claude/commands/changelog.md -->
Generate release notes from recent git history.

## Instructions
1. Run `git log --oneline {last_tag}..HEAD` to get recent commits.
2. Group commits by type (feat, fix, chore, docs, refactor, test).
3. Write release notes in Keep a Changelog format.
4. Highlight breaking changes prominently.
5. Print the changelog to stdout.
```

### 4.9 `/ideation` — Improvement & Vulnerability Discovery

```markdown
<!-- .claude/commands/ideation.md -->
Read and adopt the role defined in .claude/roles/analyst.md before proceeding.

You are performing a deep scan of this codebase to discover improvements,
performance issues, and security vulnerabilities. This is NOT a roadmap —
it's a targeted audit that surfaces actionable findings.

## Step 1: Security Scan
Search the codebase for:
- Hardcoded secrets, API keys, tokens, passwords (grep for patterns like `api_key`, `secret`, `password`, `token` in string literals)
- SQL injection vectors (string concatenation in queries)
- Missing input validation on user-facing endpoints
- Missing authentication/authorization checks
- Insecure dependencies (check for known CVEs in package.json / lock file versions)
- Exposed debug endpoints or verbose error messages in production paths
- Missing CORS configuration or overly permissive CORS
- Missing rate limiting on public endpoints

## Step 2: Performance Scan
Search for:
- N+1 query patterns (loops that make individual database/API calls)
- Synchronous operations that should be async (blocking I/O in request handlers)
- Missing indexes (large collections queried without indexed fields)
- Unbounded queries (no LIMIT/pagination on list endpoints)
- Large bundle sizes (unused imports, heavy dependencies that could be lazy-loaded)
- Missing caching where repeated expensive computations occur
- Memory leaks (event listeners never removed, growing arrays/maps never pruned)

## Step 3: Code Quality Scan
Search for:
- Dead code (exported functions/classes with zero imports)
- Duplicated logic (similar code blocks across multiple files)
- Missing error handling (try/catch gaps, unhandled promise rejections)
- Inconsistent patterns (some files use one approach, others use another)
- Missing types (any casts, untyped function parameters in TypeScript)
- Overly complex functions (deeply nested conditionals, functions > 50 lines)

## Step 4: Infrastructure Scan
Check for:
- Missing or incomplete CI/CD configuration
- Missing environment variable validation at startup
- Missing health check endpoints
- Missing structured logging
- Missing database migration scripts
- Missing backup/recovery procedures in documentation

## Output
Save to `.teamai/ideation/ideation-{date}.json`:
```json
{
  "security": [
    { "severity": "critical|high|medium|low", "title": "...", "file": "...", "line": N, "description": "...", "fix": "..." }
  ],
  "performance": [ ... ],
  "code_quality": [ ... ],
  "infrastructure": [ ... ],
  "summary": {
    "critical": N,
    "high": N,
    "medium": N,
    "low": N,
    "total": N
  }
}
```

Print a summary table to stdout showing counts by severity and category.
Each finding should be specific enough to act on — file path, line number, and a concrete fix description.
```

---

## 5. Memory & MCP Server Configuration

### 5.1 Memory Architecture

**Aperant's approach:** Aperant uses a Graphiti-based knowledge graph accessed via a Python MCP sidecar process. It stores entities (code patterns, architectural decisions, user preferences) and relations between them, with semantic search over embeddings. Aperant's V5 design document (in-progress) planned to move from Graphiti to a TypeScript-native knowledge graph backed by Turso/libSQL, with a scratchpad-to-validated promotion pipeline and cross-session pattern synthesis. The memory system was one of Aperant's most complex subsystems — and also one of its most problematic (see GitHub issues around Ollama embedding failures, missing memories, and Graphiti import path bugs).

**Our approach: use Claude Code's built-in Auto Memory.** No MCP server, no database, no sidecar process.

Claude Code already has a mature, file-based memory system that does what we need:

- **Auto Memory** (shipped, on by default) — Claude automatically saves notes about your project as it works: build commands, debugging insights, architecture decisions, code style preferences, error resolutions. Stored as plain markdown at `~/.claude/projects/<project>/memory/`. The `MEMORY.md` index (first 200 lines) is loaded at the start of every session; topic files are read on demand.
- **Auto Dream** (built-in, rolling out gradually) — A consolidation process that runs between sessions: converts relative dates to absolute, deletes contradicted facts, removes stale memories, and merges overlapping entries. The toggle exists in `/memory` settings, but Anthropic is enabling it gradually via a server-side feature flag. Check `/memory` in your Claude session — if you see "Auto-dream: on", you have it. If it shows "off" and can't be toggled, it's not yet available for your account. You can manually run `/dream` to trigger a one-time consolidation regardless.
- **Worktree sharing** — The memory directory is derived from the git repository, so all worktrees and subdirectories within the same repo share one memory. All our parallel agents automatically share the same learned knowledge.
- **Editable** — Memory files are plain markdown you can inspect with `cat`, edit with any text editor, or delete at will.

**No configuration needed.** Auto Memory is on by default in Claude Code v2.1.59+. To verify it's active, run `/memory` in any Claude session. To customize the storage location, set `autoMemoryDirectory` in your user settings.

**When to escalate to an MCP memory server:** If you later need structured entity-relation queries ("what patterns connect module X to module Y?"), cross-project memory sharing, or vector-based semantic search beyond what Auto Memory provides, these are the options ranked by complexity:

| Option | What It Adds | Install |
|---|---|---|
| **`@modelcontextprotocol/server-memory`** | Anthropic's official knowledge graph MCP. Stores entities, relations, and observations as JSONL. Simplest MCP option. | `claude mcp add memory -- npx -y @modelcontextprotocol/server-memory` |
| **`mcp-knowledge-graph`** | Community fork with per-project `.aim/` directories, named databases, and cross-machine sync via Dropbox/iCloud. | `claude mcp add knowledge-graph -- npx -y mcp-knowledge-graph` |
| **Supermemory** | Hosted service. Extracts facts, tracks changes over time, builds a user profile, 81.6% on LongMemEval. Injects context automatically at session start. | `claude plugin install claude-supermemory` |
| **`mcp-memory-service`** | Most feature-rich. Web dashboard, D3.js knowledge graph visualization, cloud sync, session harvest. Heavy. | See repo for Docker/npm setup |

For this project, start with Auto Memory. It covers 90% of what Aperant's Graphiti system did, with zero setup.

### 5.2 Required MCP Servers

```bash
# GitHub integration (issues, PRs, reviews)
claude mcp add github --scope project -- npx -y @modelcontextprotocol/server-github
# Requires: GITHUB_PERSONAL_ACCESS_TOKEN env var
```

### 5.3 Optional MCP Servers

```bash
# Browser automation for E2E testing in QA phase
claude mcp add playwright --scope project -- npx -y @anthropic-ai/mcp-playwright

# Up-to-date framework documentation
claude mcp add context7 --scope project -- npx -y @upstash/context7-mcp

# Web search for research phase
claude mcp add brave-search --scope project -- npx -y @brave/brave-search-mcp-server
# Requires: BRAVE_API_KEY env var
```

---

## 6. Server-Side Modules

Everything below runs inside the single Next.js process. These are TypeScript modules in `src/lib/` imported by API routes and the custom server wrapper.

### 6.1 Tech Stack

| Component | Technology |
|---|---|
| **Runtime** | Node.js 20+ |
| **Framework** | Next.js 15 (App Router) with custom `server.ts` for WebSocket |
| **Real-time** | `ws` WebSocket server attached to the same HTTP server |
| **State storage** | Flat files in `.teamai/` — one directory per task, JSON metadata |
| **Process management** | Node.js `child_process.spawn()` |
| **UI** | React 19 + Tailwind CSS + shadcn/ui |
| **Terminal rendering** | xterm.js 6 (for raw agent output display)
| **PTY management** | `node-pty` (spawns interactive terminal sessions for agent terminals) |

### 6.2 Process Manager (`lib/process-manager.ts`)

This is the core module. It spawns Claude CLI subprocesses and manages their lifecycle.

```typescript
import { spawn, ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import { randomUUID } from 'crypto';

interface AgentSession {
  id: string;
  process: ChildProcess;
  taskId: string;
  role: 'planner' | 'coder' | 'qa-reviewer' | 'qa-fixer' | 'merger' | 'general';
  cwd: string;
  status: 'running' | 'idle' | 'done' | 'error';
}

class ProcessManager extends EventEmitter {
  private sessions: Map<string, AgentSession> = new Map();

  /**
   * Spawn a new Claude CLI subprocess for an agent session.
   * The process stays alive for multi-turn conversation.
   */
  createSession(opts: {
    taskId: string;
    role: AgentSession['role'];
    cwd: string;
    model?: string;
    permissionMode?: string;
  }): string {
    const id = randomUUID();

    const args = [
      '-p',
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--verbose',
      '--cwd', opts.cwd,
    ];

    if (opts.model) {
      args.push('--model', opts.model);
    }

    if (opts.permissionMode) {
      args.push('--permission-mode', opts.permissionMode);
    }

    const proc = spawn('claude', args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
    });

    // Parse NDJSON from stdout line by line
    let buffer = '';
    proc.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        if (line.trim()) {
          try {
            const event = JSON.parse(line);
            this.emit('event', { sessionId: id, event });
          } catch {
            this.emit('raw', { sessionId: id, data: line });
          }
        }
      }
    });

    proc.stderr.on('data', (chunk: Buffer) => {
      this.emit('error', { sessionId: id, error: chunk.toString() });
    });

    proc.on('exit', (code) => {
      const session = this.sessions.get(id);
      if (session) session.status = code === 0 ? 'done' : 'error';
      this.emit('exit', { sessionId: id, code });
    });

    this.sessions.set(id, {
      id,
      process: proc,
      taskId: opts.taskId,
      role: opts.role,
      cwd: opts.cwd,
      status: 'running',
    });

    return id;
  }

  /**
   * Send a message (or slash command) to an existing session.
   */
  sendMessage(sessionId: string, content: string): void {
    const session = this.sessions.get(sessionId);
    if (!session || !session.process.stdin.writable) {
      throw new Error(`Session ${sessionId} not available`);
    }
    const msg = JSON.stringify({ type: 'user', content }) + '\n';
    session.process.stdin.write(msg);
  }

  /**
   * Kill a session's subprocess.
   */
  killSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.process.kill('SIGTERM');
      session.status = 'done';
    }
  }

  getSession(id: string): AgentSession | undefined {
    return this.sessions.get(id);
  }

  getAllSessions(): AgentSession[] {
    return Array.from(this.sessions.values());
  }
}

export const processManager = new ProcessManager();
```

### 6.3 Orchestrator (`lib/orchestrator.ts`)

The state machine that drives the multi-agent pipeline.

```typescript
import { processManager } from './process-manager';
import { taskStore } from './task-store';
import { execSync } from 'child_process';
import { readFileSync, writeFileSync } from 'fs';
import path from 'path';

type PipelinePhase =
  | 'spec'
  | 'plan'
  | 'implement'
  | 'qa-review'
  | 'qa-fix'
  | 'awaiting-review'   // Human must approve before merge/PR
  | 'merge'
  | 'create-pr'
  | 'done'
  | 'failed';

type MergeStrategy = 'local-merge' | 'pull-request';

interface TaskPipeline {
  taskId: string;
  description: string;
  phase: PipelinePhase;
  specPath: string;
  worktreePath: string;
  branch: string;
  qaAttempt: number;
  maxQaAttempts: number;
  mergeStrategy?: MergeStrategy; // Set by human during review
  sessionId?: string;
}

class Orchestrator {
  private pipelines: Map<string, TaskPipeline> = new Map();
  private projectRoot: string;

  constructor(projectRoot: string) {
    this.projectRoot = projectRoot;
  }

  /**
   * Start the full autonomous pipeline for a task.
   */
  async runTask(taskId: string, description: string): Promise<void> {
    const slug = this.slugify(description);
    const branch = `feat/${slug}`;
    const worktreePath = path.join(this.projectRoot, '..', 'worktrees', slug);

    // The task directory was already created by taskStore.create()
    const specPath = taskStore.getDirBySlug(slug);

    const pipeline: TaskPipeline = {
      taskId,
      description,
      phase: 'spec',
      specPath,
      worktreePath,
      branch,
      qaAttempt: 0,
      maxQaAttempts: 3,
    };

    this.pipelines.set(taskId, pipeline);
    taskStore.updatePhase(taskId, 'spec');

    await this.executePhase(pipeline);
  }

  private async executePhase(pipeline: TaskPipeline): Promise<void> {
    switch (pipeline.phase) {
      case 'spec':
        await this.runSpec(pipeline);
        break;
      case 'plan':
        await this.runPlan(pipeline);
        break;
      case 'implement':
        await this.runImplement(pipeline);
        break;
      case 'qa-review':
        await this.runQaReview(pipeline);
        break;
      case 'qa-fix':
        await this.runQaFix(pipeline);
        break;
      case 'awaiting-review':
        // Pipeline STOPS here. Human must call approveTask() to continue.
        break;
      case 'merge':
        await this.runMerge(pipeline);
        break;
      case 'create-pr':
        await this.runCreatePR(pipeline);
        break;
    }
  }

  private async runSpec(pipeline: TaskPipeline): Promise<void> {
    const sessionId = processManager.createSession({
      taskId: pipeline.taskId,
      role: 'planner',
      cwd: this.projectRoot,
    });
    pipeline.sessionId = sessionId;

    // Wait for the session to be ready, then send the command
    processManager.sendMessage(sessionId, `/spec ${pipeline.description}`);

    // Listen for completion (message_stop event), then advance
    await this.waitForCompletion(sessionId);
    processManager.killSession(sessionId);

    pipeline.phase = 'plan';
    taskStore.updatePhase(pipeline.taskId, 'plan');
    await this.executePhase(pipeline);
  }

  private async runPlan(pipeline: TaskPipeline): Promise<void> {
    const sessionId = processManager.createSession({
      taskId: pipeline.taskId,
      role: 'planner',
      cwd: this.projectRoot,
    });
    pipeline.sessionId = sessionId;

    processManager.sendMessage(sessionId, `/plan ${pipeline.specPath}/spec.md`);
    await this.waitForCompletion(sessionId);
    processManager.killSession(sessionId);

    // Create worktree for implementation
    execSync(`git worktree add "${pipeline.worktreePath}" -b "${pipeline.branch}"`, {
      cwd: this.projectRoot,
    });

    pipeline.phase = 'implement';
    taskStore.updatePhase(pipeline.taskId, 'implement');
    await this.executePhase(pipeline);
  }

  private async runImplement(pipeline: TaskPipeline): Promise<void> {
    // Read plan.json to get subtasks
    const planPath = path.join(pipeline.specPath, 'plan.json');
    const plan = JSON.parse(readFileSync(planPath, 'utf-8'));

    // Group subtasks by parallel_group
    const groups = new Map<string, any[]>();
    for (const subtask of plan.subtasks) {
      const group = subtask.parallel_group || subtask.id.toString();
      if (!groups.has(group)) groups.set(group, []);
      groups.get(group)!.push(subtask);
    }

    // Execute groups sequentially, subtasks within a group in parallel
    for (const [, subtasks] of groups) {
      await Promise.allSettled(
        subtasks.map(async (subtask: any) => {
          const sessionId = processManager.createSession({
            taskId: pipeline.taskId,
            role: 'coder',
            cwd: pipeline.worktreePath,
          });

          const prompt = `/implement Subtask ${subtask.id}: ${subtask.title}\n\n${subtask.description}\n\nFiles: ${subtask.files.join(', ')}\n\nAcceptance criteria: ${subtask.acceptance_criteria.join('; ')}`;

          processManager.sendMessage(sessionId, prompt);
          await this.waitForCompletion(sessionId);
          processManager.killSession(sessionId);
        })
      );
    }

    pipeline.phase = 'qa-review';
    taskStore.updatePhase(pipeline.taskId, 'qa-review');
    await this.executePhase(pipeline);
  }

  private async runQaReview(pipeline: TaskPipeline): Promise<void> {
    pipeline.qaAttempt++;
    const sessionId = processManager.createSession({
      taskId: pipeline.taskId,
      role: 'qa-reviewer',
      cwd: pipeline.worktreePath,
    });
    pipeline.sessionId = sessionId;

    processManager.sendMessage(sessionId, `/qa-review ${pipeline.specPath}/spec.md`);
    await this.waitForCompletion(sessionId);
    processManager.killSession(sessionId);

    // Check QA result
    const reportPath = path.join(pipeline.specPath, 'qa_report.json');
    const report = JSON.parse(readFileSync(reportPath, 'utf-8'));

    if (report.overall === 'PASS') {
      // Do NOT auto-merge. Stop and wait for human review.
      pipeline.phase = 'awaiting-review';
      taskStore.updatePhase(pipeline.taskId, 'awaiting-review');
      // Pipeline pauses here. The UI shows the QA report and diff.
      // Human clicks "Merge Locally" or "Open PR" to continue.
      return;
    } else if (pipeline.qaAttempt >= pipeline.maxQaAttempts) {
      pipeline.phase = 'failed';
      taskStore.updatePhase(pipeline.taskId, 'failed');
      return; // Stop — needs human review
    } else {
      pipeline.phase = 'qa-fix';
      taskStore.updatePhase(pipeline.taskId, 'qa-fix');
    }

    await this.executePhase(pipeline);
  }

  private async runQaFix(pipeline: TaskPipeline): Promise<void> {
    const sessionId = processManager.createSession({
      taskId: pipeline.taskId,
      role: 'qa-fixer',
      cwd: pipeline.worktreePath,
    });
    pipeline.sessionId = sessionId;

    processManager.sendMessage(sessionId, `/qa-fix ${pipeline.specPath}/qa_report.json`);
    await this.waitForCompletion(sessionId);
    processManager.killSession(sessionId);

    pipeline.phase = 'qa-review';
    taskStore.updatePhase(pipeline.taskId, 'qa-review');
    await this.executePhase(pipeline);
  }

  /**
   * Called by the UI when the human reviews the QA-passed changes and
   * chooses how to integrate them.
   *
   * strategy: 'local-merge'  → AI-powered semantic merge into target branch
   *           'pull-request'  → push branch and open a PR via GitHub MCP
   */
  async approveTask(taskId: string, strategy: MergeStrategy): Promise<void> {
    const pipeline = this.pipelines.get(taskId);
    if (!pipeline || pipeline.phase !== 'awaiting-review') {
      throw new Error(`Task ${taskId} is not awaiting review`);
    }

    pipeline.mergeStrategy = strategy;

    if (strategy === 'local-merge') {
      pipeline.phase = 'merge';
      taskStore.updatePhase(taskId, 'merge');
    } else {
      pipeline.phase = 'create-pr';
      taskStore.updatePhase(taskId, 'create-pr');
    }

    await this.executePhase(pipeline);
  }

  /**
   * Called by the UI when the human wants to reject and send back for more work.
   * Resets the task to the implement phase so agents can try again.
   */
  async rejectTask(taskId: string, feedback: string): Promise<void> {
    const pipeline = this.pipelines.get(taskId);
    if (!pipeline || pipeline.phase !== 'awaiting-review') {
      throw new Error(`Task ${taskId} is not awaiting review`);
    }

    // Write the human feedback so the coder agent can read it
    const feedbackPath = path.join(pipeline.specPath, 'human_feedback.md');
    writeFileSync(feedbackPath, `# Human Review Feedback\n\n${feedback}\n`);

    pipeline.qaAttempt = 0; // Reset QA counter for the new round
    pipeline.phase = 'implement';
    taskStore.updatePhase(taskId, 'implement');
    await this.executePhase(pipeline);
  }

  private async runMerge(pipeline: TaskPipeline): Promise<void> {
    const sessionId = processManager.createSession({
      taskId: pipeline.taskId,
      role: 'merger',
      cwd: this.projectRoot,
    });
    pipeline.sessionId = sessionId;

    processManager.sendMessage(sessionId, `/merge ${pipeline.branch}`);
    await this.waitForCompletion(sessionId);
    processManager.killSession(sessionId);

    // Cleanup worktree
    execSync(`git worktree remove "${pipeline.worktreePath}"`, { cwd: this.projectRoot });
    execSync(`git branch -d "${pipeline.branch}"`, { cwd: this.projectRoot });

    pipeline.phase = 'done';
    taskStore.updatePhase(pipeline.taskId, 'done');
  }

  private async runCreatePR(pipeline: TaskPipeline): Promise<void> {
    // Push the worktree branch to origin
    execSync(`git push -u origin "${pipeline.branch}"`, { cwd: pipeline.worktreePath });

    // Use a Claude session with GitHub MCP to create the PR
    const sessionId = processManager.createSession({
      taskId: pipeline.taskId,
      role: 'merger',
      cwd: pipeline.worktreePath,
    });
    pipeline.sessionId = sessionId;

    const specContent = readFileSync(
      path.join(pipeline.specPath, 'spec.md'), 'utf-8'
    );

    processManager.sendMessage(sessionId,
      `Create a Pull Request for branch "${pipeline.branch}" targeting the main branch.\n\n` +
      `Use the GitHub MCP server's create_pull_request tool.\n\n` +
      `Title: ${pipeline.description}\n\n` +
      `Body: Generate a clear PR description from this spec:\n\n${specContent}\n\n` +
      `Include a summary of changes, testing done (QA passed), and any notes for reviewers.`
    );
    await this.waitForCompletion(sessionId);
    processManager.killSession(sessionId);

    // Don't cleanup worktree yet — the PR is still open.
    // Worktree cleanup happens when the PR is merged (could be a future webhook).
    pipeline.phase = 'done';
    taskStore.updatePhase(pipeline.taskId, 'done');
  }

  private waitForCompletion(sessionId: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const onEvent = ({ sessionId: sid, event }: any) => {
        if (sid !== sessionId) return;
        if (event.type === 'result') {
          processManager.off('event', onEvent);
          processManager.off('exit', onExit);
          resolve();
        }
      };
      const onExit = ({ sessionId: sid, code }: any) => {
        if (sid !== sessionId) return;
        processManager.off('event', onEvent);
        processManager.off('exit', onExit);
        if (code === 0) resolve();
        else reject(new Error(`Session exited with code ${code}`));
      };
      processManager.on('event', onEvent);
      processManager.on('exit', onExit);
    });
  }

  private slugify(text: string): string {
    return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40);
  }
}

export { Orchestrator };
```

### 6.4 Task Store (`lib/task-store.ts`)

File-based task storage. Each task is a directory under `.teamai/` containing a `task.json` metadata file alongside the spec, plan, and QA artifacts. No database — just files you can inspect with `ls` and `cat`.

**Directory structure per task:**
```
.teamai/
├── add-dark-mode/
│   ├── task.json              # Metadata: id, title, description, phase, timestamps
│   ├── spec.md                # Created by /spec
│   ├── plan.json              # Created by /plan
│   ├── qa_report.json         # Created by /qa-review
│   ├── human_feedback.md      # Created by rejectTask() if rejected
│   └── events.jsonl           # Append-only log of phase transitions
├── fix-auth-bug/
│   ├── task.json
│   └── ...
└── roadmap/
    ├── roadmap-2026-04-12.md
    └── roadmap-2026-04-12.json
```

**`task.json` schema:**
```json
{
  "id": "a1b2c3d4",
  "title": "Add dark mode toggle",
  "description": "Add a dark mode toggle to the settings page...",
  "phase": "awaiting-review",
  "branch": "feat/add-dark-mode",
  "createdAt": "2026-04-12T10:30:00Z",
  "updatedAt": "2026-04-12T11:45:00Z"
}
```

**Implementation:**

```typescript
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync, appendFileSync } from 'fs';
import { join } from 'path';

interface Task {
  id: string;
  title: string;
  description: string;
  phase: string;
  branch?: string;
  createdAt: string;
  updatedAt: string;
}

function slugify(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40);
}

/**
 * TaskStore is instantiated per project. The project path determines
 * where .teamai/ lives. Usage:
 *   const store = new TaskStore('/path/to/project');
 *   store.create(id, title, description);
 */
export class TaskStore {
  private specsDir: string;

  constructor(projectPath: string) {
    this.specsDir = join(projectPath, '.teamai');
    mkdirSync(this.specsDir, { recursive: true });
  }

  create(id: string, title: string, description: string): Task {
    const slug = slugify(title);
    const dir = join(this.specsDir, slug);
    mkdirSync(dir, { recursive: true });

    const task: Task = {
      id,
      title,
      description,
      phase: 'backlog',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    writeFileSync(join(dir, 'task.json'), JSON.stringify(task, null, 2));
    return task;
  }

  updatePhase(id: string, phase: string): void {
    const task = this.getById(id);
    if (!task) throw new Error(`Task ${id} not found`);

    task.phase = phase;
    task.updatedAt = new Date().toISOString();

    const dir = this.getDirById(id);
    writeFileSync(join(dir, 'task.json'), JSON.stringify(task, null, 2));

    // Append to event log
    const event = { phase, timestamp: new Date().toISOString() };
    appendFileSync(join(dir, 'events.jsonl'), JSON.stringify(event) + '\n');
  }

  getAll(): Task[] {
    if (!existsSync(this.specsDir)) return [];
    return readdirSync(this.specsDir, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => {
        const taskPath = join(this.specsDir, d.name, 'task.json');
        if (!existsSync(taskPath)) return null;
        return JSON.parse(readFileSync(taskPath, 'utf-8')) as Task;
      })
      .filter((t): t is Task => t !== null)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  getById(id: string): Task | null {
    return this.getAll().find(t => t.id === id) || null;
  }

  getDirById(id: string): string {
    const dirs = readdirSync(this.specsDir, { withFileTypes: true }).filter(d => d.isDirectory());
    for (const d of dirs) {
      const taskPath = join(this.specsDir, d.name, 'task.json');
      if (existsSync(taskPath)) {
        const task = JSON.parse(readFileSync(taskPath, 'utf-8'));
        if (task.id === id) return join(this.specsDir, d.name);
      }
    }
    throw new Error(`Task directory not found for id ${id}`);
  }

  getDirBySlug(slug: string): string {
    return join(this.specsDir, slug);
  }

  getEvents(taskId: string): Array<{ phase: string; timestamp: string }> {
    const dir = this.getDirById(taskId);
    const eventsPath = join(dir, 'events.jsonl');
    if (!existsSync(eventsPath)) return [];
    return readFileSync(eventsPath, 'utf-8')
      .split('\n')
      .filter(line => line.trim())
      .map(line => JSON.parse(line));
  }
}
```

### 6.5 Project Store (`lib/project-store.ts`)

Manages the list of registered projects. Stores a single JSON file at `~/.teamai/projects.json`.

```typescript
import { readFileSync, writeFileSync, mkdirSync, existsSync, cpSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const CONFIG_DIR = join(homedir(), '.teamai');
const PROJECTS_FILE = join(CONFIG_DIR, 'projects.json');
const DEFAULTS_DIR = join(__dirname, '..', '..', 'defaults'); // ships with the app

interface Project {
  name: string;         // Display name (defaults to directory basename)
  path: string;         // Absolute path to the git repo
  addedAt: string;
}

export class ProjectStore {
  constructor() {
    mkdirSync(CONFIG_DIR, { recursive: true });
    if (!existsSync(PROJECTS_FILE)) {
      writeFileSync(PROJECTS_FILE, '[]');
    }
  }

  getAll(): Project[] {
    return JSON.parse(readFileSync(PROJECTS_FILE, 'utf-8'));
  }

  getByPath(projectPath: string): Project | null {
    return this.getAll().find(p => p.path === projectPath) || null;
  }

  /**
   * Register a new project. Scaffolds .claude/roles/, .claude/commands/,
   * and .teamai/ with defaults if they don't already exist.
   */
  add(projectPath: string, name?: string): Project {
    const projects = this.getAll();
    if (projects.some(p => p.path === projectPath)) {
      throw new Error(`Project already registered: ${projectPath}`);
    }

    // Scaffold defaults into the target project
    this.scaffold(projectPath);

    const project: Project = {
      name: name || projectPath.split('/').pop() || projectPath,
      path: projectPath,
      addedAt: new Date().toISOString(),
    };

    projects.push(project);
    writeFileSync(PROJECTS_FILE, JSON.stringify(projects, null, 2));
    return project;
  }

  remove(projectPath: string): void {
    const projects = this.getAll().filter(p => p.path !== projectPath);
    writeFileSync(PROJECTS_FILE, JSON.stringify(projects, null, 2));
    // Does NOT delete any files from the project directory
  }

  /**
   * Copy default roles and commands into the target project
   * if they don't already exist. Never overwrites existing files.
   */
  private scaffold(projectPath: string): void {
    const targets = [
      { src: join(DEFAULTS_DIR, 'roles'), dest: join(projectPath, '.claude', 'roles') },
      { src: join(DEFAULTS_DIR, 'commands'), dest: join(projectPath, '.claude', 'commands') },
    ];

    for (const { src, dest } of targets) {
      if (!existsSync(dest)) {
        mkdirSync(dest, { recursive: true });
        cpSync(src, dest, { recursive: true });
      }
    }

    // Create .teamai/ directory
    mkdirSync(join(projectPath, '.teamai'), { recursive: true });

    // Create CLAUDE.md if it doesn't exist
    const claudeMdPath = join(projectPath, 'CLAUDE.md');
    if (!existsSync(claudeMdPath)) {
      cpSync(join(DEFAULTS_DIR, 'CLAUDE.md'), claudeMdPath);
    }
  }
}

export const projectStore = new ProjectStore();
```

The `defaults/` directory ships with the app and contains the default role files (Section 3), command files (Section 4), and the CLAUDE.md template (Section 9).

---

## 7. Frontend Implementation

### 7.1 Page Structure

No API routes. All mutations use **Next.js Server Actions** (direct server-side function calls from React). All reads use **Server Components** that import the stores directly. The only network layer is the WebSocket in `server.ts` for real-time agent streaming.

The app has a **sidebar with a project selector**. All pages operate in the context of the currently selected project. Switching projects changes which `.teamai/` and `.claude/` directories are read.

| Route | Page | Description |
|---|---|---|
| `/` | Kanban Board | Main working view with 6 columns, search, filter, bulk ops, drag-and-drop |
| `/task/[id]` | Task Detail | Full-page tabs: Overview, Terminal, Spec, Plan, QA |
| `/insights` | Insights | Streaming chat with Claude about the active codebase |
| `/ideation` | Ideation | AI brainstorming for new tasks |
| `/terminals` | Terminals | Interactive PTY Claude sessions pre-loaded with role personas |
| `/roadmap` | Roadmap | Two-tab view: Roadmap (phased AI-generated items) + Changelog (release notes from git history) |
| `/settings` | Settings | Container isolation, pipeline phases, providers, agent roles |
| `/analytics` | Analytics | Project metrics and pipeline insights |
| `/github` | GitHub | Import issues, manage PRs via GitHub MCP |

```
app/
├── layout.tsx                  # Root layout with sidebar: project selector + nav
├── page.tsx                    # Kanban board (Server Component, reads tasks from selected project)
├── task/[id]/page.tsx          # Task detail: Overview, Terminal, Spec, Plan, QA tabs
├── insights/page.tsx           # Streaming codebase chat interface
├── ideation/page.tsx           # Codebase vulnerability scanner
├── terminals/page.tsx          # Interactive PTY terminal sessions
├── roadmap/page.tsx            # Roadmap generator + changelog viewer
├── settings/page.tsx           # Container, pipeline, providers, roles config
├── analytics/page.tsx          # Project metrics dashboard
├── github/page.tsx             # GitHub issue import + PR management
├── actions/
│   ├── tasks.ts                # Task + pipeline Server Actions
│   ├── roles.ts                # Role CRUD Server Actions
│   ├── pipeline.ts             # Pipeline config Server Actions
│   ├── roadmap.ts              # Roadmap/changelog Server Actions
│   └── projects.ts             # Project registration Server Actions
├── components/
│   ├── ui/                     # shadcn/ui primitives
│   ├── project-selector.tsx    # Sidebar project list + "Add Project" button
│   ├── kanban-board.tsx        # 6-column drag-and-drop board with search, filter, bulk ops, undo
│   ├── task-card.tsx           # Card with phase badge, description toggle, play button
│   ├── task-panel.tsx          # Floating window overlay for task detail
│   ├── task-detail.tsx         # Tabbed content: Overview/Terminal/Spec/Plan/QA
│   ├── agent-panel.tsx         # Shows streaming agent output (xterm.js)
│   ├── review-panel.tsx        # Human review: diff viewer + approve/reject buttons
│   ├── role-editor.tsx         # Markdown editor for agent persona files
│   ├── pipeline-config.tsx     # Pipeline phase config editor
│   ├── provider-config.tsx     # Per-role model/provider assignment
│   ├── container-config.tsx    # Devcontainer isolation toggle + status
│   ├── roadmap-view.tsx        # Full roadmap/changelog page with phased kanban
│   ├── ideation-scanner.tsx    # Run Scan button + streaming ideation output
│   ├── insights-chat.tsx       # Chat interface for codebase Q&A
│   ├── terminals-view.tsx      # Terminal grid with PTY sessions
│   └── connection-indicator.tsx # WebSocket connection status dot
├── hooks/
│   ├── use-websocket.ts        # WebSocket client hook
│   ├── use-phase-sync.ts       # Real-time phase change sync
│   └── use-session-stream.ts   # Session event streaming hook
├── lib/
│   ├── process-manager.ts      # Spawns Claude CLI subprocesses
│   ├── orchestrator.ts         # Pipeline state machine
│   ├── task-store.ts           # File-based task storage
│   ├── project-store.ts        # Multi-project management
│   ├── container-manager.ts    # Devcontainer lifecycle
│   └── stream-types.ts         # NDJSON/WebSocket event types
└── constants/
    └── phases.ts               # Phase badges, labels, priority colors
```

### 7.2 Server Actions (`app/actions/tasks.ts`)

```typescript
'use server';

import { TaskStore } from '@/lib/task-store';
import { Orchestrator } from '@/lib/orchestrator';
import { getActiveProjectPath } from './projects';
import { revalidatePath } from 'next/cache';
import { randomUUID } from 'crypto';

// Helper: get stores for the currently active project
function getStores() {
  const projectPath = getActiveProjectPath();
  return {
    taskStore: new TaskStore(projectPath),
    orchestrator: new Orchestrator(projectPath),
  };
}

export async function createTask(formData: FormData) {
  const { taskStore } = getStores();
  const id = randomUUID();
  const title = formData.get('title') as string;
  const description = formData.get('description') as string;
  taskStore.create(id, title, description);
  revalidatePath('/');
  return { id };
}

export async function runTask(taskId: string) {
  const { taskStore, orchestrator } = getStores();
  const task = taskStore.getById(taskId);
  if (!task) throw new Error(`Task ${taskId} not found`);
  orchestrator.runTask(taskId, task.description);
  revalidatePath('/');
}

export async function approveTask(taskId: string, strategy: 'local-merge' | 'pull-request') {
  const { orchestrator } = getStores();
  await orchestrator.approveTask(taskId, strategy);
  revalidatePath('/');
}

export async function rejectTask(taskId: string, feedback: string) {
  const { orchestrator } = getStores();
  await orchestrator.rejectTask(taskId, feedback);
  revalidatePath('/');
}

export async function getTasks() {
  const { taskStore } = getStores();
  return taskStore.getAll();
}

export async function getTask(id: string) {
  const { taskStore } = getStores();
  return taskStore.getById(id);
}

export async function getTaskEvents(taskId: string) {
  const { taskStore } = getStores();
  return taskStore.getEvents(taskId);
}
```

### 7.3 Server Actions for Projects (`app/actions/projects.ts`)

```typescript
'use server';

import { projectStore } from '@/lib/project-store';
import { cookies } from 'next/headers';
import { revalidatePath } from 'next/cache';

// The active project is stored as a cookie (simplest server-side state for SSR).
const ACTIVE_PROJECT_COOKIE = 'activeProject';

export function getActiveProjectPath(): string {
  const cookieStore = cookies();
  const path = cookieStore.get(ACTIVE_PROJECT_COOKIE)?.value;
  if (!path) throw new Error('No active project selected');
  return path;
}

export async function getActiveProject() {
  try {
    const path = getActiveProjectPath();
    return projectStore.getByPath(path);
  } catch {
    return null;
  }
}

export async function setActiveProject(projectPath: string) {
  cookies().set(ACTIVE_PROJECT_COOKIE, projectPath);
  revalidatePath('/');
}

export async function addProject(formData: FormData) {
  const path = formData.get('path') as string;
  const name = formData.get('name') as string | null;
  const project = projectStore.add(path, name || undefined);
  cookies().set(ACTIVE_PROJECT_COOKIE, path);
  revalidatePath('/');
  return project;
}

export async function removeProject(projectPath: string) {
  projectStore.remove(projectPath);
  // If this was the active project, clear the cookie
  const cookieStore = cookies();
  if (cookieStore.get(ACTIVE_PROJECT_COOKIE)?.value === projectPath) {
    cookieStore.delete(ACTIVE_PROJECT_COOKIE);
  }
  revalidatePath('/');
}

export async function getProjects() {
  return projectStore.getAll();
}
```

### 7.3 Server Actions for Roles (`app/actions/roles.ts`)

These read and write the `.claude/roles/` files on disk. The user edits the role markdown in the UI; saving writes directly to the filesystem. Editing the file on disk with a text editor works equally well — the next time a command runs, it reads the current file.

```typescript
'use server';

import { readFileSync, writeFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { revalidatePath } from 'next/cache';
import { getActiveProjectPath } from './projects';

function getRolesDir(): string {
  return join(getActiveProjectPath(), '.claude', 'roles');
}

export interface RoleDefinition {
  filename: string;       // e.g. 'qa-reviewer.md'
  name: string;           // e.g. 'QA Reviewer' (extracted from # heading)
  content: string;        // Full markdown content
}

export async function getRoles(): Promise<RoleDefinition[]> {
  const files = readdirSync(getRolesDir()).filter(f => f.endsWith('.md'));
  return files.map(filename => {
    const content = readFileSync(join(getRolesDir(), filename), 'utf-8');
    const nameMatch = content.match(/^#\s+Role:\s+(.+)$/m);
    return {
      filename,
      name: nameMatch ? nameMatch[1] : filename.replace('.md', ''),
      content,
    };
  });
}

export async function getRole(filename: string): Promise<RoleDefinition> {
  const content = readFileSync(join(getRolesDir(), filename), 'utf-8');
  const nameMatch = content.match(/^#\s+Role:\s+(.+)$/m);
  return {
    filename,
    name: nameMatch ? nameMatch[1] : filename.replace('.md', ''),
    content,
  };
}

export async function saveRole(filename: string, content: string): Promise<void> {
  // Validate filename is one of the known role files (prevent path traversal)
  const allowedFiles = readdirSync(getRolesDir()).filter(f => f.endsWith('.md'));
  if (!allowedFiles.includes(filename)) {
    throw new Error(`Unknown role file: ${filename}`);
  }
  writeFileSync(join(getRolesDir(), filename), content, 'utf-8');
  revalidatePath('/settings');
}
```

**How the settings page uses them:**

```typescript
// app/settings/page.tsx — Server Component
import { getRoles } from '../actions/roles';
import { RoleEditor } from '../components/role-editor';

export default async function SettingsPage() {
  const roles = await getRoles();
  return (
    <div>
      <h1>Agent Roles</h1>
      <p>Edit agent personas to tailor behavior to your project.
         Changes take effect on the next pipeline run.</p>
      {roles.map(role => (
        <RoleEditor key={role.filename} role={role} />
      ))}
    </div>
  );
}

// components/role-editor.tsx — Client Component
'use client';
import { saveRole, RoleDefinition } from '@/app/actions/roles';
import { useState } from 'react';

export function RoleEditor({ role }: { role: RoleDefinition }) {
  const [content, setContent] = useState(role.content);
  const [saved, setSaved] = useState(false);

  async function handleSave() {
    await saveRole(role.filename, content);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  }

  return (
    <div>
      <h2>{role.name}</h2>
      <p>{role.filename}</p>
      <textarea
        value={content}
        onChange={e => setContent(e.target.value)}
        rows={20}
      />
      <button onClick={handleSave}>
        {saved ? 'Saved!' : 'Save'}
      </button>
    </div>
  );
}
```

```typescript
// app/page.tsx — Server Component, reads directly
import { getTasks } from './actions/tasks';
import { KanbanBoard } from './components/kanban-board';

export default async function Home() {
  const tasks = await getTasks();
  return <KanbanBoard tasks={tasks} />;
}

// components/kanban-board.tsx — Client Component, calls actions
'use client';
import { createTask, runTask } from '@/app/actions/tasks';

function NewTaskButton() {
  return (
    <form action={createTask}>
      <input name="title" placeholder="Task title" />
      <textarea name="description" placeholder="Describe the feature..." />
      <button type="submit">Create Task</button>
    </form>
  );
}

function TaskCard({ task }) {
  return (
    <div>
      <h3>{task.title}</h3>
      {task.phase === 'backlog' && (
        <button onClick={() => runTask(task.id)}>Run Pipeline</button>
      )}
    </div>
  );
}
```

### 7.4 Kanban Board Columns

The kanban board has been consolidated into 6 columns. Individual pipeline phases are normalized into these columns:

| Column | Maps to Pipeline Phases |
|---|---|
| **Backlog** | `backlog` — task created, not started |
| **Analysis** | `spec`, `plan` — spec creation and planning |
| **In Progress** | `implement` — coder agents working |
| **Review** | `qa-review`, `qa-fix`, `awaiting-review`, `merge`, `create-pr`, `pr-open` — QA, human review, and integration |
| **Failed** | `failed` — QA loop exhausted or error |
| **Done** | `done` — merged or PR opened successfully |

Additional features:
- **Search**: full-text search across task titles and descriptions
- **Phase filter**: checkbox multi-select to filter by column
- **Source filter**: filter tasks by origin (ideation / competitor-analysis)
- **Sort**: sort by newest, oldest, A→Z, Z→A
- **Bulk select**: Ctrl+Click, Shift+Click to select multiple cards; bulk move or delete
- **Undo**: Ctrl+Z to undo last card move (5-second toast with manual Undo button)
- **Connection indicator**: green/amber dot showing WebSocket status
- **Optimistic drag-and-drop**: cards appear in target column immediately; WebSocket confirmation clears the moving indicator with 10-second safety timeout

### 7.5 Real-Time Updates

The WebSocket server in `server.ts` (see Section 2.1) broadcasts ProcessManager events to all connected browsers. The frontend connects with a simple React hook:

```typescript
// Frontend: React hook for streaming agent events
function useAgentStream(taskId: string) {
  const [events, setEvents] = useState<any[]>([]);
  useEffect(() => {
    const ws = new WebSocket(`ws://${window.location.host}/ws`);
    ws.onmessage = (msg) => {
      const data = JSON.parse(msg.data);
      // Filter to only events for this task's sessions
      setEvents(prev => [...prev, data]);
    };
    return () => ws.close();
  }, [taskId]);
  return events;
}
```

---

## 8. Implementation Roadmap

Each step is designed to be self-contained and testable before moving to the next.

### ✅ Step 1: Project Scaffold
Next.js project scaffolded with all dependencies, custom `server.ts`, and `npm run dev` working on port 3002 (configurable via PORT env var).

### ✅ Step 2: Role Definitions + Slash Commands
All 6 role files and 9 command files exist in `defaults/`. `teamai-workflow.md` scaffolded via `@`-import in project `CLAUDE.md`.

### ✅ Step 3: Memory & MCP Server Setup
Auto Memory confirmed active. GitHub MCP server configured (needs `GITHUB_TOKEN` env var to connect).

### ✅ Step 4: Process Manager
`src/lib/process-manager.ts` spawns Claude CLI subprocesses with NDJSON streaming. Tested with `scripts/test-process-manager.ts`.

### ✅ Step 5: Task Store + Project Store + Server Actions
`TaskStore`, `ProjectStore`, and all server actions implemented. Projects scaffold defaults on registration.

### ✅ Step 6: Project Selector + Kanban Board UI
Sidebar with project selector (add/remove/switch). Kanban board with 6 columns, New Task dialog with templates, search, filters, bulk ops, undo, drag-and-drop with optimistic UI.

### ✅ Step 6b: Search, Filter, Bulk Operations & Undo
Full-text search, phase/source filters, sort options, bulk select (Ctrl/Shift+Click), bulk move/delete. Undo with Ctrl+Z and 5-second toast. Connection indicator (green/amber WebSocket status dot).

### ✅ Step 7: Agent Panel with Streaming Output
xterm.js agent panel on task detail page. `useAgentStream` WebSocket hook filters events by `taskId`. `PhaseSyncer` keeps badge live.

### ✅ Step 8: Orchestrator
Full spec→plan→implement→qa→awaiting-review pipeline. Phase-change events broadcast via WebSocket. `processManager` and `orchestrators` stored on `global` to share across Next.js module contexts. Run Pipeline button on task detail page.

### ✅ Step 9: Human Review Panel
`ReviewPanel` on task detail page when phase is `awaiting-review`. Shows QA report (pass/fail badges), spec, git diff. Merge Locally / Open PR / Reject with Feedback actions.

### ✅ Step 10: Insights Chat
`/insights` page with streaming chat bubbles. Long-lived Claude session per project; messages sent via server action, responses stream via WebSocket.

### ✅ Step 11: Roadmap & Changelog
`/roadmap` page with Roadmap and Changelog tabs. Phased kanban view (Now/Next/Later/Icebox), competitor analysis toggle, history dropdown, convert-to-ticket, item detail overlay. Changelog generates release notes from git history.

### ✅ Step 12: Role Editor (Settings Page)
`/settings` page lists all 6 roles as collapsible cards with editable textarea. Save writes to disk immediately. Reset to Default restores from `defaults/roles/`.

### ✅ Step 13: GitHub Integration
`/github` page for importing GitHub issues as tasks and managing pull requests via GitHub MCP server.

### ✅ Step 14: Polish & Hardening
Collapsible sidebar (icon-only strip when collapsed). Task cards show truncated description with more/less toggle.

### ✅ Step 15: Customizable Pipeline Phases
`pipeline.json` in `.teamai/` controls active phases, max QA attempts, and parallel subtasks. Orchestrator reads it before each run. UI in Settings.

### ✅ Step 16: Ideation & Reference Images
`/ideation` page with Run Scan button streaming `/ideation` output. New Task dialog accepts reference image uploads saved to `.teamai/{slug}/references/`.

### ✅ Step 17: Session Recovery
On server startup, scans all registered projects for in-progress tasks and shows an amber resume banner with per-task Resume buttons.

### ✅ Step 18: Multi-Provider Support
`providers.json` in `.teamai/` configures model and provider per role. `ProcessManager.createSession` merges env overrides. Provider Config section in Settings.

### ⏭ Step 19: Remote Access & Notifications
Not yet implemented. Tailscale for remote access; Web Push / Telegram webhook for review-ready notifications.

### ✅ Step 20: Agent Terminal Sessions
`/terminals` page with interactive PTY sessions via `node-pty` + xterm.js. Role persona injected via `--append-system-prompt`. Multiple terminals open simultaneously with color-coded borders. Keyboard input and resize routed via WebSocket.

### ✅ Step 21: Container Isolation
Devcontainer toggle in Settings. Agents run inside a Docker container with host credential mounting. Live status badge via WebSocket (Stopped/Starting/Running/Restarting).



### ✅ Step 23: Analytics Dashboard
`/analytics` page with project metrics, pipeline insights, and task statistics.

### ✅ Step 24: E2E Test Suite
58 Playwright E2E tests with seed data, zero skips. 913 Vitest unit tests with zero skips or failures. TypeScript strict typecheck passes clean.
---

## 10. File Checklist

When implementation is complete, these files should exist:

```
teamai/                            # THE UI APP (this repo)
├── server.ts                       # Custom server: Next.js + WebSocket on one port
├── defaults/                       # Default files scaffolded into new projects
│   ├── roles/
│   │   ├── analyst.md
│   │   ├── planner.md
│   │   ├── coder.md
│   │   ├── qa-reviewer.md
│   │   ├── qa-fixer.md
│   │   └── merger.md
│   ├── commands/
│   │   ├── spec.md
│   │   ├── plan.md
│   │   ├── implement.md
│   │   ├── qa-review.md
│   │   ├── qa-fix.md
│   │   ├── merge.md
│   │   ├── roadmap.md
│   │   ├── changelog.md
│   │   └── ideation.md
│   ├── pipeline.json               # Default pipeline phase config
│   └── CLAUDE.md                   # Template CLAUDE.md for target projects
├── src/
│   ├── lib/
│   │   ├── process-manager.ts
│   │   ├── orchestrator.ts
│   │   ├── task-store.ts
│   │   ├── project-store.ts
│   │   ├── container-manager.ts
│   │   └── stream-types.ts
│   ├── app/
│   │   ├── layout.tsx              # Root layout with collapsible sidebar
│   │   ├── page.tsx                # Kanban board (Server Component)
│   │   ├── task/[id]/page.tsx      # Task detail page
│   │   ├── insights/page.tsx       # Streaming codebase chat
│   │   ├── terminals/page.tsx      # Agent terminal sessions
│   │   ├── ideation/page.tsx       # Vulnerability scanner
│   │   ├── roadmap/page.tsx        # Roadmap + changelog
│   │   ├── settings/page.tsx       # Container, pipeline, providers, roles
│   │   ├── analytics/page.tsx      # Project metrics dashboard
│   │   ├── github/page.tsx         # GitHub issue import
│   │   └── actions/
│   │       ├── tasks.ts            # Task + pipeline Server Actions
│   │       ├── roles.ts            # Role CRUD Server Actions
│   │       ├── pipeline.ts         # Pipeline config Server Actions
│   │       ├── roadmap.ts          # Roadmap/changelog Server Actions
│   │       └── projects.ts         # Project registration Server Actions
│   ├── components/
│   │   ├── ui/                     # shadcn/ui primitives (button, input, badge, etc.)
│   │   ├── project-selector.tsx    # Sidebar project list + add project
│   │   ├── kanban-board.tsx        # 6-column board with search/filter/bulk/undo
│   │   ├── task-card.tsx           # Card with description toggle
│   │   ├── task-panel.tsx          # Floating window overlay
│   │   ├── task-detail.tsx         # Tabbed: Overview/Terminal/Spec/Plan/QA
│   │   ├── agent-panel.tsx         # Streaming agent output (xterm.js)
│   │   ├── review-panel.tsx        # Human review: merge/PR/reject
│   │   ├── role-editor.tsx         # Agent persona editor
│   │   ├── pipeline-config.tsx     # Pipeline phase config
│   │   ├── provider-config.tsx     # Per-role model/provider
│   │   ├── container-config.tsx    # Devcontainer toggle + status
│   │   ├── roadmap-view.tsx        # Roadmap/changelog with phased kanban
│   │   ├── ideation-scanner.tsx    # Run scan + streaming output
│   │   ├── insights-chat.tsx       # Chat bubbles + input
│   │   ├── terminals-view.tsx      # PTY terminal grid
│   │   └── connection-indicator.tsx # WS status dot
│   ├── hooks/
│   │   ├── use-websocket.ts
│   │   ├── use-phase-sync.ts
│   │   └── use-session-stream.ts
│   └── constants/
│       └── phases.ts               # Phase badges, labels, priority colors
├── tests/
│   ├── unit/                       # 913 Vitest unit tests (0 skipped)
│   ├── e2e/                        # 58 Playwright E2E tests (0 skipped)
│   └── integration/                # Integration tests
├── CLAUDE.md
├── package.json
├── playwright.config.ts
├── vitest.config.ts
└── next.config.ts

~/.teamai/                         # APP-LEVEL CONFIG (created at runtime)
└── projects.json                   # [{name, path, addedAt}]

/path/to/target-project/            # EACH TARGET PROJECT (scaffolded on registration)
├── .claude/
│   ├── roles/                      # Per-project agent personas (editable)
│   │   └── ... (6 role files)
│   ├── commands/                   # Per-project pipeline commands
│   │   └── ... (9 command files including ideation.md)
│   └── settings.json               # MCP server config (managed by Claude CLI)
├── .teamai/                       # Per-project state (created at runtime)
│   ├── pipeline.json               # Pipeline phase config (customizable)
│   ├── providers.json              # Per-role model/provider assignments
│   ├── container.json              # Container isolation config
│   ├── {task-slug}/
│   │   ├── task.json
│   │   ├── spec.md
│   │   ├── plan.json
│   │   ├── qa_report.json
│   │   ├── completion_summary.md
│   │   ├── events.jsonl
│   │   ├── output.log
│   │   └── references/             # Attached screenshots/mockups
│   ├── roadmap/
│   │   └── roadmap-{date}.json
│   └── ideation/
│       └── ideation-{date}.json
└── CLAUDE.md                       # Project instructions for Claude
```
