// @vitest-environment node

/** Tests for the Role Refinement analysis engine with a faked analyst session:
 *  the fake `waitForCompletion` writes the `.analysis.json` the real agent
 *  would write, letting us exercise the parse → record → task-stamp path. */

import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const { mockEmit } = vi.hoisted(() => ({ mockEmit: vi.fn() }));

vi.mock('../../src/lib/logger', () => ({
  log: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn(),
}));

vi.mock('../../src/lib/process-manager', () => ({
  processManager: {
    on: vi.fn(), off: vi.fn(), emit: mockEmit,
  },
}));

import { TaskStore } from '../../src/lib/task-store';
import {
  analyzeFailure,
  getSuggestion,
  buildAnalysisCommand,
  ROLE_REFINEMENT_ANALYSIS_COMMAND,
  parseAnalysisOutput,
  type RoleRefinementAnalyzeDeps,
} from '../../src/lib/role-refinement';
import { join as joinPath } from 'path';

let root: string;
let taskStore: TaskStore;

beforeEach(() => {
  vi.clearAllMocks();
  root = mkdtempSync(join(tmpdir(), 'role-refine-analyze-'));
  taskStore = new TaskStore(root);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function seedTask(phase = 'failed'): string {
  const task = taskStore.create('task-1', 'Broken migration', 'Migrate the db');
  taskStore.updatePhase('task-1', phase);
  const dir = taskStore.getDirById('task-1');
  writeFileSync(join(dir, 'qa_report.json'), JSON.stringify({
    overall: 'FAIL',
    criteria: [{ name: 'Sweep completes', status: 'FAIL' }],
  }));
  writeFileSync(join(dir, 'completion_summary.md'), 'Sweep never finished.\n');
  // Seed role files so the prompt lists them as paths.
  mkdirSync(join(root, '.claude', 'roles'), { recursive: true });
  writeFileSync(join(root, '.claude', 'roles', 'planner.md'), '# Role: Planner\n');
  writeFileSync(join(root, '.claude', 'roles', 'coder.md'), '# Role: Coder\n');
  return task.id;
}

/** Fake deps whose waitForCompletion writes the analysis file like the agent would. */
function fakeDeps(analysis: Record<string, unknown>): {
  deps: RoleRefinementAnalyzeDeps;
  createSpy: Mock<[], Promise<string>>;
  sentPrompt: () => string | undefined;
} {
  let prompt: string | undefined;
  const createSpy = vi.fn(async () => 'sess-1');
  const deps: RoleRefinementAnalyzeDeps = {
    createSession: createSpy,
    sendMessage: vi.fn((_id: string, content: string) => { prompt = content; }),
    waitForCompletion: vi.fn(async () => {
      // The record file exists before the session; derive the id from the
      // newest non-analysis .json in the refinements dir.
      const dir = join(root, '.teamai', 'role-refinements');
      const files = readdirSync(dir).filter(f => f.endsWith('.json') && !f.includes('.analysis.'));
      const id = files.map(f => f.replace(/\.json$/, '')).sort().at(-1)!;
      writeFileSync(join(dir, `${id}.analysis.json`), JSON.stringify(analysis, null, 2));
    }),
    killSession: vi.fn(),
  };
  return { deps, createSpy, sentPrompt: () => prompt };
}

describe('analyzeFailure', () => {
  it('routes a role-prompt gap to suggested with edits, stamps the task, and emits', async () => {
    const taskId = seedTask();
    const { deps, createSpy, sentPrompt } = fakeDeps({
      isRolePromptGap: true,
      contractGap: false,
      contractFile: null,
      rootCause: 'Planner omits git add -f',
      confidence: 'high',
      diagnosis: 'Add a force-add rule to the planner role.',
      edits: [
        { roleFile: 'planner.md', mode: 'append', rationale: 'evidence commit', proposedContent: 'Use git add -f.', riskClass: 'additive' },
      ],
    });

    const id = await analyzeFailure(root, taskId, 'manual', deps);

    const record = getSuggestion(root, id)!;
    expect(record.status).toBe('suggested');
    expect(record.trigger).toBe('manual');
    expect(record.model).toBe('claude-sonnet-4-6'); // the analysis model is recorded on the suggestion
    expect(record.sourceTaskIds).toEqual(['task-1']);
    expect(record.isRolePromptGap).toBe(true);
    expect(record.edits).toHaveLength(1);
    expect(record.edits[0].roleFile).toBe('planner.md');
    expect(record.signature).toMatch(/^sha256:/);

    // The task is stamped for the inline card.
    expect(taskStore.getById(taskId)?.refinementStatus).toBe('suggested');
    expect(taskStore.getById(taskId)?.refinementSuggestionId).toBe(id);

    // The session is a generic one — no pipeline role persona — and the model
    // comes from the Role Refinements config (default sonnet), not the analyst role.
    expect(createSpy).toHaveBeenCalledWith(expect.objectContaining({ role: 'general', model: 'claude-sonnet-4-6' }));

    // The message invokes the internal command and hands the artifacts + role
    // files as paths; the classification instructions live in the command file.
    const prompt = sentPrompt()!;
    expect(prompt).toContain(`/${ROLE_REFINEMENT_ANALYSIS_COMMAND}`);
    expect(prompt).toContain('qa_report.json');
    expect(prompt).toContain(joinPath(root, '.claude', 'roles', 'planner.md'));
    expect(prompt).toContain('OUTPUT_FILE:');
    expect(prompt).toContain('FAILURE_ARTIFACTS:');
    expect(prompt).not.toContain('isRolePromptGap'); // instructions live in the command template

    // A refinement-update event fires so open panels refresh.
    expect(mockEmit).toHaveBeenCalledWith('refinement-update', { taskId, projectRoot: root });
  });

  it('records the recurrence cluster as sourceTaskIds and feeds sibling artifacts to the analyst', async () => {
    const taskId = seedTask();
    const siblingId = taskStore.create('task-2', 'Second failure', 'desc').id;
    taskStore.updatePhase(siblingId, 'failed');
    writeFileSync(join(taskStore.getDirById(siblingId), 'completion_summary.md'), 'second failure\n');

    const { deps, sentPrompt } = fakeDeps({
      isRolePromptGap: false,
      contractGap: false,
      contractFile: null,
      rootCause: '',
      confidence: 'low',
      diagnosis: 'not a gap',
      edits: [],
    });

    const id = await analyzeFailure(root, taskId, 'auto', deps, 'sha256:cluster', ['task-1', 'task-2']);
    const record = getSuggestion(root, id)!;
    expect(record.sourceTaskIds).toEqual(['task-1', 'task-2']);
    expect(record.signature).toBe('sha256:cluster');

    // The prompt includes the sibling's artifact path.
    expect(sentPrompt()!).toContain(join(taskStore.getDirById('task-2'), 'completion_summary.md'));
  });

  it('routes a no-gap verdict with an empty edit list', async () => {
    const taskId = seedTask();
    const { deps } = fakeDeps({
      isRolePromptGap: false,
      contractGap: false,
      contractFile: null,
      rootCause: 'Spec is ambiguous',
      confidence: 'medium',
      diagnosis: 'The spec lacks thresholds; this is a spec problem, not a role gap.',
      edits: [],
    });
    const id = await analyzeFailure(root, taskId, 'manual', deps);
    const record = getSuggestion(root, id)!;
    expect(record.status).toBe('no-gap');
    expect(record.isRolePromptGap).toBe(false);
    expect(record.edits).toEqual([]);
    expect(taskStore.getById(taskId)?.refinementStatus).toBe('no-gap');
  });

  it('flags contract gaps without role edits', async () => {
    const taskId = seedTask();
    const { deps } = fakeDeps({
      isRolePromptGap: false,
      contractGap: true,
      contractFile: 'implement.md',
      rootCause: 'wakeup schema undocumented',
      confidence: 'high',
      diagnosis: 'Document the subtask_wakeup schema in defaults/commands/implement.md.',
      edits: [],
    });
    const id = await analyzeFailure(root, taskId, 'manual', deps);
    const record = getSuggestion(root, id)!;
    expect(record.status).toBe('no-gap');
    expect(record.contractGap).toBe(true);
    expect(record.contractFile).toBe('implement.md');
    expect(record.edits).toEqual([]);
  });

  it('marks no-gap when the analysis output is malformed', async () => {
    const taskId = seedTask();
    const { deps } = fakeDeps({ isRolePromptGap: 'not-a-bool' }); // wrong shape
    const id = await analyzeFailure(root, taskId, 'manual', deps);
    const record = getSuggestion(root, id)!;
    expect(record.status).toBe('no-gap');
    expect(record.isRolePromptGap).toBe(false);
    expect(taskStore.getById(taskId)?.refinementStatus).toBe('no-gap');
  });

  it('marks no-gap when the session fails (waitForCompletion rejects)', async () => {
    const taskId = seedTask();
    const deps: RoleRefinementAnalyzeDeps = {
      createSession: vi.fn(async () => 'sess-1'),
      sendMessage: vi.fn(),
      waitForCompletion: vi.fn(async () => { throw new Error('rate limited'); }),
      killSession: vi.fn(),
    };
    const id = await analyzeFailure(root, taskId, 'manual', deps);
    const record = getSuggestion(root, id)!;
    expect(record.status).toBe('no-gap');
    expect(record.diagnosis).toContain('rate limited');
    expect(taskStore.getById(taskId)?.refinementStatus).toBe('no-gap');
  });

  it('kills the session in a finally block', async () => {
    const taskId = seedTask();
    const { deps } = fakeDeps({
      isRolePromptGap: false,
      contractGap: false,
      contractFile: null,
      rootCause: '',
      confidence: 'low',
      diagnosis: 'not a gap',
      edits: [],
    });
    await analyzeFailure(root, taskId, 'manual', deps);
    expect(deps.killSession).toHaveBeenCalledWith('sess-1');
  });

  it('clears a prior retry-loop escalation when a fresh analysis starts', async () => {
    const taskId = seedTask();
    taskStore.update(taskId, { refinementEscalated: true });
    const { deps } = fakeDeps({
      isRolePromptGap: false,
      contractGap: false,
      contractFile: null,
      rootCause: '',
      confidence: 'low',
      diagnosis: 'not a gap',
      edits: [],
    });
    await analyzeFailure(root, taskId, 'auto', deps);
    expect(taskStore.getById(taskId)?.refinementEscalated).toBe(false);
  });
});

describe('parseAnalysisOutput', () => {
  it('parses a valid payload defensively', () => {
    const out = parseAnalysisOutput(JSON.stringify({
      isRolePromptGap: true,
      contractGap: false,
      contractFile: null,
      rootCause: 'rc',
      confidence: 'high',
      diagnosis: 'd',
      edits: [
        { roleFile: 'planner.md', mode: 'replace', rationale: 'r', proposedContent: 'p', riskClass: 'modifying' },
        { roleFile: 'coder.md', mode: 'append', rationale: '', proposedContent: 'q' }, // riskClass defaults
        { nope: true }, // filtered out
      ],
    }));
    expect(out.isRolePromptGap).toBe(true);
    expect(out.edits).toHaveLength(2);
    expect(out.edits[1].riskClass).toBe('additive');
  });

  it('returns a safe no-gap fallback for invalid JSON', () => {
    const out = parseAnalysisOutput('not json');
    expect(out.isRolePromptGap).toBe(false);
    expect(out.edits).toEqual([]);
    expect(out.diagnosis).toContain('No role-prompt gap');
  });
});

describe('buildAnalysisCommand', () => {
  it('invokes the internal command with existing artifacts and role files as path args', () => {
    seedTask();
    const dir = taskStore.getDirById('task-1');
    const command = buildAnalysisCommand(root, [dir], join(root, '.teamai', 'role-refinements', 'x.analysis.json'));
    expect(command.startsWith(`/${ROLE_REFINEMENT_ANALYSIS_COMMAND}`)).toBe(true);
    expect(command).toContain(join(dir, 'qa_report.json'));
    expect(command).toContain(join(dir, 'completion_summary.md'));
    expect(command).not.toContain('output-plan.log'); // does not exist
    expect(command).toContain('OUTPUT_FILE: ' + join(root, '.teamai', 'role-refinements', 'x.analysis.json'));
    expect(command).toContain('FAILURE_ARTIFACTS:');
    expect(command).toContain('ROLE_FILES:');
  });

  it('includes artifact paths from every task dir in the cluster', () => {
    const id1 = seedTask();
    const id2 = taskStore.create('task-2', 'Second failure', 'desc').id;
    taskStore.updatePhase(id2, 'failed');
    writeFileSync(join(taskStore.getDirById(id2), 'completion_summary.md'), 'second failure\n');

    const command = buildAnalysisCommand(root, [taskStore.getDirById(id1), taskStore.getDirById(id2)], '/tmp/x.json');
    expect(command).toContain(join(taskStore.getDirById(id1), 'qa_report.json'));
    expect(command).toContain(join(taskStore.getDirById(id2), 'completion_summary.md'));
  });
});

describe('role-refinement-analysis command template', () => {
  it('carries the classification contract so the agent is not sent inline instructions', () => {
    // The analysis agent is instructed via the internal command (force-synced
    // from defaults/, like the other pipeline commands) — the instructions must
    // live in the template, not in the sent message.
    const template = readFileSync(joinPath(process.cwd(), 'defaults', 'commands', 'role-refinement-analysis.md'), 'utf-8');
    expect(template).toContain('$ARGUMENTS');
    expect(template).toContain('role-prompt gap');
    expect(template).toContain('orchestration-contract gap');
    expect(template).toContain('isRolePromptGap');
    expect(template).toContain('OUTPUT_FILE');
    expect(template).toContain('FAILURE_ARTIFACTS');
    expect(template).toContain('ROLE_FILES');
  });

  it('uses the Role Refinements configured model for the analysis session', async () => {
    const taskId = seedTask();
    // A custom model in the project config overrides the default.
    mkdirSync(join(root, '.teamai'), { recursive: true });
    writeFileSync(join(root, '.teamai', 'role-refinement.json'), JSON.stringify({ model: 'claude-opus-4-8' }));

    const { deps, createSpy } = fakeDeps({
      isRolePromptGap: false, contractGap: false, contractFile: null,
      rootCause: '', confidence: 'low', diagnosis: 'n/a', edits: [],
    });
    const id = await analyzeFailure(root, taskId, 'manual', deps);

    expect(createSpy).toHaveBeenCalledWith(expect.objectContaining({ role: 'general', model: 'claude-opus-4-8' }));
    // The model that ran the analysis is recorded on the suggestion itself.
    expect(getSuggestion(root, id)?.model).toBe('claude-opus-4-8');
  });
});
