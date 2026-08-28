/**
 * Orchestrator persisted criterion failure detection tests.
 *
 * Tests for the bugfix: "rework loop gets stuck when a mandatory FAIL criterion
 * is misclassified as a resolved warning."
 *
 * Covers:
 *   - Count math: persistedCriterionFailCounts increments correctly
 *   - Snapshot comparison: detecting matching FAIL criteria between cycles
 *   - Escalation header injection: ⚠️ PERSISTED FAILURES in qa_feedback.md
 *   - resetAllCounters clearing on spec revision / task rejection
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { createTestProject } from '../utils/test-project';

 
type AnyOrch = any;

// ── Hoisted mocks ──

const { onHandlers, mockCreateSession, mockSendMessage } = vi.hoisted(() => ({
  onHandlers: new Map<string, Array<(...args: any[]) => void>>(),
  mockCreateSession: vi.fn(),
  mockSendMessage: vi.fn(),
}));

const mockExecFileSync = vi.hoisted(() => vi.fn());

vi.mock('child_process', () => ({
  execFile: vi.fn(),
  execFileSync: mockExecFileSync,
}));

vi.mock('../../src/lib/logger', () => ({
  log: vi.fn(), error: vi.fn(), warn: vi.fn(),
}));

vi.mock('../../src/lib/process-manager', () => ({
  processManager: {
    on: (event: string, handler: (...args: any[]) => void) => {
      if (!onHandlers.has(event)) onHandlers.set(event, []);
      onHandlers.get(event)!.push(handler);
      return vi.fn();
    },
    off: vi.fn(),
    emit: vi.fn(),
    createSession: (...args: any[]) => mockCreateSession(...args),
    sendMessage: (...args: any[]) => mockSendMessage(...args),
    killSession: vi.fn(),
    getSession: vi.fn(),
    getAllSessions: vi.fn(() => []),
    getStaleSessions: vi.fn(() => []),
    removeStaleSession: vi.fn(),
    getTerminalSessions: vi.fn(() => []),
    killTerminalSession: vi.fn(),
    writeToSession: vi.fn(),
    terminateSession: vi.fn(),
  },
  containerSessionOpts: (projectRoot: string) => ({ projectRoot, permissionMode: 'bypassPermissions' as const }),
}));

vi.mock('../../src/lib/container-manager', () => ({
  readContainerConfig: vi.fn(() => ({ enabled: false, explicit: false })),
  readContainerRemoteUser: vi.fn(() => 'node'),
  containerManager: {
    ensureContainer: vi.fn(),
    getRunningContainer: vi.fn(() => null),
  },
  hostToContainerPath: vi.fn((p: string) => p),
  dockerAvailable: vi.fn(() => true),
  _resetDockerAvailableCache: vi.fn(),
}));

// ── Imports after mocks ──

import { Orchestrator } from '../../src/lib/orchestrator';
import { writeQaFeedback } from '../../src/lib/orchestrator/qa-feedback';
import { savePipelineState, restorePipelineState } from '../../src/lib/orchestrator/pipeline-state';

/** Fire an event to all registered handlers for the given event type */
function fireEvent(event: string, data: any) {
  const handlers = onHandlers.get(event);
  if (handlers) {
    for (const h of [...handlers]) {
      try { h(data); } catch { /* ignore */ }
    }
  }
}

// ── Helpers ──

function setupProject() {
  const { root, clean } = createTestProject();
  mkdirSync(join(root, '.teamai'), { recursive: true });
  writeFileSync(join(root, '.teamai', 'pipeline.json'), JSON.stringify({
    phases: ['spec', 'plan', 'implement', 'qa-review', 'merge'],
    maxQaAttempts: 3,
    parallelSubtasks: true,
  }));

  const taskId = randomUUID();
  const taskDir = join(root, '.teamai', 'persisted-failures-test');
  mkdirSync(taskDir, { recursive: true });
  writeFileSync(join(taskDir, 'task.json'), JSON.stringify({
    id: taskId,
    title: 'Persisted Failures Test',
    description: 'a test task',
    phase: 'implement',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }));

  return { root, taskId, taskDir, clean };
}

function makePipeline(taskId: string, specPath: string, overrides: Record<string, any> = {}): any {
  return {
    taskId,
    description: 'test',
    phase: 'qa-review' as string,
    specPath,
    worktreePath: '/test/wt',
    branch: 'feat/persisted-failures-test',
    qaAttempt: 1,
    maxQaAttempts: 5,
    specRevision: 1,
    deliverableFailCounts: undefined as Record<number, number> | undefined,
    persistedCriterionFailCounts: undefined as Record<string, number> | undefined,
    ...overrides,
  };
}

// ═══════════════════════════════════════════════════════════════════════
//  Count math — persistedCriterionFailCounts tracking
// ═══════════════════════════════════════════════════════════════════════

describe('persistedCriterionFailCounts — count math', () => {
  let project: ReturnType<typeof setupProject>;
  let orch: Orchestrator;

  beforeEach(() => {
    vi.clearAllMocks();
    onHandlers.clear();
    project = setupProject();
    orch = new Orchestrator(project.root);
  });

  afterEach(() => {
    project.clean();
  });

  it('increments count to 2 on first consecutive failure (previous + current = 2 total)', async () => {
    // Previous cycle's report snapshot already exists with a FAIL criterion
    const prevReport = {
      overall: 'FAIL',
      criteria: [
        { name: 'Must have 3 positive cases', status: 'FAIL', notes: 'Only 2 found' },
        { name: 'Performance', status: 'PASS' },
      ],
    };
    writeFileSync(join(project.taskDir, 'qa_report_before_bounce.json'), JSON.stringify(prevReport));

    mockExecFileSync.mockImplementation((_cmd: string, args?: string[]) => {
      if (args && args[0] === 'fetch') return '';
      if (args && args[0] === 'log') return '';
      return '';
    });

    mockCreateSession.mockResolvedValue('sess-qa-count1');

    const executeSpy = vi.spyOn(orch as AnyOrch, 'executePhase').mockResolvedValue(undefined);

    const pipeline = makePipeline(project.taskId, project.taskDir, { qaAttempt: 1 });

    try {
      const promise = (orch as AnyOrch).runQaReview(pipeline);
      await vi.waitFor(() => {
        expect(mockSendMessage).toHaveBeenCalled();
      });

      // Current QA report has the same FAIL criterion as the previous cycle
      const currentReport = {
        overall: 'FAIL',
        criteria: [
          { name: 'Must have 3 positive cases', status: 'FAIL', notes: 'Still only 2 found', fix_needed: 'Add a third positive test case' },
          { name: 'Performance', status: 'PASS' },
        ],
      };
      writeFileSync(join(project.taskDir, 'qa_report.json'), JSON.stringify(currentReport));

      fireEvent('event', { sessionId: 'sess-qa-count1', event: { type: 'result' } });
      await new Promise(r => setTimeout(r, 30));

      // The persisted count should be 2: previous cycle (1) + current cycle (1) = 2 total
      expect(pipeline.persistedCriterionFailCounts).toBeDefined();
      expect(pipeline.persistedCriterionFailCounts['Must have 3 positive cases']).toBe(2);

      // The criterion that was PASS should NOT be tracked
      expect(pipeline.persistedCriterionFailCounts['Performance']).toBeUndefined();

      await promise;
    } finally {
      executeSpy.mockRestore();
    }
  });

  it('increments count from 2 to 3 on third consecutive failure', async () => {
    // Previous snapshot has the criterion AND pipeline already has count=2
    const prevReport = {
      overall: 'FAIL',
      criteria: [
        { name: 'Must have 3 positive cases', status: 'FAIL', notes: 'Still only 2 found' },
      ],
    };
    writeFileSync(join(project.taskDir, 'qa_report_before_bounce.json'), JSON.stringify(prevReport));

    mockExecFileSync.mockImplementation((_cmd: string, args?: string[]) => {
      if (args && args[0] === 'fetch') return '';
      if (args && args[0] === 'log') return '';
      return '';
    });

    mockCreateSession.mockResolvedValue('sess-qa-count2');

    const executeSpy = vi.spyOn(orch as AnyOrch, 'executePhase').mockResolvedValue(undefined);

    // Pipeline already has persistedCriterionFailCounts = { 'Must have 3 positive cases': 2 }
    const pipeline = makePipeline(project.taskId, project.taskDir, {
      qaAttempt: 2,
      persistedCriterionFailCounts: { 'Must have 3 positive cases': 2 },
    });

    try {
      const promise = (orch as AnyOrch).runQaReview(pipeline);
      await vi.waitFor(() => {
        expect(mockSendMessage).toHaveBeenCalled();
      });

      const currentReport = {
        overall: 'FAIL',
        criteria: [
          { name: 'Must have 3 positive cases', status: 'FAIL', notes: 'Still only 2 found', fix_needed: 'Add a third positive test case' },
        ],
      };
      writeFileSync(join(project.taskDir, 'qa_report.json'), JSON.stringify(currentReport));

      fireEvent('event', { sessionId: 'sess-qa-count2', event: { type: 'result' } });
      await new Promise(r => setTimeout(r, 30));

      // Count should increment: previous 2 + current 1 = 3
      expect(pipeline.persistedCriterionFailCounts['Must have 3 positive cases']).toBe(3);

      await promise;
    } finally {
      executeSpy.mockRestore();
    }
  });

  it('resets count for a criterion when it no longer appears in current FAIL list (it got fixed)', async () => {
    // Previous snapshot AND pipeline count both have criterion "Bug A"
    const prevReport = {
      overall: 'FAIL',
      criteria: [
        { name: 'Bug A', status: 'FAIL', notes: 'Still broken' },
        { name: 'Bug B', status: 'FAIL', notes: 'New failure' },
      ],
    };
    writeFileSync(join(project.taskDir, 'qa_report_before_bounce.json'), JSON.stringify(prevReport));

    mockExecFileSync.mockImplementation((_cmd: string, args?: string[]) => {
      if (args && args[0] === 'fetch') return '';
      if (args && args[0] === 'log') return '';
      return '';
    });

    mockCreateSession.mockResolvedValue('sess-qa-reset');

    const executeSpy = vi.spyOn(orch as AnyOrch, 'executePhase').mockResolvedValue(undefined);

    // "Bug A" was in persisted failures, but now it's fixed (no longer FAIL in current report)
    const pipeline = makePipeline(project.taskId, project.taskDir, {
      qaAttempt: 2,
      persistedCriterionFailCounts: { 'Bug A': 2, 'Bug B': 1 },
    });

    try {
      const promise = (orch as AnyOrch).runQaReview(pipeline);
      await vi.waitFor(() => {
        expect(mockSendMessage).toHaveBeenCalled();
      });

      // "Bug A" is now PASS — it was fixed. "Bug B" still FAILs.
      const currentReport = {
        overall: 'FAIL',
        criteria: [
          { name: 'Bug A', status: 'PASS', notes: 'Fixed!' },
          { name: 'Bug B', status: 'FAIL', notes: 'Still broken' },
        ],
      };
      writeFileSync(join(project.taskDir, 'qa_report.json'), JSON.stringify(currentReport));

      fireEvent('event', { sessionId: 'sess-qa-reset', event: { type: 'result' } });
      await new Promise(r => setTimeout(r, 30));

      // "Bug A" should be removed from tracking (it passed!)
      expect(pipeline.persistedCriterionFailCounts['Bug A']).toBeUndefined();
      // "Bug B" should still be tracked and incremented
      expect(pipeline.persistedCriterionFailCounts['Bug B']).toBeGreaterThanOrEqual(2);

      await promise;
    } finally {
      executeSpy.mockRestore();
    }
  });

  it('does NOT track criteria when there is no previous snapshot (first QA run)', async () => {
    // No qa_report_before_bounce.json — this is the first QA run
    expect(existsSync(join(project.taskDir, 'qa_report_before_bounce.json'))).toBe(false);

    mockExecFileSync.mockImplementation((_cmd: string, args?: string[]) => {
      if (args && args[0] === 'fetch') return '';
      if (args && args[0] === 'log') return '';
      return '';
    });

    mockCreateSession.mockResolvedValue('sess-qa-first');

    const executeSpy = vi.spyOn(orch as AnyOrch, 'executePhase').mockResolvedValue(undefined);

    const pipeline = makePipeline(project.taskId, project.taskDir, { qaAttempt: 0 });

    try {
      const promise = (orch as AnyOrch).runQaReview(pipeline);
      await vi.waitFor(() => {
        expect(mockSendMessage).toHaveBeenCalled();
      });

      const currentReport = {
        overall: 'FAIL',
        criteria: [
          { name: 'Must have 3 positive cases', status: 'FAIL', notes: 'Only 2 found' },
        ],
      };
      writeFileSync(join(project.taskDir, 'qa_report.json'), JSON.stringify(currentReport));

      fireEvent('event', { sessionId: 'sess-qa-first', event: { type: 'result' } });
      await new Promise(r => setTimeout(r, 30));

      // No previous snapshot — no escalation should be triggered
      expect(pipeline.persistedCriterionFailCounts).toBeUndefined();

      await promise;
    } finally {
      executeSpy.mockRestore();
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════
//  Snapshot comparison — correct matching of FAIL criteria between cycles
// ═══════════════════════════════════════════════════════════════════════

describe('persistedCriterionFailCounts — snapshot comparison', () => {
  let project: ReturnType<typeof setupProject>;
  let orch: Orchestrator;

  beforeEach(() => {
    vi.clearAllMocks();
    onHandlers.clear();
    project = setupProject();
    orch = new Orchestrator(project.root);
  });

  afterEach(() => {
    project.clean();
  });

  it('matches criteria by name even when notes/evidence differ between cycles', async () => {
    // The criterion text is identical but the notes change — still counts as persisted
    const prevReport = {
      overall: 'FAIL',
      criteria: [
        { name: 'Must have 3 positive cases', status: 'FAIL', notes: 'Only 2 found in integration tests' },
      ],
    };
    writeFileSync(join(project.taskDir, 'qa_report_before_bounce.json'), JSON.stringify(prevReport));

    mockExecFileSync.mockImplementation((_cmd: string, args?: string[]) => {
      if (args && args[0] === 'fetch') return '';
      if (args && args[0] === 'log') return '';
      return '';
    });

    mockCreateSession.mockResolvedValue('sess-qa-match');

    const executeSpy = vi.spyOn(orch as AnyOrch, 'executePhase').mockResolvedValue(undefined);

    const pipeline = makePipeline(project.taskId, project.taskDir, { qaAttempt: 1 });

    try {
      const promise = (orch as AnyOrch).runQaReview(pipeline);
      await vi.waitFor(() => {
        expect(mockSendMessage).toHaveBeenCalled();
      });

      // Same criterion name, different notes — should still match
      const currentReport = {
        overall: 'FAIL',
        criteria: [
          { name: 'Must have 3 positive cases', status: 'FAIL', notes: 'Only 2 found, and one is mislabeled' },
        ],
      };
      writeFileSync(join(project.taskDir, 'qa_report.json'), JSON.stringify(currentReport));

      fireEvent('event', { sessionId: 'sess-qa-match', event: { type: 'result' } });
      await new Promise(r => setTimeout(r, 30));

      expect(pipeline.persistedCriterionFailCounts).toBeDefined();
      expect(pipeline.persistedCriterionFailCounts['Must have 3 positive cases']).toBe(2);

      await promise;
    } finally {
      executeSpy.mockRestore();
    }
  });

  it('matches by c.criterion field when c.name is not present', async () => {
    const prevReport = {
      overall: 'FAIL',
      criteria: [
        { criterion: 'No occurrences of X remain', status: 'FAIL', notes: 'Found 3 occurrences' },
      ],
    };
    writeFileSync(join(project.taskDir, 'qa_report_before_bounce.json'), JSON.stringify(prevReport));

    mockExecFileSync.mockImplementation((_cmd: string, args?: string[]) => {
      if (args && args[0] === 'fetch') return '';
      if (args && args[0] === 'log') return '';
      return '';
    });

    mockCreateSession.mockResolvedValue('sess-qa-criterion');

    const executeSpy = vi.spyOn(orch as AnyOrch, 'executePhase').mockResolvedValue(undefined);

    const pipeline = makePipeline(project.taskId, project.taskDir, { qaAttempt: 1 });

    try {
      const promise = (orch as AnyOrch).runQaReview(pipeline);
      await vi.waitFor(() => {
        expect(mockSendMessage).toHaveBeenCalled();
      });

      const currentReport = {
        overall: 'FAIL',
        criteria: [
          { criterion: 'No occurrences of X remain', status: 'FAIL', notes: 'Found 1 occurrence in new file' },
        ],
      };
      writeFileSync(join(project.taskDir, 'qa_report.json'), JSON.stringify(currentReport));

      fireEvent('event', { sessionId: 'sess-qa-criterion', event: { type: 'result' } });
      await new Promise(r => setTimeout(r, 30));

      expect(pipeline.persistedCriterionFailCounts['No occurrences of X remain']).toBe(2);

      await promise;
    } finally {
      executeSpy.mockRestore();
    }
  });

  it('does NOT match criteria whose text changed (spec revision changed the wording)', async () => {
    const prevReport = {
      overall: 'FAIL',
      criteria: [
        { name: 'Must have 3 positive cases', status: 'FAIL', notes: 'Only 2 found' },
      ],
    };
    writeFileSync(join(project.taskDir, 'qa_report_before_bounce.json'), JSON.stringify(prevReport));

    mockExecFileSync.mockImplementation((_cmd: string, args?: string[]) => {
      if (args && args[0] === 'fetch') return '';
      if (args && args[0] === 'log') return '';
      return '';
    });

    mockCreateSession.mockResolvedValue('sess-qa-different');

    const executeSpy = vi.spyOn(orch as AnyOrch, 'executePhase').mockResolvedValue(undefined);

    const pipeline = makePipeline(project.taskId, project.taskDir, { qaAttempt: 1 });

    try {
      const promise = (orch as AnyOrch).runQaReview(pipeline);
      await vi.waitFor(() => {
        expect(mockSendMessage).toHaveBeenCalled();
      });

      // Criterion text changed (spec revision) — should NOT match
      const currentReport = {
        overall: 'FAIL',
        criteria: [
          { name: 'Must have at least 5 positive cases (revised)', status: 'FAIL', notes: 'Only 2 found' },
        ],
      };
      writeFileSync(join(project.taskDir, 'qa_report.json'), JSON.stringify(currentReport));

      fireEvent('event', { sessionId: 'sess-qa-different', event: { type: 'result' } });
      await new Promise(r => setTimeout(r, 30));

      // Old criterion should NOT be tracked (text didn't match)
      expect(pipeline.persistedCriterionFailCounts).toBeDefined();
      expect(pipeline.persistedCriterionFailCounts['Must have 3 positive cases']).toBeUndefined();

      await promise;
    } finally {
      executeSpy.mockRestore();
    }
  });

  it('handles multiple matching criteria correctly — some new FAILs, some persisted', async () => {
    const prevReport = {
      overall: 'FAIL',
      criteria: [
        { name: 'Criterion A (persisted)', status: 'FAIL', notes: 'Fail cycle 1' },
        { name: 'Criterion B (now fixed)', status: 'FAIL', notes: 'Fail cycle 1' },
      ],
    };
    writeFileSync(join(project.taskDir, 'qa_report_before_bounce.json'), JSON.stringify(prevReport));

    mockExecFileSync.mockImplementation((_cmd: string, args?: string[]) => {
      if (args && args[0] === 'fetch') return '';
      if (args && args[0] === 'log') return '';
      return '';
    });

    mockCreateSession.mockResolvedValue('sess-qa-mixed');

    const executeSpy = vi.spyOn(orch as AnyOrch, 'executePhase').mockResolvedValue(undefined);

    const pipeline = makePipeline(project.taskId, project.taskDir, {
      qaAttempt: 2,
      persistedCriterionFailCounts: { 'Criterion A (persisted)': 2 },
    });

    try {
      const promise = (orch as AnyOrch).runQaReview(pipeline);
      await vi.waitFor(() => {
        expect(mockSendMessage).toHaveBeenCalled();
      });

      // A still fails, B is now PASS, C is a brand-new FAIL
      const currentReport = {
        overall: 'FAIL',
        criteria: [
          { name: 'Criterion A (persisted)', status: 'FAIL', notes: 'Fail cycle 3' },
          { name: 'Criterion B (now fixed)', status: 'PASS', notes: 'Fixed!' },
          { name: 'Criterion C (brand new)', status: 'FAIL', notes: 'New issue found' },
        ],
      };
      writeFileSync(join(project.taskDir, 'qa_report.json'), JSON.stringify(currentReport));

      fireEvent('event', { sessionId: 'sess-qa-mixed', event: { type: 'result' } });
      await new Promise(r => setTimeout(r, 30));

      // A: persisted — should increment from 2 to 3
      expect(pipeline.persistedCriterionFailCounts['Criterion A (persisted)']).toBe(3);
      // B: fixed — should be removed
      expect(pipeline.persistedCriterionFailCounts['Criterion B (now fixed)']).toBeUndefined();
      // C: brand new — not in previous snapshot, so not persisted
      expect(pipeline.persistedCriterionFailCounts['Criterion C (brand new)']).toBeUndefined();

      await promise;
    } finally {
      executeSpy.mockRestore();
    }
  });

  it('handles malformed previous snapshot gracefully — no crash, no escalation', async () => {
    writeFileSync(join(project.taskDir, 'qa_report_before_bounce.json'), 'not valid json {{{');

    mockExecFileSync.mockImplementation((_cmd: string, args?: string[]) => {
      if (args && args[0] === 'fetch') return '';
      if (args && args[0] === 'log') return '';
      return '';
    });

    mockCreateSession.mockResolvedValue('sess-qa-malformed-snap');

    const executeSpy = vi.spyOn(orch as AnyOrch, 'executePhase').mockResolvedValue(undefined);

    const pipeline = makePipeline(project.taskId, project.taskDir, { qaAttempt: 1 });

    try {
      const promise = (orch as AnyOrch).runQaReview(pipeline);
      await vi.waitFor(() => {
        expect(mockSendMessage).toHaveBeenCalled();
      });

      const currentReport = {
        overall: 'FAIL',
        criteria: [
          { name: 'Must have 3 positive cases', status: 'FAIL', notes: 'Only 2 found' },
        ],
      };
      writeFileSync(join(project.taskDir, 'qa_report.json'), JSON.stringify(currentReport));

      fireEvent('event', { sessionId: 'sess-qa-malformed-snap', event: { type: 'result' } });
      await new Promise(r => setTimeout(r, 30));

      // No crash, no false escalation
      expect(pipeline.phase).toBe('implement'); // bounced back normally
      expect(pipeline.persistedCriterionFailCounts).toBeUndefined();

      await promise;
    } finally {
      executeSpy.mockRestore();
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════
//  Escalation header injection — ⚠️ PERSISTED FAILURES in qa_feedback.md
// ═══════════════════════════════════════════════════════════════════════

describe('writeQaFeedback — persisted failures escalation header', () => {
  let project: ReturnType<typeof setupProject>;

  beforeEach(() => {
    vi.clearAllMocks();
    onHandlers.clear();
    project = setupProject();
  });

  afterEach(() => {
    project.clean();
  });

  it('injects ⚠️ PERSISTED FAILURES header at the top when criteria have failed 2+ times', () => {
    const report = {
      overall: 'FAIL',
      criteria: [
        { criterion: 'Must have at least 3 positive cases', status: 'FAIL', notes: 'Only 2 found', fix_needed: 'Add a third case' },
        { criterion: 'No occurrences of X', status: 'FAIL', notes: 'Found 1 occurrence', fix_needed: 'Remove X from line 42' },
      ],
    };

    const persistedCounts = {
      'Must have at least 3 positive cases': 3,
      'No occurrences of X': 2,
    };

    // Call writeQaFeedback directly with the third parameter
    writeQaFeedback(project.taskDir, report, persistedCounts);

    const feedbackPath = join(project.taskDir, 'qa_feedback.md');
    expect(existsSync(feedbackPath)).toBe(true);
    const content = readFileSync(feedbackPath, 'utf-8');

    // Escalation header appears BEFORE the standard QA Feedback header
    const persistedIndex = content.indexOf('PERSISTED FAILURES');
    const feedbackOverrideIndex = content.indexOf('QA Feedback OVERRIDES');
    expect(persistedIndex).toBeGreaterThan(-1);
    expect(feedbackOverrideIndex).toBeGreaterThan(-1);
    expect(persistedIndex).toBeLessThan(feedbackOverrideIndex);

    // Contains the count info
    expect(content).toContain('Must have at least 3 positive cases');
    expect(content).toContain('3 times in a row');
    expect(content).toContain('No occurrences of X');
    expect(content).toContain('2 times in a row');

    // Contains the guidance
    expect(content).toContain('RESOLVE THESE FIRST');
    expect(content).toContain('enumerate every case');
    expect(content).toContain('verify each assertion direction');
  });

  it('does NOT inject escalation header when criteria have failed only 1 time (count < 2)', () => {
    const report = {
      overall: 'FAIL',
      criteria: [
        { criterion: 'Must have at least 3 positive cases', status: 'FAIL', notes: 'Only 2 found' },
      ],
    };

    // Count = 1 means only one previous detection — not yet 2+ consecutive
    const persistedCounts = {
      'Must have at least 3 positive cases': 1,
    };

    writeQaFeedback(project.taskDir, report, persistedCounts);

    const feedbackPath = join(project.taskDir, 'qa_feedback.md');
    const content = readFileSync(feedbackPath, 'utf-8');

    // No escalation header
    expect(content).not.toContain('PERSISTED FAILURES');
    // But still contains the standard QA feedback
    expect(content).toContain('QA Feedback OVERRIDES');
    expect(content).toContain('Must have at least 3 positive cases');
  });

  it('does NOT inject escalation header when persistedCriterionFailCounts is undefined (first QA run)', () => {
    const report = {
      overall: 'FAIL',
      criteria: [
        { criterion: 'Must have at least 3 positive cases', status: 'FAIL', notes: 'Only 2 found' },
      ],
    };

    // undefined = no persisted failures tracking at all (first QA pass)
    writeQaFeedback(project.taskDir, report, undefined);

    const feedbackPath = join(project.taskDir, 'qa_feedback.md');
    const content = readFileSync(feedbackPath, 'utf-8');

    expect(content).not.toContain('PERSISTED FAILURES');
    expect(content).toContain('QA Feedback OVERRIDES');
    expect(content).toContain('Must have at least 3 positive cases');
  });

  it('includes both escalation header and standard FAIL criteria in the same feedback', () => {
    const report = {
      overall: 'FAIL',
      criteria: [
        { criterion: 'Persisted criterion A', status: 'FAIL', notes: 'Still broken', fix_needed: 'Fix it properly' },
        { criterion: 'New criterion B (first failure)', status: 'FAIL', notes: 'Never seen before', fix_needed: 'Add missing feature' },
      ],
    };

    const persistedCounts = {
      'Persisted criterion A': 2,
    };

    writeQaFeedback(project.taskDir, report, persistedCounts);

    const feedbackPath = join(project.taskDir, 'qa_feedback.md');
    const content = readFileSync(feedbackPath, 'utf-8');

    // Has the escalation section
    expect(content).toContain('PERSISTED FAILURES');
    expect(content).toContain('Persisted criterion A');
    expect(content).toContain('2 times in a row');

    // ALSO has the standard Failed Criteria section (with both criteria)
    expect(content).toContain('Failed Criteria');
    expect(content).toContain('Persisted criterion A');
    expect(content).toContain('New criterion B (first failure)');

    // The escalation section comes BEFORE the standard info
    const escalationIndex = content.indexOf('PERSISTED FAILURES');
    const failedCriteriaIndex = content.indexOf('Failed Criteria');
    expect(escalationIndex).toBeLessThan(failedCriteriaIndex);
  });
});

// ═══════════════════════════════════════════════════════════════════════
//  E2E: Full QA→bounce→escalate→resolve cycle
// ═══════════════════════════════════════════════════════════════════════

describe('E2E — persisted failures escalation full cycle', () => {
  let project: ReturnType<typeof setupProject>;
  let orch: Orchestrator;

  beforeEach(() => {
    vi.clearAllMocks();
    onHandlers.clear();
    project = setupProject();
    orch = new Orchestrator(project.root);

    // Setup plan.json for implement phase
    writeFileSync(join(project.taskDir, 'plan.json'), JSON.stringify({
      subtasks: [{
        id: 1,
        title: 'Implement feature',
        description: 'Build the feature',
        files: ['src/feature.ts'],
        acceptance_criteria: ['Must have at least 3 positive cases'],
      }],
    }));
  });

  afterEach(() => {
    project.clean();
  });

  it('full cycle: QA FAIL (cycle 1) → bounce → QA FAIL same criterion (cycle 2) → escalation injected → QA PASS (fixed)', async () => {
    // ── Cycle 1: First QA run — FAIL on "Must have at least 3 positive cases" ──
    mockExecFileSync.mockImplementation((_cmd: string, args?: string[]) => {
      if (args && args[0] === 'fetch') return '';
      if (args && args[0] === 'log') return '';
      return '';
    });

    mockCreateSession.mockResolvedValue('sess-e2e-cycle1');
    const executeSpy = vi.spyOn(orch as AnyOrch, 'executePhase').mockResolvedValue(undefined);

    const pipeline = makePipeline(project.taskId, project.taskDir, {
      phase: 'qa-review',
      qaAttempt: 0,
      maxQaAttempts: 3,
      worktreePath: join(project.root, 'worktrees', 'test-task'),
    });

    try {
      // Cycle 1 QA run
      const qa1Promise = (orch as AnyOrch).runQaReview(pipeline);
      await vi.waitFor(() => {
        expect(mockSendMessage).toHaveBeenCalled();
      });

      const cycle1Report = {
        overall: 'FAIL',
        criteria: [
          { name: 'Must have at least 3 positive cases', status: 'FAIL', notes: 'Only 2 positive cases found', fix_needed: 'Add a third positive test case' },
        ],
        additional_issues: [
          { severity: 'warning', description: 'Test case at line 45 is labeled "positive" but asserts zero — this inflates the count', file: 'src/feature.test.ts' },
        ],
      };
      writeFileSync(join(project.taskDir, 'qa_report.json'), JSON.stringify(cycle1Report));

      fireEvent('event', { sessionId: 'sess-e2e-cycle1', event: { type: 'result' } });
      await new Promise(r => setTimeout(r, 30));

      // Cycle 1: should bounce to implement (no previous snapshot, so no escalation yet)
      expect(pipeline.phase).toBe('implement');
      expect(pipeline.persistedCriterionFailCounts).toBeUndefined(); // first run — no prior snapshot means no recurrence
      expect(existsSync(join(project.taskDir, 'qa_report_before_bounce.json'))).toBe(true);

      await qa1Promise;
      executeSpy.mockRestore();

      // ── Simulate: implement runs (coder fixes the warning but NOT the FAIL criterion) ──
      // (The implement phase is short-circuited via executeSpy above)

      // ── Cycle 2: Second QA run — same FAIL criterion appears again ──
      mockExecFileSync.mockReset();
      mockCreateSession.mockReset();
      mockSendMessage.mockClear();
      onHandlers.clear();
      mockExecFileSync.mockImplementation((_cmd: string, args?: string[]) => {
        if (args && args[0] === 'fetch') return '';
        if (args && args[0] === 'log') return '';
        return '';
      });
      mockCreateSession.mockResolvedValue('sess-e2e-cycle2');

      pipeline.phase = 'qa-review';
      pipeline.qaAttempt = 1;
      const executeSpy2 = vi.spyOn(orch as AnyOrch, 'executePhase').mockResolvedValue(undefined);

      try {
        const qa2Promise = (orch as AnyOrch).runQaReview(pipeline);
        await vi.waitFor(() => {
          expect(mockSendMessage).toHaveBeenCalled();
        });

        // Same criterion FAILs again — the coder fixed the warning but not the FAIL
        const cycle2Report = {
          overall: 'FAIL',
          criteria: [
            { name: 'Must have at least 3 positive cases', status: 'FAIL', notes: 'Still only 2 positive cases — the coder fixed the warning but the criterion is still FAIL', fix_needed: 'Add a third positive test case' },
          ],
        };
        writeFileSync(join(project.taskDir, 'qa_report.json'), JSON.stringify(cycle2Report));

        fireEvent('event', { sessionId: 'sess-e2e-cycle2', event: { type: 'result' } });
        await new Promise(r => setTimeout(r, 30));

        // Cycle 2: persistedCriterionFailCounts should be set to 2
        expect(pipeline.persistedCriterionFailCounts).toBeDefined();
        expect(pipeline.persistedCriterionFailCounts!['Must have at least 3 positive cases']).toBe(2);

        // qa_feedback.md should contain the escalation header
        const feedbackPath = join(project.taskDir, 'qa_feedback.md');
        expect(existsSync(feedbackPath)).toBe(true);
        const feedback = readFileSync(feedbackPath, 'utf-8');
        expect(feedback).toContain('PERSISTED FAILURES');
        expect(feedback).toContain('Must have at least 3 positive cases');
        expect(feedback).toContain('2 times in a row');
        expect(feedback).toContain('RESOLVE THESE FIRST');

        await qa2Promise;
        executeSpy2.mockRestore();

        // ── Simulate: implement runs, this time fixes the FAIL criterion ──

      // ── Cycle 3: QA PASS ──
      mockExecFileSync.mockReset();
      mockCreateSession.mockReset();
      mockSendMessage.mockClear();
      onHandlers.clear();
      mockExecFileSync.mockImplementation((_cmd: string, _args?: string[]) => '');
      mockCreateSession.mockResolvedValue('sess-e2e-cycle3');

        // But first, let the implement phase run to clean up the snapshot
        // (we'll simulate the implement+push flow by priming the snapshot
        //  to have a different set of FAIL criteria — i.e., the fix worked)

        // Write new previous snapshot showing the criterion was fixed
        // (The implement phase would have overwritten qa_report_before_bounce.json,
        //  and since the code was fixed, the next QA should pass)

        pipeline.phase = 'qa-review';
        pipeline.qaAttempt = 2;
        const executeSpy3 = vi.spyOn(orch as AnyOrch, 'executePhase').mockResolvedValue(undefined);

        try {
          const qa3Promise = (orch as AnyOrch).runQaReview(pipeline);
          await vi.waitFor(() => {
            expect(mockSendMessage).toHaveBeenCalled();
          });

          // This time QA passes
          const cycle3Report = {
            overall: 'PASS',
            criteria: [
              { name: 'Must have at least 3 positive cases', status: 'PASS', notes: 'All 3 positive cases correctly asserted' },
            ],
          };
          writeFileSync(join(project.taskDir, 'qa_report.json'), JSON.stringify(cycle3Report));

          fireEvent('event', { sessionId: 'sess-e2e-cycle3', event: { type: 'result' } });
          await qa3Promise;

          // Final state: awaiting-review (PASS)
          expect(pipeline.phase).toBe('awaiting-review');
        } finally {
          executeSpy3.mockRestore();
        }
      } finally {
        executeSpy2.mockRestore();
      }
    } finally {
      executeSpy.mockRestore();
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════
//  Mixed spec concerns + additional issues regression
// ═══════════════════════════════════════════════════════════════════════

describe('QA mixed spec concerns and recurring additional issues', () => {
  let project: ReturnType<typeof setupProject>;
  let orch: Orchestrator;

  beforeEach(() => {
    vi.clearAllMocks();
    onHandlers.clear();
    project = setupProject();
    orch = new Orchestrator(project.root);
  });

  afterEach(() => project.clean());

  it('surfaces recurring additional issues with spec concerns and fails at the global QA budget', async () => {
    const previous = {
      overall: 'FAIL',
      additional_issues: [{ description: 'Duplicate test block', file: 'src/feature.test.ts' }],
      spec_concerns: [{ issue: 'Ambiguous requirement', reasoning: 'The spec omits a boundary case' }],
    };
    writeFileSync(join(project.taskDir, 'qa_report_before_bounce.json'), JSON.stringify(previous));

    mockExecFileSync.mockImplementation((_cmd: string, args?: string[]) => {
      if (args && args[0] === 'fetch') return '';
      if (args && args[0] === 'log') return '';
      if (args && args[0] === 'rev-parse') return 'abc123\\n';
      return '';
    });
    mockCreateSession.mockResolvedValue('sess-mixed');

    const pipeline = makePipeline(project.taskId, project.taskDir, {
      qaAttempt: 0,
      qaRoundCount: 2,
      maxQaAttempts: 3,
    });
    const executeSpy = vi.spyOn(orch as AnyOrch, 'executePhase').mockResolvedValue(undefined);

    try {
      const promise = (orch as AnyOrch).runQaReview(pipeline);
      await vi.waitFor(() => expect(mockSendMessage).toHaveBeenCalled());
      writeFileSync(join(project.taskDir, 'qa_report.json'), JSON.stringify({
        overall: 'FAIL',
        additional_issues: [{ description: 'Duplicate test block', file: 'src/feature.test.ts' }],
        spec_concerns: [{ issue: 'Ambiguous requirement', reasoning: 'Still unresolved', suggested_fix: 'Clarify boundary' }],
      }));
      fireEvent('event', { sessionId: 'sess-mixed', event: { type: 'result' } });
      await promise;

      expect(pipeline.qaRoundCount).toBe(3);
      expect(pipeline.persistedAdditionalIssueCounts?.['src/feature.test.ts::duplicate test block']).toBe(2);
      expect(pipeline.phase).toBe('failed');
      const feedback = readFileSync(join(project.taskDir, 'qa_feedback.md'), 'utf8');
      expect(feedback).toContain('Duplicate test block');
      expect(feedback).toContain('PERSISTED ADDITIONAL ISSUES');
    } finally {
      executeSpy.mockRestore();
    }
  });

  it('tracks recurring additional issues across two real spec-concern QA rounds', async () => {
    mockExecFileSync.mockImplementation((_cmd: string, args?: string[]) => {
      if (args && args[0] === 'fetch') return '';
      if (args && args[0] === 'log') return '';
      if (args && args[0] === 'rev-parse') return 'abc123\\n';
      return '';
    });
    mockCreateSession.mockImplementation(async () => `sess-real-${mockCreateSession.mock.calls.length + 1}`);
    const pipeline = makePipeline(project.taskId, project.taskDir, {
      qaAttempt: 0,
      qaRoundCount: 0,
      maxQaAttempts: 5,
    });
    const executeSpy = vi.spyOn(orch as AnyOrch, 'executePhase').mockResolvedValue(undefined);
    const issue = { description: 'Duplicate test block', file: 'src/feature.test.ts' };
    try {
      for (const [index, reasoning] of ['First round', 'Second round'].entries()) {
        const promise = (orch as AnyOrch).runQaReview(pipeline);
        const sessionId = `sess-real-${index + 2}`;
        await vi.waitFor(() => expect(mockSendMessage).toHaveBeenCalledWith(sessionId, expect.any(String)));
        writeFileSync(join(project.taskDir, 'qa_report.json'), JSON.stringify({
          overall: 'FAIL',
          additional_issues: [issue],
          spec_concerns: [{ issue: 'Ambiguous requirement', reasoning }],
        }));
        fireEvent('event', { sessionId, event: { type: 'result' } });
        await promise;
        if (index === 0) {
          expect(pipeline.phase).toBe('spec');
          // Spec revision cleanup removes the comparison snapshot as part of
          // starting a fresh revision. Restore only the production-produced
          // cycle-1 report, never hand-seeding it before a QA round.
          writeFileSync(join(project.taskDir, 'qa_report_before_bounce.json'), JSON.stringify({
            overall: 'FAIL', additional_issues: [issue],
            spec_concerns: [{ issue: 'Ambiguous requirement', reasoning }],
          }));
          pipeline.phase = 'qa-review';
        }
      }
      expect(pipeline.persistedAdditionalIssueCounts?.['src/feature.test.ts::duplicate test block']).toBe(2);
    } finally {
      executeSpy.mockRestore();
    }
  });

  it('writeQaFeedback includes recurring additional issues in the coder feedback', () => {
    const report = {
      overall: 'FAIL',
      additional_issues: [{ description: 'Duplicate test block', file: 'src/feature.test.ts' }],
    };
    writeQaFeedback(project.taskDir, report, undefined, {
      'src/feature.test.ts::duplicate test block': 2,
    });
    const feedback = readFileSync(join(project.taskDir, 'qa_feedback.md'), 'utf8');
    expect(feedback).toContain('PERSISTED ADDITIONAL ISSUES');
    expect(feedback).toContain('Duplicate test block');
    expect(feedback).toContain('2 times in a row');
    expect(feedback).toContain('src/feature.test.ts');
  });
});

// ═══════════════════════════════════════════════════════════════════════
//  resetAllCounters — persistedCriterionFailCounts clearing
// ═══════════════════════════════════════════════════════════════════════

describe('resetAllCounters — persistedCriterionFailCounts clearing', () => {
  let project: ReturnType<typeof setupProject>;
  let orch: Orchestrator;

  beforeEach(() => {
    vi.clearAllMocks();
    onHandlers.clear();
    project = setupProject();
    orch = new Orchestrator(project.root);
  });

  afterEach(() => {
    project.clean();
  });

  it('clears persistedCriterionFailCounts when rejectTask is called (task rejection resets counters)', async () => {
    // Setup: task is awaiting-review with persisted fails
    const taskStore = (orch as AnyOrch).taskStore;
    taskStore.update(project.taskId, { phase: 'awaiting-review' });

    // Write spec.md and plan.json so the pipeline can re-enter implement
    writeFileSync(join(project.taskDir, 'spec.md'), '# Test spec');
    writeFileSync(join(project.taskDir, 'plan.json'), JSON.stringify({
      subtasks: [{
        id: 1,
        title: 'Test subtask',
        description: 'Test',
        files: ['src/test.ts'],
        acceptance_criteria: ['Works'],
      }],
    }));

    // Spy on runImplement to prevent cascade into implement phase
    const implSpy = vi.spyOn(orch as AnyOrch, 'runImplement').mockResolvedValue(undefined);

    try {
      // Mock git operations for the reject-task implement phase
      mockExecFileSync.mockReturnValue('abc123\n');

      // Reject the task
      await (orch as AnyOrch).rejectTask(project.taskId, 'Please fix the actual FAIL criterion', 'coder');

      // Verify the pipeline was created and persistedCriterionFailCounts was cleared
      const newPipeline = (orch as AnyOrch).pipelines.get(project.taskId);
      expect(newPipeline).toBeDefined();
      // After resetAllCounters, persistedCriterionFailCounts should be {}
      expect(newPipeline.persistedCriterionFailCounts).toEqual({});
      // qaAttempt should be reset
      expect(newPipeline.qaAttempt).toBe(0);
    } finally {
      implSpy.mockRestore();
    }
  });

  it('clears persistedCriterionFailCounts during autoReviseSpec (spec revision resets counters)', async () => {
    // Setup: task has a qa_report.json with spec_concerns
    const taskStore = (orch as AnyOrch).taskStore;
    taskStore.update(project.taskId, { phase: 'qa-review', specRevision: 1 });

    writeFileSync(join(project.taskDir, 'spec.md'), '# Original Spec\n\nMust have at least 3 positive cases.');
    writeFileSync(join(project.taskDir, 'plan.json'), JSON.stringify({
      subtasks: [{
        id: 1, title: 'Test', description: 'Test', files: ['src/test.ts'], acceptance_criteria: ['Must have at least 3 positive cases'],
      }],
    }));

    // QA report with spec_concerns and persisted failures
    writeFileSync(join(project.taskDir, 'qa_report.json'), JSON.stringify({
      overall: 'FAIL',
      criteria: [
        { name: 'Must have at least 3 positive cases', status: 'FAIL', notes: 'Impossible — only 2 slots exist' },
      ],
      spec_concerns: [
        { issue: 'Spec requires 3 cases but only 2 slots exist', reasoning: 'The data structure only supports 2 entries', suggested_fix: 'Reduce the requirement to 2 cases' },
      ],
    }));

    // Mock git operations for the spec revision cascade
    mockExecFileSync.mockImplementation((_cmd: string, args?: string[]) => {
      if (args && (args[0] === 'fetch' || args[0] === 'push' || args[0] === 'pull')) return '';
      if (args && args[0] === 'rev-parse') return 'abc123\n';
      return '';
    });

    // Spy on executePhase to prevent cascade into spec/plan/implement pipeline
    // (Spec revision goes through autoReviseSpec → advancePhase(spec) → executePhase(spec))
    const executeSpy = vi.spyOn(orch as AnyOrch, 'executePhase').mockResolvedValue(undefined);

    // Create pipeline with persisted failures
    const pipeline = makePipeline(project.taskId, project.taskDir, {
      phase: 'qa-review',
      qaAttempt: 2,
      maxQaAttempts: 5,
      qaRoundCount: 2,
      persistedCriterionFailCounts: { 'Must have at least 3 positive cases': 3 },
      persistedAdditionalIssueCounts: { 'src/test.ts::duplicate test block': 2 },
      deliverableFailCounts: { 1: 2 },
      worktreePath: join(project.root, 'worktrees', 'test-task'),
    });

    // Directly set the pipeline on the orchestrator so runQaReview can find it
    (orch as AnyOrch).pipelines.set(project.taskId, pipeline);

    try {
      // Call runQaReview — it will detect spec_concerns and call autoReviseSpec
      // which calls resetAllCounters
      mockExecFileSync.mockImplementation((_cmd: string, args?: string[]) => {
        if (args && args[0] === 'fetch') return '';
        if (args && args[0] === 'log') return '';
        return '';
      });
      mockCreateSession.mockResolvedValue('sess-qa-revise');

      const promise = (orch as AnyOrch).runQaReview(pipeline);
      await vi.waitFor(() => {
        expect(mockSendMessage).toHaveBeenCalled();
      });

      // Fire result event so waitForCompletion resolves
      fireEvent('event', { sessionId: 'sess-qa-revise', event: { type: 'result' } });
      await new Promise(r => setTimeout(r, 50));

      await promise;

      // Spec revision resets per-revision operational counters but preserves
      // cross-round QA history and the global round budget.
      expect(pipeline.persistedCriterionFailCounts).toEqual({ 'Must have at least 3 positive cases': 3 });
      expect(pipeline.persistedAdditionalIssueCounts).toEqual({ 'src/test.ts::duplicate test block': 2 });
      expect(pipeline.deliverableFailCounts).toEqual({});
      expect(pipeline.qaAttempt).toBe(0);
      expect(pipeline.qaRoundCount).toBe(3);
      expect(pipeline.wakeupSubtaskId).toBeUndefined();
    } finally {
      executeSpy.mockRestore();
    }
  });

  it('persistedCriterionFailCounts survives pipeline state save/restore (crash recovery)', () => {
    // Simulate saving and restoring pipeline state
    const specPath = project.taskDir;

    const pipeline = makePipeline(project.taskId, specPath, {
      persistedCriterionFailCounts: {
        'Criterion A': 2,
        'Criterion B': 4,
      },
    });

    // Save pipeline state (same as orchestrator does in savePipelineState)
    savePipelineState(pipeline);

    // Verify the state file exists and contains the counts
    const statePath = join(specPath, '.pipeline_state.json');
    expect(existsSync(statePath)).toBe(true);
    const state = JSON.parse(readFileSync(statePath, 'utf-8'));
    expect(state.persistedCriterionFailCounts).toBeDefined();
    expect(state.persistedCriterionFailCounts['Criterion A']).toBe(2);
    expect(state.persistedCriterionFailCounts['Criterion B']).toBe(4);

    // Restore (simulates crash recovery in runTask)
    const restored = restorePipelineState(project.taskId, specPath);
    expect(restored).not.toBeNull();
    expect(restored!.persistedCriterionFailCounts).toBeDefined();
    expect(restored!.persistedCriterionFailCounts!['Criterion A']).toBe(2);
    expect(restored!.persistedCriterionFailCounts!['Criterion B']).toBe(4);
  });

  it('cleanupTaskArtifacts for qa-review phase deletes qa_report_before_bounce.json', async () => {
    // Write the bounce snapshot
    writeFileSync(join(project.taskDir, 'qa_report_before_bounce.json'), JSON.stringify({
      overall: 'FAIL',
      criteria: [{ name: 'Test', status: 'FAIL' }],
    }));

    expect(existsSync(join(project.taskDir, 'qa_report_before_bounce.json'))).toBe(true);

    // Call cleanupTaskArtifacts for qa-review phase
    await (orch as AnyOrch).cleanupTaskArtifacts(project.taskId, 'qa-review');

    // The bounce snapshot should be deleted
    expect(existsSync(join(project.taskDir, 'qa_report_before_bounce.json'))).toBe(false);
  });
});
