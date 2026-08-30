import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync, appendFileSync, rmSync, unlinkSync, renameSync, statSync } from 'fs';

export function isRetryableError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err
    && ((err as { code: string }).code === 'EPERM' || (err as { code: string }).code === 'EBUSY');
}
import { join } from 'path';
import { slugify } from './utils';
import { warn as logWarn } from './logger';
import { PHASE_ARTIFACTS } from './orchestrator/artifacts';

type MergeStrategy = 'local-merge' | 'pull-request';

/**
 * Atomically write JSON to a file: write to a .tmp file, then rename.
 * Prevents corruption if the process crashes mid-write.
 *
 * On Windows, the OS may hold a brief file lock after a prior operation
 * (especially under antivirus scanners).  We retry with a capped spin so
 * we never block the event loop for more than a few milliseconds per
 * attempt.  Windows locks typically release in under 5 ms; total worst-
 * case blocking is ~14 ms across 3 retries (2 ms → 4 ms → 8 ms).
 */
function atomicWriteJson(filePath: string, data: unknown, retries = 3): void {
  const tmpPath = filePath + '.tmp';
  writeFileSync(tmpPath, JSON.stringify(data, null, 2));
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      renameSync(tmpPath, filePath);
      return;
    } catch (err) {
      if (attempt === retries - 1 || !isRetryableError(err)) throw err;
      // Windows may hold a file lock briefly — retry after a capped delay.
      // Exponential backoff with a smaller base than before (was 10 ms ×
      // 2^attempt, up to 70 ms total) to avoid blocking the event loop.
      const delay = Math.min(10, 2 * (2 ** attempt)); // 2 ms, 4 ms, 8 ms
      const waitUntil = Date.now() + delay;
      while (Date.now() < waitUntil) { /* busy-wait — capped */ }
    }
  }
}

export interface Task {
  id: string;
  title: string;
  description: string;
  /** Canonical slug (BUG-13): set at creation, unique among task dirs.
   *  Used for the task directory, branch, and (by default) worktree names.
   *  Legacy tasks (created before this field) fall back to
   *  slugify(description). */
  slug?: string;
  /** Override for the worktree *directory* name only — distinct from
   *  `slug`, which keeps deriving the task directory and branch name. Set
   *  when the canonical `<slug>` worktree path can't be reclaimed (e.g. a
   *  file locked open by an external process like an IDE indexer or an
   *  antivirus scanner) and the pipeline relocates to `<slug>-r2`, `-r3`,
   *  etc. instead of fighting for the original path. Always resolve a
   *  task's worktree directory name via resolveWorktreeDirName() rather
   *  than reading `slug` directly. */
  worktreeDirName?: string;
  phase: string;
  /** Conventional-Commits type for the ticket-history commit subject
   *  (feat/fix/refactor/chore/docs). Falls back to 'feat' when unset —
   *  e.g. tasks created before this field existed. */
  taskType?: string;
  branch?: string;
  dependencies?: string[];     // IDs of tasks this task depends on
  rateLimitedUntil?: string;   // ISO timestamp — set when pipeline is paused by API rate limit
  wakeupUntil?: string;        // ISO timestamp — set when implement phase is paused for background process (ADR 002)
  wakeupSubtaskId?: number;    // Subtask ID that triggered the wakeup (ADR 002)
  source?: string;             // 'ideation' | 'competitor-analysis' — source of roadmap item
  competitiveContext?: string; // competitor context from roadmap item
  platform?: string;            // platform info from PR creation
  prUrl?: string;               // URL of the created Pull Request
  mergeStrategy?: MergeStrategy; // chosen merge strategy for awaiting-review tasks
  completionSummary?: string;   // summary of what was completed when task fails
  /** Why a `failed` task failed — distinguishes "ran out of QA-attempt budget
   *  on a genuine code defect" from "ran out of spec-revision budget without
   *  QA ever passing" (the latter usually means the approach itself needs a
   *  redesign, not another implement pass). Undefined for legacy failed tasks
   *  written before this field existed. */
  failureReason?: 'qa-attempts-exhausted' | 'spec-revision-exhausted';
  subtaskProgress?: { completed: number; total: number } | null;  // computed at load time from plan.json
  autoProcessed?: boolean;      // set to true when auto mode marks the task as done (PR auto-merged)
  autoReviewed?: boolean;       // set to true when user marks the auto-done task as manually reviewed
  isPaused?: boolean;            // set to true when user pauses the task (session killed, stays in current phase)
  /** Latest role-refinement analysis outcome — drives the inline card on the
   *  failed task without a directory scan on every render (Role Refinement
   *  Assistant). 'none' is the absent default. */
  refinementStatus?: 'none' | 'analyzing' | 'suggested' | 'no-gap';
  /** Newest role-refinement suggestion record for this task. */
  refinementSuggestionId?: string;
  /** Retry-loop guard — how many times Apply & Retry has re-run this task after a refinement (Phase 3). */
  refinementRetryCount?: number;
  /** Set by the watcher when auto-analysis escalates to a human (a refinement
   *  was applied but the task failed the same way, or the retry-loop cap was
   *  hit). Drives the escalation banner on the failed-task card. */
  refinementEscalated?: boolean;
  createdAt: string;
  updatedAt: string;
}

/**
 * TaskStore is instantiated per project. The project path determines
 * where .teamai/ lives.
 */
export class TaskStore {
  private specsDir: string;

  /**
   * In-memory id → directory index (BUG-16). Built lazily on first lookup;
   * revalidated via the specs-dir mtime, which changes whenever a task
   * directory is added or removed. Content edits inside an existing dir
   * don't move tasks between dirs, so they can't stale the mapping.
   */
  private _dirIndex: Map<string, string> | null = null;
  private _dirIndexMtimeMs = -1;

  constructor(projectPath: string) {
    this.specsDir = join(projectPath, '.teamai');
    mkdirSync(this.specsDir, { recursive: true });
  }

  private _invalidateIndex(): void {
    this._dirIndex = null;
    this._dirIndexMtimeMs = -1;
  }

  private _ensureIndex(): Map<string, string> {
    let mtimeMs = -1;
    try { mtimeMs = statSync(this.specsDir).mtimeMs; } catch { /* dir missing */ }
    if (this._dirIndex && mtimeMs === this._dirIndexMtimeMs) return this._dirIndex;

    const index = new Map<string, string>();
    if (existsSync(this.specsDir)) {
      for (const d of readdirSync(this.specsDir, { withFileTypes: true })) {
        if (!d.isDirectory()) continue;
        const taskPath = join(this.specsDir, d.name, 'task.json');
        if (!existsSync(taskPath)) continue;
        try {
          const task = JSON.parse(readFileSync(taskPath, 'utf-8'));
          if (task?.id) index.set(task.id, join(this.specsDir, d.name));
        } catch { /* unreadable task.json — skip */ }
      }
    }
    this._dirIndex = index;
    this._dirIndexMtimeMs = mtimeMs;
    return index;
  }

  /** Read a task.json from an indexed dir; null if missing/unparseable. */
  private _readTaskAt(dir: string): Task | null {
    try {
      return JSON.parse(readFileSync(join(dir, 'task.json'), 'utf-8')) as Task;
    } catch {
      return null;
    }
  }

  create(id: string, title: string, description: string, source?: string, competitiveContext?: string, taskType?: string): Task {
    // Canonical unique slug (BUG-13): two tasks whose titles share a 40-char
    // prefix must not share a directory (and later a branch/worktree).
    // A title of only symbols slugifies to hyphens — fall back to 'task'.
    const base = slugify(title).replace(/^-+$/, '') || 'task';
    let slug = base;
    for (let n = 2; existsSync(join(this.specsDir, slug)); n++) {
      slug = `${base}-${n}`;
    }
    const dir = join(this.specsDir, slug);
    mkdirSync(dir, { recursive: true });

    const task: Task = {
      id,
      title,
      description,
      slug,
      phase: 'backlog',
      source,
      competitiveContext,
      taskType: taskType || undefined,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    atomicWriteJson(join(dir, 'task.json'), task);
    this._invalidateIndex();
    return task;
  }

  update(id: string, fields: Partial<Omit<Task, 'id' | 'createdAt'>>): void {
    const task = this.getById(id);
    if (!task) throw new Error(`Task ${id} not found`);
    const updated = { ...task, ...fields, updatedAt: new Date().toISOString() };
    const dir = this.getDirById(id);
    atomicWriteJson(join(dir, 'task.json'), updated);
  }

  updatePhase(id: string, phase: string, eventExtra?: Record<string, unknown>): void {
    const task = this.getById(id);
    if (!task) throw new Error(`Task ${id} not found`);

    task.phase = phase;
    task.updatedAt = new Date().toISOString();

    const dir = this.getDirById(id);
    atomicWriteJson(join(dir, 'task.json'), task);

    const event = { phase, timestamp: new Date().toISOString(), ...eventExtra };
    try {
      appendFileSync(join(dir, 'events.jsonl'), JSON.stringify(event) + '\n');
    } catch (err) {
      // task.json is the source of truth for phase and is already written;
      // a failed events.jsonl append must not throw (which would surface as a
      // phase-transition failure) but must be visible, since the audit trail
      // (used by analytics and retry resume) is now incomplete.
      logWarn('task-store', `Failed to append phase event for ${id}`, err);
    }
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
      // Tie-break by id so equal-createdAt tasks have a deterministic order
      // (readdirSync order is filesystem-dependent and unstable).
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));
  }

  getById(id: string): Task | null {
    const dir = this._dirIndex ? this._ensureIndex().get(id) : undefined;
    if (dir) {
      const task = this._readTaskAt(dir);
      if (task?.id === id) return task;
      // Stale entry (task.json deleted/rewritten in place) — rebuild once.
    }
    this._invalidateIndex();
    const freshDir = this._ensureIndex().get(id);
    return freshDir ? this._readTaskAt(freshDir) : null;
  }

  getDirById(id: string): string {
    const dir = this._dirIndex ? this._ensureIndex().get(id) : undefined;
    // Verify the indexed dir still holds THIS task — a dir can be recycled
    // (deleted + re-created for another task) within one mtime tick.
    if (dir && this._readTaskAt(dir)?.id === id) return dir;
    this._invalidateIndex();
    const freshDir = this._ensureIndex().get(id);
    if (freshDir) return freshDir;
    throw new Error(`Task directory not found for id ${id}`);
  }

  delete(id: string): void {
    const dir = this.getDirById(id);
    // Clean up any stale .tmp file that might remain from a failed atomic write
    try { const tmpPath = join(dir, 'task.json.tmp'); if (existsSync(tmpPath)) unlinkSync(tmpPath); } catch { /* best-effort */ }
    rmSync(dir, { recursive: true, force: true });
    this._invalidateIndex();
  }

  // Remove pipeline artifacts at or after a given level so the pipeline can re-run from there.
  // level: 'spec' | 'plan' | 'qa'
  clearArtifacts(id: string, level: 'spec' | 'plan' | 'qa'): void {
    const dir = this.getDirById(id);
    const files = PHASE_ARTIFACTS[level];
    for (const f of files) {
      const p = join(dir, f);
      if (existsSync(p)) unlinkSync(p);
    }
  }

  getDirBySlug(slug: string): string {
    return join(this.specsDir, slug);
  }

  /**
   * Read the raw task.json file for the given task without parsing.
   * Returns the raw file content or null if not found. Used for
   * atomic writes that need to read-back before modifying.
   */
  readRawTaskJson(id: string): string | null {
    try {
      const dir = this.getDirById(id);
      const path = join(dir, 'task.json');
      if (!existsSync(path)) return null;
      return readFileSync(path, 'utf-8');
    } catch {
      return null;
    }
  }

  getEvents(taskId: string): Array<{ phase: string; timestamp: string; [key: string]: unknown }> {
    const dir = this.getDirById(taskId);
    const eventsPath = join(dir, 'events.jsonl');
    if (!existsSync(eventsPath)) return [];
    return readFileSync(eventsPath, 'utf-8')
      .split('\n')
      .filter(line => line.trim())
      .map(line => JSON.parse(line));
  }
}
