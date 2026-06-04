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

    (orch as AnyOrch)._writeQaFeedback(pipeline(project.taskId, project.taskDir), report);

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

    (orch as AnyOrch)._writeQaFeedback(pipeline(project.taskId, project.taskDir), report);

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

    (orch as AnyOrch)._writeQaFeedback(pipeline(project.taskId, project.taskDir), report);

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

    (orch as AnyOrch)._writeQaFeedback(pipeline(project.taskId, project.taskDir), report);

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

    (orch as AnyOrch)._writeQaFeedback(pipeline(project.taskId, project.taskDir), report);

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

    (orch as AnyOrch)._writeQaFeedback(pipeline(project.taskId, project.taskDir), report);

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

    (orch as AnyOrch)._writeQaFeedback(pipeline(project.taskId, project.taskDir), report);

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

    expect(() => (orch as AnyOrch)._writeQaFeedback(pipeline(project.taskId, project.taskDir), report)).not.toThrow();

    const feedbackPath = join(project.taskDir, 'qa_feedback.md');
    expect(existsSync(feedbackPath)).toBe(true);
  });

  it('handles empty criteria gracefully', () => {
    const report = {
      overall: 'FAIL',
      criteria: [],
    };

    (orch as AnyOrch)._writeQaFeedback(pipeline(project.taskId, project.taskDir), report);

    const feedbackPath = join(project.taskDir, 'qa_feedback.md');
    const content = readFileSync(feedbackPath, 'utf-8');
    expect(content).toContain('Overall: FAIL');
    expect(content).toContain('QA Feedback');
  });

  // ── Severity embedded in plan.json patch tags ──────────────────────

  it('embeds critical severity in [QA ISSUE (critical): ...] patch tag', () => {
    const report = {
      overall: 'FAIL',
      additional_issues: [
        { severity: 'critical', description: 'Memory leak', file: 'src/featureA.ts', fix_needed: 'Add cleanup' },
      ],
    };

    (orch as AnyOrch)._writeQaFeedback(pipeline(project.taskId, project.taskDir), report);

    const planPath = join(project.taskDir, 'plan.json');
    const plan = JSON.parse(readFileSync(planPath, 'utf-8'));
    const subtaskA = plan.subtasks.find((s: any) => s.id === 1);
    expect(subtaskA.acceptance_criteria.some((ac: string) =>
      ac === '[QA ISSUE (critical): Memory leak → Fix: Add cleanup]'
    )).toBe(true);
    expect(subtaskA.qa_flagged).toBe(true);
  });

  it('embeds warning severity in [QA ISSUE (warning): ...] patch tag', () => {
    const report = {
      overall: 'FAIL',
      additional_issues: [
        { severity: 'warning', description: 'Deprecated API', file: 'src/featureB.ts' },
      ],
    };

    (orch as AnyOrch)._writeQaFeedback(pipeline(project.taskId, project.taskDir), report);

    const planPath = join(project.taskDir, 'plan.json');
    const plan = JSON.parse(readFileSync(planPath, 'utf-8'));
    const subtaskB = plan.subtasks.find((s: any) => s.id === 2);
    expect(subtaskB.acceptance_criteria.some((ac: string) =>
      ac === '[QA ISSUE (warning): Deprecated API]'
    )).toBe(true);
    expect(subtaskB.qa_flagged).toBe(true);
  });

  it('embeds suggestion severity in [QA ISSUE (suggestion): ...] patch tag', () => {
    const report = {
      overall: 'FAIL',
      additional_issues: [
        { severity: 'suggestion', description: 'Add JSDoc comments', file: 'src/featureA.ts' },
      ],
    };

    (orch as AnyOrch)._writeQaFeedback(pipeline(project.taskId, project.taskDir), report);

    const planPath = join(project.taskDir, 'plan.json');
    const plan = JSON.parse(readFileSync(planPath, 'utf-8'));
    const subtaskA = plan.subtasks.find((s: any) => s.id === 1);
    expect(subtaskA.acceptance_criteria.some((ac: string) =>
      ac === '[QA ISSUE (suggestion): Add JSDoc comments]'
    )).toBe(true);
  });

  it('embeds error severity (newly added) in [QA ISSUE (error): ...] patch tag', () => {
    const report = {
      overall: 'FAIL',
      additional_issues: [
        { severity: 'error', description: 'Null pointer dereference', file: 'src/featureA.ts', fix_needed: 'Add null check' },
      ],
    };

    (orch as AnyOrch)._writeQaFeedback(pipeline(project.taskId, project.taskDir), report);

    const planPath = join(project.taskDir, 'plan.json');
    const plan = JSON.parse(readFileSync(planPath, 'utf-8'));
    const subtaskA = plan.subtasks.find((s: any) => s.id === 1);
    expect(subtaskA.acceptance_criteria.some((ac: string) =>
      ac === '[QA ISSUE (error): Null pointer dereference → Fix: Add null check]'
    )).toBe(true);
    expect(subtaskA.qa_flagged).toBe(true);
  });

  it('falls back to unknown severity when severity is missing from additional_issues', () => {
    const report = {
      overall: 'FAIL',
      additional_issues: [
        { description: 'No severity specified', file: 'src/featureA.ts' },
      ],
    };

    (orch as AnyOrch)._writeQaFeedback(pipeline(project.taskId, project.taskDir), report);

    const planPath = join(project.taskDir, 'plan.json');
    const plan = JSON.parse(readFileSync(planPath, 'utf-8'));
    const subtaskA = plan.subtasks.find((s: any) => s.id === 1);
    expect(subtaskA.acceptance_criteria.some((ac: string) =>
      ac.includes('[QA ISSUE (unknown)')
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

    (orch as AnyOrch)._writeCompletionSummary(pipeline(project.taskId, project.taskDir));

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

    (orch as AnyOrch)._writeCompletionSummary(pipeline(project.taskId, project.taskDir));

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

    (orch as AnyOrch)._writeCompletionSummary(pipeline(project.taskId, project.taskDir));

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

    (orch as AnyOrch)._writeCompletionSummary(pipeline(project.taskId, project.taskDir));

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

    (orch as AnyOrch)._writeCompletionSummary(pipeline(project.taskId, project.taskDir));

    const taskPath = join(project.taskDir, 'task.json');
    const task = JSON.parse(readFileSync(taskPath, 'utf-8'));
    expect(task.completionSummary).toBeDefined();
    expect(task.completionSummary).toContain('3 QA attempts');
  });

  it('does not crash when qa_report.json is missing', () => {
    expect(() => (orch as AnyOrch)._writeCompletionSummary(pipeline(project.taskId, project.taskDir))).not.toThrow();

    const summaryPath = join(project.taskDir, 'completion_summary.md');
    expect(existsSync(summaryPath)).toBe(true);
    const content = readFileSync(summaryPath, 'utf-8');
    expect(content).toContain('3 QA attempts');
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
      .replace(/\s*\[QA ISSUE\s*\((\w*)\):\s*/g, '[$1] ')
      .replace(/\]$/, '');
  };

  it('transforms [QA CORRECTION: Fix X] → [BLOCKER] Fix X', () => {
    expect(cleanCriteria('[QA CORRECTION: Handle null inputs]'))
      .toBe('[BLOCKER] Handle null inputs');
  });

  it('transforms [QA ISSUE (critical): desc → Fix: fix] → [critical] desc → Fix: fix', () => {
    expect(cleanCriteria('[QA ISSUE (critical): Memory leak → Fix: Add cleanup]'))
      .toBe('[critical] Memory leak → Fix: Add cleanup');
  });

  it('transforms [QA ISSUE (warning): desc] → [warning] desc', () => {
    expect(cleanCriteria('[QA ISSUE (warning): Deprecated API]'))
      .toBe('[warning] Deprecated API');
  });

  it('transforms [QA ISSUE (suggestion): desc] → [suggestion] desc', () => {
    expect(cleanCriteria('[QA ISSUE (suggestion): Add JSDoc comments]'))
      .toBe('[suggestion] Add JSDoc comments');
  });

  it('transforms [QA ISSUE (error): desc → Fix: fix] → [error] desc → Fix: fix', () => {
    expect(cleanCriteria('[QA ISSUE (error): Null pointer dereference → Fix: Add null check]'))
      .toBe('[error] Null pointer dereference → Fix: Add null check');
  });

  it('handles unknown severity gracefully (e.g. custom severity from QA agent)', () => {
    // The regex captures any \w* word — even non-standard severities
    expect(cleanCriteria('[QA ISSUE (high): Performance regression → Fix: Add cache]'))
      .toBe('[high] Performance regression → Fix: Add cache');
  });

  it('handles missing/empty severity — produces [] prefix', () => {
    // \w* allows zero-length match — empty parens produce empty bracket tag
    expect(cleanCriteria('[QA ISSUE (): No severity given]'))
      .toBe('[] No severity given');
  });

  it('passes through non-QA criteria unchanged', () => {
    expect(cleanCriteria('Feature A works correctly'))
      .toBe('Feature A works correctly');
    expect(cleanCriteria('Tests pass'))
      .toBe('Tests pass');
  });

  it('strips only trailing bracket — preserves brackets in description text', () => {
    expect(cleanCriteria('[QA ISSUE (critical): Fix the [login] button]'))
      .toBe('[critical] Fix the [login] button');
  });

  it('handles multiple QA CORRECTION + QA ISSUE entries in the same criteria string', () => {
    // In practice each criteria entry is a single tag, but the regex is applied
    // per-string with /g flag. The closing bracket from the first tag is preserved
    // (only the last ] is stripped) — this is expected since plan.json stores tags
    // as separate array elements, not concatenated strings.
    const input = '[QA ISSUE (critical): Fix A][QA ISSUE (warning): Fix B]';
    expect(cleanCriteria(input)).toBe('[critical] Fix A][warning] Fix B');
  });
});
