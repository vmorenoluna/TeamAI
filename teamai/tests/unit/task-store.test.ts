/**
 * Unit tests for TaskStore.
 *
 * Tests all filesystem-based methods: create, update, updatePhase, getAll,
 * getById, getDirById, delete, clearArtifacts, getDirBySlug, readRawTaskJson,
 * and getEvents. Uses createTestProject() for isolated temp directories.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, readFileSync, writeFileSync, rmSync, mkdirSync } from 'fs';
import { join } from 'path';
import { TaskStore, isRetryableError } from '@/lib/task-store';
import { setupTaskStoreTest, makeTask, type TaskStoreTestEnv } from '../utils/task-store-harness';

// ── Helpers ─────────────────────────────────────────────────────────────────

let env: TaskStoreTestEnv;
let store: TaskStore;
let root: string;
let clean: () => void;

function createTask(
  title = 'Test task',
  description = 'Description',
  source?: string,
  competitiveContext?: string,
) {
  return makeTask(store, env.nextId, title, description, source, competitiveContext);
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('isRetryableError', () => {
  it('returns true for {code: "EPERM"}', () => {
    expect(isRetryableError({ code: 'EPERM' })).toBe(true);
  });

  it('returns true for {code: "EBUSY"}', () => {
    expect(isRetryableError({ code: 'EBUSY' })).toBe(true);
  });

  it('returns false for {code: "ENOENT"}', () => {
    expect(isRetryableError({ code: 'ENOENT' })).toBe(false);
  });

  it('returns false for {code: "EEXIST"}', () => {
    expect(isRetryableError({ code: 'EEXIST' })).toBe(false);
  });

  it('returns false for null', () => {
    expect(isRetryableError(null)).toBe(false);
  });

  it('returns false for undefined', () => {
    expect(isRetryableError(undefined)).toBe(false);
  });

  it('returns false for a string error', () => {
    expect(isRetryableError('some string error')).toBe(false);
  });

  it('returns false for a plain Error instance', () => {
    expect(isRetryableError(new Error('boom'))).toBe(false);
  });

  it('returns false for a number', () => {
    expect(isRetryableError(42)).toBe(false);
  });
});

describe('TaskStore', () => {
  beforeEach(() => {
    env = setupTaskStoreTest();
    store = env.store;
    root = env.root;
    clean = env.clean;
  });

  afterEach(() => {
    clean();
  });

  // ── constructor ─────────────────────────────────────────────────────

  describe('constructor', () => {
    it('creates the .teamai directory if it does not exist', () => {
      // createTestProject creates root but not .teamai/
      // TaskStore constructor calls mkdirSync(specsDir, { recursive: true })
      expect(existsSync(join(root, '.teamai'))).toBe(true);
    });
  });

  // ── create ───────────────────────────────────────────────────────────

  describe('create', () => {
    it('creates a task with the correct default fields', () => {
      const task = createTask('Fix login bug', 'Users cannot log in');

      expect(task.id).toMatch(/^task-/);
      expect(task.title).toBe('Fix login bug');
      expect(task.description).toBe('Users cannot log in');
      expect(task.phase).toBe('backlog');
      expect(task.source).toBeUndefined();
      expect(task.competitiveContext).toBeUndefined();
      // createdAt and updatedAt are set in the same create() call but
      // use separate new Date() invocations — they may differ by a few ms.
      expect(Date.parse(task.createdAt)).not.toBeNaN();
      expect(Date.parse(task.updatedAt)).not.toBeNaN();
      expect(new Date(task.updatedAt).getTime())
        .toBeGreaterThanOrEqual(new Date(task.createdAt).getTime());
    });

    it('creates a task with source and competitiveContext', () => {
      const task = createTask(
        'Competitive feature',
        'Match competitor X',
        'competitor-analysis',
        'Competitor X has this',
      );

      expect(task.source).toBe('competitor-analysis');
      expect(task.competitiveContext).toBe('Competitor X has this');
    });

    it('writes task.json to a slugified directory', () => {
      // slugify('Fix Login BUG') → 'fix-login-bug' (no trailing punctuation)
      const _task = createTask('Fix Login BUG', 'desc');

      const dir = join(root, '.teamai', 'fix-login-bug');
      expect(existsSync(dir)).toBe(true);

      const raw = JSON.parse(readFileSync(join(dir, 'task.json'), 'utf-8'));
      expect(raw.id).toBe(_task.id);
      expect(raw.title).toBe('Fix Login BUG');
    });

    it('handles multiple tasks with distinct slugs without collisions', () => {
      // "Fix bug" → 'fix-bug', "Fix bug UI" → 'fix-bug-ui' — different slugs
      const task1 = createTask('Fix bug', 'desc');
      const task2 = store.create(env.nextId(), 'Fix bug UI', 'desc');

      // Both should be retrievable (no overwrite)
      expect(store.getById(task1.id)).not.toBeNull();
      expect(store.getById(task2.id)).not.toBeNull();
      expect(task1.id).not.toBe(task2.id);
    });

    it('does not leave stale .tmp files after a successful write', () => {
      void createTask('Atomic test', 'desc');
      const dir = join(root, '.teamai', 'atomic-test');
      const tmpPath = join(dir, 'task.json.tmp');

      // The .tmp file should not exist after successful write
      expect(existsSync(tmpPath)).toBe(false);
      // The real file should exist
      expect(existsSync(join(dir, 'task.json'))).toBe(true);
    });
  });

  // ── getAll ───────────────────────────────────────────────────────────

  describe('getAll', () => {
    it('returns an empty array when no tasks exist', () => {
      expect(store.getAll()).toEqual([]);
    });

    it('returns all tasks sorted by createdAt descending', async () => {
      const task1 = createTask('Task 1');
      // Small delay to ensure distinct createdAt values
      await new Promise(r => setTimeout(r, 5));
      const task2 = createTask('Task 2');

      const all = store.getAll();
      expect(all.length).toBe(2);
      // Newest first
      expect(all[0].id).toBe(task2.id);
      expect(all[1].id).toBe(task1.id);
    });

    it('breaks createdAt ties deterministically by id (not readdirSync order)', () => {
      // Two tasks with identical createdAt must not fall back to filesystem
      // (readdirSync) ordering, which is unstable. Tie-break on id instead.
      const ts = '2024-01-01T00:00:00.000Z';
      const dirZ = join(root, '.teamai', 'dir-z');
      const dirA = join(root, '.teamai', 'dir-a');
      mkdirSync(dirZ, { recursive: true });
      mkdirSync(dirA, { recursive: true });
      writeFileSync(join(dirZ, 'task.json'), JSON.stringify({
        id: 'id-z', title: 'Z', description: 'z', phase: 'backlog', createdAt: ts, updatedAt: ts,
      }));
      writeFileSync(join(dirA, 'task.json'), JSON.stringify({
        id: 'id-a', title: 'A', description: 'a', phase: 'backlog', createdAt: ts, updatedAt: ts,
      }));

      const all = store.getAll();
      expect(all.map(t => t.id)).toEqual(['id-a', 'id-z']);
    });

    it('returns empty array from an empty .teamai directory', () => {
      // Fresh store on a new path — directory created by constructor but empty
      const emptyRoot = join(root, 'empty-project');
      const emptyStore = new TaskStore(emptyRoot);
      expect(emptyStore.getAll()).toEqual([]);
    });

    it('returns empty array when .teamai directory does not exist', () => {
      // Remove the directory that the constructor created so the
      // !existsSync(this.specsDir) early-return path is exercised.
      const emptyRoot = join(root, 'deleted-teamai');
      const emptyStore = new TaskStore(emptyRoot);
      rmSync(join(emptyRoot, '.teamai'), { recursive: true, force: true });
      expect(emptyStore.getAll()).toEqual([]);
    });
  });

  // ── getById ──────────────────────────────────────────────────────────

  describe('getById', () => {
    it('returns a task by its ID', () => {
      const task = createTask('Find me', 'desc');
      const found = store.getById(task.id);
      expect(found).not.toBeNull();
      expect(found!.title).toBe('Find me');
    });

    it('returns null when no task matches the ID', () => {
      expect(store.getById('nonexistent')).toBeNull();
    });
  });

  // ── getDirById ───────────────────────────────────────────────────────

  describe('getDirById', () => {
    it('returns the directory path for a task', () => {
      const task = createTask('Dir test', 'desc');
      const dir = store.getDirById(task.id);
      expect(dir).toBe(join(root, '.teamai', 'dir-test'));
      expect(existsSync(dir)).toBe(true);
    });

    it('throws when the task ID is not found', () => {
      expect(() => store.getDirById('no-such-id')).toThrow('Task directory not found for id no-such-id');
    });
  });

  // ── update ───────────────────────────────────────────────────────────

  describe('update', () => {
    it('updates provided task fields', () => {
      const task = createTask('Original title', 'Original desc');
      store.update(task.id, { title: 'Updated title', description: 'Updated desc' });

      const updated = store.getById(task.id)!;
      expect(updated.title).toBe('Updated title');
      expect(updated.description).toBe('Updated desc');
    });

    it('preserves fields not specified in the update', () => {
      const task = createTask('Preserve me', 'desc');
      store.update(task.id, { phase: 'in-progress' });

      const updated = store.getById(task.id)!;
      expect(updated.title).toBe('Preserve me');
      expect(updated.description).toBe('desc');
      expect(updated.phase).toBe('in-progress');
    });

    it('updates the updatedAt timestamp', () => {
      const task = createTask('Timestamp test', 'desc');
      const originalUpdatedAt = task.updatedAt;

      // Small delay for distinct timestamp
      store.update(task.id, { title: 'New' });

      const updated = store.getById(task.id)!;
      expect(new Date(updated.updatedAt).getTime()).toBeGreaterThanOrEqual(
        new Date(originalUpdatedAt).getTime(),
      );
    });

    it('no-ops gracefully with an empty update object', () => {
      const task = createTask('Empty update', 'desc');
      store.update(task.id, {});

      const unchanged = store.getById(task.id)!;
      expect(unchanged.title).toBe('Empty update');
      expect(unchanged.phase).toBe('backlog');
    });

    it('does not allow changing the task ID', () => {
      const task = createTask('ID test', 'desc');
      store.update(task.id, { title: 'new title' } as any);

      const updated = store.getById(task.id)!;
      // ID should remain unchanged (Omit<Task, 'id' | 'createdAt'> prevents this at type level)
      expect(updated.id).toBe(task.id);
    });

    it('throws when the task is not found', () => {
      expect(() => store.update('nonexistent', { title: 'X' })).toThrow('Task nonexistent not found');
    });
  });

  // ── updatePhase ──────────────────────────────────────────────────────

  describe('updatePhase', () => {
    it('updates the task phase', () => {
      const task = createTask('Phase test', 'desc');
      store.updatePhase(task.id, 'in-progress');

      const updated = store.getById(task.id)!;
      expect(updated.phase).toBe('in-progress');
    });

    it('appends an event for each phase change to events.jsonl', () => {
      const task = createTask('Event test', 'desc');
      store.updatePhase(task.id, 'in-progress');
      store.updatePhase(task.id, 'awaiting-review');

      const dir = store.getDirById(task.id);
      const eventsPath = join(dir, 'events.jsonl');
      expect(existsSync(eventsPath)).toBe(true);

      const lines = readFileSync(eventsPath, 'utf-8').trim().split('\n');
      expect(lines.length).toBe(2);

      const event1 = JSON.parse(lines[0]);
      expect(event1.phase).toBe('in-progress');
      expect(Date.parse(event1.timestamp)).not.toBeNaN();

      const event2 = JSON.parse(lines[1]);
      expect(event2.phase).toBe('awaiting-review');
    });

    it('appends an event even when updating to the same phase', () => {
      const task = createTask('Same phase', 'desc');
      store.updatePhase(task.id, 'in-progress');
      store.updatePhase(task.id, 'in-progress'); // same phase again

      const events = store.getEvents(task.id);
      expect(events.length).toBe(2);
      expect(events[0].phase).toBe('in-progress');
      expect(events[1].phase).toBe('in-progress');
    });

    it('throws when the task is not found', () => {
      expect(() => store.updatePhase('nonexistent', 'done')).toThrow('Task nonexistent not found');
    });

    it('records the task as completed when transitioning to done, regardless of which caller does it', () => {
      // Guards against the gap where only orchestrator.markTaskDone() called
      // markCompletedTask() explicitly — any other finalization path (e.g.
      // runMergePhase's direct-merge flow, which only ever calls
      // updatePhase/advancePhase) reached 'done' without ever being recorded,
      // permanently blocking dependency resolution for tasks depending on it
      // once its directory was deleted or never locally restored.
      const task = createTask('Direct-merge finish', 'desc');
      store.updatePhase(task.id, 'done');

      expect(store.isTaskCompleted(task.id)).toBe(true);
    });

    it('does not record completion for non-done phase transitions', () => {
      const task = createTask('Not done yet', 'desc');
      store.updatePhase(task.id, 'awaiting-review');

      expect(store.isTaskCompleted(task.id)).toBe(false);
    });

    it('keeps a dependency resolvable via isTaskCompleted after its directory is deleted', () => {
      const dep = createTask('Dependency task', 'desc');
      store.updatePhase(dep.id, 'done');
      store.delete(dep.id);

      expect(store.getById(dep.id)).toBeNull();
      expect(store.isTaskCompleted(dep.id)).toBe(true);
    });

    it('persists awaitingReviewReason on the task when parking on awaiting-review with a reason', () => {
      const task = createTask('Failure park', 'desc');
      store.updatePhase(task.id, 'awaiting-review', {
        awaitingReviewReason: 'Spec phase produced no spec.md.',
      });

      expect(store.getById(task.id)!.awaitingReviewReason).toBe('Spec phase produced no spec.md.');
    });

    it('does not set awaitingReviewReason when awaiting-review has no reason (genuine QA pass)', () => {
      const task = createTask('QA pass', 'desc');
      store.updatePhase(task.id, 'awaiting-review');

      expect(store.getById(task.id)!.awaitingReviewReason).toBeUndefined();
    });

    it('clears a stale awaitingReviewReason once the task leaves awaiting-review', () => {
      const task = createTask('Rejected back to implement', 'desc');
      store.updatePhase(task.id, 'awaiting-review', {
        awaitingReviewReason: 'Spec phase produced no spec.md.',
      });
      store.updatePhase(task.id, 'implement');

      expect(store.getById(task.id)!.awaitingReviewReason).toBeUndefined();
    });
  });

  // ── delete ───────────────────────────────────────────────────────────

  describe('delete', () => {
    it('removes the task directory', () => {
      const task = createTask('To delete', 'desc');
      const dir = store.getDirById(task.id);

      store.delete(task.id);

      expect(existsSync(dir)).toBe(false);
    });

    it('throws when deleting a non-existent task', () => {
      expect(() => store.delete('nonexistent')).toThrow();
    });

    it('cleans up stale .tmp files before deletion', () => {
      const task = createTask('Tmp test', 'desc');
      const dir = store.getDirById(task.id);

      // Simulate a stale .tmp file
      writeFileSync(join(dir, 'task.json.tmp'), 'stale');

      // Should not throw
      expect(() => store.delete(task.id)).not.toThrow();
      expect(existsSync(dir)).toBe(false);
    });
  });

  // ── clearArtifacts ───────────────────────────────────────────────────

  describe('clearArtifacts', () => {
    let taskId: string;
    let dir: string;

    beforeEach(() => {
      const task = createTask('Artifact test', 'desc');
      taskId = task.id;
      dir = store.getDirById(task.id);

      // Create some artifact files
      writeFileSync(join(dir, 'spec.md'), '# spec');
      writeFileSync(join(dir, 'spec_summary.md'), '# spec summary');
      writeFileSync(join(dir, 'plan.json'), '{}');
      writeFileSync(join(dir, 'qa_report.json'), '{}');
      writeFileSync(join(dir, 'qa_feedback.md'), '# feedback');
      writeFileSync(join(dir, 'completion_summary.md'), '# summary');
      writeFileSync(join(dir, 'qa_report_before_bounce.json'), '{}');
      writeFileSync(join(dir, 'qa_report_before_failed.json'), '{}');
      writeFileSync(join(dir, 'spec_revision_feedback.md'), '# revision feedback');
      writeFileSync(join(dir, 'spec_v1.md'), '# original spec snapshot');
      // Control file: not in any artifact registry — should survive all levels
      writeFileSync(join(dir, 'human_feedback.md'), '# human review');
    });

    it('clears spec-level artifacts (all downstream files)', () => {
      store.clearArtifacts(taskId, 'spec');

      // Spec-level: cleared
      expect(existsSync(join(dir, 'spec.md'))).toBe(false);
      expect(existsSync(join(dir, 'spec_summary.md'))).toBe(false);
      expect(existsSync(join(dir, 'spec_revision_feedback.md'))).toBe(false);
      expect(existsSync(join(dir, 'spec_v1.md'))).toBe(false);
      // Plan-level: cleared
      expect(existsSync(join(dir, 'plan.json'))).toBe(false);
      // QA-level: cleared (cumulative — spec clears everything downstream)
      expect(existsSync(join(dir, 'qa_report.json'))).toBe(false);
      expect(existsSync(join(dir, 'qa_feedback.md'))).toBe(false);
      expect(existsSync(join(dir, 'completion_summary.md'))).toBe(false);
      expect(existsSync(join(dir, 'qa_report_before_bounce.json'))).toBe(false);
      expect(existsSync(join(dir, 'qa_report_before_failed.json'))).toBe(false);
      // Control: not in registry — should survive
      expect(existsSync(join(dir, 'human_feedback.md'))).toBe(true);
    });

    // routeHumanFeedback's "Request Changes → Analyst" path has no cap on
    // specRevision (unlike autoReviseSpec's QA-driven cap of 3), so a task
    // can accumulate spec_v5.md+ / qa_report_v6.json+ from repeated
    // human-driven revisions. PHASE_ARTIFACTS['spec'] must clear those too,
    // not just the first few — otherwise a spec restart leaves old revision
    // history littering the task directory.
    it('clears spec_v and qa_report_v snapshots beyond the first few', () => {
      writeFileSync(join(dir, 'spec_v5.md'), '# fifth revision snapshot');
      writeFileSync(join(dir, 'qa_report_v6.json'), '{}');

      store.clearArtifacts(taskId, 'spec');

      expect(existsSync(join(dir, 'spec_v5.md'))).toBe(false);
      expect(existsSync(join(dir, 'qa_report_v6.json'))).toBe(false);
    });

    it('clears plan-level artifacts (plan + downstream QA files)', () => {
      store.clearArtifacts(taskId, 'plan');

      // Plan-level: cleared
      expect(existsSync(join(dir, 'plan.json'))).toBe(false);
      // QA-level: cleared (cumulative — plan clears everything downstream)
      expect(existsSync(join(dir, 'qa_report.json'))).toBe(false);
      expect(existsSync(join(dir, 'qa_feedback.md'))).toBe(false);
      expect(existsSync(join(dir, 'completion_summary.md'))).toBe(false);
      expect(existsSync(join(dir, 'qa_report_before_bounce.json'))).toBe(false);
      expect(existsSync(join(dir, 'qa_report_before_failed.json'))).toBe(false);
      // Spec-level: should remain (plan is downstream of spec)
      expect(existsSync(join(dir, 'spec.md'))).toBe(true);
      expect(existsSync(join(dir, 'spec_summary.md'))).toBe(true);
      expect(existsSync(join(dir, 'spec_revision_feedback.md'))).toBe(true);
      expect(existsSync(join(dir, 'spec_v1.md'))).toBe(true);
      // Control: not in registry — should survive
      expect(existsSync(join(dir, 'human_feedback.md'))).toBe(true);
    });

    it('clears qa-level artifacts only', () => {
      store.clearArtifacts(taskId, 'qa');

      // QA-level: cleared
      expect(existsSync(join(dir, 'qa_report.json'))).toBe(false);
      expect(existsSync(join(dir, 'qa_feedback.md'))).toBe(false);
      expect(existsSync(join(dir, 'completion_summary.md'))).toBe(false);
      expect(existsSync(join(dir, 'qa_report_before_bounce.json'))).toBe(false);
      expect(existsSync(join(dir, 'qa_report_before_failed.json'))).toBe(false);
      // Spec + plan-level: should remain (upstream of qa)
      expect(existsSync(join(dir, 'spec.md'))).toBe(true);
      expect(existsSync(join(dir, 'spec_summary.md'))).toBe(true);
      expect(existsSync(join(dir, 'spec_revision_feedback.md'))).toBe(true);
      expect(existsSync(join(dir, 'spec_v1.md'))).toBe(true);
      expect(existsSync(join(dir, 'plan.json'))).toBe(true);
      // Control: not in registry — should survive
      expect(existsSync(join(dir, 'human_feedback.md'))).toBe(true);
    });

    it('does not throw when clearing non-existent artifacts', () => {
      // spec.md was deleted in a previous clearArtifacts call — clearing again should be fine
      store.clearArtifacts(taskId, 'qa'); // qa_feedback, completion_summary removed
      store.clearArtifacts(taskId, 'qa'); // should not throw

      // All qa-level files should still be gone
      expect(existsSync(join(dir, 'qa_feedback.md'))).toBe(false);
    });

    it('throws when task is not found', () => {
      expect(() => store.clearArtifacts('nonexistent', 'spec')).toThrow();
    });
  });

  // ── getDirBySlug ─────────────────────────────────────────────────────

  describe('getDirBySlug', () => {
    it('returns the directory path for a given slug', () => {
      const path = store.getDirBySlug('my-slug');
      expect(path).toBe(join(root, '.teamai', 'my-slug'));
    });
  });

  // ── readRawTaskJson ──────────────────────────────────────────────────

  describe('readRawTaskJson', () => {
    it('returns the raw task.json content as a string', () => {
      const task = createTask('Raw JSON test', 'desc');
      const raw = store.readRawTaskJson(task.id);

      expect(raw).not.toBeNull();
      const parsed = JSON.parse(raw!);
      expect(parsed.title).toBe('Raw JSON test');
    });

    it('returns null when the task is not found', () => {
      expect(store.readRawTaskJson('nonexistent')).toBeNull();
    });
  });

  // ── getEvents ────────────────────────────────────────────────────────

  describe('getEvents', () => {
    it('returns an empty array when no events have been recorded', () => {
      const task = createTask('No events', 'desc');
      expect(store.getEvents(task.id)).toEqual([]);
    });

    it('returns events in chronological order', () => {
      const task = createTask('Events test', 'desc');
      store.updatePhase(task.id, 'in-progress');
      store.updatePhase(task.id, 'awaiting-review');
      store.updatePhase(task.id, 'done');

      const events = store.getEvents(task.id);
      expect(events.length).toBe(3);
      expect(events[0].phase).toBe('in-progress');
      expect(events[1].phase).toBe('awaiting-review');
      expect(events[2].phase).toBe('done');

      // Timestamps should be in chronological order
      expect(new Date(events[1].timestamp).getTime())
        .toBeGreaterThanOrEqual(new Date(events[0].timestamp).getTime());
      expect(new Date(events[2].timestamp).getTime())
        .toBeGreaterThanOrEqual(new Date(events[1].timestamp).getTime());
    });

    it('throws when task is not found', () => {
      expect(() => store.getEvents('nonexistent')).toThrow();
    });
  });

  describe('canonical slug (BUG-13 / T14)', () => {
    it('stores a slug derived from the title on the task record', () => {
      const t = createTask('Fix Login Bug', 'Something entirely different');
      expect(t.slug).toBe('fix-login-bug');
      expect(store.getById(t.id)?.slug).toBe('fix-login-bug');
      expect(store.getDirById(t.id)).toBe(join(root, '.teamai', 'fix-login-bug'));
    });

    it('two tasks with identical titles get distinct dirs and slugs', () => {
      const t1 = createTask('Same Title');
      const t2 = createTask('Same Title');
      const t3 = createTask('Same Title');
      expect(t1.slug).toBe('same-title');
      expect(t2.slug).toBe('same-title-2');
      expect(t3.slug).toBe('same-title-3');
      expect(store.getDirById(t1.id)).not.toBe(store.getDirById(t2.id));
      expect(store.getDirById(t2.id)).not.toBe(store.getDirById(t3.id));
    });

    it('titles sharing a 40-char slug prefix do not collide', () => {
      const longA = 'Refactor the authentication middleware to support rotating tokens';
      const longB = 'Refactor the authentication middleware to support static tokens';
      const t1 = createTask(longA);
      const t2 = createTask(longB);
      expect(t1.slug).not.toBe(t2.slug);
      expect(store.getDirById(t1.id)).not.toBe(store.getDirById(t2.id));
    });

    it('falls back to "task" for titles that slugify to empty', () => {
      const t = createTask('!!!', 'symbols only');
      expect(t.slug).toBe('task');
      expect(store.getDirById(t.id)).toBe(join(root, '.teamai', 'task'));
    });
  });

  describe('directory index (BUG-16 / T20)', () => {
    it('getById resolves repeatedly without rescanning results changing', () => {
      const tasks = Array.from({ length: 20 }, (_, i) =>
        store.create(`idx-${i}`, `Task number ${i}`, `Desc ${i}`));
      for (const t of tasks) {
        expect(store.getById(t.id)?.title).toBe(t.title);
      }
      // Second pass hits the warm index
      for (const t of tasks) {
        expect(store.getById(t.id)?.id).toBe(t.id);
      }
    });

    it('picks up a task directory created externally (not via store.create)', () => {
      createTask('Warm the index');
      expect(store.getById('external-1')).toBeNull();

      // Simulate another process (e.g. git pull) adding a task dir
      const dir = join(root, '.teamai', 'external-task');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'task.json'), JSON.stringify({
        id: 'external-1', title: 'External', description: 'From git pull',
        phase: 'done', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      }));

      expect(store.getById('external-1')?.title).toBe('External');
      expect(store.getDirById('external-1')).toBe(dir);
    });

    it('recovers when a task.json is deleted behind the index', () => {
      const t = createTask('Doomed task');
      expect(store.getById(t.id)).not.toBeNull();

      const dir = store.getDirById(t.id);
      rmSync(join(dir, 'task.json'));

      expect(store.getById(t.id)).toBeNull();
      expect(() => store.getDirById(t.id)).toThrow(/not found/);
    });

    it('getDirById stays correct across delete and re-create with the same title', () => {
      const t1 = createTask('Recycled title');
      const dir1 = store.getDirById(t1.id);
      store.delete(t1.id);
      expect(() => store.getDirById(t1.id)).toThrow();

      const t2 = createTask('Recycled title');
      expect(store.getDirById(t2.id)).toBe(dir1); // same slug dir, new id
      expect(store.getById(t1.id)).toBeNull();
      expect(store.getById(t2.id)?.id).toBe(t2.id);
    });
  });
});
