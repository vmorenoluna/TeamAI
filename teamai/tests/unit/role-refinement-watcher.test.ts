// @vitest-environment node

/** Unit tests for the Phase-2 role-refinement watcher: every auto-trigger gate
 *  (mode, recurrence, daily cap, signature dedupe, retry-loop escalation) plus
 *  the phase-change listener wiring. analyzeFailure is mocked; recurrence is
 *  real (detectRecurrence reads real task artifacts). */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const { mockAnalyzeFailure, mockRetryFailedTask } = vi.hoisted(() => ({
  mockAnalyzeFailure: vi.fn(async (_projectRoot: string, _taskId: string, _trigger: string, _deps: unknown, _sig?: string) => 'sug-x'),
  mockRetryFailedTask: vi.fn(),
}));

vi.mock('../../src/lib/role-refinement', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/role-refinement')>();
  return { ...actual, analyzeFailure: mockAnalyzeFailure };
});

vi.mock('../../src/lib/task-retry', () => ({
  retryFailedTask: mockRetryFailedTask,
  preRestoreFailedTask: vi.fn(),
}));

vi.mock('../../src/lib/logger', () => ({
  log: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn(),
}));

import { processManager } from '../../src/lib/process-manager';
import { TaskStore } from '../../src/lib/task-store';
import {
  setRoleRefinementConfig,
  writeSuggestion,
  detectRecurrence,
  getSuggestion,
  revertRefinement,
  type RoleRefinementSuggestion,
} from '../../src/lib/role-refinement';
import {
  maybeAutoAnalyze,
  maybeAutoApplyAndRetry,
  startRoleRefinementWatcher,
  stopRoleRefinementWatcher,
  REFINEMENT_RETRY_LOOP_CAP,
} from '../../src/lib/role-refinement-watcher';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'role-watcher-'));
  mkdirSync(join(root, '.teamai'), { recursive: true });
  vi.clearAllMocks();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  stopRoleRefinementWatcher();
  delete (globalThis as { __autoModeProjectStates?: unknown }).__autoModeProjectStates;
});

/** Flip the pipeline auto-runner (auto-mode) state that isAutoModeEnabled reads. */
function setAutoRunner(enabled: boolean): void {
  (globalThis as { __autoModeProjectStates?: Map<string, { enabled: boolean; maxParallel: number }> }).__autoModeProjectStates =
    new Map([[root, { enabled, maxParallel: 1 }]]);
}

/** Create a failed task that triggers detectRecurrence (persisted criterion). */
function seedRecurringFailure(taskId: string, failCriteria: string[]): string {
  const store = new TaskStore(root);
  store.create(taskId, `Task ${taskId}`, 'desc');
  const dir = store.getDirById(taskId);
  writeFileSync(join(dir, 'qa_report.json'), JSON.stringify({
    criteria: failCriteria.map(name => ({ name, status: 'FAIL' })),
  }));
  writeFileSync(join(dir, 'qa_report_before_bounce.json'), JSON.stringify({
    criteria: failCriteria.map(name => ({ name, status: 'FAIL' })),
  }));
  store.updatePhase(taskId, 'failed');
  return dir;
}

function makeRecord(overrides: Partial<RoleRefinementSuggestion> = {}): RoleRefinementSuggestion {
  return {
    id: 's-1',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    status: 'suggested',
    trigger: 'auto',
    sourceTaskIds: ['t-1'],
    signature: 'sha256:covered',
    isRolePromptGap: true,
    contractGap: false,
    contractFile: null,
    rootCause: 'x',
    confidence: 'high',
    diagnosis: 'd',
    edits: [],
    appliedAt: null,
    appliedBy: null,
    backups: [],
    ...overrides,
  };
}

describe('maybeAutoAnalyze', () => {
  it('does not run when mode is off or manual', async () => {
    seedRecurringFailure('t-1', ['Evidence missing']);
    setRoleRefinementConfig(root, { mode: 'off', model: 'claude-sonnet-4-6', autoApply: false, maxAutoAnalysesPerDay: 5, recurrenceThreshold: 2 });
    await maybeAutoAnalyze(root, 't-1');
    expect(mockAnalyzeFailure).not.toHaveBeenCalled();

    setRoleRefinementConfig(root, { mode: 'manual', model: 'claude-sonnet-4-6', autoApply: false, maxAutoAnalysesPerDay: 5, recurrenceThreshold: 2 });
    await maybeAutoAnalyze(root, 't-1');
    expect(mockAnalyzeFailure).not.toHaveBeenCalled();
  });

  it('auto-analyzes a recurring failure with trigger "auto" and the cluster signature', async () => {
    seedRecurringFailure('t-1', ['Evidence missing']);
    setRoleRefinementConfig(root, { mode: 'auto', model: 'claude-sonnet-4-6', autoApply: false, maxAutoAnalysesPerDay: 5, recurrenceThreshold: 2 });

    await maybeAutoAnalyze(root, 't-1');
    expect(mockAnalyzeFailure).toHaveBeenCalledTimes(1);
    const [, taskId, trigger, , signature] = mockAnalyzeFailure.mock.calls[0] as unknown[];
    expect(taskId).toBe('t-1');
    expect(trigger).toBe('auto');
    expect(signature).toMatch(/^sha256:/);
  });

  it('passes the whole recurrence cluster as sourceTaskIds to analyzeFailure', async () => {
    seedRecurringFailure('t-1', ['Evidence missing']);
    // A sibling task failing the same way forms a cluster.
    const store = new TaskStore(root);
    store.create('t-2', 'Task t-2', 'desc');
    const dir2 = store.getDirById('t-2');
    writeFileSync(join(dir2, 'qa_report.json'), JSON.stringify({ criteria: [{ name: 'Evidence missing', status: 'FAIL' }] }));
    store.updatePhase('t-2', 'failed');
    setRoleRefinementConfig(root, { mode: 'auto', model: 'claude-sonnet-4-6', autoApply: false, maxAutoAnalysesPerDay: 5, recurrenceThreshold: 2 });

    await maybeAutoAnalyze(root, 't-1');
    expect(mockAnalyzeFailure).toHaveBeenCalledTimes(1);
    const [, , , , , sourceTaskIds] = mockAnalyzeFailure.mock.calls[0] as unknown[];
    expect(sourceTaskIds).toEqual(expect.arrayContaining(['t-1', 't-2']));
  });

  it('does not run when recurrence is not detected (single first-time failure)', async () => {
    const store = new TaskStore(root);
    store.create('t-1', 'Task t-1', 'desc');
    const dir = store.getDirById('t-1');
    writeFileSync(join(dir, 'qa_report.json'), JSON.stringify({ criteria: [{ name: 'x', status: 'FAIL' }] }));
    store.updatePhase('t-1', 'failed');
    setRoleRefinementConfig(root, { mode: 'auto', model: 'claude-sonnet-4-6', autoApply: false, maxAutoAnalysesPerDay: 5, recurrenceThreshold: 2 });

    await maybeAutoAnalyze(root, 't-1');
    expect(mockAnalyzeFailure).not.toHaveBeenCalled();
  });

  it('respects the maxAutoAnalysesPerDay spend cap', async () => {
    seedRecurringFailure('t-1', ['Evidence missing']);
    // A different signature, so the dedupe gate doesn't fire first.
    writeSuggestion(root, makeRecord({ id: 'other', signature: 'sha256:other' }));
    setRoleRefinementConfig(root, { mode: 'auto', model: 'claude-sonnet-4-6', autoApply: false, maxAutoAnalysesPerDay: 1, recurrenceThreshold: 2 });

    await maybeAutoAnalyze(root, 't-1');
    expect(mockAnalyzeFailure).not.toHaveBeenCalled();
  });

  it('skips when an existing record already covers the signature', async () => {
    seedRecurringFailure('t-1', ['Evidence missing']);
    writeSuggestion(root, makeRecord({ signature: detectRecurrence(root, 't-1').signature }));
    setRoleRefinementConfig(root, { mode: 'auto', model: 'claude-sonnet-4-6', autoApply: false, maxAutoAnalysesPerDay: 5, recurrenceThreshold: 2 });

    await maybeAutoAnalyze(root, 't-1');
    expect(mockAnalyzeFailure).not.toHaveBeenCalled();
  });

  it('escalates (does not re-analyze) when an applied refinement shares the signature', async () => {
    seedRecurringFailure('t-1', ['Evidence missing']);
    writeSuggestion(root, makeRecord({
      status: 'applied',
      appliedAt: new Date().toISOString(),
      appliedBy: 'human',
      signature: detectRecurrence(root, 't-1').signature,
    }));
    setRoleRefinementConfig(root, { mode: 'auto', model: 'claude-sonnet-4-6', autoApply: false, maxAutoAnalysesPerDay: 5, recurrenceThreshold: 2 });

    await maybeAutoAnalyze(root, 't-1');
    expect(mockAnalyzeFailure).not.toHaveBeenCalled();
  });

  it('escalates (does not auto-analyze) past the retry-loop cap', async () => {
    seedRecurringFailure('t-1', ['Evidence missing']);
    new TaskStore(root).update('t-1', { refinementRetryCount: REFINEMENT_RETRY_LOOP_CAP });
    setRoleRefinementConfig(root, { mode: 'auto', model: 'claude-sonnet-4-6', autoApply: false, maxAutoAnalysesPerDay: 5, recurrenceThreshold: 2 });

    await maybeAutoAnalyze(root, 't-1');
    expect(mockAnalyzeFailure).not.toHaveBeenCalled();
  });

  it('ignores unknown tasks', async () => {
    setRoleRefinementConfig(root, { mode: 'auto', model: 'claude-sonnet-4-6', autoApply: false, maxAutoAnalysesPerDay: 5, recurrenceThreshold: 2 });
    await maybeAutoAnalyze(root, 'ghost');
    expect(mockAnalyzeFailure).not.toHaveBeenCalled();
  });

  it('stamps refinementEscalated when the retry-loop cap is reached', async () => {
    seedRecurringFailure('t-1', ['Evidence missing']);
    new TaskStore(root).update('t-1', { refinementRetryCount: REFINEMENT_RETRY_LOOP_CAP });
    setRoleRefinementConfig(root, { mode: 'auto', model: 'claude-sonnet-4-6', autoApply: false, maxAutoAnalysesPerDay: 5, recurrenceThreshold: 2 });

    await maybeAutoAnalyze(root, 't-1');
    expect(mockAnalyzeFailure).not.toHaveBeenCalled();
    expect(new TaskStore(root).getById('t-1')?.refinementEscalated).toBe(true);
  });

  it('stamps refinementEscalated when an applied refinement shares the signature', async () => {
    seedRecurringFailure('t-1', ['Evidence missing']);
    writeSuggestion(root, makeRecord({
      status: 'applied',
      appliedBy: 'human',
      appliedAt: new Date().toISOString(),
      signature: detectRecurrence(root, 't-1').signature,
    }));
    setRoleRefinementConfig(root, { mode: 'auto', model: 'claude-sonnet-4-6', autoApply: false, maxAutoAnalysesPerDay: 5, recurrenceThreshold: 2 });

    await maybeAutoAnalyze(root, 't-1');
    expect(mockAnalyzeFailure).not.toHaveBeenCalled();
    expect(new TaskStore(root).getById('t-1')?.refinementEscalated).toBe(true);
  });
});

describe('maybeAutoApplyAndRetry', () => {
  /** Seed a suggested, auto-triggered, high-confidence record + a role file to edit. */
  function seedAutoSuggested(): string {
    const store = new TaskStore(root);
    store.create('t-1', 'Task t-1', 'desc');
    const dir = store.getDirById('t-1');
    writeFileSync(join(dir, 'qa_report.json'), JSON.stringify({ criteria: [{ name: 'x', status: 'FAIL' }] }));
    writeFileSync(join(dir, 'qa_report_before_bounce.json'), JSON.stringify({ criteria: [{ name: 'x', status: 'FAIL' }] }));
    store.updatePhase('t-1', 'failed');
    const rolesDir = join(root, '.claude', 'roles');
    mkdirSync(rolesDir, { recursive: true });
    writeFileSync(join(rolesDir, 'planner.md'), '# Role: Planner\n\nold body\n', 'utf-8');
    writeSuggestion(root, makeRecord({
      id: 's-1',
      status: 'suggested',
      trigger: 'auto',
      confidence: 'high',
      signature: detectRecurrence(root, 't-1').signature,
      sourceTaskIds: ['t-1'],
      edits: [{ roleFile: 'planner.md', mode: 'append', rationale: 'r', proposedContent: 'Always use git add -f.', riskClass: 'additive' }],
    }));
    return 's-1';
  }

  it('auto-applies an eligible suggestion and retries when all gates pass', async () => {
    seedAutoSuggested();
    setRoleRefinementConfig(root, { mode: 'auto', model: 'claude-sonnet-4-6', autoApply: true, maxAutoAnalysesPerDay: 5, recurrenceThreshold: 2 });
    setAutoRunner(true);

    await maybeAutoApplyAndRetry(root, 's-1');

    const record = getSuggestion(root, 's-1')!;
    expect(record.status).toBe('applied');
    expect(record.appliedBy).toBe('auto');
    expect(new TaskStore(root).getById('t-1')?.refinementRetryCount).toBe(1);
    expect(mockRetryFailedTask).toHaveBeenCalledWith(root, 't-1');
    // The edit actually landed, with a backup for one-click revert (§7/§8).
    expect(readFileSync(join(root, '.claude', 'roles', 'planner.md'), 'utf-8')).toContain('git add -f');
    expect(record.backups).toHaveLength(1);
    expect(existsSync(record.backups[0].backupPath)).toBe(true);
    // Revert restores the pre-apply body — auto-apply is fully revertable.
    revertRefinement(root, 's-1');
    expect(readFileSync(join(root, '.claude', 'roles', 'planner.md'), 'utf-8')).toContain('old body');
  });

  it('does nothing when autoApply is not opted in', async () => {
    seedAutoSuggested();
    setRoleRefinementConfig(root, { mode: 'auto', model: 'claude-sonnet-4-6', autoApply: false, maxAutoAnalysesPerDay: 5, recurrenceThreshold: 2 });
    setAutoRunner(true);

    await maybeAutoApplyAndRetry(root, 's-1');
    expect(getSuggestion(root, 's-1')?.status).toBe('suggested');
    expect(mockRetryFailedTask).not.toHaveBeenCalled();
  });

  it('does nothing when the pipeline auto-runner is off (compounded opt-in)', async () => {
    seedAutoSuggested();
    setRoleRefinementConfig(root, { mode: 'auto', model: 'claude-sonnet-4-6', autoApply: true, maxAutoAnalysesPerDay: 5, recurrenceThreshold: 2 });
    setAutoRunner(false);

    await maybeAutoApplyAndRetry(root, 's-1');
    expect(getSuggestion(root, 's-1')?.status).toBe('suggested');
    expect(mockRetryFailedTask).not.toHaveBeenCalled();
  });

  it('does nothing for an ineligible (modifying) record — human review required', async () => {
    seedAutoSuggested();
    writeSuggestion(root, makeRecord({
      id: 's-2',
      status: 'suggested',
      trigger: 'auto',
      confidence: 'high',
      sourceTaskIds: ['t-1'],
      edits: [{ roleFile: 'planner.md', mode: 'replace', rationale: 'r', proposedContent: 'FULL REWRITE', riskClass: 'modifying' }],
    }));
    setRoleRefinementConfig(root, { mode: 'auto', model: 'claude-sonnet-4-6', autoApply: true, maxAutoAnalysesPerDay: 5, recurrenceThreshold: 2 });
    setAutoRunner(true);

    await maybeAutoApplyAndRetry(root, 's-2');
    expect(getSuggestion(root, 's-2')?.status).toBe('suggested');
    expect(mockRetryFailedTask).not.toHaveBeenCalled();
  });

  it('does nothing once the retry-loop cap is reached (escalation, not auto-apply)', async () => {
    seedAutoSuggested();
    new TaskStore(root).update('t-1', { refinementRetryCount: REFINEMENT_RETRY_LOOP_CAP });
    setRoleRefinementConfig(root, { mode: 'auto', model: 'claude-sonnet-4-6', autoApply: true, maxAutoAnalysesPerDay: 5, recurrenceThreshold: 2 });
    setAutoRunner(true);

    await maybeAutoApplyAndRetry(root, 's-1');
    expect(getSuggestion(root, 's-1')?.status).toBe('suggested');
    expect(mockRetryFailedTask).not.toHaveBeenCalled();
  });
});

describe('startRoleRefinementWatcher', () => {
  it('fires maybeAutoAnalyze on a phase-change to failed', async () => {
    seedRecurringFailure('t-1', ['Evidence missing']);
    setRoleRefinementConfig(root, { mode: 'auto', model: 'claude-sonnet-4-6', autoApply: false, maxAutoAnalysesPerDay: 5, recurrenceThreshold: 2 });

    startRoleRefinementWatcher();
    processManager.emit('phase-change', { taskId: 't-1', phase: 'failed', projectRoot: root });

    await vi.waitFor(() => expect(mockAnalyzeFailure).toHaveBeenCalledTimes(1));
    const [, taskId, trigger] = mockAnalyzeFailure.mock.calls[0] as unknown[];
    expect(taskId).toBe('t-1');
    expect(trigger).toBe('auto');
  });

  it('ignores non-failed phase changes', async () => {
    seedRecurringFailure('t-1', ['Evidence missing']);
    setRoleRefinementConfig(root, { mode: 'auto', model: 'claude-sonnet-4-6', autoApply: false, maxAutoAnalysesPerDay: 5, recurrenceThreshold: 2 });

    startRoleRefinementWatcher();
    processManager.emit('phase-change', { taskId: 't-1', phase: 'implement', projectRoot: root });
    await new Promise(r => setTimeout(r, 20));
    expect(mockAnalyzeFailure).not.toHaveBeenCalled();
  });

  it('runs the full closed loop: phase-change → auto-analysis → auto-apply → retry', async () => {
    seedRecurringFailure('t-1', ['Evidence missing']);
    setRoleRefinementConfig(root, { mode: 'auto', model: 'claude-sonnet-4-6', autoApply: true, maxAutoAnalysesPerDay: 5, recurrenceThreshold: 2 });
    setAutoRunner(true);

    // The mocked analyzer writes a REAL suggested record so the continuation
    // (maybeAutoApplyAndRetry) has something to apply.
    mockAnalyzeFailure.mockImplementation(async (_p: string, taskId: string, _t: string, _deps: unknown, sig?: string) => {
      const mod = await vi.importActual<typeof import('../../src/lib/role-refinement')>('../../src/lib/role-refinement');
      const rolesDir = join(root, '.claude', 'roles');
      mkdirSync(rolesDir, { recursive: true });
      writeFileSync(join(rolesDir, 'planner.md'), '# Role: Planner\n\nold body\n', 'utf-8');
      mod.writeSuggestion(root, makeRecord({
        id: 'closed-loop-sug',
        status: 'suggested',
        trigger: 'auto',
        confidence: 'high',
        signature: sig ?? 'sha256:x',
        sourceTaskIds: [taskId],
        edits: [{ roleFile: 'planner.md', mode: 'append', rationale: 'r', proposedContent: 'Use git add -f.', riskClass: 'additive' }],
      }));
      return 'closed-loop-sug';
    });

    startRoleRefinementWatcher();
    processManager.emit('phase-change', { taskId: 't-1', phase: 'failed', projectRoot: root });

    await vi.waitFor(() => expect(mockRetryFailedTask).toHaveBeenCalledWith(root, 't-1'));
    const record = getSuggestion(root, 'closed-loop-sug')!;
    expect(record.status).toBe('applied');
    expect(record.appliedBy).toBe('auto');
    expect(new TaskStore(root).getById('t-1')?.refinementRetryCount).toBe(1);
  });
});
