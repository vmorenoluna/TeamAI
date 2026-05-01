import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync, appendFileSync, rmSync } from 'fs';
import { join } from 'path';

export interface Task {
  id: string;
  title: string;
  description: string;
  phase: string;
  branch?: string;
  dependencies?: string[];     // IDs of tasks this task depends on
  roleOverride?: string;       // role filename (e.g. 'coder.md') for implement phase
  rateLimitedUntil?: string;   // ISO timestamp — set when pipeline is paused by API rate limit
  createdAt: string;
  updatedAt: string;
}

function slugify(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40);
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

  update(id: string, fields: Partial<Omit<Task, 'id' | 'createdAt'>>): void {
    const task = this.getById(id);
    if (!task) throw new Error(`Task ${id} not found`);
    const updated = { ...task, ...fields, updatedAt: new Date().toISOString() };
    const dir = this.getDirById(id);
    writeFileSync(join(dir, 'task.json'), JSON.stringify(updated, null, 2));
  }

  updatePhase(id: string, phase: string): void {
    const task = this.getById(id);
    if (!task) throw new Error(`Task ${id} not found`);

    task.phase = phase;
    task.updatedAt = new Date().toISOString();

    const dir = this.getDirById(id);
    writeFileSync(join(dir, 'task.json'), JSON.stringify(task, null, 2));

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
    rmSync(dir, { recursive: true, force: true });
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
