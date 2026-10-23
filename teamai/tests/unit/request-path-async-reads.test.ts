/**
 * The request path (server actions that feed page renders and refreshes) must
 * not touch the task store or task artifacts with synchronous fs calls.
 *
 *   AC4: pass-through spies on fs.readFileSync/readdirSync/existsSync/statSync/
 *        lstatSync see no call for a path under <project>/.teamai/ or
 *        <project>/.claude/roles/ while the read actions run. The Role
 *        Refinement config and suggestion store (.teamai/role-refinement.json,
 *        .teamai/role-refinements/) are deliberately still synchronous
 *        (deferred) and are the only allowed paths.
 *   AC5: the converted reads yield the same task data as before the change.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';

const h = vi.hoisted(() => ({
  spies: {} as Record<string, import('vitest').Mock>,
}));

// Pass-through spies over the sync fs reads; fs/promises stays real.
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  const wrapped: Record<string, unknown> = {};
  for (const name of ['readFileSync', 'readdirSync', 'existsSync', 'statSync', 'lstatSync'] as const) {
    const spy = vi.fn((...args: unknown[]) => (actual[name] as (...a: unknown[]) => unknown)(...args));
    h.spies[name] = spy;
    wrapped[name] = spy;
  }
  const patched = { ...actual, ...wrapped };
  return { ...patched, default: patched };
});

let mockProjectPath = '/test/project';

vi.mock('next/headers', () => ({
  cookies: vi.fn(async () => ({
    get: vi.fn((name: string) => (name === 'activeProject' ? { value: mockProjectPath } : undefined)),
    set: vi.fn(),
    delete: vi.fn(),
  })),
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/process-manager', () => ({
  processManager: {
    on: vi.fn().mockReturnThis(), off: vi.fn().mockReturnThis(), emit: vi.fn(),
    sendMessage: vi.fn(), killSession: vi.fn(), createSession: vi.fn(), getSession: vi.fn(),
    getStaleSessions: vi.fn(() => []),
  },
  containerSessionOpts: (projectRoot: string) => ({ projectRoot, permissionMode: 'bypassPermissions' as const }),
}));
vi.mock('@/lib/logger', () => ({ log: vi.fn(), warn: vi.fn(), error: vi.fn() }));
vi.mock('@/engine/engine-client', () => ({ engineCall: vi.fn(async () => []) }));
vi.mock('@/lib/orchestrator', () => ({
  detectDefaultBranch: vi.fn(async () => 'main'),
}));

import { mkdirSync, rmSync, writeFileSync, existsSync } from 'fs';
import { join, resolve, sep } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import {
  getTasks, getTask, getTaskEvents, getTaskArtifacts, getTaskFull,
} from '@/app/actions/tasks';
import { getWorkflowTasks } from '@/app/actions/workflow';
import { engineCall } from '@/engine/engine-client';
import { getAnalytics } from '@/app/actions/analytics';
import { getTaskReferences } from '@/app/actions/references';

const ID_A = 'task-a';
const ID_B = 'task-b';

const PLAN_A = {
  subtasks: [
    { id: 1, title: 'First', description: 'd', files: ['a.ts'], acceptance_criteria: ['x'], depends_on: [], completed: true },
    { id: 2, title: 'Second', description: 'd', files: ['b.ts'], acceptance_criteria: ['y'], depends_on: [1], completed: true },
    { id: 3, title: 'Third', description: 'd', files: ['c.ts'], acceptance_criteria: ['z'], depends_on: [2], completed: false },
  ],
};
const PLAN_B = {
  subtasks: [{ id: 1, title: 'Only', description: 'd', files: ['a.ts'], acceptance_criteria: ['x'], depends_on: [], completed: false }],
};
const QA_REPORT = { overall: 'PASS', criteria: [{ name: 'c1', result: 'PASS' }], additional_issues: [] };
const REASON = 'Spec phase produced no spec_summary.md';
const SESSION_MAP = { st1: 'sess-1', qa: 'sess-qa' };
const CODER_ROLE = '# Coder\nWrite boring code.\n';

let root: string;
let dirA: string;
let dirB: string;

function ev(phase: string, extra: Record<string, unknown> = {}) {
  return JSON.stringify({ phase, timestamp: '2026-01-01T00:00:00.000Z', ...extra });
}

function writeTask(dir: string, task: Record<string, unknown>) {
  mkdirSync(dir, { recursive: true });
  const now = '2026-01-01T00:00:00.000Z';
  writeFileSync(join(dir, 'task.json'), JSON.stringify({
    title: String(task.id), description: 'fixture', createdAt: now, updatedAt: now, ...task,
  }));
}

function buildFixture() {
  root = join(tmpdir(), `teamai-async-reads-${randomUUID().slice(0, 8)}`);
  mkdirSync(root, { recursive: true });
  dirA = join(root, '.teamai', 'task-a-slug');
  dirB = join(root, '.teamai', 'task-b-slug');

  // Task A: awaiting-review with a reason only in events.jsonl, two spec
  // snapshots-worth of history, per-subtask log, references, session map.
  writeTask(dirA, { id: ID_A, phase: 'awaiting-review', dependencies: [ID_B] });
  writeFileSync(join(dirA, 'plan.json'), JSON.stringify(PLAN_A));
  writeFileSync(join(dirA, 'events.jsonl'),
    [ev('backlog'), ev('spec'), ev('plan'), ev('implement'), ev('qa-review'), ev('awaiting-review', { awaitingReviewReason: REASON })].join('\n') + '\n');
  writeFileSync(join(dirA, 'qa_report.json'), JSON.stringify(QA_REPORT));
  writeFileSync(join(dirA, 'spec.md'), '# Spec live\n');
  writeFileSync(join(dirA, 'spec_v1.md'), '# Spec v1\n');
  writeFileSync(join(dirA, 'output.log'), 'agent output\n');
  writeFileSync(join(dirA, 'output-st1.log'), 'st1 log\n');
  writeFileSync(join(dirA, 'session_map.json'), JSON.stringify(SESSION_MAP));
  mkdirSync(join(dirA, 'references'), { recursive: true });
  writeFileSync(join(dirA, 'references', 'ref-b.png'), 'png');
  writeFileSync(join(dirA, 'references', 'ref-a.jpg'), 'jpg');
  writeFileSync(join(dirA, 'references', 'notes.txt'), 'not an image');

  // Task B: live spec identical to its highest snapshot (legacy copy scheme).
  writeTask(dirB, { id: ID_B, phase: 'implement' });
  writeFileSync(join(dirB, 'plan.json'), JSON.stringify(PLAN_B));
  writeFileSync(join(dirB, 'events.jsonl'), [ev('backlog'), ev('spec'), ev('plan'), ev('implement')].join('\n') + '\n');
  writeFileSync(join(dirB, 'spec.md'), '# Spec same\n');
  writeFileSync(join(dirB, 'spec_v1.md'), '# Spec same\n');
  writeFileSync(join(dirB, 'output.log'), 'b output\n');
  writeFileSync(join(dirB, 'output-st1.log'), 'b st1 log\n');
  writeFileSync(join(dirB, 'session_map.json'), '{}');

  mkdirSync(join(root, '.claude', 'roles'), { recursive: true });
  writeFileSync(join(root, '.claude', 'roles', 'coder.md'), CODER_ROLE);
  writeFileSync(join(root, '.claude', 'roles', 'README.txt'), 'ignored');
  mockProjectPath = root;
}

beforeAll(buildFixture);

afterAll(() => {
  if (root && existsSync(root)) rmSync(root, { recursive: true, force: true });
});

function spyCalls(): Array<{ fn: string; path: string }> {
  const calls: Array<{ fn: string; path: string }> = [];
  for (const [fn, spy] of Object.entries(h.spies)) {
    for (const args of spy.mock.calls) {
      if (typeof args[0] === 'string') calls.push({ fn, path: resolve(args[0]) });
      else if (args[0] instanceof URL) calls.push({ fn, path: resolve(args[0].pathname) });
    }
  }
  return calls;
}

describe('request-path reads use fs/promises (AC4)', () => {
  it('makes no sync fs call under .teamai/ or .claude/roles/ outside the deferred role-refinement store', async () => {
    for (const spy of Object.values(h.spies)) spy.mockClear();

    await getTasks();
    await getTask(ID_A);
    await getTaskEvents(ID_A);
    await getTaskArtifacts(ID_A);
    await getTaskFull(ID_A);
    await getWorkflowTasks();
    await getAnalytics();
    await getTaskReferences(ID_A);

    const teamaiDir = join(resolve(root), '.teamai') + sep;
    const rolesDir = join(resolve(root), '.claude', 'roles');
    const deferred = [
      join(resolve(root), '.teamai', 'role-refinements'),
      join(resolve(root), '.teamai', 'role-refinement.json'),
    ];
    const isDeferred = (p: string) => deferred.some(d => p === d || p.startsWith(d + sep));

    const calls = spyCalls();
    // Wiring: the spies are live (getTaskFull reads the deferred refinement store synchronously).
    expect(calls.length).toBeGreaterThan(0);

    const offenders = calls.filter(c =>
      (c.path.startsWith(teamaiDir) || c.path === rolesDir || c.path.startsWith(rolesDir + sep)) && !isDeferred(c.path));
    expect(offenders).toEqual([]);
  }, 30_000);
});

describe('request-path reads return unchanged results (AC5)', () => {
  it('getTasks enriches each task with subtaskProgress from plan.json', async () => {
    const tasks = await getTasks();
    expect(tasks).toHaveLength(2);
    expect(tasks.find(t => t.id === ID_A)?.subtaskProgress).toEqual({ completed: 2, total: 3 });
    expect(tasks.find(t => t.id === ID_B)?.subtaskProgress).toEqual({ completed: 0, total: 1 });
  }, 30_000);

  it('getTaskFull assembles plan, logs, spec versions, session map, role files and review reason', async () => {
    const full = await getTaskFull(ID_A);

    expect(full.task.id).toBe(ID_A);
    expect(full.allTasks.map(t => t.id).sort()).toEqual([ID_A, ID_B]);
    expect(full.dependencies.map(t => t.id)).toEqual([ID_B]);
    expect(full.dependents).toEqual([]);
    expect(full.spec).toBe('# Spec live\n');
    expect(full.plan).toEqual(PLAN_A);
    expect(full.qaReport).toEqual(QA_REPORT);
    expect(full.humanFeedback).toBeNull();
    expect(full.diff).toBeNull();
    expect(full.agentOutput).toBe('agent output\n');
    expect(full.subtaskTerminals).toEqual([{ id: 1, title: 'First', log: 'st1 log\n' }]);
    expect(full.qaLog).toBeNull();
    expect(full.specLog).toBeNull();
    expect(full.planLog).toBeNull();
    expect(full.mergeLog).toBeNull();
    // Live spec differs from the highest snapshot (v1), so it surfaces as v2.
    expect(full.specVersions).toEqual({ v1: '# Spec v1\n', v2: '# Spec live\n' });
    expect(full.sessionMap).toEqual(SESSION_MAP);
    expect(full.specPath).toBe(join(dirA, 'spec.md'));
    expect(full.awaitingReviewReason).toBe(REASON);
    expect(full.roleFiles).toEqual({ 'coder.md': CODER_ROLE });
    expect(full.refinementMode).toBe('manual');
    expect(full.refinementSuggestion).toBeNull();
    expect(full.refinementSuggestions).toEqual([]);
  }, 30_000);

  it('getTaskFull collapses a live spec equal to the highest snapshot into that version', async () => {
    const full = await getTaskFull(ID_B);

    expect(full.specVersions).toEqual({ v1: '# Spec same\n' });
    expect(full.dependents.map(t => t.id)).toEqual([ID_A]);
    expect(full.awaitingReviewReason).toBeNull();
    expect(full.subtaskTerminals).toEqual([{ id: 1, title: 'Only', log: 'b st1 log\n' }]);
    expect(full.sessionMap).toEqual({});
  }, 30_000);

  it('getTaskReferences lists only image files, sorted', async () => {
    await expect(getTaskReferences(ID_A)).resolves.toEqual(['ref-a.jpg', 'ref-b.png']);
    await expect(getTaskReferences(ID_B)).resolves.toEqual([]);
  }, 30_000);
});

describe('getWorkflowTasks — activity comes from the engine', () => {
  it('asks the engine for active task ids with a 5000 ms timeout and marks those tasks active', async () => {
    vi.mocked(engineCall).mockResolvedValueOnce([ID_A]);

    const tasks = await getWorkflowTasks();

    expect(engineCall).toHaveBeenLastCalledWith('orchestrator.getActiveTaskIds', [{ projectPath: root }], { timeoutMs: 5000 });
    expect(tasks.find(t => t.task.id === ID_A)?.isActive).toBe(true);
    expect(tasks.find(t => t.task.id === ID_B)?.isActive).toBe(false);
  }, 30_000);

  it('reports every task idle when the engine call fails or times out', async () => {
    vi.mocked(engineCall).mockRejectedValueOnce(new Error('Engine call timed out'));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const tasks = await getWorkflowTasks();

    expect(tasks).toHaveLength(2);
    expect(tasks.every(t => t.isActive === false)).toBe(true);
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  }, 30_000);
});
