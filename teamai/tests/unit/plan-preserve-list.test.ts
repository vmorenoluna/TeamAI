/**
 * Unit tests for the scoped planner re-plan preserve-list guardrail:
 *   snapshotPreservedPlanSubtasks — capture the unselected subtasks before the
 *     planner session runs (keyed by id, with their pre-session index).
 *   restorePreservedPlanSubtasks — enforce the preserve-list after the session:
 *     overwrite any drift on preserved ids, re-insert dropped ones, and drop
 *     renumbered orphans. Everything unselected must come back byte-for-byte.
 */
// @vitest-environment node

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

vi.mock('../../src/lib/logger', () => ({
  log: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn(),
}));

import {
  snapshotPreservedPlanSubtasks,
  restorePreservedPlanSubtasks,
  loadPreservedPlanSubtasks,
  clearPreservedPlanSubtasks,
} from '../../src/lib/orchestrator/plan-validation';

const PRESERVE_SNAPSHOT_FILE = 'plan_preserve_snapshot.json';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'plan-preserve-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writePlan(subtasks: unknown[]) {
  writeFileSync(join(dir, 'plan.json'), JSON.stringify({ complexity: 2, subtasks }, null, 2));
}

function readPlan() {
  return JSON.parse(readFileSync(join(dir, 'plan.json'), 'utf-8'));
}

function st(id: number, overrides: Record<string, unknown> = {}) {
  return {
    id,
    title: `Subtask ${id}`,
    description: `description ${id}`,
    files: [`src/${id}.ts`],
    acceptance_criteria: [`criterion ${id}`],
    parallel_group: 'A',
    completed: false,
    qa_flagged: false,
    ...overrides,
  };
}

describe('snapshotPreservedPlanSubtasks', () => {
  it('captures every subtask NOT in the selection, keyed by id with its index', () => {
    writePlan([st(1), st(2), st(3)]);
    const snapshot = snapshotPreservedPlanSubtasks(dir, [2]);
    expect([...snapshot.keys()].sort()).toEqual([1, 3]);
    expect(snapshot.get(1)).toEqual({ subtask: st(1), index: 0 });
    expect(snapshot.get(3)).toEqual({ subtask: st(3), index: 2 });
  });

  it('returns an empty map when plan.json is missing', () => {
    expect(snapshotPreservedPlanSubtasks(dir, [1])).toEqual(new Map());
  });

  it('returns an empty map when plan.json is malformed', () => {
    writeFileSync(join(dir, 'plan.json'), 'not json');
    expect(snapshotPreservedPlanSubtasks(dir, [1])).toEqual(new Map());
  });

  it('returns an empty map when the selection covers every subtask', () => {
    writePlan([st(1), st(2)]);
    expect(snapshotPreservedPlanSubtasks(dir, [1, 2])).toEqual(new Map());
  });

  it('drops stale ids that no longer exist in the plan', () => {
    writePlan([st(1), st(2)]);
    // 99 is stale — silently ignored; 1 is preserved.
    const snapshot = snapshotPreservedPlanSubtasks(dir, [99]);
    expect([...snapshot.keys()]).toEqual([1, 2]);
  });
});

describe('persisted snapshot (crash recovery)', () => {
  it('snapshotPreservedPlanSubtasks persists the snapshot to disk', () => {
    writePlan([st(1), st(2), st(3)]);
    snapshotPreservedPlanSubtasks(dir, [2]);
    expect(existsSync(join(dir, PRESERVE_SNAPSHOT_FILE))).toBe(true);
  });

  it('loadPreservedPlanSubtasks round-trips the persisted snapshot byte-for-byte', () => {
    writePlan([st(1), st(2, { completed: true, qa_flagged: false }), st(3)]);
    snapshotPreservedPlanSubtasks(dir, [1]);
    const loaded = loadPreservedPlanSubtasks(dir);
    expect(loaded).not.toBeNull();
    expect([...loaded!.keys()].sort()).toEqual([2, 3]);
    expect(loaded!.get(2)).toEqual({ subtask: st(2, { completed: true, qa_flagged: false }), index: 1 });
    expect(loaded!.get(3)).toEqual({ subtask: st(3), index: 2 });
  });

  it('does not persist when the selection covers every subtask (nothing to preserve)', () => {
    writePlan([st(1), st(2)]);
    const snapshot = snapshotPreservedPlanSubtasks(dir, [1, 2]);
    expect(snapshot.size).toBe(0);
    expect(existsSync(join(dir, PRESERVE_SNAPSHOT_FILE))).toBe(false);
  });

  it('returns null for a missing or malformed persisted snapshot', () => {
    expect(loadPreservedPlanSubtasks(dir)).toBeNull();
    writeFileSync(join(dir, PRESERVE_SNAPSHOT_FILE), 'not json');
    expect(loadPreservedPlanSubtasks(dir)).toBeNull();
  });

  it('clearPreservedPlanSubtasks deletes the persisted snapshot', () => {
    writePlan([st(1), st(2)]);
    snapshotPreservedPlanSubtasks(dir, [1]);
    expect(existsSync(join(dir, PRESERVE_SNAPSHOT_FILE))).toBe(true);
    clearPreservedPlanSubtasks(dir);
    expect(existsSync(join(dir, PRESERVE_SNAPSHOT_FILE))).toBe(false);
  });

  it('clearPreservedPlanSubtasks is a safe no-op when no snapshot exists', () => {
    expect(() => clearPreservedPlanSubtasks(dir)).not.toThrow();
  });
});

describe('restorePreservedPlanSubtasks', () => {
  it('overwrites a preserved subtask the planner rewrote, byte-for-byte', () => {
    const original2 = st(2, { completed: true, qa_flagged: false });
    writePlan([st(1), original2, st(3)]);
    const snapshot = snapshotPreservedPlanSubtasks(dir, [1]);

    // Planner rewrote #2 (preserved) and added a brand-new #4 (kept).
    writePlan([
      st(1, { description: 'rewritten by planner' }),
      st(2, { description: 'clobbered', files: ['src/nope.ts'], completed: false }),
      st(3),
      st(4, { title: 'New subtask' }),
    ]);

    restorePreservedPlanSubtasks(dir, snapshot);

    const plan = readPlan();
    const byId = Object.fromEntries(plan.subtasks.map((s: { id: number }) => [s.id, s]));
    // #2 restored verbatim; #4 (new id) kept; #1 is selected so its rewrite survives.
    expect(byId[2]).toEqual(original2);
    expect(byId[4]).toEqual(st(4, { title: 'New subtask' }));
    expect(byId[1].description).toBe('rewritten by planner');
  });

  it('re-inserts a preserved subtask the planner dropped, at its pre-session index', () => {
    writePlan([st(1), st(2), st(3)]);
    const snapshot = snapshotPreservedPlanSubtasks(dir, [1]);

    // Planner dropped #2 entirely and kept #3, added #4.
    writePlan([st(1), st(3), st(4, { title: 'New subtask' })]);

    restorePreservedPlanSubtasks(dir, snapshot);

    const plan = readPlan();
    expect(plan.subtasks).toEqual([st(1), st(2), st(3), st(4, { title: 'New subtask' })]);
  });

  it('always undoes a merge of preserved subtasks: restores both originals, keeps the merged new id', () => {
    writePlan([st(1), st(2), st(3)]);
    const snapshot = snapshotPreservedPlanSubtasks(dir, [1]);

    // Planner merged preserved #2 + #3 into a single NEW subtask #7 (outside
    // the preserve-list) and kept the selected #1. Neither original survives
    // under its own id, so the guardrail must bring both back byte-for-byte
    // (open question #1: merging of preserved subtasks is always undone).
    writePlan([
      st(1, { description: 'rewritten by planner' }),
      st(7, {
        title: 'Merged B and C',
        description: 'B and C combined',
        files: ['src/2.ts', 'src/3.ts'],
        acceptance_criteria: ['b', 'c'],
      }),
    ]);

    restorePreservedPlanSubtasks(dir, snapshot);

    const plan = readPlan();
    const byId = Object.fromEntries(plan.subtasks.map((s: { id: number }) => [s.id, s]));
    // Both preserved subtasks come back byte-for-byte.
    expect(byId[2]).toEqual(st(2));
    expect(byId[3]).toEqual(st(3));
    // The merged new id is outside the preserve-list, so it is kept.
    expect(byId[7].title).toBe('Merged B and C');
    // Selected #1 keeps its rewrite.
    expect(byId[1].description).toBe('rewritten by planner');
  });

  it('flags in-place drift in output.log so the undo is diagnosable', () => {
    writePlan([st(1), st(2)]);
    const snapshot = snapshotPreservedPlanSubtasks(dir, [1]);

    // Planner rewrote preserved #2 in place (same id, different content).
    writePlan([st(1), st(2, { description: 'clobbered by planner' })]);

    restorePreservedPlanSubtasks(dir, snapshot);

    // The corrective action is logged, and the subtask is restored verbatim.
    const log = readFileSync(join(dir, 'output.log'), 'utf-8');
    expect(log).toContain('Preserved subtask #2 was modified by the planner');
    const plan = readPlan();
    expect(plan.subtasks[1]).toEqual(st(2));
  });

  it('removes a renumbered orphan duplicate and restores the original id', () => {
    writePlan([st(1), st(2), st(3)]);
    const snapshot = snapshotPreservedPlanSubtasks(dir, [1]);

    // Planner renumbered preserved #2 → #5 (same content, including title).
    writePlan([st(1), st(3), st(5, { title: 'Subtask 2', description: 'description 2', files: ['src/2.ts'], acceptance_criteria: ['criterion 2'] })]);

    restorePreservedPlanSubtasks(dir, snapshot);

    const plan = readPlan();
    const ids = plan.subtasks.map((s: { id: number }) => s.id);
    expect(ids).toContain(2);
    expect(ids).not.toContain(5);
    expect(plan.subtasks[1]).toEqual(st(2));
  });

  it('keeps preserved subtasks in the correct order when re-inserting', () => {
    writePlan([st(1), st(2), st(3)]);
    const snapshot = snapshotPreservedPlanSubtasks(dir, [2]);

    // Planner dropped #1 and #3 (both preserved) but kept the selected #2.
    writePlan([st(2)]);

    restorePreservedPlanSubtasks(dir, snapshot);

    const plan = readPlan();
    expect(plan.subtasks.map((s: { id: number }) => s.id)).toEqual([1, 2, 3]);
  });

  it('is a no-op when the preserved snapshot is empty', () => {
    writePlan([st(1)]);
    const before = readFileSync(join(dir, 'plan.json'), 'utf-8');
    restorePreservedPlanSubtasks(dir, new Map());
    expect(readFileSync(join(dir, 'plan.json'), 'utf-8')).toBe(before);
  });

  it('is a no-op when plan.json is missing', () => {
    expect(() => restorePreservedPlanSubtasks(dir, new Map([[1, { subtask: st(1), index: 0 }]]))).not.toThrow();
    expect(existsSync(join(dir, 'plan.json'))).toBe(false);
  });
});
