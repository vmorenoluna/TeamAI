// @vitest-environment node

/**
 * Agent command delivery — how a work mode's instructions reach the agent.
 *
 * Complements agent-prompt-routing.test.ts (which pins WHICH mode each
 * pipeline state selects):
 *   - instructions are rendered from TeamAI's own shipped templates, never
 *     from whatever `.claude/commands/` the session's cwd happens to hold —
 *     a task worktree carries its branch's committed copy, which can be stale
 *     or lack a command entirely (e.g. a task already in flight when TeamAI
 *     was upgraded);
 *   - each mode gets only its own workflow: a fresh spec/plan/subtask never
 *     carries the revision/replan/rework procedure, and vice versa.
 *
 * No real agent is invoked.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';

const { mockCreateSession, mockSendMessage, mockExecFileSync } = vi.hoisted(() => ({
  mockCreateSession: vi.fn(),
  mockSendMessage: vi.fn(),
  mockExecFileSync: vi.fn(),
}));

vi.mock('../../src/lib/logger', () => ({ log: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn() }));

vi.mock('../../src/lib/process-manager', () => ({
  processManager: {
    on: vi.fn(), off: vi.fn(), emit: vi.fn(),
    createSession: (...args: unknown[]) => mockCreateSession(...args),
    sendMessage: (...args: unknown[]) => mockSendMessage(...args),
    killSession: vi.fn(),
    getSession: vi.fn(),
  },
  containerSessionOpts: (projectRoot: string) => ({ projectRoot }),
}));

vi.mock('child_process', () => ({
  execFile: vi.fn(),
  execFileSync: (...args: unknown[]) => mockExecFileSync(...args),
}));

vi.mock('../../src/lib/container-manager', () => ({
  readContainerConfig: vi.fn(() => ({ enabled: false, explicit: false })),
  readContainerRemoteUser: vi.fn(() => 'node'),
  containerManager: { ensureContainer: vi.fn(), getRunningContainer: vi.fn(() => null) },
  hostToContainerPath: vi.fn((p: string) => p),
  dockerAvailable: vi.fn(() => true),
  _resetDockerAvailableCache: vi.fn(),
}));

import { runSpecPhase } from '../../src/lib/orchestrator/phase-runners';
import { runSubtaskSession } from '../../src/lib/orchestrator/implement';
import { readCommandTemplate } from '../../src/lib/command-templates';
import { promptMode, requestOf } from '../utils/agent-prompts';

class StopAfterSend extends Error {}

let root: string;
let specPath: string;
let worktreePath: string;

beforeEach(() => {
  vi.clearAllMocks();
  root = join(tmpdir(), `teamai-delivery-${randomUUID().slice(0, 8)}`);
  specPath = join(root, '.teamai', 'task-slug');
  worktreePath = join(root, '.worktrees', 'task-slug');
  mkdirSync(specPath, { recursive: true });
  mockCreateSession.mockResolvedValue('sess-1');
  mockExecFileSync.mockImplementation(() => { throw new Error('not a git repo'); });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const pipeline = (phase: string) => ({
  taskId: 'task-1', title: 'Build it', description: 'Build it', phase, specPath, worktreePath,
  branch: 'feat/build-it', qaAttempt: 0, maxQaAttempts: 3, specRevision: 1, qaRevision: 0,
});

const deps = () => ({
  projectRoot: root,
  persistAndEmitPhase: vi.fn(),
  sessionOpts: (role: string, cwd: string, taskId: string) => ({ role, cwd, taskId }),
  waitForCompletion: vi.fn(async () => { throw new StopAfterSend(); }),
  advancePhase: vi.fn(),
  rotateOutputLog: vi.fn(),
  phaseHeader: vi.fn(),
  savePipelineState: vi.fn(),
  toAgentPath: (p: string) => p,
  executePhase: vi.fn(),
  gitPush: vi.fn(),
  execGit: vi.fn(),
  execGitCapture: vi.fn(() => ''),
  getPipelineConfig: () => ({
    wakeupScanRetryDelayMs: 0, maxImplementRetries: 3, maxQaAttempts: 3, parallelSubtasks: true,
    maxStallRecoveries: 3, idleStallMinutes: 10, toolStallMinutes: 30,
  }),
  scheduleWakeup: vi.fn(),
  writeCompletionSummary: vi.fn(),
  taskStore: { get: vi.fn(), update: vi.fn(), getAll: vi.fn(() => []) },
  planWriteLock: { current: Promise.resolve() },
});

async function run(fn: () => Promise<unknown>) {
  try { await fn(); } catch (err) { if (!(err instanceof StopAfterSend)) throw err; }
}

function writeStaleCommands(dir: string) {
  mkdirSync(join(dir, '.claude', 'commands'), { recursive: true });
  for (const name of ['spec', 'implement', 'implement-fix']) {
    writeFileSync(join(dir, '.claude', 'commands', `${name}.md`), `STALE ${name} COPY $ARGUMENTS`);
  }
}

describe('instructions come from TeamAI\'s shipped templates', () => {
  it('a spec session at the project root ignores the project\'s own .claude/commands copy', async () => {
    writeStaleCommands(root);

    await run(() => runSpecPhase(pipeline('spec') as never, deps() as never));

    const message = mockSendMessage.mock.calls[0][1] as string;
    expect(message).not.toContain('STALE');
    expect(message.startsWith(readCommandTemplate('spec').split('$ARGUMENTS')[0])).toBe(true);
  });

  it('an implement session in a worktree ignores the branch\'s committed .claude/commands copy', async () => {
    writeStaleCommands(worktreePath);
    writeFileSync(join(specPath, 'plan.json'), JSON.stringify({ subtasks: [] }));
    const subtask = { id: 1, title: 'Do it', description: 'Do it', files: ['a.ts'], acceptance_criteria: ['ok'] };

    await run(() => runSubtaskSession(
      pipeline('implement') as never, deps() as never, subtask as never, worktreePath,
      join(specPath, 'output.log'), false, false, join(specPath, 'human_feedback.md'),
      [], new Set(), { current: Promise.resolve() },
    ));

    const message = mockSendMessage.mock.calls[0][1] as string;
    expect(message).not.toContain('STALE');
    expect(promptMode(message)).toBe('implement');
    expect(requestOf(message)).toContain('Subtask 1: Do it');
  });
});

describe('each mode carries only its own workflow', () => {
  const pairs: [string, string, string][] = [
    // [command, its own workflow marker, the other mode's marker it must not carry]
    ['spec', '## Step 1: Requirements Gathering', '## Revision Workflow'],
    ['spec-revise', '## Revision Workflow', '## Step 1: Requirements Gathering'],
    ['plan-revise', '## Re-plan Rules', '__none__'],
    ['implement', '## Instructions', '## QA Rework Mode'],
    ['implement-fix', '## QA Rework Mode', '__none__'],
  ];

  for (const [command, own, other] of pairs) {
    it(`${command} has "${own}"${other === '__none__' ? '' : ` and not "${other}"`}`, () => {
      const text = readCommandTemplate(command);
      expect(text).toContain(own);
      if (other !== '__none__') expect(text).not.toContain(other);
    });
  }

  it('plan (fresh) does not carry the re-plan rules', () => {
    expect(readCommandTemplate('plan')).not.toContain('## Re-plan Rules');
  });

  it('no command still keys a mode off a marker the orchestrator no longer sends', () => {
    for (const name of ['spec', 'spec-revise', 'plan', 'plan-revise', 'implement', 'implement-fix', 'qa-review']) {
      const text = readCommandTemplate(name);
      expect(text, name).not.toMatch(/prompt begins with `(REVISION|REPLAN):`/);
      expect(text, name).not.toContain('If the prompt includes "⚠️ QA FEEDBACK" at the top');
    }
  });
});
