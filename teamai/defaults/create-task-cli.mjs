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
 * Usage:
 *   node create-task-cli.mjs --project <path> --title "..." --description "..."
 */
import { existsSync, mkdirSync, writeFileSync, renameSync } from 'node:fs';
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

function main() {
  const { project, title, description } = parseArgs(process.argv.slice(2));

  if (!project) fail('--project <path> is required');
  if (!title) fail('--title "<text>" is required');
  if (!description) fail('--description "<text>" is required');
  if (!existsSync(project)) fail(`project path does not exist: ${project}`);

  const specsDir = join(project, '.teamai');
  mkdirSync(specsDir, { recursive: true });

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
    createdAt: now,
    updatedAt: now,
  };

  const taskPath = join(dir, 'task.json');
  const tmpPath = `${taskPath}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(task, null, 2));
  renameSync(tmpPath, taskPath);

  console.log(`Created ticket "${title}" (backlog) at .teamai/${slug}/task.json`);
  console.log(`id: ${task.id}`);
}

main();
