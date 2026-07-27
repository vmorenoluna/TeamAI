/**
 * Seed Script for E2E Tests
 *
 * Creates a test project with sample tasks in various pipeline phases
 * so Playwright e2e tests can run against real data.
 *
 * Usage:
 *   npx tsx tests/e2e/seed.ts                  # Seed with defaults
 *   npx tsx tests/e2e/seed.ts --with-plans      # Also create plan.json for tasks
 *   npx tsx tests/e2e/seed.ts --with-qa-report  # Also create qa_report.json
 *   npx tsx tests/e2e/seed.ts --serve           # Start dev server after seeding
 *
 * The script adds the project to ~/.teamai/projects.json using ProjectStore.
 * To clean up: delete the project from the UI or manually remove it from
 * ~/.teamai/projects.json.
 */

import { mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, renameSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { homedir } from 'os';

// ── Config ─────────────────────────────────────────────────────────────

const PROJECT_NAME = 'E2E Test Project';
const SEED_DIR = join(process.cwd(), '.teamai-e2e-seed');

/**
 * Resolve the projects.json path, respecting TEAMAI_CONFIG_DIR for isolation.
 * Falls back to ~/.teamai/projects.json in production (manual seeding).
 */
function getConfigPath(): string {
  const base = process.env.TEAMAI_CONFIG_DIR || homedir();
  return join(base, '.teamai', 'projects.json');
}

// ── Types ──────────────────────────────────────────────────────────────

interface SeedTask {
  title: string;
  description: string;
  phase: string;
  spec?: string;
  plan?: { subtasks: Array<{
    id: number;
    title: string;
    description: string;
    files: string[];
    acceptance_criteria: string[];
    completed?: boolean;
  }> };
  qaReport?: {
    overall: 'PASS' | 'FAIL';
    criteria: Array<{ name: string; status: string; notes: string }>;
    spec_concerns?: Array<{ issue: string; reasoning: string; suggested_fix?: string }>;
    issues?: Array<{ severity: string; message: string }>;
  };
  completionSummary?: string;
  /** Git branch name for tasks in implement/merge/create-pr/pr-open phases. */
  branch?: string;
  /** PR/MR URL for tasks in pr-open/merge phases. */
  prUrl?: string;
  /** Auto-mode: true when auto mode marked the task as done. */
  autoProcessed?: boolean;
  /** Auto-mode: true when user has manually reviewed the auto-done task. */
  autoReviewed?: boolean;
  /** ISO timestamp — pipeline paused by API rate limit. */
  rateLimitedUntil?: string;
  /** IDs of tasks this task depends on (blocked by). */
  dependencies?: string[];
  /** Human reviewer feedback for awaiting-review tasks. */
  humanFeedback?: string;
  /** Write a session_map.json to simulate an active pipeline session. */
  sessionMap?: Record<string, string>;
}

// ── Sample Data ────────────────────────────────────────────────────────

const SAMPLE_TASKS: SeedTask[] = [
  {
    title: 'Implement dark mode toggle',
    description: 'Add a dark mode toggle to the settings page',
    phase: 'backlog',
  },
  {
    title: 'Fix: login button not visible on mobile',
    description: 'The login button is hidden behind the navbar on small screens',
    phase: 'implement',
    branch: 'feat/fix-login-button-not-visible-on-mobile',
    spec: '# Spec: Fix login button mobile visibility\n\n## Background\nLogin button is hidden behind navbar on screens < 768px.\n\n## Requirements\n- Button must be visible at all breakpoints\n- Navbar z-index must not overlap interactive elements',
    plan: {
      subtasks: [
        { id: 1, title: 'Fix CSS z-index', description: 'Adjust z-index layering', files: ['src/components/navbar.tsx', 'src/app/globals.css'], acceptance_criteria: ['Navbar is behind interactive elements'], completed: true },
        { id: 2, title: 'Add responsive test', description: 'Add viewport test', files: ['src/app/login/login.test.tsx'], acceptance_criteria: ['Login button visible at 375px width'] },
      ],
    },
    completionSummary: '# Completion Summary\n\nTask failed after 2 QA attempts.\n\n## Plan Subtasks\n\n- [x] **Fix CSS z-index** — COMPLETED\n- [ ] **Add responsive test** — NOT COMPLETED\n\n## Last QA Report\n\nOverall: **FAIL**\n\n| Criterion | Status | Notes |\n|-----------|--------|-------|\n| Mobile visibility | FAIL | Button still hidden at 375px |',
  },
  {
    title: 'Feat: Add keyboard shortcuts',
    description: 'Implement keyboard shortcuts for common actions',
    phase: 'backlog',
    spec: '# Spec: Keyboard Shortcuts\n\n## Overview\nAllow users to navigate and perform actions using keyboard shortcuts.\n\n## Shortcuts\n- `Ctrl+N` — New task\n- `Ctrl+F` — Focus search\n- `Escape` — Close panel',
    plan: {
      subtasks: [
        { id: 1, title: 'Define shortcut map', description: 'Create a configurable shortcut mapping', files: ['src/lib/shortcuts.ts'], acceptance_criteria: ['All shortcuts are configurable'] },
        { id: 2, title: 'Add keydown listener', description: 'Global keyboard event handler', files: ['src/hooks/use-shortcuts.ts'], acceptance_criteria: ['Shortcuts fire on correct key combos'] },
      ],
    },
  },
  {
    title: 'Docs: Update README with API reference',
    description: 'Document the public API endpoints',
    phase: 'qa-review',
    spec: '# Spec: API Documentation\n\n## Endpoints to Document\n- `GET /api/tasks`\n- `POST /api/tasks`\n- `GET /api/tasks/:id`',
    qaReport: {
      overall: 'FAIL',
      criteria: [
        { name: 'All endpoints documented', status: 'FAIL', notes: 'Missing DELETE endpoint' },
        { name: 'Examples included', status: 'PASS', notes: '' },
      ],
      issues: [
        { severity: 'error', message: 'DELETE /api/tasks/:id not documented' },
      ],
    },
  },
  {
    title: 'Refactor: Extract shared types to common package',
    description: 'Move shared TypeScript interfaces to a types package',
    phase: 'done',
    spec: '# Spec: Shared Types Refactor\n\n## Motivation\nReduce duplication of type definitions across packages.\n\n## Plan\n1. Create `@teamai/types` package\n2. Move shared interfaces\n3. Update imports',
    plan: {
      subtasks: [
        { id: 1, title: 'Create types package', description: 'Initialize new pnpm workspace package', files: ['packages/types/package.json', 'packages/types/tsconfig.json'], acceptance_criteria: ['Package builds successfully'], completed: true },
        { id: 2, title: 'Move interfaces', description: 'Copy shared interfaces to new package', files: ['packages/types/src/index.ts'], acceptance_criteria: ['All shared types are exported'], completed: true },
        { id: 3, title: 'Update imports', description: 'Change import paths across the codebase', files: ['src/lib/task-store.ts', 'src/lib/stream-types.ts'], acceptance_criteria: ['No broken imports'], completed: true },
      ],
    },
  },
  {
    title: 'Feat: Export tasks as CSV',
    description: 'Allow users to export their task list as CSV',
    phase: 'backlog',
  },
  {
    title: 'Test: terminal live event labels',
    description: 'Verify live streaming events show agent labels in real-time',
    phase: 'implement',
    spec: '# Spec: Terminal Live Event Labels\n\n## Overview\nTerminal must show agent labels on live streaming events.\n\n## Requirements\n- Live events arriving via WebSocket must be prefixed with [Role] label',
  },
  {
    title: 'Fix: search bar crashes on empty input',
    description: 'Search bar crashes with "Cannot read property of undefined" when submitted empty',
    phase: 'failed',
    spec: '# Spec: Fix search crash\n\n## Steps to Reproduce\n1. Click search bar\n2. Press Enter without typing\n3. App crashes\n\n## Requirements\n- Empty input should be handled gracefully',
    plan: {
      subtasks: [
        { id: 1, title: 'Add empty guard clause', description: 'Guard against empty/null input at search handler', files: ['src/components/search-bar.tsx'], acceptance_criteria: ['No crash on empty input'], completed: true },
        { id: 2, title: 'Add validation test', description: 'Unit test for empty input handling', files: ['src/components/search-bar.test.tsx'], acceptance_criteria: ['Test passes with empty string input'] },
      ],
    },
    qaReport: {
      overall: 'FAIL',
      criteria: [
        { name: 'Empty input handled without crash', status: 'PASS', notes: '' },
        { name: 'Shows helpful error message to user', status: 'FAIL', notes: 'No user-facing message shown — just silently ignores' },
        { name: 'Edge cases covered (whitespace, special chars)', status: 'FAIL', notes: 'Only basic empty string is handled' },
      ],
      issues: [
        { severity: 'warning', message: 'No toast/notification shown on empty submit' },
        { severity: 'warning', message: 'Whitespace-only input not handled' },
      ],
    },
    completionSummary: '# Completion Summary\n\nTask failed after reaching max QA attempts (3/3).\n\n## Plan Subtasks\n\n- [x] **Add empty guard clause** — COMPLETED\n- [ ] **Add validation test** — NOT COMPLETED\n\n## Last QA Report\n\nOverall: **FAIL**\n\n| Criterion | Status | Notes |\n|-----------|--------|-------|\n| Empty input handled without crash | PASS | |\n| Shows helpful error message to user | FAIL | No user-facing message shown |\n| Edge cases covered (whitespace, special chars) | FAIL | Only basic empty string handled |\n\n## Issues\n\n- [warning] No toast/notification shown on empty submit\n- [warning] Whitespace-only input not handled',
  },
  // ── Tasks for missing pipeline phases (BDD coverage) ────────────────
  {
    title: 'Feat: Add user profile page',
    description: 'Create a user profile page showing account details and settings',
    phase: 'spec',
    spec: '# Spec: User Profile Page\n\n## Background\nUsers need a dedicated profile page to view and manage their account.\n\n## Requirements\n- Display user name, email, avatar\n- Show account creation date\n- Link to settings page\n- Responsive layout for mobile',
  },
  {
    title: 'Feat: Add pagination to task list',
    description: 'Add server-side pagination to the task list API and UI',
    phase: 'plan',
    spec: '# Spec: Task List Pagination\n\n## Requirements\n- API accepts ?page and ?limit params\n- Response includes total count\n- UI shows page controls\n- Default 20 items per page',
    plan: {
      subtasks: [
        { id: 1, title: 'Add pagination params to API', description: 'Accept page and limit query params', files: ['src/app/api/tasks/route.ts'], acceptance_criteria: ['API returns paginated results'] },
        { id: 2, title: 'Add page controls UI', description: 'Render page number buttons', files: ['src/components/pagination.tsx'], acceptance_criteria: ['Page controls render with correct page count'] },
        { id: 3, title: 'Wire up state', description: 'Connect pagination to task store', files: ['src/hooks/use-paginated-tasks.ts'], acceptance_criteria: ['Clicking page button loads correct page'] },
      ],
    },
  },
  {
    title: 'Fix: Navbar dropdown z-index conflict',
    description: 'Navbar dropdown menus appear behind page content on certain pages',
    phase: 'awaiting-review',
    spec: '# Spec: Fix Navbar Dropdown Z-Index\n\n## Requirements\n- Dropdowns must appear above all page content\n- Must not break sticky header behavior',
    plan: {
      subtasks: [
        { id: 1, title: 'Audit z-indexes', description: 'Map all z-index values in the app', files: ['docs/z-index-map.md'], acceptance_criteria: ['All z-index values documented'], completed: true },
        { id: 2, title: 'Fix stacking contexts', description: 'Resolve conflicting stacking contexts', files: ['src/components/navbar.tsx', 'src/app/globals.css'], acceptance_criteria: ['Dropdown renders above all content'], completed: true },
      ],
    },
    qaReport: {
      overall: 'PASS',
      criteria: [
        { name: 'Dropdown renders above all content', status: 'PASS', notes: 'Verified at 1920px and 375px' },
        { name: 'Sticky header still works', status: 'PASS', notes: 'Header sticks on scroll' },
      ],
    },
    humanFeedback: '# Human Review\n\nThe fix looks good. The dropdown now renders above the hero section.\n\nPlease also check the mobile nav menu — it has a separate z-index stack.\n\nApproved for merge.',
  },
  {
    title: 'Feat: Add real-time WebSocket notifications',
    description: 'Add in-app notification toasts for task status changes',
    phase: 'create-pr',
    branch: 'feat/add-real-time-websocket-notifications',
    spec: '# Spec: Real-Time Notifications\n\n## Requirements\n- Toast notification on task phase change\n- Clickable toast to navigate to task\n- Dismissible with close button',
    plan: {
      subtasks: [
        { id: 1, title: 'Create notification store', description: 'Zustand store for notification state', files: ['src/lib/notification-store.ts'], acceptance_criteria: ['Store holds notification queue'], completed: true },
        { id: 2, title: 'Build toast component', description: 'Animated toast notification UI', files: ['src/components/toast.tsx'], acceptance_criteria: ['Toast renders, animates in, and dismisses'], completed: true },
        { id: 3, title: 'Wire up WebSocket events', description: 'Subscribe to phase-change events', files: ['src/hooks/use-notifications.ts'], acceptance_criteria: ['Toast appears on phase change'], completed: true },
      ],
    },
  },
  {
    title: 'Refactor: Migrate API to v2 endpoints',
    description: 'Migrate all internal API consumers from v1 to v2 endpoint paths',
    phase: 'pr-open',
    branch: 'feat/refactor-migrate-api-to-v2-endpoints',
    prUrl: 'https://github.com/teamai/TeamAI/pull/142',
    spec: '# Spec: API v2 Migration\n\n## Requirements\n- All internal calls use /api/v2/ prefix\n- v1 endpoints preserved for backwards compat\n- No breaking changes to external consumers',
    plan: {
      subtasks: [
        { id: 1, title: 'Create v2 route handlers', description: 'Duplicate v1 handlers under /api/v2/', files: ['src/app/api/v2/tasks/route.ts'], acceptance_criteria: ['v2 endpoints return same data'], completed: true },
        { id: 2, title: 'Update internal consumers', description: 'Change all fetch calls to /api/v2/', files: ['src/app/actions/*.ts'], acceptance_criteria: ['All internal calls use v2'], completed: true },
        { id: 3, title: 'Add deprecation headers', description: 'Add warning headers to v1 endpoints', files: ['src/app/api/v1/route.ts'], acceptance_criteria: ['v1 responses include deprecation header'], completed: true },
      ],
    },
  },
  {
    title: 'Fix: Merge conflict in shared utils',
    description: 'Resolve git merge conflict in src/lib/utils.ts between feature branches',
    phase: 'merge',
    branch: 'feat/fix-merge-conflict-in-shared-utils',
    prUrl: 'https://github.com/teamai/TeamAI/pull/150',
    spec: '# Spec: Resolve Merge Conflict\n\n## Background\nTwo feature branches modified the same slugify function.\n\n## Requirements\n- Merge both changes without losing functionality\n- All tests pass after resolution',
    plan: {
      subtasks: [
        { id: 1, title: 'Resolve slugify conflict', description: 'Merge both versions of slugify', files: ['src/lib/utils.ts'], acceptance_criteria: ['Both slugify features work'], completed: true },
        { id: 2, title: 'Run full test suite', description: 'All tests pass after merge', files: [], acceptance_criteria: ['0 test failures'], completed: true },
      ],
    },
  },
  // ── Additional behavioral test data ────────────────────────────────
  {
    title: 'Auto: Update deprecated dependencies',
    description: 'Auto-processed task that was merged by CI — needs manual review',
    phase: 'done',
    branch: 'feat/auto-update-deprecated-dependencies',
    autoProcessed: true,
    autoReviewed: false,
    spec: '# Spec: Dependency Update\n\n## Requirements\n- Update all deprecated npm packages\n- No breaking changes',
    plan: {
      subtasks: [
        { id: 1, title: 'Audit dependencies', description: 'Run npm audit and list deprecated packages', files: ['package.json'], acceptance_criteria: ['Audit report generated'], completed: true },
        { id: 2, title: 'Update packages', description: 'Update to latest compatible versions', files: ['package.json'], acceptance_criteria: ['No security vulnerabilities'], completed: true },
      ],
    },
  },
  {
    title: 'Fix: Rate-limited API token refresh',
    description: 'API token refresh endpoint hitting rate limits during heavy usage',
    phase: 'implement',
    branch: 'feat/fix-rate-limited-api-token-refresh',
    rateLimitedUntil: new Date(Date.now() + 3600000).toISOString(),
    spec: '# Spec: Rate-Limited Token Refresh\n\n## Requirements\n- Implement exponential backoff\n- Queue requests during rate limit period',
    plan: {
      subtasks: [
        { id: 1, title: 'Add backoff logic', description: 'Implement exponential backoff', files: ['src/lib/api-client.ts'], acceptance_criteria: ['Requests retry with increasing delay'], completed: true },
        { id: 2, title: 'Add request queue', description: 'Queue and batch requests', files: ['src/lib/request-queue.ts'], acceptance_criteria: ['Requests queued during rate limit'] },
      ],
    },
    sessionMap: { '2': 'session-rate-limited-99' },
  },
];

// ── Helpers ────────────────────────────────────────────────────────────

function computeSeedChecksum(content: string): string {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { createHash } = require('crypto');
  return 'sha256:' + createHash('sha256').update(content).digest('hex').slice(0, 16);
}

function slugify(title: string): string {
  return title.toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80);
}

function makeTaskId(): string {
  return randomUUID();
}

function writeTask(dir: string, taskId: string, seed: SeedTask): void {
  const task: Record<string, unknown> = {
      id: taskId,
      title: seed.title,
      description: seed.description,
      phase: seed.phase,
      createdAt: new Date(Date.now() - Math.random() * 86400000 * 7).toISOString(),
      updatedAt: new Date().toISOString(),
    };
    if (seed.completionSummary) task.completionSummary = seed.completionSummary;
    if (seed.branch) task.branch = seed.branch;
    if (seed.prUrl) task.prUrl = seed.prUrl;
    if (seed.autoProcessed !== undefined) task.autoProcessed = seed.autoProcessed;
    if (seed.autoReviewed !== undefined) task.autoReviewed = seed.autoReviewed;
    if (seed.rateLimitedUntil) task.rateLimitedUntil = seed.rateLimitedUntil;
    if (seed.dependencies) task.dependencies = seed.dependencies;
  writeFileSync(join(dir, 'task.json'), JSON.stringify(task, null, 2));

  // Write realistic phase-change events based on current phase
  const now = Date.now();
  const eventPhases = buildEventChain(seed.phase);
  const events = eventPhases.map((phase, i) => ({
    phase,
    timestamp: new Date(now - (eventPhases.length - i) * 86400000).toISOString(),
  }));
  writeFileSync(join(dir, 'events.jsonl'), events.map(e => JSON.stringify(e)).join('\n') + '\n');
}

/** Build a realistic chain of phase events for the given current phase. */
function buildEventChain(currentPhase: string): string[] {
  const ALL_PHASES = ['backlog', 'spec', 'plan', 'implement', 'qa-review', 'awaiting-review', 'create-pr', 'pr-open', 'merge', 'failed', 'done'];
  const idx = ALL_PHASES.indexOf(currentPhase);
  if (idx <= 0) return ['backlog', currentPhase];
  return ALL_PHASES.slice(0, idx + 1);
}

function writeSpec(dir: string, seed: SeedTask): void {
  if (seed.spec) {
    writeFileSync(join(dir, 'spec.md'), seed.spec);
  }
}

function writePlan(dir: string, seed: SeedTask): void {
  if (seed.plan) {
    writeFileSync(join(dir, 'plan.json'), JSON.stringify(seed.plan, null, 2));
  }
}

function writeQaReport(dir: string, seed: SeedTask): void {
  if (seed.qaReport) {
    writeFileSync(join(dir, 'qa_report.json'), JSON.stringify(seed.qaReport, null, 2));
  }
}

function writeCompletionSummary(dir: string, seed: SeedTask): void {
  if (seed.completionSummary) {
    writeFileSync(join(dir, 'completion_summary.md'), seed.completionSummary);
  }
}

function writeHumanFeedback(dir: string, seed: SeedTask): void {
  if (seed.humanFeedback) {
    writeFileSync(join(dir, 'human_feedback.md'), seed.humanFeedback);
  }
}

function writeSessionMap(dir: string, seed: SeedTask): void {
  if (seed.sessionMap) {
    writeFileSync(join(dir, 'session_map.json'), JSON.stringify(seed.sessionMap, null, 2));
  }
}

async function confirmOrSkip(): Promise<boolean> {
  // Skip confirmation in CI, when --yes flag is passed, or when using a temp config dir
  if (process.env.CI || process.argv.includes('--yes') || process.argv.includes('-y') || process.env.TEAMAI_CONFIG_DIR) {
    return true;
  }

  const configPath = getConfigPath();
  console.log(`\n⚠️  This will modify your TeamAI project registry at:`);
  console.log(`   ${configPath}`);

  // Read current projects for display
  const existing = existsSync(configPath)
    ? JSON.parse(readFileSync(configPath, 'utf-8')) as Array<{ name: string; path: string }>
    : [];
  if (existing.length > 0) {
    console.log(`   Currently has ${existing.length} project(s):`);
    for (const p of existing) {
      console.log(`     - ${p.name} (${p.path})`);
    }
  }

  console.log(`   Will add: "${PROJECT_NAME}" at ${SEED_DIR}`);
  console.log('');
  return await confirm('Proceed with seeding?');
}

function registerProject(root: string): void {
  const configPath = getConfigPath();
  const configDir = join(configPath, '..');
  mkdirSync(configDir, { recursive: true });

  const projects: Array<{ name: string; path: string }> = existsSync(configPath)
    ? JSON.parse(readFileSync(configPath, 'utf-8'))
    : [];

  // Remove any stale seed entries
  const filtered = projects.filter(p =>
    p.path !== root && !p.path.includes('.teamai-e2e-seed')
  );

  filtered.push({ name: PROJECT_NAME, path: root });

  // Atomic write: temp file → rename
  const tmpPath = configPath + '.tmp';
  writeFileSync(tmpPath, JSON.stringify(filtered, null, 2));
  renameSync(tmpPath, configPath);

  console.log(`  Registered project "${PROJECT_NAME}" at ${root}`);
}

function readlineSync(question: string): Promise<string> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const rl = require('readline').createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise(resolve => {
    rl.question(question, (answer: string) => {
      rl.close();
      resolve(answer.trim().toLowerCase());
    });
  });
}

async function confirm(prompt: string): Promise<boolean> {
  try {
    const answer = await readlineSync(`${prompt} [y/N] `);
    return answer === 'y' || answer === 'yes';
  } catch {
    // If stdin is not a TTY (e.g., piped), default to skip
    console.log('  (non-interactive, skipping registration — use --yes to force)');
    return false;
  }
}

// ── Main ───────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (!(await confirmOrSkip())) {
    console.log('\n❌ Seeding cancelled. Use --yes to skip confirmation.');
    process.exit(1);
  }
  const withPlans = args.includes('--with-plans');
  const withQaReports = args.includes('--with-qa-report');
  const serve = args.includes('--serve');

  // Clean previous seed if exists
  if (existsSync(SEED_DIR)) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { rmSync } = require('fs');
    rmSync(SEED_DIR, { recursive: true, force: true });
  }

  mkdirSync(SEED_DIR, { recursive: true });
  console.log(`Seeding e2e test project at ${SEED_DIR}...`);

  // Initialize as git repo
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { execFileSync } = require('child_process');
    execFileSync('git', ['init'], { cwd: SEED_DIR, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'e2e@teamai.dev'], { cwd: SEED_DIR, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.name', 'E2E Test'], { cwd: SEED_DIR, stdio: 'ignore' });
    writeFileSync(join(SEED_DIR, '.gitkeep'), '');
    execFileSync('git', ['add', '.gitkeep'], { cwd: SEED_DIR, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'initial'], { cwd: SEED_DIR, stdio: 'ignore' });
    console.log('  Initialized git repo');
  } catch {
    console.log('  (git not available, skipping git init)');
  }

  // Create .teamai and .claude directories for full page compatibility
  mkdirSync(join(SEED_DIR, '.teamai'), { recursive: true });
  mkdirSync(join(SEED_DIR, '.claude', 'roles'), { recursive: true });
  mkdirSync(join(SEED_DIR, '.claude', 'commands'), { recursive: true });

  // Copy default role files so pages that call getRoles() don't crash
  const defaultRolesDir = join(process.cwd(), 'defaults', 'roles');
  const defaultCommandsDir = join(process.cwd(), 'defaults', 'commands');
  const scaffoldManifest: Record<string, string> = {};

  if (existsSync(defaultRolesDir)) {
    const roles = readdirSync(defaultRolesDir).filter(f => f.endsWith('.md'));
    for (const role of roles) {
      const content = readFileSync(join(defaultRolesDir, role), 'utf-8');
      writeFileSync(join(SEED_DIR, '.claude', 'roles', role), content);
      scaffoldManifest[`roles/${role}`] = computeSeedChecksum(content);
    }
    console.log(`  Copied ${roles.length} role files to .claude/roles/`);
  }

  // Copy default command templates for sync-status testing
  if (existsSync(defaultCommandsDir)) {
    const cmds = readdirSync(defaultCommandsDir).filter(f => f.endsWith('.md'));
    for (const cmd of cmds) {
      const content = readFileSync(join(defaultCommandsDir, cmd), 'utf-8');
      writeFileSync(join(SEED_DIR, '.claude', 'commands', cmd), content);
      scaffoldManifest[`commands/${cmd}`] = computeSeedChecksum(content);
    }
    console.log(`  Copied ${cmds.length} command files to .claude/commands/`);
  }

  // Write .teamai-scaffold.json manifest so syncDefaults can track versions
  const workflowSrc = join(process.cwd(), 'defaults', 'teamai-workflow.md');
  if (existsSync(workflowSrc)) {
    const wfContent = readFileSync(workflowSrc, 'utf-8');
    writeFileSync(join(SEED_DIR, '.claude', 'teamai-workflow.md'), wfContent);
    scaffoldManifest['teamai-workflow.md'] = computeSeedChecksum(wfContent);
  }
  writeFileSync(
    join(SEED_DIR, '.claude', '.teamai-scaffold.json'),
    JSON.stringify({ version: 1, files: scaffoldManifest }, null, 2),
  );
  console.log(`  Wrote .teamai-scaffold.json manifest with ${Object.keys(scaffoldManifest).length} entries`);

  // Write default pipeline config
  writeFileSync(
    join(SEED_DIR, '.teamai', 'pipeline.json'),
    JSON.stringify({
      phases: ['spec', 'plan', 'implement', 'qa-review', 'merge'],
      maxQaAttempts: 3,
      parallelSubtasks: true,
    }, null, 2),
  );

  const createdTasks: Array<{ id: string; title: string; slug: string }> = [];

  for (const seed of SAMPLE_TASKS) {
    const slug = slugify(seed.title);
    const taskDir = join(SEED_DIR, '.teamai', slug);
    mkdirSync(taskDir, { recursive: true });

    const taskId = makeTaskId();
    writeTask(taskDir, taskId, seed);
    writeSpec(taskDir, seed);

    if (withPlans || seed.plan) {
      writePlan(taskDir, seed);
    }

    if (withQaReports || seed.qaReport) {
      writeQaReport(taskDir, seed);
    }

    writeCompletionSummary(taskDir, seed);
    writeHumanFeedback(taskDir, seed);
    writeSessionMap(taskDir, seed);

    createdTasks.push({ id: taskId, title: seed.title, slug });
    console.log(`  ✓ ${seed.title} → ${seed.phase}`);
  }

  // Register the project (writes to ~/.teamai/projects.json)
  registerProject(SEED_DIR);

  console.log(`\n✅ Seeded ${createdTasks.length} tasks in "${PROJECT_NAME}"`);
  console.log(`   Project path: ${SEED_DIR}`);
  console.log(`   Run 'npm run dev' to start the dev server with this data.`);

  // Optionally start dev server
  if (serve) {
    console.log(`\nStarting dev server...`);
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { spawn } = require('child_process');
    const child = spawn('npm', ['run', 'dev'], {
      cwd: process.cwd(),
      stdio: 'inherit',
      env: { ...process.env, NODE_ENV: 'development' },
    });

    child.on('close', (code: number) => {
      console.log(`Dev server exited with code ${code}`);
    });
  }
}

main().catch(err => {
  console.error('\n❌ Seeding failed:', err);
  process.exit(1);
});
