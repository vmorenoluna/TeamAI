// @vitest-environment node

/**
 * Tests the plan.json patch step of writeQaFeedback in isolation:
 * a failed plan.json write must warn (not swallow) while qa_feedback.md
 * (the primary channel) is still written first.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockWarn, mockWriteFileSync, mockReadFileSync } = vi.hoisted(() => ({
  mockWarn: vi.fn(),
  mockWriteFileSync: vi.fn(),
  mockReadFileSync: vi.fn(() => JSON.stringify({
    subtasks: [
      {
        id: 1,
        title: 'Add feature',
        files: ['src/feature.ts'],
        acceptance_criteria: ['criterion text'],
      },
    ],
  })),
}));

vi.mock('fs', () => ({
  existsSync: vi.fn(() => true),
  readFileSync: mockReadFileSync,
  writeFileSync: mockWriteFileSync,
}));

vi.mock('../../src/lib/logger', () => ({
  log: vi.fn(),
  warn: mockWarn,
  error: vi.fn(),
  info: vi.fn(),
}));

import { writeQaFeedback } from '../../src/lib/orchestrator/qa-feedback';

const report = {
  overall: 'FAIL',
  criteria: [{ status: 'FAIL', criterion: 'criterion text', fix_needed: 'fix it' }],
};

describe('writeQaFeedback — plan.json patch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockWriteFileSync.mockReset();
  });

  it('warns when the plan.json patch write fails (qa_feedback.md still written)', () => {
    // First write (qa_feedback.md) succeeds; second (plan.json) throws.
    mockWriteFileSync
      .mockImplementationOnce(() => undefined)
      .mockImplementationOnce(() => { throw new Error('disk full'); });

    expect(() => writeQaFeedback('/test/spec', report as never)).not.toThrow();

    expect(mockWarn).toHaveBeenCalledWith(
      'qa-feedback',
      expect.stringContaining('Failed to patch plan.json'),
      expect.anything(),
    );
  });

  it('does not warn when the plan.json patch write succeeds', () => {
    writeQaFeedback('/test/spec', report as never);

    expect(mockWarn).not.toHaveBeenCalled();
  });
});

describe('writeQaFeedback — subtask completion correction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockWriteFileSync.mockReset();
  });

  /** Grabs and parses the plan.json write (the second writeFileSync call —
   *  the first is always qa_feedback.md). */
  function writtenPlan(): { subtasks: Array<{ id: number; completed?: boolean; qa_flagged?: boolean }> } {
    const planCall = mockWriteFileSync.mock.calls.find(c => String(c[0]).includes('plan.json'));
    return JSON.parse(planCall![1] as string);
  }

  it('unmarks a subtask as incomplete when explicit subtask_ids targets it', () => {
    mockReadFileSync.mockReturnValueOnce(JSON.stringify({
      subtasks: [{ id: 1, title: 'Add feature', files: ['src/feature.ts'], acceptance_criteria: [], completed: true }],
    }));
    const reportWithId = {
      overall: 'FAIL',
      criteria: [{ status: 'FAIL', criterion: 'Some criterion', fix_needed: 'fix it', subtask_ids: [1] }],
    };

    writeQaFeedback('/test/spec', reportWithId as never);

    const plan = writtenPlan();
    expect(plan.subtasks[0].qa_flagged).toBe(true);
    expect(plan.subtasks[0].completed).toBe(false);
  });

  it('unmarks subtasks referenced by a "LABEL-N" token in criterion text when subtask_ids is empty (live regression)', () => {
    // Reproduces the exact failure this was found from: a QA agent leaves
    // subtask_ids empty despite the instruction, and the criterion cites
    // the constraint ids ("AC-11 (CS-10/CS-11)") rather than reusing the
    // plan's own acceptance-criteria wording — the blind fuzzy fallback
    // can't resolve that, but the subtask titles literally contain "CS-10"
    // / "CS-11".
    mockReadFileSync.mockReturnValueOnce(JSON.stringify({
      subtasks: [
        { id: 11, title: 'CS-10: make analyzeCadencePatterns distinguish the leading tone from the subtonic', files: [], acceptance_criteria: [], completed: true },
        { id: 12, title: 'CS-11: make encourageCadenceAppropriateEnding use pitch-class chord-tone identity', files: [], acceptance_criteria: [], completed: true },
        { id: 13, title: 'Unrelated subtask', files: [], acceptance_criteria: [], completed: true },
      ],
    }));
    const reportNoIds = {
      overall: 'FAIL',
      criteria: [{
        status: 'FAIL',
        criterion: 'AC-11 (CS-10/CS-11): minor PAC/HC/DC cadenceDegree gating on the true leading tone',
        fix_needed: 'wire chord.soundsAs into analyzeCadencePatterns and encourageCadenceAppropriateEnding',
      }],
    };

    writeQaFeedback('/test/spec', reportNoIds as never);

    const plan = writtenPlan();
    const byId = Object.fromEntries(plan.subtasks.map(s => [s.id, s]));
    expect(byId[11].completed).toBe(false);
    expect(byId[11].qa_flagged).toBe(true);
    expect(byId[12].completed).toBe(false);
    expect(byId[12].qa_flagged).toBe(true);
    // Unrelated subtask is untouched.
    expect(byId[13].completed).toBe(true);
    expect(byId[13].qa_flagged).toBeUndefined();
  });

  it('unmarks a subtask referenced by "subtask N" in an additional_issues meta-note', () => {
    mockReadFileSync.mockReturnValueOnce(JSON.stringify({
      subtasks: [
        { id: 15, title: 'Sweep-level verification', files: [], acceptance_criteria: [], completed: true },
      ],
    }));
    const reportMetaIssue = {
      overall: 'FAIL',
      additional_issues: [{
        description: 'plan.json marks subtask 15 (sweep verification) as "completed": true, but its evidence predates the fix',
      }],
    };

    writeQaFeedback('/test/spec', reportMetaIssue as never);

    const plan = writtenPlan();
    expect(plan.subtasks[0].completed).toBe(false);
    expect(plan.subtasks[0].qa_flagged).toBe(true);
  });

  it('unmarks a subtask via the fuzzy text fallback (no subtask_ids, no LABEL-N/subtask-N reference)', () => {
    // Default mockReadFileSync fixture: subtask 1's acceptance_criteria
    // contains 'criterion text', matched by the tier-3 fuzzy fallback.
    writeQaFeedback('/test/spec', report as never);

    const plan = writtenPlan();
    expect(plan.subtasks[0].qa_flagged).toBe(true);
    expect(plan.subtasks[0].completed).toBe(false);
  });
});
