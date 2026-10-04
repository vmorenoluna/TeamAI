#!/usr/bin/env node
/**
 * Creates a bare backlog ticket for TeamAI's kanban board — the same shape
 * TaskStore.create() (src/lib/task-store.ts) produces when a human clicks
 * "Add Task" in the UI: title + description only, phase "backlog". No
 * spec.md, no plan.json — the ticket goes through the normal
 * spec -> plan -> implement -> qa-review pipeline once started, like any
 * other backlog card.
 *
 * Lives under defaults/ (not scripts/) and uses only Node builtins so it
 * works unmodified in every mode TeamAI runs in: `tsx watch server.ts` in
 * dev, and the packaged Electron app, which only ships defaults/**\/*  (not
 * scripts/**\/*) — see package.json's "build.files".
 *
 * Mirrors TaskStore.create() in src/lib/task-store.ts (slug derivation,
 * collision handling, task.json shape) — keep both in sync if that method
 * ever changes.
 *
 * --depends-on sets the `dependencies` field (src/lib/task-store.ts:68, "IDs
 * of tasks this task depends on") — the same field auto-mode.ts gates
 * auto-start on (a backlog task is only picked once every dependency's
 * phase is "done") and the kanban UI's dependency arrows read. TaskStore
 * itself only sets this via update() after creation (see
 * app/actions/tasks.ts addDependency); this CLI sets it directly in the
 * initial write since the task doesn't exist yet for update() to target.
 *
 * Usage:
 *   node create-task-cli.mjs --project <path> --title "..." --description "..." [--depends-on <id1,id2,...>]
 */
import { existsSync, mkdirSync, writeFileSync, renameSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      out[argv[i].slice(2)] = argv[i + 1];
      i++;
    }
  }
  return out;
}

function slugify(text) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40);
}

function fail(message) {
  console.error(`create-task-cli: ${message}`);
  process.exit(1);
}

/** Scan every `.teamai/*\/task.json` for known task ids, for --depends-on validation. */
function existingTaskIds(specsDir) {
  const ids = new Set();
  if (!existsSync(specsDir)) return ids;
  for (const entry of readdirSync(specsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    try {
      const task = JSON.parse(readFileSync(join(specsDir, entry.name, 'task.json'), 'utf-8'));
      if (task?.id) ids.add(task.id);
    } catch { /* unreadable/missing task.json — skip */ }
  }
  return ids;
}

function main() {
  const { project, title, description, 'depends-on': dependsOn } = parseArgs(process.argv.slice(2));

  if (!project) fail('--project <path> is required');
  if (!title) fail('--title "<text>" is required');
  if (!description) fail('--description "<text>" is required');
  if (!existsSync(project)) fail(`project path does not exist: ${project}`);

  const specsDir = join(project, '.teamai');
  mkdirSync(specsDir, { recursive: true });

  let dependencies;
  if (dependsOn) {
    dependencies = [...new Set(dependsOn.split(',').map(s => s.trim()).filter(Boolean))];
    const known = existingTaskIds(specsDir);
    for (const depId of dependencies) {
      if (!known.has(depId)) {
        console.error(`create-task-cli: warning — --depends-on id "${depId}" does not match any existing task.json; the new ticket will never auto-start until a task with that id reaches "done"`);
      }
    }
  }

  const base = slugify(title).replace(/^-+$/, '') || 'task';
  let slug = base;
  for (let n = 2; existsSync(join(specsDir, slug)); n++) {
    slug = `${base}-${n}`;
  }
  const dir = join(specsDir, slug);
  mkdirSync(dir, { recursive: true });

  const now = new Date().toISOString();
  const task = {
    id: randomUUID(),
    title,
    description,
    slug,
    phase: 'backlog',
    ...(dependencies && dependencies.length > 0 ? { dependencies } : {}),
    createdAt: now,
    updatedAt: now,
  };

  const taskPath = join(dir, 'task.json');
  const tmpPath = `${taskPath}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(task, null, 2));
  renameSync(tmpPath, taskPath);

  console.log(`Created ticket "${title}" (backlog) at .teamai/${slug}/task.json`);
  console.log(`id: ${task.id}`);
  if (dependencies && dependencies.length > 0) {
    console.log(`depends on: ${dependencies.join(', ')}`);
  }
}

main();
