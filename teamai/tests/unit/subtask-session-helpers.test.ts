// @vitest-environment node

/**
 * Unit tests for the helpers extracted from runSubtaskSession: criteria
 * filtering, pre/post-subtask sensors, stall-recovery header, wakeup-file
 * consumption, deliverable verification and the scope check.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';

const { mockRunSensors, mockExecFileSync } = vi.hoisted(() => ({
  mockRunSensors: vi.fn(),
  mockExecFileSync: vi.fn(),
}));

vi.mock('../../src/lib/logger', () => ({
  log: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn(),
}));

vi.mock('../../src/lib/process-manager', () => ({
  processManager: {
    on: vi.fn(), off: vi.fn(), emit: vi.fn(), createSession: vi.fn(), sendMessage: vi.fn(),
    killSession: vi.fn(), getSession: vi.fn(), getAllSessions: vi.fn(() => []),
  },
  containerSessionOpts: (projectRoot: string) => ({ projectRoot, permissionMode: 'bypassPermissions' as const }),
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

vi.mock('../../src/lib/sensors', () => ({
  runSensors: (...args: unknown[]) => mockRunSensors(...args),
  sensorRunSummary: vi.fn(() => 'SENSOR SUMMARY'),
}));

import {
  filterSubtaskCriteria, runPreSubtaskSensors, runPostSubtaskSensors, buildStallRecoveryHeader,
  consumeSubtaskWakeupFiles, verifySubtaskDeliverables, checkSubtaskScope,
  type ImplementPipeline, type ImplementDeps,
} from '../../src/lib/orchestrator/implement';
import type { PlanSubtask } from '../../src/lib/orchestrator/types';

let specDir: string;
let cwd: string;
let execGitCapture: ReturnType<typeof vi.fn<any[], string>>;
let advancePhase: ReturnType<typeof vi.fn>;
let writeCompletionSummary: ReturnType<typeof vi.fn>;
let pipelineConfig: Record<string, unknown>;

function makeSubtask(over: Partial<PlanSubtask> = {}): PlanSubtask {
  return { id: 1, title: 'Subtask', description: 'd', files: [], acceptance_criteria: [], ...over };
}

function makePipeline(over: Partial<ImplementPipeline> = {}): ImplementPipeline {
  return { taskId: 't1', specPath: specDir, worktreePath: cwd, ...over } as unknown as ImplementPipeline;
}

function makeDeps(): ImplementDeps {
  return {
    execGitCapture, advancePhase, writeCompletionSummary,
    getPipelineConfig: () => pipelineConfig,
  } as unknown as ImplementDeps;
}

function outputLog(): string {
  const p = join(specDir, 'output.log');
  return existsSync(p) ? readFileSync(p, 'utf-8') : '';
}

beforeEach(() => {
  const base = join(tmpdir(), 'subtask-helpers-' + randomUUID());
  specDir = join(base, 'spec');
  cwd = join(base, 'wt');
  mkdirSync(specDir, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  execGitCapture = vi.fn<any[], string>(() => '');
  advancePhase = vi.fn();
  writeCompletionSummary = vi.fn();
  pipelineConfig = { maxImplementRetries: 3 };
  mockRunSensors.mockReset();
});

afterEach(() => {
  rmSync(join(specDir, '..'), { recursive: true, force: true });
});

describe('filterSubtaskCriteria', () => {
  const criteria = ['Feature works', '[QA CORRECTION: x]', '[QA ISSUE: y → Fix: z]'];

  it('keeps only the QA entries on a QA rework', () => {
    const r = filterSubtaskCriteria(makeSubtask({ acceptance_criteria: criteria }), true);
    expect(r.qaOnlyCriteria).toEqual(['[QA CORRECTION: x]', '[QA ISSUE: y → Fix: z]']);
    expect(r.criteriaLine.startsWith('QA issues to fix: ')).toBe(true);
  });

  it('returns a fallback line when a QA rework has no QA entries', () => {
    const r = filterSubtaskCriteria(makeSubtask({ acceptance_criteria: ['Feature works'] }), true);
    expect(r.qaOnlyCriteria).toEqual([]);
    expect(r.criteriaLine).toBe('No specific QA criteria for this subtask — see the QA feedback above for issues to address.');
  });

  it('returns every criterion without QA feedback', () => {
    const r = filterSubtaskCriteria(makeSubtask({ acceptance_criteria: criteria }), false);
    expect(r.qaOnlyCriteria).toEqual(criteria);
    expect(r.criteriaLine).toBe('Acceptance criteria: ' + criteria.join('; '));
  });
});

describe('runPreSubtaskSensors', () => {
  it('resolves and logs when runSensors rejects', async () => {
    pipelineConfig = { sensors: { pre_subtask: [{ name: 'a' }] } };
    mockRunSensors.mockRejectedValue(new Error('boom'));
    await expect(runPreSubtaskSensors(makePipeline(), makeDeps(), makeSubtask(), cwd, 'log')).resolves.toBeUndefined();
    expect(outputLog()).toContain('[SENSOR:pre_subtask] pre-subtask sensors failed (non-blocking): boom');
  });

  it('does not call runSensors when none are configured', async () => {
    await runPreSubtaskSensors(makePipeline(), makeDeps(), makeSubtask(), cwd, 'log');
    expect(mockRunSensors).not.toHaveBeenCalled();
  });
});

describe('runPostSubtaskSensors', () => {
  beforeEach(() => {
    pipelineConfig = { sensors: { post_subtask: [{ name: 'lint' }] } };
  });

  it('writes a FAIL sensor report for a failing sensor', async () => {
    mockRunSensors.mockResolvedValue({ allPassed: false, reports: [{ sensor: 'lint', passed: false, exitCode: 2 }] });
    await runPostSubtaskSensors(makePipeline(), makeDeps(), makeSubtask({ id: 4, title: 'T4' }), cwd, 'log');
    const report = JSON.parse(readFileSync(join(specDir, 'sensor_report-st4.json'), 'utf-8'));
    expect(report.overall).toBe('FAIL');
    expect(report.failures).toHaveLength(1);
    expect(report.failures[0].sensor).toBe('lint');
    expect(report.failures[0].error).toBe('exit code 2');
  });

  it('writes no report when all sensors pass', async () => {
    mockRunSensors.mockResolvedValue({ allPassed: true, reports: [{ sensor: 'lint', passed: true, exitCode: 0 }] });
    await runPostSubtaskSensors(makePipeline(), makeDeps(), makeSubtask({ id: 4 }), cwd, 'log');
    expect(existsSync(join(specDir, 'sensor_report-st4.json'))).toBe(false);
  });

  it('resolves and logs when runSensors rejects', async () => {
    mockRunSensors.mockRejectedValue(new Error('kaput'));
    await expect(runPostSubtaskSensors(makePipeline(), makeDeps(), makeSubtask({ id: 4 }), cwd, 'log')).resolves.toBeUndefined();
    expect(outputLog()).toContain('[SENSOR:post_subtask] post-subtask sensors error:');
  });
});

describe('buildStallRecoveryHeader', () => {
  const cfg = { idleStallMinutes: 7, toolStallMinutes: 31 };
  const prefix = '⚠️ SESSION RECOVERED AFTER STALL-KILL (attempt 2/3)';

  it('describes an idle stall', () => {
    const h = buildStallRecoveryHeader('idle', 2, 3, cfg);
    expect(h.startsWith(prefix)).toBe(true);
    expect(h).toContain('over 7 minutes while IDLE');
  });

  it('describes a tool stall', () => {
    const h = buildStallRecoveryHeader('tool', 2, 3, cfg);
    expect(h.startsWith(prefix)).toBe(true);
    expect(h).toContain('over 31 minutes while a tool was running');
  });

  it('falls through to the tool variant when the kind is undefined', () => {
    const h = buildStallRecoveryHeader(undefined, 2, 3, cfg);
    expect(h.startsWith(prefix)).toBe(true);
    expect(h).toContain('over 31 minutes while a tool was running');
  });
});

describe('consumeSubtaskWakeupFiles', () => {
  const wakeup = (id: number, at: string) => JSON.stringify({
    subtask_id: id, wakeup_at: at, background_command: 'cmd' + id, expected_artifact: 'out.txt',
  });

  beforeEach(() => {
    execGitCapture.mockReturnValue('headsha\n');
  });

  it('consumes a wakeup file written for another subtask', async () => {
    const file = join(specDir, 'subtask_wakeup-st7.json');
    writeFileSync(file, wakeup(7, '2030-01-01T00:00:00Z'));
    const pipeline = makePipeline();
    const detected = await consumeSubtaskWakeupFiles(pipeline, makeDeps(), makeSubtask({ id: 8 }), cwd, false);
    expect(detected).toBe(true);
    expect(pipeline.wakeupSubtaskId).toBe(7);
    expect(existsSync(file)).toBe(false);
  });

  it('adopts the earliest wakeup_at across subtasks', async () => {
    writeFileSync(join(specDir, 'subtask_wakeup-st2.json'), wakeup(2, '2030-01-02T00:00:00Z'));
    writeFileSync(join(specDir, 'subtask_wakeup-st3.json'), wakeup(3, '2030-01-01T00:00:00Z'));
    const pipeline = makePipeline();
    const detected = await consumeSubtaskWakeupFiles(pipeline, makeDeps(), makeSubtask({ id: 4 }), cwd, false);
    expect(detected).toBe(true);
    expect(pipeline.wakeupUntil).toBe('2030-01-01T00:00:00Z');
  });

  it('treats a malformed file as missing and deletes it', async () => {
    const file = join(specDir, 'subtask_wakeup-st5.json');
    writeFileSync(file, '{not json');
    const pipeline = makePipeline();
    const detected = await consumeSubtaskWakeupFiles(pipeline, makeDeps(), makeSubtask({ id: 5 }), cwd, false);
    expect(detected).toBe(false);
    expect(outputLog()).toContain('[WAKEUP] Malformed subtask_wakeup-st5.json — treating as missing');
    expect(existsSync(file)).toBe(false);
  });
});

describe('verifySubtaskDeliverables', () => {
  it('returns incomplete and counts the first failure', () => {
    const pipeline = makePipeline();
    const r = verifySubtaskDeliverables(pipeline, makeDeps(), makeSubtask({ id: 6, files_to_create: ['out/a.txt'] }), cwd);
    expect(r).toBe('incomplete');
    expect(pipeline.deliverableFailCounts?.[6]).toBe(1);
    expect(advancePhase).not.toHaveBeenCalled();
  });

  it('fails the task once the retry cap is reached', () => {
    const pipeline = makePipeline({ deliverableFailCounts: { 6: 2 } });
    const r = verifySubtaskDeliverables(pipeline, makeDeps(), makeSubtask({ id: 6, files_to_create: ['out/a.txt'] }), cwd);
    expect(r).toBe('failed');
    const report = JSON.parse(readFileSync(join(specDir, 'qa_report.json'), 'utf-8'));
    expect(report.overall).toBe('FAIL');
    expect(advancePhase).toHaveBeenCalledWith(pipeline, 'failed');
  });

  it('returns ok when every deliverable is committed', () => {
    mkdirSync(join(cwd, 'out'));
    writeFileSync(join(cwd, 'out/a.txt'), 'x');
    const r = verifySubtaskDeliverables(makePipeline(), makeDeps(), makeSubtask({ files_to_create: ['out/a.txt'] }), cwd);
    expect(r).toBe('ok');
  });
});

describe('checkSubtaskScope', () => {
  it('flags files outside files ∪ files_to_create', () => {
    execGitCapture.mockReturnValue('src/a.ts\nnew.ts\nstray.ts\n');
    const violations = new Set<number>();
    const changed = checkSubtaskScope(
      makePipeline(), makeDeps(), makeSubtask({ id: 3, files: ['src/a.ts'], files_to_create: ['new.ts'] }),
      cwd, 'abc123', join(specDir, 'st3.log'), violations,
    );
    expect(violations.has(3)).toBe(true);
    expect(outputLog()).toContain('stray.ts');
    expect(changed).toEqual(['src/a.ts', 'new.ts', 'stray.ts']);
  });

  it('skips the check for the QA-fallback subtask 9999', () => {
    const violations = new Set<number>();
    const changed = checkSubtaskScope(
      makePipeline(), makeDeps(), makeSubtask({ id: 9999, files: ['a.ts'] }),
      cwd, 'abc123', join(specDir, 'st9999.log'), violations,
    );
    expect(execGitCapture).not.toHaveBeenCalled();
    expect(violations.size).toBe(0);
    expect(changed).toEqual([]);
  });

  it('returns [] when git diff fails', () => {
    execGitCapture.mockImplementation(() => { throw new Error('boom'); });
    const violations = new Set<number>();
    const changed = checkSubtaskScope(
      makePipeline(), makeDeps(), makeSubtask({ id: 4, files: ['a.ts'] }),
      cwd, 'abc123', join(specDir, 'st4.log'), violations,
    );
    expect(changed).toEqual([]);
    expect(violations.size).toBe(0);
    expect(outputLog()).toContain('git diff failed: boom');
  });
});
