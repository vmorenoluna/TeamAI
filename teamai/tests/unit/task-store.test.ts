import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TaskStore } from '@/lib/task-store';
import { mkdirSync, rmSync, existsSync, writeFileSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';

describe('TaskStore', () => {
  const testDir = join(process.cwd(), '.teamai-test-' + randomUUID().slice(0, 8));
  let store: TaskStore;

  beforeEach(() => {
    mkdirSync(testDir, { recursive: true });
    store = new TaskStore(testDir);
  });

  afterEach(() => {
    if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
  });

  it('creates a task and returns it with correct fields', () => {
    const task = store.create('task-1', 'Test Task', 'A test description');
    expect(task.id).toBe('task-1');
    expect(task.title).toBe('Test Task');
    expect(task.description).toBe('A test description');
    expect(task.phase).toBe('backlog');
    expect(task.createdAt).toBeDefined();
    expect(task.updatedAt).toBeDefined();
  });

  it('stores created tasks on disk and retrieves them via getAll', () => {
    store.create('task-1', 'Task One', 'Desc one');
    store.create('task-2', 'Task Two', 'Desc two');

    const all = store.getAll();
    expect(all).toHaveLength(2);
    expect(all.map(t => t.title)).toContain('Task One');
    expect(all.map(t => t.title)).toContain('Task Two');
  });

  it('getById returns the correct task', () => {
    store.create('task-a', 'Alpha', 'First');
    store.create('task-b', 'Beta', 'Second');

    const found = store.getById('task-a');
    expect(found).not.toBeNull();
    expect(found!.title).toBe('Alpha');
  });

  it('getById returns null for unknown id', () => {
    expect(store.getById('nonexistent')).toBeNull();
  });

  it('update modifies task fields', () => {
    store.create('task-1', 'Original', 'Desc');
    store.update('task-1', { title: 'Updated Title', description: 'New desc' });

    const updated = store.getById('task-1');
    expect(updated!.title).toBe('Updated Title');
    expect(updated!.description).toBe('New desc');
  });

  it('updatePhase changes phase and writes events.jsonl', () => {
    store.create('task-1', 'Task', 'Desc');

    store.updatePhase('task-1', 'spec');
    let task = store.getById('task-1');
    expect(task!.phase).toBe('spec');

    store.updatePhase('task-1', 'plan');
    task = store.getById('task-1');
    expect(task!.phase).toBe('plan');

    // Check events file exists
    const dir = store.getDirById('task-1');
    expect(existsSync(join(dir, 'events.jsonl'))).toBe(true);
  });

  it('delete removes the task directory', () => {
    store.create('task-del', 'Delete Me', 'x');
    const dir = store.getDirById('task-del');
    expect(existsSync(dir)).toBe(true);

    store.delete('task-del');
    expect(() => store.getDirById('task-del')).toThrow();
    expect(store.getById('task-del')).toBeNull();
  });

  it('throws on update for nonexistent task', () => {
    expect(() => store.update('ghost', { title: 'x' })).toThrow('not found');
  });

  it('clearArtifacts removes spec, plan, and qa files', () => {
    store.create('task-1', 'Task', 'Desc');
    const dir = store.getDirById('task-1');

    // Simulate artifact files

    writeFileSync(join(dir, 'spec.md'), '# spec');
    writeFileSync(join(dir, 'plan.json'), '{}');
    writeFileSync(join(dir, 'qa_report.json'), '{}');

    // Clear at spec level removes all three
    store.clearArtifacts('task-1', 'spec');
    expect(existsSync(join(dir, 'spec.md'))).toBe(false);
    expect(existsSync(join(dir, 'plan.json'))).toBe(false);
    expect(existsSync(join(dir, 'qa_report.json'))).toBe(false);

    // Re-create and test clear at plan level
    writeFileSync(join(dir, 'spec.md'), '# spec');
    writeFileSync(join(dir, 'plan.json'), '{}');
    writeFileSync(join(dir, 'qa_report.json'), '{}');
    store.clearArtifacts('task-1', 'plan');
    expect(existsSync(join(dir, 'spec.md'))).toBe(true);  // spec preserved
    expect(existsSync(join(dir, 'plan.json'))).toBe(false);
    expect(existsSync(join(dir, 'qa_report.json'))).toBe(false);
  });
});
