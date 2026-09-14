/**
 * Orchestrator QA feedback tests.
 * Tests the _writeQaFeedback and _writeCompletionSummary private methods
 * to verify the criterion field fix, additional_issues handling, and plan.json patching.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { createTestProject } from '../utils/test-project';

 
type AnyOrch = any;

// Mock process-manager
vi.mock('../../src/lib/process-manager', () => ({
  processManager: {
    on: vi.fn(),
    off: vi.fn(),
    emit: vi.fn(),
    createSession: vi.fn(),
    sendMessage: vi.fn(),
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
}));

vi.mock('../../src/lib/container-manager', () => ({
  readContainerConfig: vi.fn(() => ({ enabled: false })),
  readContainerRemoteUser: vi.fn(() => 'node'),
  containerManager: {
    getRunningContainer: vi.fn(() => null),
  },
  hostToContainerPath: vi.fn((p: string) => p),
}));

import { Orchestrator } from '../../src/lib/orchestrator';

function setupProject() {
  const { root, clean } = createTestProject();
  mkdirSync(join(root, '.teamai'), { recursive: true });
  writeFileSync(join(root, '.teamai', 'pipeline.json'), JSON.stringify({
    phases: ['spec', 'plan', 'implement', 'qa-review', 'merge'],
    maxQaAttempts: 3,
    parallelSubtasks: true,
  }));

  const taskId = randomUUID();
  const taskDir = join(root, '.teamai', 'my-test');
  mkdirSync(taskDir, { recursive: true });
  writeFileSync(join(taskDir, 'task.json'), JSON.stringify({
    id: taskId,
    title: 'Test Task',
    description: 'A test',
    phase: 'implement',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }));

  // Create plan.json with acceptance criteria for patching tests
  writeFileSync(join(taskDir, 'plan.json'), JSON.stringify({
    subtasks: [
      {
        id: 1,
        title: 'Add feature A',
        description: 'Implement feature A',
        files: ['src/featureA.ts', 'src/featureA.test.ts'],
        acceptance_criteria: ['Feature A works correctly', 'Tests pass'],
      },
      {
        id: 2,
        title: 'Add feature B',
        description: 'Implement feature B',
        files: ['src/featureB.ts'],
        acceptance_criteria: ['Feature B returns valid data'],
      },
    ],
  }));

  return { root, taskId, taskDir, clean };
}

describe('_writeQaFeedback', () => {
  let project: ReturnType<typeof setupProject>;
  let orch: Orchestrator;

  beforeEach(() => {
    vi.clearAllMocks();
    project = setupProject();
    orch = new Orchestrator(project.root);
  });

  afterEach(() => {
    project.clean();
  });

  const pipeline = (taskId: string, specPath: string) => ({
    taskId,
    description: 'test',
    phase: 'qa-review' as const,
    specPath,
    worktreePath: '/test/wt',
    branch: 'feat/test',
    qaAttempt: 1,
    maxQaAttempts: 3,
  });

  it('uses c.criterion field (not c.name) for failed criteria', () => {
    const report = {
      overall: 'FAIL',
      criteria: [
        { criterion: 'Error handling', status: 'FAIL', notes: 'Missing try/catch' },
        { criterion: 'Performance', status: 'FAIL', notes: 'Slow on large inputs', fix_needed: 'Add caching' },
      ],
    };

    (orch as AnyOrch)._ctx.writeQaFeedback(pipeline(project.taskId, project.taskDir), report);

    const feedbackPath = join(project.taskDir, 'qa_feedback.md');
    expect(existsSync(feedbackPath)).toBe(true);
    const content = readFileSync(feedbackPath, 'utf-8');

    expect(content).toContain('Error handling');
    expect(content).toContain('Missing try/catch');
    expect(content).toContain('Performance');
    expect(content).toContain('Slow on large inputs');
    expect(content).toContain('Add caching');
    expect(content).toContain('QA Feedback OVERRIDES');
  });

  it('falls back to c.name when c.criterion is not present', () => {
    const report = {
      overall: 'FAIL',
      criteria: [
        { name: 'Old-style criterion', status: 'FAIL', notes: 'Needs work' },
      ],
    };

    (orch as AnyOrch)._ctx.writeQaFeedback(pipeline(project.taskId, project.taskDir), report);

    const feedbackPath = join(project.taskDir, 'qa_feedback.md');
    const content = readFileSync(feedbackPath, 'utf-8');
    expect(content).toContain('Old-style criterion');
  });

  it('handles additional_issues field (the actual QA report field name)', () => {
    const report = {
      overall: 'FAIL',
      criteria: [],
      additional_issues: [
        { severity: 'critical', description: 'Security vulnerability in auth', file: 'src/auth.ts' },
        { severity: 'warning', description: 'Deprecated API usage', fix_needed: 'Switch to v2 API' },
      ],
    };

    (orch as AnyOrch)._ctx.writeQaFeedback(pipeline(project.taskId, project.taskDir), report);

    const feedbackPath = join(project.taskDir, 'qa_feedback.md');
    const content = readFileSync(feedbackPath, 'utf-8');

    expect(content).toContain('Additional Issues');
    expect(content).toContain('Security vulnerability in auth');
    expect(content).toContain('src/auth.ts');
    expect(content).toContain('Deprecated API usage');
    expect(content).toContain('Switch to v2 API');
  });

  it('handles legacy report.issues field as fallback', () => {
    const report = {
      overall: 'FAIL',
      issues: [
        { severity: 'error', message: 'Legacy format issue', file: 'src/old.ts' },
      ],
    };

    (orch as AnyOrch)._ctx.writeQaFeedback(pipeline(project.taskId, project.taskDir), report);

    const feedbackPath = join(project.taskDir, 'qa_feedback.md');
    const content = readFileSync(feedbackPath, 'utf-8');
    expect(content).toContain('Legacy format issue');
    expect(content).toContain('src/old.ts');
  });

  it('patches plan.json acceptance criteria from failed QA criteria', () => {
    const report = {
      overall: 'FAIL',
      criteria: [
        { criterion: 'Feature A works', status: 'FAIL', fix_needed: 'Handle null inputs' },
      ],
    };

    (orch as AnyOrch)._ctx.writeQaFeedback(pipeline(project.taskId, project.taskDir), report);

    const planPath = join(project.taskDir, 'plan.json');
    const plan = JSON.parse(readFileSync(planPath, 'utf-8'));

    const subtaskA = plan.subtasks.find((s: any) => s.id === 1);
    expect(subtaskA.acceptance_criteria.some((ac: string) => ac.includes('[QA CORRECTION: Handle null inputs]'))).toBe(true);
  });

  it('patches plan.json with additional_issues appended to relevant subtasks by file match', () => {
    const report = {
      overall: 'FAIL',
      additional_issues: [
        { severity: 'critical', description: 'Race condition possible', file: 'src/featureA.ts', fix_needed: 'Add mutex' },
      ],
    };

    (orch as AnyOrch)._ctx.writeQaFeedback(pipeline(project.taskId, project.taskDir), report);

    const planPath = join(project.taskDir, 'plan.json');
    const plan = JSON.parse(readFileSync(planPath, 'utf-8'));

    // Subtask 1 has files: ['src/featureA.ts', 'src/featureA.test.ts'] — should get the issue
    const subtaskA = plan.subtasks.find((s: any) => s.id === 1);
    expect(subtaskA.acceptance_criteria.some((ac: string) => ac.includes('Race condition possible'))).toBe(true);

    // Subtask 2 has files: ['src/featureB.ts'] — should NOT get the issue
    const subtaskB = plan.subtasks.find((s: any) => s.id === 2);
    expect(subtaskB.acceptance_criteria.some((ac: string) => ac.includes('Race condition possible'))).toBe(false);
  });

  it('patches plan.json via basename matching (not substring)', () => {
    const report = {
      overall: 'FAIL',
      additional_issues: [
        // file 'src/featureB.ts' — should match subtask 2 because basenames match
        { severity: 'warning', description: 'Logging needed', file: 'featureB.ts' },
      ],
    };

    (orch as AnyOrch)._ctx.writeQaFeedback(pipeline(project.taskId, project.taskDir), report);

    const planPath = join(project.taskDir, 'plan.json');
    const plan = JSON.parse(readFileSync(planPath, 'utf-8'));

    const subtaskB = plan.subtasks.find((s: any) => s.id === 2);
    expect(subtaskB.acceptance_criteria.some((ac: string) => ac.includes('Logging needed'))).toBe(true);
  });

  it('does not crash when plan.json is missing', () => {
    // Delete plan.json
    rmSync(join(project.taskDir, 'plan.json'));
    const report = {
      overall: 'FAIL',
      criteria: [{ criterion: 'X', status: 'FAIL', fix_needed: 'Fix it' }],
    };

    expect(() => (orch as AnyOrch)._ctx.writeQaFeedback(pipeline(project.taskId, project.taskDir), report)).not.toThrow();

    const feedbackPath = join(project.taskDir, 'qa_feedback.md');
    expect(existsSync(feedbackPath)).toBe(true);
  });

  it('handles empty criteria gracefully', () => {
    const report = {
      overall: 'FAIL',
      criteria: [],
    };

    (orch as AnyOrch)._ctx.writeQaFeedback(pipeline(project.taskId, project.taskDir), report);

    const feedbackPath = join(project.taskDir, 'qa_feedback.md');
    const content = readFileSync(feedbackPath, 'utf-8');
    expect(content).toContain('Overall: FAIL');
    expect(content).toContain('QA Feedback');
  });

  // ── QA ISSUE patch tags (severity removed) ──────────────────────

  it('writes [QA ISSUE: ...] tag without severity', () => {
    const report = {
      overall: 'FAIL',
      additional_issues: [
        { description: 'Memory leak', file: 'src/featureA.ts', fix_needed: 'Add cleanup' },
      ],
    };

    (orch as AnyOrch)._ctx.writeQaFeedback(pipeline(project.taskId, project.taskDir), report);

    const planPath = join(project.taskDir, 'plan.json');
    const plan = JSON.parse(readFileSync(planPath, 'utf-8'));
    const subtaskA = plan.subtasks.find((s: any) => s.id === 1);
    expect(subtaskA.acceptance_criteria.some((ac: string) =>
      ac === '[QA ISSUE: Memory leak → Fix: Add cleanup]'
    )).toBe(true);
    expect(subtaskA.qa_flagged).toBe(true);
  });

  it('writes [QA ISSUE: ...] tag without fix_needed', () => {
    const report = {
      overall: 'FAIL',
      additional_issues: [
        { description: 'Deprecated API', file: 'src/featureB.ts' },
      ],
    };

    (orch as AnyOrch)._ctx.writeQaFeedback(pipeline(project.taskId, project.taskDir), report);

    const planPath = join(project.taskDir, 'plan.json');
    const plan = JSON.parse(readFileSync(planPath, 'utf-8'));
    const subtaskB = plan.subtasks.find((s: any) => s.id === 2);
    expect(subtaskB.acceptance_criteria.some((ac: string) =>
      ac === '[QA ISSUE: Deprecated API]'
    )).toBe(true);
    expect(subtaskB.qa_flagged).toBe(true);
  });

  it('flags issue even without fix_needed — just description', () => {
    const report = {
      overall: 'FAIL',
      additional_issues: [
        { description: 'Add JSDoc comments', file: 'src/featureA.ts' },
      ],
    };

    (orch as AnyOrch)._ctx.writeQaFeedback(pipeline(project.taskId, project.taskDir), report);

    const planPath = join(project.taskDir, 'plan.json');
    const plan = JSON.parse(readFileSync(planPath, 'utf-8'));
    const subtaskA = plan.subtasks.find((s: any) => s.id === 1);
    expect(subtaskA.acceptance_criteria.some((ac: string) =>
      ac === '[QA ISSUE: Add JSDoc comments]'
    )).toBe(true);
  });

  it('writes [QA ISSUE: ...] with fix_needed', () => {
    const report = {
      overall: 'FAIL',
      additional_issues: [
        { description: 'Null pointer dereference', file: 'src/featureA.ts', fix_needed: 'Add null check' },
      ],
    };

    (orch as AnyOrch)._ctx.writeQaFeedback(pipeline(project.taskId, project.taskDir), report);

    const planPath = join(project.taskDir, 'plan.json');
    const plan = JSON.parse(readFileSync(planPath, 'utf-8'));
    const subtaskA = plan.subtasks.find((s: any) => s.id === 1);
    expect(subtaskA.acceptance_criteria.some((ac: string) =>
      ac === '[QA ISSUE: Null pointer dereference → Fix: Add null check]'
    )).toBe(true);
    expect(subtaskA.qa_flagged).toBe(true);
  });

  it('still flags issue when description is the only field (no severity needed)', () => {
    const report = {
      overall: 'FAIL',
      additional_issues: [
        { description: 'No severity specified', file: 'src/featureA.ts' },
      ],
    };

    (orch as AnyOrch)._ctx.writeQaFeedback(pipeline(project.taskId, project.taskDir), report);

    const planPath = join(project.taskDir, 'plan.json');
    const plan = JSON.parse(readFileSync(planPath, 'utf-8'));
    const subtaskA = plan.subtasks.find((s: any) => s.id === 1);
    expect(subtaskA.acceptance_criteria.some((ac: string) =>
      ac.includes('[QA ISSUE:')
    )).toBe(true);
  });
});

describe('_writeCompletionSummary', () => {
  let project: ReturnType<typeof setupProject>;
  let orch: Orchestrator;

  beforeEach(() => {
    vi.clearAllMocks();
    project = setupProject();
    orch = new Orchestrator(project.root);
  });

  afterEach(() => {
    project.clean();
  });

  const pipeline = (taskId: string, specPath: string) => ({
    taskId,
    description: 'test',
    phase: 'qa-review' as const,
    specPath,
    worktreePath: '/test/wt',
    branch: 'feat/test',
    qaAttempt: 3,
    maxQaAttempts: 3,
  });

  it('uses c.criterion field for criterion names (not undefined)', () => {
    // Create qa_report.json with criterion field
    writeFileSync(join(project.taskDir, 'qa_report.json'), JSON.stringify({
      overall: 'FAIL',
      criteria: [
        { criterion: 'Error handling', status: 'FAIL', notes: 'Missing try/catch' },
        { criterion: 'Performance', status: 'PASS' },
        { criterion: 'Code style', status: 'FAIL', notes: 'Inconsistent formatting' },
      ],
    }));

    (orch as AnyOrch)._ctx.writeCompletionSummary(pipeline(project.taskId, project.taskDir));

    const summaryPath = join(project.taskDir, 'completion_summary.md');
    expect(existsSync(summaryPath)).toBe(true);
    const content = readFileSync(summaryPath, 'utf-8');

    // Verify criterion names are VISIBLE (not "undefined")
    expect(content).toContain('Error handling');
    expect(content).toContain('Performance');
    expect(content).toContain('Code style');
    expect(content).not.toContain('| undefined');
  });

  it('falls back to c.name when c.criterion missing', () => {
    writeFileSync(join(project.taskDir, 'qa_report.json'), JSON.stringify({
      overall: 'FAIL',
      criteria: [
        { name: 'Old field', status: 'FAIL' },
      ],
    }));

    (orch as AnyOrch)._ctx.writeCompletionSummary(pipeline(project.taskId, project.taskDir));

    const summaryPath = join(project.taskDir, 'completion_summary.md');
    const content = readFileSync(summaryPath, 'utf-8');
    expect(content).toContain('Old field');
  });

  it('includes additional_issues in completion summary', () => {
    writeFileSync(join(project.taskDir, 'qa_report.json'), JSON.stringify({
      overall: 'FAIL',
      criteria: [{ criterion: 'Tests', status: 'FAIL' }],
      additional_issues: [
        { severity: 'critical', description: 'Memory leak detected' },
        { severity: 'warning', description: 'Unused imports', message: 'Clean up' },
      ],
    }));

    (orch as AnyOrch)._ctx.writeCompletionSummary(pipeline(project.taskId, project.taskDir));

    const summaryPath = join(project.taskDir, 'completion_summary.md');
    const content = readFileSync(summaryPath, 'utf-8');

    expect(content).toContain('### Issues');
    expect(content).toContain('Memory leak detected');
    expect(content).toContain('Unused imports');
  });

  it('includes incomplete subtasks in summary', () => {
    writeFileSync(join(project.taskDir, 'qa_report.json'), JSON.stringify({
      overall: 'FAIL',
      criteria: [],
    }));

    (orch as AnyOrch)._ctx.writeCompletionSummary(pipeline(project.taskId, project.taskDir));

    const summaryPath = join(project.taskDir, 'completion_summary.md');
    const content = readFileSync(summaryPath, 'utf-8');

    expect(content).toContain('Add feature A');
    expect(content).toContain('NOT COMPLETED');
  });

  it('stores summary on task via taskStore.update', () => {
    writeFileSync(join(project.taskDir, 'qa_report.json'), JSON.stringify({
      overall: 'FAIL',
      criteria: [{ criterion: 'X', status: 'FAIL' }],
    }));

    (orch as AnyOrch)._ctx.writeCompletionSummary(pipeline(project.taskId, project.taskDir));

    const taskPath = join(project.taskDir, 'task.json');
    const task = JSON.parse(readFileSync(taskPath, 'utf-8'));
    expect(task.completionSummary).toBeDefined();
    expect(task.completionSummary).toContain('3 QA attempts');
  });

  it('does not crash when qa_report.json is missing', () => {
    expect(() => (orch as AnyOrch)._ctx.writeCompletionSummary(pipeline(project.taskId, project.taskDir))).not.toThrow();

    const summaryPath = join(project.taskDir, 'completion_summary.md');
    expect(existsSync(summaryPath)).toBe(true);
    const content = readFileSync(summaryPath, 'utf-8');
    expect(content).toContain('3 QA attempts');
  });

  it('warns when a budget-based failure has no QA report', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      (orch as AnyOrch)._ctx.writeCompletionSummary(
        pipeline(project.taskId, project.taskDir),
        'qa-attempts-exhausted',
      );

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Expected qa_report.json for qa-attempts-exhausted failure'),
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('does not warn about a missing QA report for a pre-QA session crash', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      (orch as AnyOrch)._ctx.writeCompletionSummary(
        pipeline(project.taskId, project.taskDir),
        'session-crashed',
        'session exited unexpectedly',
      );

      expect(warnSpy).not.toHaveBeenCalledWith(
        expect.stringContaining('Expected qa_report.json'),
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('writes the qa-attempts-exhausted header and stores that failureReason', () => {
    (orch as AnyOrch)._ctx.writeCompletionSummary(
      pipeline(project.taskId, project.taskDir),
      'qa-attempts-exhausted',
    );

    const content = readFileSync(join(project.taskDir, 'completion_summary.md'), 'utf-8');
    expect(content).toContain('3 QA attempts');
    expect(content).not.toContain('spec revisions');

    const task = JSON.parse(readFileSync(join(project.taskDir, 'task.json'), 'utf-8'));
    expect(task.failureReason).toBe('qa-attempts-exhausted');
  });

  it("writes a spec-revision-exhausted header distinct from the QA-attempts one, and stores that failureReason", () => {
    const p = { ...pipeline(project.taskId, project.taskDir), qaRoundCount: 7, specRevision: 5 };
    (orch as AnyOrch)._ctx.writeCompletionSummary(p, 'spec-revision-exhausted');

    const content = readFileSync(join(project.taskDir, 'completion_summary.md'), 'utf-8');
    expect(content).toContain('5 spec revisions');
    expect(content).toContain('7 total QA rounds');
    expect(content).not.toContain('Task failed after 3 QA attempts');

    const task = JSON.parse(readFileSync(join(project.taskDir, 'task.json'), 'utf-8'));
    expect(task.failureReason).toBe('spec-revision-exhausted');
  });

  it('includes spec_concerns from the last QA report in the spec-revision-exhausted summary', () => {
    writeFileSync(join(project.taskDir, 'qa_report.json'), JSON.stringify({
      overall: 'FAIL',
      criteria: [{ criterion: 'X', status: 'FAIL' }],
      spec_concerns: [
        { issue: 'Calibration lever does not converge', reasoning: 'golden_zone_pct declines as weight increases', suggested_fix: 'Redesign the constraint' },
      ],
    }));

    const p = { ...pipeline(project.taskId, project.taskDir), qaRoundCount: 4, specRevision: 5 };
    (orch as AnyOrch)._ctx.writeCompletionSummary(p, 'spec-revision-exhausted');

    const content = readFileSync(join(project.taskDir, 'completion_summary.md'), 'utf-8');
    expect(content).toContain('Spec Concerns');
    expect(content).toContain('Calibration lever does not converge');
    expect(content).toContain('Redesign the constraint');
  });
});

// ── Severity cleaning regex in subtaskFeedback (runImplement) ─────────
// These tests verify the regex that transforms plan.json acceptance criteria
// into the human-readable format the engineer sees in their prompt.

describe('subtaskFeedback — severity cleaning regex', () => {
  // Regex extracted from runImplement — must match the production code exactly
  const cleanCriteria = (ac: string): string => {
    return ac
      .replace(/\s*\[QA CORRECTION:\s*/g, '[BLOCKER] ')
      .replace(/\s*\[QA ISSUE\s*(?:\((?:\w*)\))?:\s*/g, '')
      .replace(/\]$/, '');
  };

  it('transforms [QA CORRECTION: Fix X] → [BLOCKER] Fix X', () => {
    expect(cleanCriteria('[QA CORRECTION: Handle null inputs]'))
      .toBe('[BLOCKER] Handle null inputs');
  });

  it('strips [QA ISSUE: ...] prefix — severity removed', () => {
    expect(cleanCriteria('[QA ISSUE: Memory leak → Fix: Add cleanup]'))
      .toBe('Memory leak → Fix: Add cleanup');
  });

  it('strips legacy [QA ISSUE (critical): ...] prefix for backward compat', () => {
    expect(cleanCriteria('[QA ISSUE (critical): Memory leak → Fix: Add cleanup]'))
      .toBe('Memory leak → Fix: Add cleanup');
  });

  it('strips legacy [QA ISSUE (warning): ...] prefix for backward compat', () => {
    expect(cleanCriteria('[QA ISSUE (warning): Deprecated API]'))
      .toBe('Deprecated API');
  });

  it('strips legacy [QA ISSUE (suggestion): ...] prefix for backward compat', () => {
    expect(cleanCriteria('[QA ISSUE (suggestion): Add JSDoc comments]'))
      .toBe('Add JSDoc comments');
  });

  it('strips legacy [QA ISSUE (error): desc → Fix: fix] prefix for backward compat', () => {
    expect(cleanCriteria('[QA ISSUE (error): Null pointer dereference → Fix: Add null check]'))
      .toBe('Null pointer dereference → Fix: Add null check');
  });

  it('strips legacy severity regardless of label (backward compat)', () => {
    expect(cleanCriteria('[QA ISSUE (high): Performance regression → Fix: Add cache]'))
      .toBe('Performance regression → Fix: Add cache');
  });

  it('strips empty severity parens from legacy tags', () => {
    expect(cleanCriteria('[QA ISSUE (): No severity given]'))
      .toBe('No severity given');
  });

  it('passes through non-QA criteria unchanged', () => {
    expect(cleanCriteria('Feature A works correctly'))
      .toBe('Feature A works correctly');
    expect(cleanCriteria('Tests pass'))
      .toBe('Tests pass');
  });

  it('strips only trailing bracket — preserves brackets in description text', () => {
    expect(cleanCriteria('[QA ISSUE: Fix the [login] button]'))
      .toBe('Fix the [login] button');
  });

  it('handles multiple QA CORRECTION + QA ISSUE entries (backward compat)', () => {
    const input = '[QA ISSUE (critical): Fix A][QA ISSUE (warning): Fix B]';
    expect(cleanCriteria(input)).toBe('Fix A]Fix B');
  });
});
