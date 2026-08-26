// @vitest-environment node

/** Unit tests for the Phase-2 role-refinement watcher: every auto-trigger gate
 *  (mode, recurrence, daily cap, signature dedupe, retry-loop escalation) plus
 *  the phase-change listener wiring. analyzeFailure is mocked; recurrence is
 *  real (detectRecurrence reads real task artifacts). */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const { mockAnalyzeFailure } = vi.hoisted(() => ({
  mockAnalyzeFailure: vi.fn(async (_projectRoot: string, _taskId: string, _trigger: string, _deps: unknown, _sig?: string) => 'sug-x'),
}));

vi.mock('../../src/lib/role-refinement', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/role-refinement')>();
  return { ...actual, analyzeFailure: mockAnalyzeFailure };
});

vi.mock('../../src/lib/logger', () => ({
  log: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn(),
}));

import { processManager } from '../../src/lib/process-manager';
import { TaskStore } from '../../src/lib/task-store';
import {
  setRoleRefinementConfig,
  writeSuggestion,
  detectRecurrence,
  type RoleRefinementSuggestion,
} from '../../src/lib/role-refinement';
import {
  maybeAutoAnalyze,
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
});

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
    setRoleRefinementConfig(root, { mode: 'off', autoApply: false, maxAutoAnalysesPerDay: 5, recurrenceThreshold: 2 });
    await maybeAutoAnalyze(root, 't-1');
    expect(mockAnalyzeFailure).not.toHaveBeenCalled();

    setRoleRefinementConfig(root, { mode: 'manual', autoApply: false, maxAutoAnalysesPerDay: 5, recurrenceThreshold: 2 });
    await maybeAutoAnalyze(root, 't-1');
    expect(mockAnalyzeFailure).not.toHaveBeenCalled();
  });

  it('auto-analyzes a recurring failure with trigger "auto" and the cluster signature', async () => {
    seedRecurringFailure('t-1', ['Evidence missing']);
    setRoleRefinementConfig(root, { mode: 'auto', autoApply: false, maxAutoAnalysesPerDay: 5, recurrenceThreshold: 2 });

    await maybeAutoAnalyze(root, 't-1');
    expect(mockAnalyzeFailure).toHaveBeenCalledTimes(1);
    const [, taskId, trigger, , signature] = mockAnalyzeFailure.mock.calls[0] as unknown[];
    expect(taskId).toBe('t-1');
    expect(trigger).toBe('auto');
    expect(signature).toMatch(/^sha256:/);
  });

  it('does not run when recurrence is not detected (single first-time failure)', async () => {
    const store = new TaskStore(root);
    store.create('t-1', 'Task t-1', 'desc');
    const dir = store.getDirById('t-1');
    writeFileSync(join(dir, 'qa_report.json'), JSON.stringify({ criteria: [{ name: 'x', status: 'FAIL' }] }));
    store.updatePhase('t-1', 'failed');
    setRoleRefinementConfig(root, { mode: 'auto', autoApply: false, maxAutoAnalysesPerDay: 5, recurrenceThreshold: 2 });

    await maybeAutoAnalyze(root, 't-1');
    expect(mockAnalyzeFailure).not.toHaveBeenCalled();
  });

  it('respects the maxAutoAnalysesPerDay spend cap', async () => {
    seedRecurringFailure('t-1', ['Evidence missing']);
    // A different signature, so the dedupe gate doesn't fire first.
    writeSuggestion(root, makeRecord({ id: 'other', signature: 'sha256:other' }));
    setRoleRefinementConfig(root, { mode: 'auto', autoApply: false, maxAutoAnalysesPerDay: 1, recurrenceThreshold: 2 });

    await maybeAutoAnalyze(root, 't-1');
    expect(mockAnalyzeFailure).not.toHaveBeenCalled();
  });

  it('skips when an existing record already covers the signature', async () => {
    seedRecurringFailure('t-1', ['Evidence missing']);
    writeSuggestion(root, makeRecord({ signature: detectRecurrence(root, 't-1').signature }));
    setRoleRefinementConfig(root, { mode: 'auto', autoApply: false, maxAutoAnalysesPerDay: 5, recurrenceThreshold: 2 });

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
    setRoleRefinementConfig(root, { mode: 'auto', autoApply: false, maxAutoAnalysesPerDay: 5, recurrenceThreshold: 2 });

    await maybeAutoAnalyze(root, 't-1');
    expect(mockAnalyzeFailure).not.toHaveBeenCalled();
  });

  it('escalates (does not auto-analyze) past the retry-loop cap', async () => {
    seedRecurringFailure('t-1', ['Evidence missing']);
    new TaskStore(root).update('t-1', { refinementRetryCount: REFINEMENT_RETRY_LOOP_CAP });
    setRoleRefinementConfig(root, { mode: 'auto', autoApply: false, maxAutoAnalysesPerDay: 5, recurrenceThreshold: 2 });

    await maybeAutoAnalyze(root, 't-1');
    expect(mockAnalyzeFailure).not.toHaveBeenCalled();
  });

  it('ignores unknown tasks', async () => {
    setRoleRefinementConfig(root, { mode: 'auto', autoApply: false, maxAutoAnalysesPerDay: 5, recurrenceThreshold: 2 });
    await maybeAutoAnalyze(root, 'ghost');
    expect(mockAnalyzeFailure).not.toHaveBeenCalled();
  });
});

describe('startRoleRefinementWatcher', () => {
  it('fires maybeAutoAnalyze on a phase-change to failed', async () => {
    seedRecurringFailure('t-1', ['Evidence missing']);
    setRoleRefinementConfig(root, { mode: 'auto', autoApply: false, maxAutoAnalysesPerDay: 5, recurrenceThreshold: 2 });

    startRoleRefinementWatcher();
    processManager.emit('phase-change', { taskId: 't-1', phase: 'failed', projectRoot: root });

    await vi.waitFor(() => expect(mockAnalyzeFailure).toHaveBeenCalledTimes(1));
    const [, taskId, trigger] = mockAnalyzeFailure.mock.calls[0] as unknown[];
    expect(taskId).toBe('t-1');
    expect(trigger).toBe('auto');
  });

  it('ignores non-failed phase changes', async () => {
    seedRecurringFailure('t-1', ['Evidence missing']);
    setRoleRefinementConfig(root, { mode: 'auto', autoApply: false, maxAutoAnalysesPerDay: 5, recurrenceThreshold: 2 });

    startRoleRefinementWatcher();
    processManager.emit('phase-change', { taskId: 't-1', phase: 'implement', projectRoot: root });
    await new Promise(r => setTimeout(r, 20));
    expect(mockAnalyzeFailure).not.toHaveBeenCalled();
  });
});
