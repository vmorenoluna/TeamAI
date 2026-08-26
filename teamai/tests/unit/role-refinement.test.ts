// @vitest-environment node

/** Unit tests for the Role Refinement Assistant core lib (Phase 1):
 *  config load/save, suggestion store, signature dedupe/supersede, and
 *  apply/dismiss/revert with backups. */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

vi.mock('../../src/lib/logger', () => ({
  log: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn(),
}));

import {
  DEFAULT_ROLE_REFINEMENT_CONFIG,
  getRoleRefinementConfig,
  setRoleRefinementConfig,
  writeSuggestion,
  getSuggestion,
  listSuggestions,
  suggestionsForTask,
  updateSuggestion,
  buildFailureSignature,
  detectRecurrence,
  countAutoAnalysesToday,
  applyRefinement,
  dismissRefinement,
  revertRefinement,
  type RoleRefinementSuggestion,
} from '../../src/lib/role-refinement';
import { TaskStore } from '../../src/lib/task-store';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'role-refine-'));
  mkdirSync(join(root, '.teamai'), { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function seedRoles() {
  const rolesDir = join(root, '.claude', 'roles');
  mkdirSync(rolesDir, { recursive: true });
  writeFileSync(join(rolesDir, 'planner.md'), '# Role: Planner\n\nold body\n', 'utf-8');
  writeFileSync(join(rolesDir, 'coder.md'), '# Role: Coder\n\ncoder body\n', 'utf-8');
}

function makeRecord(overrides: Partial<RoleRefinementSuggestion> = {}): RoleRefinementSuggestion {
  return {
    id: 'sug-1',
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
    status: 'suggested',
    trigger: 'manual',
    sourceTaskIds: ['task-1'],
    signature: 'sha256:abc',
    isRolePromptGap: true,
    contractGap: false,
    contractFile: null,
    rootCause: 'Planner never mentions git add -f',
    confidence: 'high',
    diagnosis: 'A project-specific convention is missing from the planner role.',
    edits: [{ roleFile: 'planner.md', mode: 'append', rationale: 'add the rule', proposedContent: 'Always use git add -f for gitignored evidence.', riskClass: 'additive' }],
    appliedAt: null,
    appliedBy: null,
    backups: [],
    ...overrides,
  };
}

describe('config', () => {
  it('returns defaults when the config file is missing', () => {
    expect(getRoleRefinementConfig(root)).toEqual(DEFAULT_ROLE_REFINEMENT_CONFIG);
  });

  it('round-trips a custom config', () => {
    setRoleRefinementConfig(root, { mode: 'off', autoApply: true, maxAutoAnalysesPerDay: 2, recurrenceThreshold: 3 });
    expect(getRoleRefinementConfig(root)).toEqual({ mode: 'off', autoApply: true, maxAutoAnalysesPerDay: 2, recurrenceThreshold: 3 });
  });

  it('clamps an invalid mode back to manual', () => {
    writeFileSync(join(root, '.teamai', 'role-refinement.json'), JSON.stringify({ mode: 'nope' }));
    expect(getRoleRefinementConfig(root).mode).toBe('manual');
  });
});

describe('suggestion store', () => {
  it('writes, reads, lists, and filters by task', () => {
    const record = makeRecord();
    writeSuggestion(root, record);
    expect(getSuggestion(root, 'sug-1')).toEqual(record);
    expect(listSuggestions(root)).toHaveLength(1);
    expect(suggestionsForTask(root, 'task-1')).toHaveLength(1);
    expect(suggestionsForTask(root, 'other')).toHaveLength(0);
  });

  it('lists newest first and skips analysis payload files', () => {
    writeSuggestion(root, makeRecord({ id: 'a', createdAt: '2026-08-01T00:00:00.000Z' }));
    writeSuggestion(root, makeRecord({ id: 'b', createdAt: '2026-08-02T00:00:00.000Z' }));
    // A stray raw analysis payload in the same dir must be ignored.
    writeFileSync(join(root, '.teamai', 'role-refinements', 'b.analysis.json'), '{"raw":true}');
    expect(listSuggestions(root).map(s => s.id)).toEqual(['b', 'a']);
  });

  it('supersedes a pending/suggested record with the same signature', () => {
    writeSuggestion(root, makeRecord({ id: 'first', signature: 'sha256:same', status: 'suggested' }));
    writeSuggestion(root, makeRecord({ id: 'second', signature: 'sha256:same' }));
    expect(getSuggestion(root, 'first')?.status).toBe('superseded');
    expect(getSuggestion(root, 'second')?.status).toBe('suggested');
    // A different signature is not touched.
    writeSuggestion(root, makeRecord({ id: 'third', signature: 'sha256:other' }));
    expect(getSuggestion(root, 'second')?.status).toBe('suggested');
    expect(getSuggestion(root, 'third')?.status).toBe('suggested');
  });

  it('updateSuggestion merges fields and bumps updatedAt', () => {
    writeSuggestion(root, makeRecord());
    const before = getSuggestion(root, 'sug-1')!;
    updateSuggestion(root, 'sug-1', { status: 'applied' });
    const after = getSuggestion(root, 'sug-1')!;
    expect(after.status).toBe('applied');
    expect(after.id).toBe('sug-1');
    expect(after.createdAt).toBe(before.createdAt);
    expect(after.updatedAt >= before.updatedAt).toBe(true);
  });
});

describe('buildFailureSignature', () => {
  it('hashes sorted FAIL-criterion names', () => {
    const dir = join(root, 'task-1');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'qa_report.json'), JSON.stringify({
      criteria: [
        { name: 'z', status: 'FAIL' },
        { name: 'a', status: 'FAIL' },
        { name: 'pass', status: 'PASS' },
      ],
    }));
    const s1 = buildFailureSignature(dir, 'task-1');
    const s2 = buildFailureSignature(dir, 'task-1');
    expect(s1).toMatch(/^sha256:/);
    expect(s1).toBe(s2);
    // Different criterion set → different signature.
    writeFileSync(join(dir, 'qa_report.json'), JSON.stringify({ criteria: [{ name: 'a', status: 'FAIL' }] }));
    expect(buildFailureSignature(dir, 'task-1')).not.toBe(s1);
  });
});

describe('detectRecurrence', () => {
  function createFailedTask(id: string, failCriteria: string[] = [], withFailedEvent = true) {
    const store = new TaskStore(root);
    store.create(id, `Task ${id}`, 'desc');
    const dir = store.getDirById(id);
    if (failCriteria.length > 0) {
      writeFileSync(join(dir, 'qa_report.json'), JSON.stringify({
        criteria: failCriteria.map(name => ({ name, status: 'FAIL' })),
      }));
    }
    if (withFailedEvent) store.updatePhase(id, 'failed');
    return { store, dir };
  }

  it('hits on a persisted FAIL criterion (current report vs previous-cycle snapshot)', () => {
    const { dir } = createFailedTask('t1', ['Evidence missing']);
    // Previous QA cycle failed the same criterion.
    writeFileSync(join(dir, 'qa_report_before_bounce.json'), JSON.stringify({
      criteria: [{ name: 'Evidence missing', status: 'FAIL' }],
    }));

    const r = detectRecurrence(root, 't1');
    expect(r.hit).toBe(true);
    expect(r.cluster).toEqual(['t1']);
    expect(r.signature).toMatch(/^sha256:/);
  });

  it('hits when the same task has reached failed >= recurrenceThreshold times', () => {
    const { store } = createFailedTask('t1');
    store.updatePhase('t1', 'failed'); // second failed transition

    const r = detectRecurrence(root, 't1');
    expect(r.hit).toBe(true);
    expect(r.cluster).toEqual(['t1']);
  });

  it('clusters two distinct tasks that failed with overlapping FAIL criteria', () => {
    createFailedTask('t1', ['Evidence missing']);
    createFailedTask('t2', ['Evidence missing', 'Other']);

    const r = detectRecurrence(root, 't1');
    expect(r.hit).toBe(true);
    expect(r.cluster).toContain('t1');
    expect(r.cluster).toContain('t2');
    // Same cluster viewed from either task yields the same signature (dedupe key).
    expect(detectRecurrence(root, 't2').signature).toBe(r.signature);
  });

  it('does not hit on a single first-time failure', () => {
    createFailedTask('t1', ['Evidence missing']);
    const r = detectRecurrence(root, 't1');
    expect(r.hit).toBe(false);
    expect(r.signature).toBe('');
  });

  it('ignores sibling tasks outside the rolling window', () => {
    createFailedTask('t1', ['Evidence missing']);
    const { dir: t2Dir } = createFailedTask('t2', ['Evidence missing']);
    // Age t2's failed event beyond the window by rewriting events.jsonl.
    const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
    writeFileSync(join(t2Dir, 'events.jsonl'),
      JSON.stringify({ phase: 'failed', timestamp: old }) + '\n');

    const r = detectRecurrence(root, 't1');
    expect(r.hit).toBe(false);
    expect(r.cluster).toEqual(['t1']);
  });
});

describe('countAutoAnalysesToday', () => {
  it('counts only auto-triggered records created today', () => {
    const today = new Date().toISOString();
    const yesterday = new Date(Date.now() - 86_400_000).toISOString();
    writeSuggestion(root, makeRecord({ id: 'a', trigger: 'auto', createdAt: today }));
    writeSuggestion(root, makeRecord({ id: 'b', trigger: 'auto', createdAt: today }));
    writeSuggestion(root, makeRecord({ id: 'c', trigger: 'manual', createdAt: today }));
    writeSuggestion(root, makeRecord({ id: 'd', trigger: 'auto', createdAt: yesterday }));
    expect(countAutoAnalysesToday(root)).toBe(2);
  });
});

describe('applyRefinement', () => {
  beforeEach(seedRoles);

  it('throws when the suggestion is not in suggested status', () => {
    writeSuggestion(root, makeRecord({ status: 'no-gap', edits: [] }));
    expect(() => applyRefinement(root, 'sug-1')).toThrow(/not "suggested"/);
  });

  it('throws when there are no edits', () => {
    writeSuggestion(root, makeRecord({ edits: [] }));
    expect(() => applyRefinement(root, 'sug-1')).toThrow(/no role edits/);
  });

  it('throws for an unknown role file', () => {
    writeSuggestion(root, makeRecord({ edits: [{ roleFile: 'ghost.md', mode: 'append', rationale: 'x', proposedContent: 'y', riskClass: 'additive' }] }));
    expect(() => applyRefinement(root, 'sug-1')).toThrow(/Unknown role file/);
  });

  it('appends an additive edit, backs up the original, and marks applied', () => {
    writeSuggestion(root, makeRecord());
    applyRefinement(root, 'sug-1');

    const content = readFileSync(join(root, '.claude', 'roles', 'planner.md'), 'utf-8');
    expect(content).toContain('# Role: Planner');
    expect(content).toContain('Always use git add -f for gitignored evidence.');

    const record = getSuggestion(root, 'sug-1')!;
    expect(record.status).toBe('applied');
    expect(record.appliedBy).toBe('human');
    expect(record.backups).toHaveLength(1);
    expect(record.backups[0].roleFile).toBe('planner.md');
    expect(existsSync(record.backups[0].backupPath)).toBe(true);
    // The backup holds the pre-apply body.
    expect(readFileSync(record.backups[0].backupPath, 'utf-8')).toContain('old body');
  });

  it('replaces with a hand-edited override', () => {
    writeSuggestion(root, makeRecord({
      edits: [{ roleFile: 'planner.md', mode: 'replace', rationale: 'rewrite', proposedContent: 'NEW BODY', riskClass: 'modifying' }],
    }));
    applyRefinement(root, 'sug-1', { 'planner.md': 'HAND EDITED' });
    expect(readFileSync(join(root, '.claude', 'roles', 'planner.md'), 'utf-8')).toBe('HAND EDITED');
  });
});

describe('dismissRefinement / revertRefinement', () => {
  beforeEach(seedRoles);

  it('dismisses a suggested record without touching role files', () => {
    writeSuggestion(root, makeRecord());
    dismissRefinement(root, 'sug-1');
    expect(getSuggestion(root, 'sug-1')?.status).toBe('dismissed');
    expect(readFileSync(join(root, '.claude', 'roles', 'planner.md'), 'utf-8')).toContain('old body');
  });

  it('reverts an applied refinement from its backup and marks dismissed', () => {
    writeSuggestion(root, makeRecord());
    applyRefinement(root, 'sug-1');
    expect(readFileSync(join(root, '.claude', 'roles', 'planner.md'), 'utf-8')).toContain('git add -f');

    revertRefinement(root, 'sug-1');
    expect(readFileSync(join(root, '.claude', 'roles', 'planner.md'), 'utf-8')).toContain('old body');
    expect(getSuggestion(root, 'sug-1')?.status).toBe('dismissed');
    expect(getSuggestion(root, 'sug-1')?.appliedAt).toBeNull();
  });

  it('throws when reverting a non-applied record', () => {
    writeSuggestion(root, makeRecord());
    expect(() => revertRefinement(root, 'sug-1')).toThrow(/not applied/);
  });
});
