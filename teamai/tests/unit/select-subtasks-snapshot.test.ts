// @vitest-environment node

/**
 * Tests the human_feedback_before_bounce.md snapshot in selectSubtasks:
 * a failed snapshot write must warn (not swallow).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';

const { mockWarn, mockWriteFileSync, mockExecFileSync } = vi.hoisted(() => ({
  mockWarn: vi.fn(),
  mockWriteFileSync: vi.fn(),
  mockExecFileSync: vi.fn(),
}));

vi.mock('child_process', () => ({
  execFile: vi.fn(),
  execFileSync: mockExecFileSync,
}));

vi.mock('../../src/lib/logger', () => ({
  log: vi.fn(),
  warn: mockWarn,
  error: vi.fn(),
  info: vi.fn(),
}));

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

// Override only writeFileSync with a controllable mock that defaults to the
// real implementation, so plan.json/human_feedback.md setup writes land on disk.
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  const realWrite = actual.writeFileSync;
  (mockWriteFileSync as unknown as { mockImplementation: (f: (...a: unknown[]) => void) => void })
    .mockImplementation((...args: unknown[]) => realWrite(...(args as Parameters<typeof realWrite>)));
  return { ...actual, writeFileSync: mockWriteFileSync };
});

import { selectSubtasks, selectReworkTargets } from '../../src/lib/orchestrator/implement';
import type { PlanSubtask } from '../../src/lib/orchestrator/types';
import { writeFileSync } from 'fs';

// ── Helpers ──

function setup() {
  const root = join(tmpdir(), `teamai-select-subtasks-${randomUUID().slice(0, 8)}`);
  const specPath = join(root, 'task-slug');
  mkdirSync(specPath, { recursive: true });

  writeFileSync(join(specPath, 'plan.json'), JSON.stringify({
    subtasks: [
      { id: 1, title: 'S1', description: '', files: ['src/a.ts'], acceptance_criteria: ['A works'], depends_on: [] },
    ],
  }));
  writeFileSync(join(specPath, 'human_feedback.md'), '# Feedback');

  return { root, specPath };
}

function pipeline(specPath: string) {
  return {
    taskId: 't1',
    description: 'd',
    phase: 'implement',
    specPath,
    worktreePath: join(specPath, '..', 'wt'),
    branch: 'feat/test',
    qaAttempt: 0,
    maxQaAttempts: 3,
  };
}

// ── Tests ──

describe('selectSubtasks — human_feedback_before_bounce.md snapshot', () => {
  let ctx: ReturnType<typeof setup>;

  beforeEach(() => {
    vi.clearAllMocks();
    ctx = setup();
  });

  afterEach(() => {
    try { rmSync(ctx.root, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  it('snapshots human_feedback.md when absent', () => {
    selectSubtasks(pipeline(ctx.specPath) as never);
    expect(existsSync(join(ctx.specPath, 'human_feedback_before_bounce.md'))).toBe(true);
    expect(mockWarn).not.toHaveBeenCalled();
  });

  it('warns (does not throw) when the snapshot write fails', () => {
    mockWriteFileSync.mockImplementationOnce(() => { throw new Error('disk full'); });

    expect(() => selectSubtasks(pipeline(ctx.specPath) as never)).not.toThrow();

    expect(mockWarn).toHaveBeenCalledWith(
      'implement',
      expect.stringContaining('Failed to snapshot human feedback'),
      expect.anything(),
    );
  });

  it('warns (does not throw) when the synthesized QA-rework subtask persist fails', () => {
    // Trigger the synthesized 9999 path: qa_feedback.md present + no
    // qa_flagged subtasks. Drop human_feedback.md so its snapshot write
    // (the only other writeFileSync in selectSubtasks) doesn't run first.
    rmSync(join(ctx.specPath, 'human_feedback.md'));
    writeFileSync(join(ctx.specPath, 'qa_feedback.md'), '# QA feedback');

    mockWriteFileSync.mockImplementationOnce(() => { throw new Error('disk full'); });

    expect(() => selectSubtasks(pipeline(ctx.specPath) as never)).not.toThrow();

    expect(mockWarn).toHaveBeenCalledWith(
      'implement',
      expect.stringContaining('Failed to persist synthesized QA-rework subtask'),
      expect.anything(),
    );
  });

  it('marks coder-targeted subtasks incomplete so a reject re-runs them (G2)', () => {
    // All subtasks already complete — a plain reject would previously hit
    // the [SKIP] branch and the comment would never reach the coder.
    writeFileSync(join(ctx.specPath, 'plan.json'), JSON.stringify({
      subtasks: [
        { id: 1, title: 'Auth', description: 'auth module', files: ['src/auth.ts'], acceptance_criteria: ['Auth works'], depends_on: [], completed: true },
        { id: 2, title: 'UI', description: 'ui', files: ['src/ui.ts'], acceptance_criteria: ['UI works'], depends_on: [], completed: true },
      ],
    }));
    writeFileSync(join(ctx.specPath, 'human_feedback.md'),
      '# Human Review Feedback\nTarget: coder\n\nFix the auth module\n');

    const selection = selectSubtasks(pipeline(ctx.specPath) as never);
    const ids = selection.effectiveSubtasks.map(s => s.id);
    expect(ids).toContain(1);
    expect(ids).not.toContain(2);
  });

  it('re-runs only the explicitly selected subtasks (overrides keyword match)', () => {
    writeFileSync(join(ctx.specPath, 'plan.json'), JSON.stringify({
      subtasks: [
        { id: 1, title: 'Auth', description: 'auth module', files: ['src/auth.ts'], acceptance_criteria: ['Auth works'], depends_on: [], completed: true },
        { id: 2, title: 'UI', description: 'ui', files: ['src/ui.ts'], acceptance_criteria: ['UI works'], depends_on: [], completed: true },
        { id: 3, title: 'API', description: 'api', files: ['src/api.ts'], acceptance_criteria: ['API works'], depends_on: [], completed: true },
      ],
    }));
    // The message would keyword-match subtask 1, but the explicit selection wins.
    writeFileSync(join(ctx.specPath, 'human_feedback.md'),
      '# Human Review Feedback\nTarget: coder\nSubtasks: 3\n\nFix the auth module\n');

    const selection = selectSubtasks(pipeline(ctx.specPath) as never);
    expect(selection.effectiveSubtasks.map(s => s.id)).toEqual([3]);
  });

  it('re-runs the explicit selection over a stale qa_flagged set', () => {
    writeFileSync(join(ctx.specPath, 'plan.json'), JSON.stringify({
      subtasks: [
        { id: 1, title: 'Auth', description: 'auth module', files: ['src/auth.ts'], acceptance_criteria: ['Auth works'], depends_on: [], completed: true, qa_flagged: true },
        { id: 2, title: 'UI', description: 'ui', files: ['src/ui.ts'], acceptance_criteria: ['UI works'], depends_on: [], completed: true },
      ],
    }));
    writeFileSync(join(ctx.specPath, 'qa_feedback.md'), '# stale QA feedback');
    writeFileSync(join(ctx.specPath, 'human_feedback.md'),
      '# Human Review Feedback\nTarget: coder\nSubtasks: 2\n\nRework the UI\n');

    const selection = selectSubtasks(pipeline(ctx.specPath) as never);
    expect(selection.effectiveSubtasks.map(s => s.id)).toEqual([2]);
  });
});

describe('selectReworkTargets', () => {
  const subtasks: PlanSubtask[] = [
    { id: 1, title: 'Auth', description: 'auth module', files: ['src/auth.ts'], acceptance_criteria: ['Auth works'], depends_on: [] },
    { id: 2, title: 'UI', description: 'ui', files: ['src/ui.ts'], acceptance_criteria: ['UI works'], depends_on: [] },
  ];

  it('returns matching subtask ids by keyword', () => {
    expect(selectReworkTargets(subtasks, 'Fix the auth module')).toEqual([1]);
  });

  it('falls back to all subtasks when nothing matches', () => {
    expect(selectReworkTargets(subtasks, 'Refactor everything')).toEqual([1, 2]);
  });
});
