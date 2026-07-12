import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync, appendFileSync, rmSync, unlinkSync, renameSync } from 'fs';

function isRetryableError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && ((err as { code: string }).code === 'EPERM' || (err as { code: string }).code === 'EBUSY');
}
import { join } from 'path';
import { slugify } from './utils';

type MergeStrategy = 'local-merge' | 'pull-request';

/**
 * Atomically write JSON to a file: write to a .tmp file, then rename.
 * Prevents corruption if the process crashes mid-write.
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
      // Windows may hold a file lock briefly — retry after a short delay
      const waitUntil = Date.now() + 10 * (2 ** attempt);
      while (Date.now() < waitUntil) { /* busy-wait */ }
    }
  }
}

export interface Task {
  id: string;
  title: string;
  description: string;
  phase: string;
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
  subtaskProgress?: { completed: number; total: number } | null;  // computed at load time from plan.json
  autoProcessed?: boolean;      // set to true when auto mode marks the task as done (PR auto-merged)
  autoReviewed?: boolean;       // set to true when user marks the auto-done task as manually reviewed
  createdAt: string;
  updatedAt: string;
}

/**
 * TaskStore is instantiated per project. The project path determines
 * where .teamai/ lives.
 */
export class TaskStore {
  private specsDir: string;

  constructor(projectPath: string) {
    this.specsDir = join(projectPath, '.teamai');
    mkdirSync(this.specsDir, { recursive: true });
  }

  create(id: string, title: string, description: string, source?: string, competitiveContext?: string): Task {
    const slug = slugify(title);
    const dir = join(this.specsDir, slug);
    mkdirSync(dir, { recursive: true });

    const task: Task = {
      id,
      title,
      description,
      phase: 'backlog',
      source,
      competitiveContext,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    atomicWriteJson(join(dir, 'task.json'), task);
    return task;
  }

  update(id: string, fields: Partial<Omit<Task, 'id' | 'createdAt'>>): void {
    const task = this.getById(id);
    if (!task) throw new Error(`Task ${id} not found`);
    const updated = { ...task, ...fields, updatedAt: new Date().toISOString() };
    const dir = this.getDirById(id);
    atomicWriteJson(join(dir, 'task.json'), updated);
  }

  updatePhase(id: string, phase: string): void {
    const task = this.getById(id);
    if (!task) throw new Error(`Task ${id} not found`);

    task.phase = phase;
    task.updatedAt = new Date().toISOString();

    const dir = this.getDirById(id);
    atomicWriteJson(join(dir, 'task.json'), task);

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

  delete(id: string): void {
    const dir = this.getDirById(id);
    // Clean up any stale .tmp file that might remain from a failed atomic write
    try { const tmpPath = join(dir, 'task.json.tmp'); if (existsSync(tmpPath)) unlinkSync(tmpPath); } catch { /* best-effort */ }
    rmSync(dir, { recursive: true, force: true });
  }

  // Remove pipeline artifacts at or after a given level so the pipeline can re-run from there.
  // level: 'spec' | 'plan' | 'qa'
  clearArtifacts(id: string, level: 'spec' | 'plan' | 'qa'): void {
    const dir = this.getDirById(id);
    const files: Record<string, string[]> = {
      spec: ['spec.md', 'plan.json', 'qa_report.json', 'spec_revision_feedback.md', 'spec_v1.md', 'spec_v2.md', 'spec_v3.md'],
      plan: ['plan.json', 'qa_report.json'],
      qa:   ['qa_report.json', 'qa_feedback.md', 'completion_summary.md', 'qa_report_before_bounce.json'],
    };
    for (const f of files[level]) {
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
