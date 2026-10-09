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
 * Overlap check (mirrors src/lib/orchestrator/backlog-check.ts):
 *   --list prints the open tickets and the board fingerprint. A create must
 *   pass that fingerprint as --board; under the board lock the CLI recomputes
 *   it and refuses (exit 3, listing the newcomers) if tickets were added since
 *   the caller looked, so a ticket is never filed against a board its author
 *   didn't see. The lock protocol is a copy of src/lib/board-lock.ts — keep
 *   both in sync.
 *
 * --depends-on sets the `dependencies` field (src/lib/task-store.ts, "IDs
 * of tasks this task depends on") — the same field auto-mode.ts gates
 * auto-start on (a backlog task is only picked once every dependency's
 * phase is "done") and the kanban UI's dependency arrows read. TaskStore
 * itself only sets this via update() after creation (see
 * app/actions/tasks.ts addDependency); this CLI sets it directly in the
 * initial write since the task doesn't exist yet for update() to target.
 *
 * Usage:
 *   node create-task-cli.mjs --project <path> --list
 *   node create-task-cli.mjs --project <path> --board <fingerprint> --title "..." --description "..." [--depends-on <id1,id2,...>]
 */
import { existsSync, mkdirSync, writeFileSync, renameSync, readdirSync, readFileSync, openSync, closeSync, writeSync, unlinkSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { hostname } from 'node:os';

const BOARD_LOCK_FILE = '.board.lock';
const STALE_AFTER_MS = 30_000;
const ACQUIRE_TIMEOUT_MS = 15_000;

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    const key = argv[i].slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) { out[key] = true; continue; }
    out[key] = next;
    i++;
  }
  return out;
}

function slugify(text) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40);
}

function fail(message, code = 1) {
  console.error(`create-task-cli: ${message}`);
  process.exit(code);
}

/** Every readable `.teamai/*\/task.json`. */
function allTasks(specsDir) {
  const tasks = [];
  if (!existsSync(specsDir)) return tasks;
  for (const entry of readdirSync(specsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    try {
      const task = JSON.parse(readFileSync(join(specsDir, entry.name, 'task.json'), 'utf-8'));
      if (task?.id) tasks.push(task);
    } catch { /* unreadable/missing task.json — skip */ }
  }
  return tasks;
}

function openTickets(specsDir) {
  return allTasks(specsDir)
    .filter(t => t.phase !== 'done')
    .sort((a, b) => a.id.localeCompare(b.id))
    .map(t => ({ id: t.id, title: t.title, phase: t.phase, description: t.description }));
}

/** Same algorithm as backlog-check.ts boardFingerprint(). */
function boardFingerprint(tickets) {
  return createHash('sha256').update(tickets.map(t => t.id).sort().join('\n')).digest('hex').slice(0, 16);
}

// ── Board lock (copy of src/lib/board-lock.ts) ───────────────────────────

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (err) { return err.code === 'EPERM'; }
}

function readOwner(lockPath) {
  try { return JSON.parse(readFileSync(lockPath, 'utf-8')); } catch { return null; }
}

function isLockStale(lockPath) {
  const owner = readOwner(lockPath);
  const now = Date.now();
  if (!owner) {
    try { return now - statSync(lockPath).mtimeMs > STALE_AFTER_MS; } catch { return true; }
  }
  if (now - owner.acquiredAt > STALE_AFTER_MS) return true;
  return owner.host === hostname() && !pidAlive(owner.pid);
}

function withBoardLock(specsDir, fn) {
  const lockPath = join(specsDir, BOARD_LOCK_FILE);
  const deadline = Date.now() + ACQUIRE_TIMEOUT_MS;
  for (;;) {
    try {
      const fd = openSync(lockPath, 'wx');
      try { writeSync(fd, JSON.stringify({ pid: process.pid, host: hostname(), acquiredAt: Date.now() })); } finally { closeSync(fd); }
      break;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }
    if (isLockStale(lockPath)) { try { unlinkSync(lockPath); } catch { /* taken over */ } continue; }
    if (Date.now() > deadline) fail(`timed out waiting for the board lock at ${lockPath}`);
    sleepSync(25);
  }
  const release = () => {
    const owner = readOwner(lockPath);
    if (owner && (owner.pid !== process.pid || owner.host !== hostname())) return;
    try { unlinkSync(lockPath); } catch { /* best-effort */ }
  };
  process.once('exit', release);
  try {
    return fn();
  } finally {
    release();
    process.removeListener('exit', release);
  }
}

// ── Main ─────────────────────────────────────────────────────────────────

function main() {
  const args = parseArgs(process.argv.slice(2));
  const { project, title, description, board, list } = args;
  const dependsOn = args['depends-on'];

  if (!project || project === true) fail('--project <path> is required');
  if (!existsSync(project)) fail(`project path does not exist: ${project}`);
  const specsDir = join(project, '.teamai');

  if (list) {
    const tickets = openTickets(specsDir);
    console.log(JSON.stringify({ fingerprint: boardFingerprint(tickets), tickets }, null, 2));
    return;
  }

  if (!title || title === true) fail('--title "<text>" is required');
  if (!description || description === true) fail('--description "<text>" is required');
  if (!board || board === true) {
    fail('--board <fingerprint> is required: run with --list first, check the new ticket against every open ticket, then pass the printed fingerprint');
  }
  mkdirSync(specsDir, { recursive: true });

  withBoardLock(specsDir, () => {
    const current = openTickets(specsDir);
    if (boardFingerprint(current) !== board) {
      console.error('create-task-cli: the board changed since --list. Check the new ticket against these, then retry with the new fingerprint:');
      console.error(JSON.stringify({ fingerprint: boardFingerprint(current), tickets: current }, null, 2));
      process.exit(3);
    }

    let dependencies;
    if (dependsOn && dependsOn !== true) {
      dependencies = [...new Set(dependsOn.split(',').map(s => s.trim()).filter(Boolean))];
      const known = new Set(allTasks(specsDir).map(t => t.id));
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
  });
}

main();
