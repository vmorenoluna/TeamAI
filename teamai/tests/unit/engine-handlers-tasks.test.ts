/**
 * Engine handlers for tasks / orchestrator / background results. Behavioural
 * assertions ported from the action-level tests (tasks-retry, tasks-background-actions,
 * tasks-restart-phase, tasks-delete-worktree), now against the handlers that take
 * `projectPath` explicitly.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';

const h = vi.hoisted(() => ({
  moveTaskToPhase: vi.fn(),
  clearPipelineStateFile: vi.fn(),
  cancelPipeline: vi.fn(),
  runTask: vi.fn(),
  resumeTask: vi.fn(),
  approveTask: vi.fn(),
  markTaskDone: vi.fn(),
  cleanupTaskArtifacts: vi.fn(),
  rejectTask: vi.fn(),
  getWorktreePath: vi.fn(),
  retryAutoMerge: vi.fn(),
  execGitQueued: vi.fn(),
  getActiveTaskIds: vi.fn(() => ['a', 'b']),
}));

vi.mock('@/lib/logger', () => ({ log: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn() }));
vi.mock('@/lib/auto-mode', () => ({ retryAutoMerge: h.retryAutoMerge }));
vi.mock('@/lib/process-manager', async () => {
  const { EventEmitter: EE } = await import('events');
  return { processManager: new EE() };
});
vi.mock('@/lib/orchestrator', () => ({
  getOrchestrator: vi.fn(() => ({
    moveTaskToPhase: h.moveTaskToPhase,
    clearPipelineStateFile: h.clearPipelineStateFile,
    cancelPipeline: h.cancelPipeline,
    runTask: h.runTask,
    resumeTask: h.resumeTask,
    approveTask: h.approveTask,
    markTaskDone: h.markTaskDone,
    cleanupTaskArtifacts: h.cleanupTaskArtifacts,
    rejectTask: h.rejectTask,
    getWorktreePath: h.getWorktreePath,
  })),
  getActiveTaskIds: h.getActiveTaskIds,
}));
vi.mock('@/lib/orchestrator/worktree-utils', () => ({
  execGitQueued: h.execGitQueued,
  removeStaleWorktreeRegistration: vi.fn(),
}));

import { tasksHandlers } from '@/engine/handlers/tasks';
import { orchestratorHandlers } from '@/engine/handlers/orchestrator';
import { backgroundHandlers } from '@/engine/handlers/background';
import { processManager } from '@/lib/process-manager';
import { TaskStore } from '@/lib/task-store';

const TEST_DIR = join(process.cwd(), '.teamai-test-engine-tasks-' + Math.random().toString(36).slice(2, 10));
const call = (name: string, params: Record<string, unknown>) =>
  tasksHandlers[`tasks.${name}`]({ projectPath: TEST_DIR, ...params }) as Promise<any>;
const flush = () => new Promise(resolve => setTimeout(resolve, 0));
const never = () => new Promise<never>(() => { /* never settles */ });

let seq = 0;
function seedTask(opts: { phase: string; events?: string[]; branch?: string; extra?: Record<string, unknown>; qaReport?: Record<string, unknown> }) {
  const slug = `task-${++seq}`;
  const taskDir = join(TEST_DIR, '.teamai', slug);
  mkdirSync(taskDir, { recursive: true });
  const now = new Date().toISOString();
  writeFileSync(join(taskDir, 'task.json'), JSON.stringify({
    id: slug, title: slug, description: 'desc', phase: opts.phase, branch: opts.branch ?? `feat/${slug}`,
    createdAt: now, updatedAt: now, ...opts.extra,
  }, null, 2));
  const phases = opts.events ?? ['backlog', 'spec', 'plan', 'implement', 'qa-review', 'failed'];
  writeFileSync(join(taskDir, 'events.jsonl'), phases.map(p => JSON.stringify({ phase: p, timestamp: now })).join('\n') + '\n');
  if (opts.qaReport) writeFileSync(join(taskDir, 'qa_report.json'), JSON.stringify(opts.qaReport));
  return { taskId: slug, taskDir };
}

type ActionResult = { operationId: string; action: string; taskId?: string; projectRoot: string; ok: boolean; error?: string };
let events: ActionResult[];
const onResult = (e: ActionResult) => events.push(e);

describe('engine task handlers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    events = [];
    mkdirSync(TEST_DIR, { recursive: true });
    (processManager as unknown as EventEmitter).on('action-result', onResult);
    h.moveTaskToPhase.mockResolvedValue(undefined);
    h.runTask.mockResolvedValue(undefined);
    h.resumeTask.mockResolvedValue(undefined);
    h.cleanupTaskArtifacts.mockResolvedValue(undefined);
    h.approveTask.mockImplementation(never);
    h.markTaskDone.mockImplementation(never);
    h.execGitQueued.mockResolvedValue('');
    h.getWorktreePath.mockReturnValue(join(TEST_DIR, 'wt'));
  });
  afterEach(() => {
    (processManager as unknown as EventEmitter).off('action-result', onResult);
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('exports every tasks.* method', () => {
    expect(Object.keys(tasksHandlers).sort()).toEqual([
      'addBlock', 'addDependency', 'approveTask', 'bulkDeleteTasks', 'checkBulkTaskWorktrees', 'checkTaskWorktree',
      'createTask', 'createTasks', 'deleteTask', 'deleteTaskWorktree', 'markTaskDone', 'moveTask', 'pauseTask',
      'playTask', 'rejectTask', 'removeBlock', 'removeDependency', 'restartCurrentPhase', 'resumeTask', 'retryTask',
      'retryTaskWithOptions', 'runTask', 'stopTask',
    ].map(n => `tasks.${n}`));
  });

  describe('retryTask', () => {
    it('snapshots qa_report.json, clears the budget and resumes at the failed phase', async () => {
      const { taskId, taskDir } = seedTask({ phase: 'failed', qaReport: { overall: 'FAIL', criteria: [{ name: 'AC-1', status: 'FAIL' }] } });
      const res = await call('retryTask', { taskId });
      expect(res.success).toBe(true);
      expect(res.operationId).toBeTruthy();
      const snapshot = JSON.parse(readFileSync(join(taskDir, 'qa_report_before_failed.json'), 'utf-8'));
      expect(snapshot.criteria[0].name).toBe('AC-1');
      expect(h.clearPipelineStateFile).toHaveBeenCalledWith(expect.stringContaining('.teamai'));
      expect(h.moveTaskToPhase).toHaveBeenCalledWith(taskId, 'qa-review');
    });

    it('does not snapshot when there is no qa_report.json', async () => {
      const { taskId, taskDir } = seedTask({ phase: 'failed' });
      expect((await call('retryTask', { taskId })).success).toBe(true);
      expect(existsSync(join(taskDir, 'qa_report_before_failed.json'))).toBe(false);
    });

    it('resumes at implement when the chain stopped there', async () => {
      const { taskId } = seedTask({ phase: 'failed', events: ['backlog', 'spec', 'plan', 'implement', 'failed'] });
      await call('retryTask', { taskId });
      expect(h.moveTaskToPhase).toHaveBeenCalledWith(taskId, 'implement');
    });

    it('resumes at spec for qa-attempts-exhausted with spec_concerns', async () => {
      const { taskId } = seedTask({
        phase: 'failed',
        extra: { failureReason: 'qa-attempts-exhausted' },
        qaReport: { overall: 'FAIL', criteria: [], spec_concerns: [{ criterion: 'AC-4', concern: 'wrong' }] },
      });
      await call('retryTask', { taskId });
      expect(h.moveTaskToPhase).toHaveBeenCalledWith(taskId, 'spec');
    });

    it('returns Task not found for an unknown task', async () => {
      expect(await call('retryTask', { taskId: 'nope' })).toEqual({ success: false, error: 'Task not found' });
      expect(h.moveTaskToPhase).not.toHaveBeenCalled();
    });

    it('rejects a task that is not failed', async () => {
      const { taskId } = seedTask({ phase: 'done' });
      expect(await call('retryTask', { taskId })).toEqual({ success: false, error: 'Task is in phase "done", not "failed"' });
    });

    it('forwards the caller-supplied operationId unchanged', async () => {
      const { taskId } = seedTask({ phase: 'failed' });
      expect((await call('retryTask', { taskId, operationId: 'op-fixed' })).operationId).toBe('op-fixed');
    });

    it('hands a stalled auto-merge back to the CI poller (AC4)', async () => {
      const { taskId } = seedTask({ phase: 'pr-open', extra: { autoMergeStalled: true } });
      expect(await call('retryTask', { taskId })).toEqual({ success: true });
      expect(h.retryAutoMerge).toHaveBeenCalledWith(TEST_DIR, taskId);
      expect(h.moveTaskToPhase).not.toHaveBeenCalled();
    });

    it('returns the auto-mode error when retryAutoMerge throws (AC4)', async () => {
      const { taskId } = seedTask({ phase: 'pr-open', extra: { autoMergeStalled: true } });
      h.retryAutoMerge.mockImplementation(() => { throw new Error('Auto mode is not enabled for this project'); });
      expect(await call('retryTask', { taskId })).toEqual({ success: false, error: 'Auto mode is not enabled for this project' });
    });
  });

  describe('retryTaskWithOptions', () => {
    it('moves to the chosen phase and clears the budget', async () => {
      const { taskId } = seedTask({ phase: 'failed' });
      const res = await call('retryTaskWithOptions', { taskId, phase: 'plan' });
      expect(res.success).toBe(true);
      expect(h.clearPipelineStateFile).toHaveBeenCalled();
      expect(h.moveTaskToPhase).toHaveBeenCalledWith(taskId, 'plan');
    });

    it('RESUME_AUTO behaves like retryTask', async () => {
      const { taskId } = seedTask({ phase: 'failed' });
      const { RESUME_AUTO } = await import('@/lib/orchestrator/artifacts');
      await call('retryTaskWithOptions', { taskId, phase: RESUME_AUTO });
      expect(h.moveTaskToPhase).toHaveBeenCalledWith(taskId, 'qa-review');
    });
  });

  describe('background reporting', () => {
    it('reports a rejected moveTaskToPhase as ok:false action-result and via background.getResult', async () => {
      const { taskId } = seedTask({ phase: 'failed' });
      h.moveTaskToPhase.mockRejectedValue(new Error('boom'));
      const res = await call('retryTask', { taskId, operationId: 'op-r' });
      await flush();
      expect(events).toEqual([
        { operationId: 'op-r', action: 'retry', taskId, projectRoot: TEST_DIR, ok: false, error: 'boom' },
      ]);
      expect(res.success).toBe(true);
      expect(await backgroundHandlers['background.getResult']({ operationId: 'op-r' })).toEqual({ status: 'failed', error: 'boom' });
    });

    it('emits nothing when failure-only work resolves; moveTask returns an operationId', async () => {
      const { taskId } = seedTask({ phase: 'failed' });
      const moved = await call('moveTask', { taskId, targetPhase: 'backlog' });
      expect(moved.operationId).toBeTruthy();
      expect(h.moveTaskToPhase).toHaveBeenCalledWith(taskId, 'backlog');
      await flush();
      expect(events).toEqual([]);
    });

    it('unknown operation ids resolve to status unknown', async () => {
      expect(await backgroundHandlers['background.getResult']({ operationId: 'never-seen' })).toEqual({ status: 'unknown' });
    });
  });

  describe('duplicate guards use the engine registry (AC6)', () => {
    it('approveTask refuses a second start while pending', async () => {
      const { taskId } = seedTask({ phase: 'awaiting-review' });
      const first = await call('approveTask', { taskId, strategy: 'pull-request' });
      expect(first.success).toBe(true);
      expect(await call('approveTask', { taskId, strategy: 'pull-request' })).toEqual({
        success: false, error: 'Approve is already in progress for this task',
      });
      expect(h.approveTask).toHaveBeenCalledTimes(1);
      expect(h.approveTask).toHaveBeenCalledWith(taskId, 'pull-request');
    });

    it('approveTask outside awaiting-review', async () => {
      const { taskId } = seedTask({ phase: 'implement' });
      expect(await call('approveTask', { taskId, strategy: 'local-merge' })).toEqual({
        success: false, error: 'Task is in phase "implement", not "awaiting-review"',
      });
    });

    it('markTaskDone refuses a second start while pending', async () => {
      const { taskId } = seedTask({ phase: 'awaiting-review' });
      expect((await call('markTaskDone', { taskId })).success).toBe(true);
      expect(await call('markTaskDone', { taskId })).toEqual({ success: false, error: 'Mark done is already in progress for this task' });
      expect(h.markTaskDone).toHaveBeenCalledTimes(1);
    });

    it('stopTask refuses a second start while its cleanup is pending', async () => {
      const { taskId } = seedTask({ phase: 'implement' });
      h.cleanupTaskArtifacts.mockImplementation(never);
      expect((await call('stopTask', { taskId })).success).toBe(true);
      expect(await call('stopTask', { taskId })).toEqual({ success: false, error: 'Stop is already in progress for this task' });
      expect(h.cancelPipeline).toHaveBeenCalledTimes(1);
    });

    it('deleteTaskWorktree refuses a second start while pending', async () => {
      const { taskId } = seedTask({ phase: 'done' });
      mkdirSync(join(TEST_DIR, 'wt'), { recursive: true });
      h.execGitQueued.mockImplementation(never);
      expect((await call('deleteTaskWorktree', { taskId })).success).toBe(true);
      expect(await call('deleteTaskWorktree', { taskId })).toEqual({
        success: false, error: 'Delete worktree is already in progress for this task',
      });
    });
  });

  describe('stopTask', () => {
    it('pauses synchronously, then moves to backlog once cleanup resolves', async () => {
      const { taskId } = seedTask({ phase: 'implement' });
      let finish!: () => void;
      h.cleanupTaskArtifacts.mockImplementation(() => new Promise<void>(r => { finish = r; }));
      const phaseChanges: unknown[] = [];
      (processManager as unknown as EventEmitter).on('phase-change', e => phaseChanges.push(e));
      await call('stopTask', { taskId, operationId: 'op-s' });
      expect(new TaskStore(TEST_DIR).getById(taskId)).toMatchObject({ phase: 'implement', isPaused: true });
      finish();
      await flush();
      expect(new TaskStore(TEST_DIR).getById(taskId)).toMatchObject({ phase: 'backlog', isPaused: false });
      expect(phaseChanges).toEqual([{ taskId, phase: 'backlog', projectRoot: TEST_DIR }]);
      expect(events).toEqual([{ operationId: 'op-s', action: 'stop', taskId, projectRoot: TEST_DIR, ok: true }]);
    });

    it('refuses to stop in a no-stop phase', async () => {
      const { taskId } = seedTask({ phase: 'done' });
      expect(await call('stopTask', { taskId })).toEqual({ success: false, error: 'Cannot stop task in "done" phase' });
    });
  });

  describe('restartCurrentPhase', () => {
    it('re-runs qa-review without re-implementing', async () => {
      const { taskId } = seedTask({ phase: 'qa-review' });
      expect((await call('restartCurrentPhase', { taskId })).success).toBe(true);
      expect(h.cancelPipeline).toHaveBeenCalledWith(taskId);
      expect(h.runTask).toHaveBeenCalledWith(taskId, 'desc', 'qa-review');
    });

    it('resets subtask completion flags for implement', async () => {
      const { taskId, taskDir } = seedTask({ phase: 'implement' });
      writeFileSync(join(taskDir, 'plan.json'), JSON.stringify({ subtasks: [{ id: 1, completed: true }, { id: 2, completed: true }] }));
      await call('restartCurrentPhase', { taskId });
      const plan = JSON.parse(readFileSync(join(taskDir, 'plan.json'), 'utf-8'));
      expect(plan.subtasks.map((s: { completed: boolean }) => s.completed)).toEqual([false, false]);
      expect(h.runTask).toHaveBeenCalledWith(taskId, 'desc', 'implement');
    });

    it('uses moveTaskToPhase for spec', async () => {
      const { taskId } = seedTask({ phase: 'spec' });
      await call('restartCurrentPhase', { taskId });
      expect(h.moveTaskToPhase).toHaveBeenCalledWith(taskId, 'spec');
    });

    it('refuses a non-restartable phase', async () => {
      const { taskId } = seedTask({ phase: 'done' });
      expect(await call('restartCurrentPhase', { taskId })).toEqual({ success: false, error: 'Cannot restart task in "done" phase' });
    });
  });

  describe('deleteTaskWorktree', () => {
    it('reports missing branch / missing directory / project-root', async () => {
      const noBranch = seedTask({ phase: 'done', branch: '' });
      expect(await call('deleteTaskWorktree', { taskId: noBranch.taskId })).toEqual({ success: false, error: 'No branch found for this task' });

      const { taskId } = seedTask({ phase: 'done' });
      h.getWorktreePath.mockReturnValue(join(TEST_DIR, 'missing'));
      expect(await call('deleteTaskWorktree', { taskId })).toEqual({ success: false, error: 'Worktree directory not found on disk' });

      h.getWorktreePath.mockReturnValue(TEST_DIR);
      expect((await call('deleteTaskWorktree', { taskId })).error).toMatch(/^Refusing to delete worktree at project root/);
    });

    it('removes the worktree, clears the branch and emits ok:true', async () => {
      const { taskId } = seedTask({ phase: 'done' });
      mkdirSync(join(TEST_DIR, 'wt'), { recursive: true });
      await call('deleteTaskWorktree', { taskId, operationId: 'op-d' });
      await flush();
      expect(h.execGitQueued).toHaveBeenCalledWith(['worktree', 'remove', join(TEST_DIR, 'wt')], TEST_DIR, TEST_DIR);
      expect(new TaskStore(TEST_DIR).getById(taskId)?.branch).toBeUndefined();
      expect(events).toEqual([{ operationId: 'op-d', action: 'delete-worktree', taskId, projectRoot: TEST_DIR, ok: true }]);
    });

    it('checkTaskWorktree / checkBulkTaskWorktrees report existence', async () => {
      const { taskId } = seedTask({ phase: 'done' });
      mkdirSync(join(TEST_DIR, 'wt'), { recursive: true });
      expect(await call('checkTaskWorktree', { taskId })).toEqual({ exists: true, path: join(TEST_DIR, 'wt') });
      expect(await call('checkBulkTaskWorktrees', { taskIds: [taskId, 'nope'] })).toEqual({ [taskId]: true, nope: false });
    });
  });

  describe('pause / resume / play / run', () => {
    it('pauseTask then resumeTask round-trips the paused flag', async () => {
      const { taskId } = seedTask({ phase: 'implement' });
      expect(await call('pauseTask', { taskId })).toEqual({ success: true });
      expect(await call('pauseTask', { taskId })).toEqual({ success: false, error: 'Task is already paused' });
      const res = await call('resumeTask', { taskId });
      expect(res.success).toBe(true);
      expect(h.moveTaskToPhase).toHaveBeenCalledWith(taskId, 'implement');
      expect(await call('resumeTask', { taskId })).toEqual({ success: false, error: 'Task is not paused' });
    });

    it('playTask only starts backlog tasks', async () => {
      const a = seedTask({ phase: 'backlog' });
      expect((await call('playTask', { taskId: a.taskId })).success).toBe(true);
      expect(h.resumeTask).toHaveBeenCalledWith(a.taskId);
      const b = seedTask({ phase: 'plan' });
      expect(await call('playTask', { taskId: b.taskId })).toEqual({ success: false, error: 'Task is in "plan" phase, not "backlog"' });
    });

    it('runTask throws for an unknown task', async () => {
      await expect(call('runTask', { taskId: 'nope' })).rejects.toThrow('Task nope not found');
    });
  });

  describe('rejectTask / CRUD / dependencies', () => {
    it('rejectTask throws on an invalid target and forwards a valid one', async () => {
      await expect(call('rejectTask', { taskId: 't', feedback: 'f', target: 'bogus' })).rejects.toThrow('Invalid feedback target: bogus');
      await call('rejectTask', { taskId: 't', feedback: 'f', target: 'analyst', subtaskIds: [1] });
      expect(h.rejectTask).toHaveBeenCalledWith('t', 'f', 'analyst', [1]);
    });

    it('createTask validates taskType; createTasks keeps ids and fields; delete variants remove them', async () => {
      const { id } = await call('createTask', { title: 'T', description: 'D', taskType: ' FIX ' });
      const store = new TaskStore(TEST_DIR);
      expect(store.getById(id)).toMatchObject({ title: 'T', description: 'D' });
      const { ids } = await call('createTasks', {
        tasks: [
          { id: 'i1', title: 'One', description: 'd1', source: 'github', competitive_context: 'cc' },
          { id: 'i2', title: 'Two', description: 'd2' },
        ],
      });
      expect(ids).toEqual(['i1', 'i2']);
      expect(store.getById('i1')).toMatchObject({ title: 'One', description: 'd1' });
      await call('deleteTask', { taskId: id });
      expect(store.getById(id)).toBeFalsy();
      await call('bulkDeleteTasks', { taskIds: ['i1', 'missing', 'i2'] });
      expect(store.getById('i1')).toBeFalsy();
      expect(store.getById('i2')).toBeFalsy();
    });

    it('dependency and block helpers edit dependencies', async () => {
      const a = seedTask({ phase: 'backlog' });
      const b = seedTask({ phase: 'backlog' });
      const store = new TaskStore(TEST_DIR);
      await call('addDependency', { taskId: a.taskId, depId: b.taskId });
      expect(store.getById(a.taskId)?.dependencies).toEqual([b.taskId]);
      await call('removeDependency', { taskId: a.taskId, depId: b.taskId });
      expect(store.getById(a.taskId)?.dependencies).toEqual([]);
      await call('addBlock', { thisTaskId: a.taskId, blockedTaskId: b.taskId });
      expect(store.getById(b.taskId)?.dependencies).toEqual([a.taskId]);
      await call('removeBlock', { thisTaskId: a.taskId, blockedTaskId: b.taskId });
      expect(store.getById(b.taskId)?.dependencies).toEqual([]);
    });
  });

  it('orchestrator.getActiveTaskIds returns the orchestrator ids', async () => {
    expect(await orchestratorHandlers['orchestrator.getActiveTaskIds']({ projectPath: TEST_DIR })).toEqual(['a', 'b']);
  });
});
