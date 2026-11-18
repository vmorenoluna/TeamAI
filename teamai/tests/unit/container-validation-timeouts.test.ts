/**
 * Validation steps get their own timeouts: a large project's test suite must
 * not be killed by the generic 5-minute exec default, and a step that is
 * stopped says so instead of ending mid-output.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';

const { mockExec } = vi.hoisted(() => ({ mockExec: vi.fn() }));

vi.mock('child_process', () => ({
  spawn: vi.fn(),
  execFile: (file: string, args: string[], opts: { timeout?: number }, cb: (err: Error | null, stdout: string, stderr: string) => void) => {
    const out = mockExec(file, args, opts) as string | Error;
    if (out instanceof Error) { setImmediate(() => cb(out, (out as Error & { stdout?: string }).stdout ?? '', '')); return; }
    setImmediate(() => cb(null, out, ''));
  },
  ChildProcess: class MockChildProcess {},
}));

vi.mock('../../src/lib/logger', () => ({ log: vi.fn(), error: vi.fn(), warn: vi.fn() }));

import { validationStepTimeoutMs, readValidationRecord } from '../../src/lib/container-validation';
import { ContainerManager } from '../../src/lib/container-manager';

const MIN = 60_000;
let root: string;

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'validation-timeouts-'));
  mockExec.mockReset();
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

const writePipeline = (cfg: unknown) => {
  mkdirSync(path.join(root, '.teamai'), { recursive: true });
  writeFileSync(path.join(root, '.teamai', 'pipeline.json'), JSON.stringify(cfg));
};

describe('validationStepTimeoutMs', () => {
  it('defaults to 30 min for install and build, 60 min for tests, 5 min for the fast checks', () => {
    expect(validationStepTimeoutMs(root, 'Install dependencies')).toBe(30 * MIN);
    expect(validationStepTimeoutMs(root, 'Build')).toBe(30 * MIN);
    expect(validationStepTimeoutMs(root, 'Tests')).toBe(60 * MIN);
    expect(validationStepTimeoutMs(root, 'Agent tooling')).toBe(5 * MIN);
    expect(validationStepTimeoutMs(root, 'Native modules')).toBe(5 * MIN);
  });

  it('honours per-step overrides in .teamai/pipeline.json', () => {
    writePipeline({ containerValidationTimeoutMinutes: { install: 45, test: 90 } });
    expect(validationStepTimeoutMs(root, 'Install dependencies')).toBe(45 * MIN);
    expect(validationStepTimeoutMs(root, 'Tests')).toBe(90 * MIN);
    expect(validationStepTimeoutMs(root, 'Build')).toBe(30 * MIN);
  });

  it('ignores invalid overrides and unreadable config', () => {
    writePipeline({ containerValidationTimeoutMinutes: { test: 0, build: -5, install: 'soon' } });
    expect(validationStepTimeoutMs(root, 'Tests')).toBe(60 * MIN);
    expect(validationStepTimeoutMs(root, 'Build')).toBe(30 * MIN);
    expect(validationStepTimeoutMs(root, 'Install dependencies')).toBe(30 * MIN);
    writeFileSync(path.join(root, '.teamai', 'pipeline.json'), '{ not json');
    expect(validationStepTimeoutMs(root, 'Tests')).toBe(60 * MIN);
  });
});

describe('validation step execution', () => {
  const steps = () => [
    { name: 'Install dependencies', command: 'install-cmd', status: 'pending' as const },
    { name: 'Tests', command: 'test-cmd', status: 'pending' as const },
  ];

  const manager = () => {
    const m = new ContainerManager();
    const internals = m as unknown as {
      records: Map<string, unknown>;
      _newRecord: (root: string, state: string) => { containerId: string | null; remoteWorkspaceFolder: string | null };
      _buildValidationSteps: () => Promise<unknown>;
    };
    const record = internals._newRecord(root, 'running');
    record.containerId = 'abc123';
    record.remoteWorkspaceFolder = '/workspaces/p';
    internals.records.set(root, record);
    vi.spyOn(internals, '_buildValidationSteps').mockResolvedValue(steps());
    return m;
  };

  it('passes each step its own timeout instead of the 5-minute exec default', async () => {
    mockExec.mockReturnValue('ok');
    expect(await manager().validateContainer(root)).toBe(true);
    const timeouts = mockExec.mock.calls.map(c => c[2].timeout);
    expect(timeouts).toEqual([30 * MIN, 60 * MIN]);
  });

  it('reports a step stopped at its limit, with the message at the end of the error', async () => {
    mockExec.mockImplementation((_f: string, args: string[]) =>
      args.includes('test-cmd') ? Object.assign(new Error('killed'), { killed: true, stdout: 'partial test output' }) : 'ok');
    writePipeline({ containerValidationTimeoutMinutes: { test: 90 } });
    expect(await manager().validateContainer(root)).toBe(false);
    const record = readValidationRecord(root)!;
    expect(record.status).toBe('failed');
    expect(record.failedStep).toBe('Tests');
    expect(record.error).toContain('partial test output');
    expect(record.error!.trimEnd().endsWith('if the step is legitimately slower.')).toBe(true);
    expect(record.error).toContain('90-minute limit');
  });
});
