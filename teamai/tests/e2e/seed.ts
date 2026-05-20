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

import { mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { homedir } from 'os';

// ── Config ─────────────────────────────────────────────────────────────

const PROJECT_NAME = 'E2E Test Project';
const SEED_DIR = join(process.cwd(), '.teamai-e2e-seed');
const HOME_DIR = homedir();
const TEAMAI_CONFIG = join(HOME_DIR, '.teamai', 'projects.json');

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
    issues: Array<{ severity: string; message: string }>;
  };
  completionSummary?: string;
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
];

// ── Helpers ────────────────────────────────────────────────────────────

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
    if (seed.completionSummary) {
      task.completionSummary = seed.completionSummary;
    }
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
  const ALL_PHASES = ['backlog', 'spec', 'plan', 'implement', 'qa-review', 'failed', 'done'];
  const idx = ALL_PHASES.indexOf(currentPhase);
  if (idx <= 0) return ['backlog', currentPhase];
  // For intermediate phases, include all steps up to and including the current one
  return ALL_PHASES.slice(0, idx + 1).filter(p => !['awaiting-review', 'merge', 'create-pr'].includes(p));
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

async function confirmOrSkip(): Promise<boolean> {
  // Skip confirmation in CI or when --yes flag is passed
  if (process.env.CI || process.argv.includes('--yes') || process.argv.includes('-y')) {
    return true;
  }

  console.log(`\n⚠️  This will modify your TeamAI project registry at:`);
  console.log(`   ${TEAMAI_CONFIG}`);

  // Read current projects for display
  const existing = existsSync(TEAMAI_CONFIG)
    ? JSON.parse(readFileSync(TEAMAI_CONFIG, 'utf-8')) as Array<{ name: string; path: string }>
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
  const projects: Array<{ name: string; path: string }> = existsSync(TEAMAI_CONFIG)
    ? JSON.parse(readFileSync(TEAMAI_CONFIG, 'utf-8'))
    : [];

  // Remove existing entry with same path, if any
  const filtered = projects.filter(p => p.path !== root);

  filtered.push({ name: PROJECT_NAME, path: root });
  mkdirSync(join(HOME_DIR, '.teamai'), { recursive: true });
  writeFileSync(TEAMAI_CONFIG, JSON.stringify(filtered, null, 2));

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

  // Copy default role files so pages that call getRoles() don't crash
  const defaultRolesDir = join(process.cwd(), 'defaults', 'roles');
  if (existsSync(defaultRolesDir)) {
    const roles = readdirSync(defaultRolesDir).filter(f => f.endsWith('.md'));
    for (const role of roles) {
      const content = readFileSync(join(defaultRolesDir, role), 'utf-8');
      writeFileSync(join(SEED_DIR, '.claude', 'roles', role), content);
    }
    console.log(`  Copied ${roles.length} role files to .claude/roles/`);
  }

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
