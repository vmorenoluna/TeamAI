import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readPipelineSensors, sensorRunSummary, runSensors } from '@/lib/sensors';
import type { SensorReport, SensorRunResult } from '@/lib/sensors';
import { mkdirSync, writeFileSync, existsSync, rmSync, readFileSync } from 'fs';
import path from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';

// ── Helpers ───────────────────────────────────────────────────────────────

/** Create a temporary directory for test artifacts. */
function tempDir(): string {
  const dir = path.join(tmpdir(), 'sensors-test-' + randomUUID());
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Create a temporary file path (doesn't create the file). */
function tempFile(): string {
  return path.join(tmpdir(), 'sensors-log-' + randomUUID() + '.log');
}

// ── Mock child_process.execFile ───────────────────────────────────────────

const { mockExecFile } = vi.hoisted(() => ({
  mockExecFile: vi.fn(),
}));

vi.mock('child_process', () => ({
  execFile: mockExecFile,
}));

// ── Mock helpers for promisify(execFile) callback style ───────────────────

/** Simulate a successful execFile call (exit 0). Calls the node-style callback. */
function mockSuccess(stdout = '', stderr = '') {
  mockExecFile.mockImplementationOnce(
    (_file: string, _args: string[], _opts: Record<string, unknown>, callback: (err: null, result: { stdout: string; stderr: string }) => void) => {
      callback(null, { stdout, stderr });
    },
  );
}

/**
 * Simulate a failed execFile call (non-zero exit, timeout, or ENOENT).
 * Calls the node-style callback with an error.
 */
function mockReject(
  message: string,
  code: number | string,
  stdout = '',
  stderr = '',
  killed = false,
) {
  mockExecFile.mockImplementationOnce(
    (_file: string, _args: string[], _opts: Record<string, unknown>, callback: (err: Record<string, unknown>, result: { stdout: string; stderr: string }) => void) => {
      const err: Record<string, unknown> = { message };
      err.code = code;
      if (killed) err.killed = true;
      if (stdout) err.stdout = stdout;
      if (stderr) err.stderr = stderr;
      callback(err, { stdout, stderr });
    },
  );
}

// ── readPipelineSensors ───────────────────────────────────────────────────

describe('readPipelineSensors', () => {
  it('returns undefined when no sensors key present', () => {
    expect(readPipelineSensors({})).toBeUndefined();
    expect(readPipelineSensors({ other: 'value' })).toBeUndefined();
  });

  it('returns undefined when sensors is not an object', () => {
    expect(readPipelineSensors({ sensors: 'not-an-object' })).toBeUndefined();
    expect(readPipelineSensors({ sensors: null })).toBeUndefined();
    expect(readPipelineSensors({ sensors: 42 })).toBeUndefined();
  });

  it('returns undefined when sensors object has no valid hooks', () => {
    expect(readPipelineSensors({ sensors: {} })).toBeUndefined();
    expect(readPipelineSensors({ sensors: { unrelated: true } })).toBeUndefined();
  });

  it('parses string commands into SensorConfig objects', () => {
    const cfg = readPipelineSensors({
      sensors: {
        pre_subtask: ['npx tsc --noEmit'],
      },
    });
    expect(cfg).toBeDefined();
    expect(cfg!.pre_subtask).toHaveLength(1);
    expect(cfg!.pre_subtask![0]).toEqual({ command: 'npx tsc --noEmit' });
  });

  it('parses object commands with label and timeout', () => {
    const cfg = readPipelineSensors({
      sensors: {
        post_subtask: [
          { command: 'npm test', label: 'Test suite', timeout: 300_000 },
        ],
      },
    });
    expect(cfg!.post_subtask![0]).toEqual({
      command: 'npm test',
      label: 'Test suite',
      timeout: 300_000,
    });
  });

  it('handles mixed string and object commands', () => {
    const cfg = readPipelineSensors({
      sensors: {
        pre_merge: [
          'npm run lint',
          { command: 'npx tsc --noEmit', label: 'Typecheck' },
        ],
      },
    });
    expect(cfg!.pre_merge).toHaveLength(2);
    expect(cfg!.pre_merge![0]).toEqual({ command: 'npm run lint' });
    expect(cfg!.pre_merge![1]).toEqual({ command: 'npx tsc --noEmit', label: 'Typecheck' });
  });

  it('silently skips malformed entries', () => {
    const cfg = readPipelineSensors({
      sensors: {
        pre_subtask: ['valid command', null, 123, {}, { noCommand: true }, 'another valid'],
      },
    });
    expect(cfg!.pre_subtask).toHaveLength(2);
    expect(cfg!.pre_subtask![0]).toEqual({ command: 'valid command' });
    expect(cfg!.pre_subtask![1]).toEqual({ command: 'another valid' });
  });

  it('silently skips non-array hook values', () => {
    const cfg = readPipelineSensors({
      sensors: {
        pre_subtask: 'not-an-array',
        post_subtask: ['npm run lint'],
      },
    });
    expect(cfg!.pre_subtask).toBeUndefined();
    expect(cfg!.post_subtask).toHaveLength(1);
  });

  it('reads all four hook types', () => {
    const cfg = readPipelineSensors({
      sensors: {
        pre_subtask: ['echo pre'],
        post_subtask: ['echo post'],
        pre_merge: ['echo merge'],
        on_failure: ['echo fail'],
      },
    });
    expect(cfg!.pre_subtask).toHaveLength(1);
    expect(cfg!.post_subtask).toHaveLength(1);
    expect(cfg!.pre_merge).toHaveLength(1);
    expect(cfg!.on_failure).toHaveLength(1);
  });

  it('skips hooks with only malformed entries', () => {
    const cfg = readPipelineSensors({
      sensors: {
        pre_subtask: [null, 123, {}],
        post_subtask: ['echo ok'],
      },
    });
    expect(cfg!.pre_subtask).toBeUndefined();
    expect(cfg!.post_subtask).toHaveLength(1);
  });

  it('returns undefined when all hooks are empty after filtering', () => {
    expect(readPipelineSensors({ sensors: { pre_subtask: [] } })).toBeUndefined();
    expect(readPipelineSensors({ sensors: { pre_subtask: [null] } })).toBeUndefined();
  });
});

// ── sensorRunSummary ──────────────────────────────────────────────────────

describe('sensorRunSummary', () => {
  function makeReport(overrides: Partial<SensorReport> = {}): SensorReport {
    return {
      sensor: 'test-sensor',
      command: 'echo hello',
      exitCode: 0,
      stdout: '',
      stderr: '',
      passed: true,
      ...overrides,
    };
  }

  function makeResult(overrides: Partial<SensorRunResult> = {}): SensorRunResult {
    return {
      hook: 'pre_subtask',
      reports: [],
      allPassed: true,
      ...overrides,
    };
  }

  it('returns empty string for empty reports', () => {
    expect(sensorRunSummary(makeResult({ reports: [] }))).toBe('');
  });

  it('shows PASS for a passed sensor', () => {
    const result = makeResult({
      reports: [makeReport({ sensor: 'Lint', passed: true, exitCode: 0 })],
      allPassed: true,
    });
    const summary = sensorRunSummary(result);
    expect(summary).toContain('[PASS]');
    expect(summary).toContain('Lint');
    expect(summary).toContain('(exit 0)');
  });

  it('shows FAIL for a failed sensor with exit code', () => {
    const result = makeResult({
      reports: [makeReport({ sensor: 'Tests', passed: false, exitCode: 1 })],
      allPassed: false,
    });
    const summary = sensorRunSummary(result);
    expect(summary).toContain('[FAIL]');
    expect(summary).toContain('Tests');
    expect(summary).toContain('(exit 1)');
  });

  it('shows ERROR for a sensor with an error message', () => {
    const result = makeResult({
      reports: [makeReport({
        sensor: 'Build',
        passed: false,
        exitCode: null,
        error: 'Command not found: make',
      })],
      allPassed: false,
    });
    const summary = sensorRunSummary(result);
    expect(summary).toContain('[ERROR]');
    expect(summary).toContain('Command not found: make');
    expect(summary).toContain('(exit null)');
  });

  it('includes the hook name', () => {
    const result = makeResult({
      hook: 'post_subtask',
      reports: [makeReport({ sensor: 'Check' })],
    });
    expect(sensorRunSummary(result)).toContain('Sensor results for post_subtask');
  });

  it('handles multiple sensors with mixed statuses', () => {
    const result = makeResult({
      hook: 'pre_merge',
      reports: [
        makeReport({ sensor: 'Lint', passed: true, exitCode: 0 }),
        makeReport({ sensor: 'Typecheck', passed: false, exitCode: 2 }),
        makeReport({ sensor: 'Tests', passed: false, exitCode: null, error: 'timeout' }),
      ],
      allPassed: false,
    });
    const summary = sensorRunSummary(result);
    expect(summary).toContain('[PASS] Lint (exit 0)');
    expect(summary).toContain('[FAIL] Typecheck (exit 2)');
    expect(summary).toContain('[ERROR] Tests (exit null) — timeout');
  });

  it('appends error message with mdash separator', () => {
    const result = makeResult({
      reports: [makeReport({ sensor: 'X', passed: false, exitCode: null, error: 'timed out' })],
    });
    expect(sensorRunSummary(result)).toContain(' — timed out');
  });
});

// ── runSensors ────────────────────────────────────────────────────────────

describe('runSensors', () => {
  let testDir: string;
  let logFile: string;

  beforeEach(() => {
    testDir = tempDir();
    logFile = tempFile();
    writeFileSync(logFile, ''); // create the file
    mockExecFile.mockReset();
  });

  afterEach(() => {
    try { rmSync(testDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    try { rmSync(logFile, { force: true }); } catch { /* best-effort */ }
  });

  // ── Empty sensors ─────────────────────────────────────────────────────

  it('returns allPassed: true with empty reports when sensors array is empty', async () => {
    const result = await runSensors([], 'pre_subtask', {
      cwd: testDir,
      specPath: testDir,
      files: [],
    });
    expect(result.hook).toBe('pre_subtask');
    expect(result.reports).toHaveLength(0);
    expect(result.allPassed).toBe(true);
  });

  it('returns allPassed: true when sensors is null or undefined', async () => {
    const r1 = await runSensors(null as unknown as SensorReport[], 'pre_subtask', { cwd: testDir, specPath: testDir, files: [] });
    expect(r1.allPassed).toBe(true);
    expect(r1.reports).toHaveLength(0);
    const r2 = await runSensors(undefined as unknown as SensorReport[], 'pre_subtask', { cwd: testDir, specPath: testDir, files: [] });
    expect(r2.allPassed).toBe(true);
  });

  // ── Successful sensor ─────────────────────────────────────────────────

  it('runs a sensor and returns a pass report', async () => {
    mockSuccess('OK\n', '');

    const result = await runSensors(
      [{ command: 'echo hello' }],
      'pre_subtask',
      { cwd: testDir, specPath: testDir, files: ['src/app.ts'], logFile },
    );

    expect(result.reports).toHaveLength(1);
    const r = result.reports[0];
    expect(r.passed).toBe(true);
    expect(r.exitCode).toBe(0);
    expect(r.sensor).toBe('echo');
    expect(r.command).toBe('echo hello');
    expect(r.stdout).toBe('OK\n');
    expect(r.stderr).toBe('');
    expect(r.error).toBeUndefined();
    expect(result.allPassed).toBe(true);
  });

  it('uses custom label when provided', async () => {
    mockSuccess();

    const result = await runSensors(
      [{ command: 'npx tsc --noEmit', label: 'TypeScript typecheck' }],
      'pre_subtask',
      { cwd: testDir, specPath: testDir, files: [] },
    );

    expect(result.reports[0].sensor).toBe('TypeScript typecheck');
  });

  // ── Failed sensor (non-zero exit) ─────────────────────────────────────

  it('reports a sensor that exits non-zero', async () => {
    mockReject('Command failed', 1, 'some output', 'ERROR: something broke');

    const result = await runSensors(
      [{ command: 'npm test' }],
      'post_subtask',
      { cwd: testDir, specPath: testDir, files: [], logFile },
    );

    const r = result.reports[0];
    expect(r.passed).toBe(false);
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toBe('some output');
    expect(r.stderr).toBe('ERROR: something broke');
    expect(r.error).toBe('Command failed');
    expect(result.allPassed).toBe(false);
  });

  it('defaults exitCode to 1 when error object has no numeric code', async () => {
    mockReject('generic failure', 'SOME_STRING');

    const result = await runSensors(
      [{ command: 'bad-command' }],
      'pre_subtask',
      { cwd: testDir, specPath: testDir, files: [] },
    );

    expect(result.reports[0].exitCode).toBe(1);
    expect(result.reports[0].passed).toBe(false);
  });

  // ── Timeout ───────────────────────────────────────────────────────────

  it('handles timeout (killed: true)', async () => {
    mockReject('ETIMEDOUT', 'ETIMEDOUT', '', '', true);

    const result = await runSensors(
      [{ command: 'sleep 999', timeout: 100 }],
      'pre_subtask',
      { cwd: testDir, specPath: testDir, files: [] },
    );

    const r = result.reports[0];
    expect(r.passed).toBe(false);
    expect(r.exitCode).toBeNull();
    expect(r.error).toContain('timed out');
    expect(r.error).toContain('100ms');
  });

  // ── ENOENT (command not found) ────────────────────────────────────────

  it('handles ENOENT (command not found)', async () => {
    mockReject('spawn nonexistent ENOENT', 'ENOENT');

    const result = await runSensors(
      [{ command: 'nonexistent-command' }],
      'pre_subtask',
      { cwd: testDir, specPath: testDir, files: [] },
    );

    const r = result.reports[0];
    expect(r.passed).toBe(false);
    expect(r.exitCode).toBeNull();
    expect(r.error).toBe('Command not found: nonexistent-command');
  });

  // ── Environment variables ─────────────────────────────────────────────

  it('passes SENSOR_FILES env var with file list', async () => {
    mockSuccess();

    await runSensors(
      [{ command: 'lint-check' }],
      'pre_subtask',
      { cwd: testDir, specPath: testDir, files: ['src/a.ts', 'src/b.ts'], logFile },
    );

    const env = mockExecFile.mock.calls[0][2].env as Record<string, string>;
    expect(env.SENSOR_FILES).toBe('src/a.ts src/b.ts');
  });

  it('passes empty SENSOR_FILES when files is empty', async () => {
    mockSuccess();

    await runSensors(
      [{ command: 'check' }],
      'pre_subtask',
      { cwd: testDir, specPath: testDir, files: [] },
    );

    const env = mockExecFile.mock.calls[0][2].env as Record<string, string>;
    expect(env.SENSOR_FILES).toBe('');
  });

  it('passes SENSOR_OUTPUT env var with the report path', async () => {
    mockSuccess();

    await runSensors(
      [{ command: 'check', label: 'My Check' }],
      'pre_merge',
      { cwd: testDir, specPath: testDir, files: [] },
    );

    const env = mockExecFile.mock.calls[0][2].env as Record<string, string>;
    expect(env.SENSOR_OUTPUT).toContain('pre_merge-my-check');
    expect(env.SENSOR_OUTPUT).toContain('.json');
  });

  it('passes SENSOR_CWD env var', async () => {
    mockSuccess();

    await runSensors(
      [{ command: 'check' }],
      'pre_subtask',
      { cwd: testDir, specPath: testDir, files: [] },
    );

    const env = mockExecFile.mock.calls[0][2].env as Record<string, string>;
    expect(env.SENSOR_CWD).toBe(testDir);
  });

  // ── Custom timeout ────────────────────────────────────────────────────

  it('uses custom timeout from sensor config', async () => {
    mockSuccess();

    await runSensors(
      [{ command: 'slow-check', timeout: 42_000 }],
      'pre_subtask',
      { cwd: testDir, specPath: testDir, files: [] },
    );

    const opts = mockExecFile.mock.calls[0][2];
    expect(opts.timeout).toBe(42_000);
  });

  // ── Output report file ────────────────────────────────────────────────

  it('writes the sensor report to disk', async () => {
    mockSuccess('output', 'warnings');

    await runSensors(
      [{ command: 'check', label: 'My Sensor' }],
      'post_subtask',
      { cwd: testDir, specPath: testDir, files: [] },
    );

    const sensorsDir = path.join(testDir, 'sensors');
    expect(existsSync(sensorsDir)).toBe(true);

    const reportFile = path.join(sensorsDir, 'post_subtask-my-sensor.json');
    expect(existsSync(reportFile)).toBe(true);

    const reportJson = JSON.parse(readFileSync(reportFile, 'utf-8'));
    expect(reportJson.sensor).toBe('My Sensor');
    expect(reportJson.passed).toBe(true);
    expect(reportJson.exitCode).toBe(0);
  });

  // ── Subtask ID suffix ─────────────────────────────────────────────────

  it('includes subtaskId in output filename', async () => {
    mockSuccess();

    await runSensors(
      [{ command: 'check', label: 'Lint' }],
      'post_subtask',
      { cwd: testDir, specPath: testDir, files: [], subtaskId: 3, logFile },
    );

    const env = mockExecFile.mock.calls[0][2].env as Record<string, string>;
    expect(env.SENSOR_OUTPUT).toContain('-st3.json');
  });

  it('does not include subtask suffix when subtaskId is undefined', async () => {
    mockSuccess();

    await runSensors(
      [{ command: 'check' }],
      'pre_subtask',
      { cwd: testDir, specPath: testDir, files: [] },
    );

    const env = mockExecFile.mock.calls[0][2].env as Record<string, string>;
    expect(env.SENSOR_OUTPUT).not.toContain('-st0');
  });

  // ── Log file output ──────────────────────────────────────────────────

  it('appends pass result to logFile', async () => {
    mockSuccess();

    await runSensors(
      [{ command: 'check', label: 'Checker' }],
      'pre_subtask',
      { cwd: testDir, specPath: testDir, files: [], logFile },
    );

    const log = readFileSync(logFile, 'utf-8');
    expect(log).toContain('[SENSOR:pre_subtask] Checker — PASS (exit 0)');
  });

  it('appends fail result to logFile', async () => {
    mockReject('fail', 2, '', '');

    await runSensors(
      [{ command: 'check', label: 'Failer' }],
      'post_subtask',
      { cwd: testDir, specPath: testDir, files: [], logFile },
    );

    const log = readFileSync(logFile, 'utf-8');
    // When report.error is set, the status label is 'ERROR' not 'FAIL'
    expect(log).toContain('[SENSOR:post_subtask] Failer — ERROR (exit 2)');
    expect(log).toContain('Error: fail');
  });

  it('does not log when logFile is not provided', async () => {
    mockSuccess();

    // Should not throw
    await runSensors(
      [{ command: 'check' }],
      'pre_subtask',
      { cwd: testDir, specPath: testDir, files: [] },
    );

    // No logFile = nothing to read, just verify no crash
  });

  // ── Multiple sensors ──────────────────────────────────────────────────

  it('runs multiple sensors sequentially', async () => {
    mockSuccess();
    mockReject('fail', 1);

    const result = await runSensors(
      [{ command: 'passer' }, { command: 'failer' }],
      'pre_subtask',
      { cwd: testDir, specPath: testDir, files: [] },
    );

    expect(result.reports).toHaveLength(2);
    expect(result.reports[0].passed).toBe(true);
    expect(result.reports[1].passed).toBe(false);
    expect(result.allPassed).toBe(false);
    expect(mockExecFile).toHaveBeenCalledTimes(2);
  });

  it('reports allPassed: true when all sensors pass', async () => {
    mockSuccess();
    mockSuccess();

    const result = await runSensors(
      [{ command: 'a' }, { command: 'b' }],
      'pre_subtask',
      { cwd: testDir, specPath: testDir, files: [] },
    );

    expect(result.allPassed).toBe(true);
  });

  // ── stderr capture ────────────────────────────────────────────────────

  it('captures stderr in the report', async () => {
    mockReject('fail', 1, '', 'type error on line 42');

    const result = await runSensors(
      [{ command: 'tsc' }],
      'pre_subtask',
      { cwd: testDir, specPath: testDir, files: [] },
    );

    expect(result.reports[0].stderr).toBe('type error on line 42');
  });

  // ── Label derived from command ────────────────────────────────────────

  it('derives label from command when not specified', async () => {
    mockSuccess();

    const result = await runSensors(
      [{ command: 'npx eslint src/' }],
      'pre_subtask',
      { cwd: testDir, specPath: testDir, files: [] },
    );

    expect(result.reports[0].sensor).toBe('npx');
  });
});
