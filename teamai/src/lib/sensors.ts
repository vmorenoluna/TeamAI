import { execFile } from 'child_process';
import { promisify } from 'util';
import { existsSync, mkdirSync, writeFileSync, appendFileSync } from 'fs';
import path from 'path';
import { warn } from './logger';

const execFileAsync = promisify(execFile);

// ── Types ────────────────────────────────────────────────────────────────

/** A single sensor definition: a shell command to execute. */
export interface SensorConfig {
  /** Shell command to run (e.g. "npx tsc --noEmit", "npm run lint", "python -m mypy .") */
  command: string;
  /** Timeout in milliseconds. Defaults to 120_000 (2 minutes). */
  timeout?: number;
  /** Human-readable label (e.g. "TypeScript typecheck"). Auto-derived from command if omitted. */
  label?: string;
}

/** Grouped sensor hooks keyed by pipeline lifecycle point. */
export interface SensorsConfig {
  /** Run before each subtask session starts (in the worktree). Failure logs a warning but does not block. */
  pre_subtask?: SensorConfig[];
  /** Run after each subtask session completes (in the worktree). Failure writes a FAIL criterion to qa_report.json. */
  post_subtask?: SensorConfig[];
  /** Run before the merge phase (in the worktree). Failure blocks the merge. */
  pre_merge?: SensorConfig[];
  /** Run when a sensor or phase fails (in the worktree). Best-effort — failures are logged but never block. */
  on_failure?: SensorConfig[];
}

/** Structured output from a single sensor run. */
export interface SensorReport {
  /** Sensor label (derived from config). */
  sensor: string;
  /** The command that was executed. */
  command: string;
  /** Exit code: 0 = pass, non-zero = fail, null = timeout or spawn failure. */
  exitCode: number | null;
  /** First 4 KB of stdout. */
  stdout: string;
  /** First 4 KB of stderr. */
  stderr: string;
  /** Whether this sensor passed (exitCode === 0). */
  passed: boolean;
  /** Error message if the sensor could not be spawned or timed out. */
  error?: string;
}

/** Summary of all sensor runs for a given hook. */
export interface SensorRunResult {
  hook: string;
  reports: SensorReport[];
  /** True if ALL sensors passed (exit code 0). */
  allPassed: boolean;
}

// ── Constants ─────────────────────────────────────────────────────────────

const DEFAULT_TIMEOUT_MS = 120_000; // 2 minutes
const MAX_OUTPUT_CHARS = 4096; // cap stdout/stderr in reports

// ── Sensor execution engine ───────────────────────────────────────────────

/**
 * Run a list of sensors sequentially in the given working directory.
 *
 * Each sensor receives these environment variables:
 *   SENSOR_FILES   — space-separated list of file paths the sensor should inspect
 *   SENSOR_OUTPUT  — path where the sensor should write its JSON report
 *   SENSOR_CWD      — the working directory (same as cwd param)
 *
 * Sensor reports are written to `{specPath}/sensors/` for persistence
 * and also appended to the task's output log.
 *
 * @returns A SensorRunResult with all reports and a summary `allPassed` flag.
 */
export async function runSensors(
  sensors: SensorConfig[],
  hook: string,
  params: {
    cwd: string;
    specPath: string;
    files: string[];
    subtaskId?: number;
    logFile?: string;
  },
): Promise<SensorRunResult> {
  if (!sensors || sensors.length === 0) {
    return { hook, reports: [], allPassed: true };
  }

  const reports: SensorReport[] = [];

  for (const sensor of sensors) {
    const label = sensor.label || sensor.command.split(' ')[0];
    const timeout = sensor.timeout || DEFAULT_TIMEOUT_MS;

    // Ensure the sensors output directory exists
    const sensorsDir = path.join(params.specPath, 'sensors');
    if (!existsSync(sensorsDir)) {
      try { mkdirSync(sensorsDir, { recursive: true }); }
      catch (err) { warn('sensors', `Failed to create sensors output dir ${sensorsDir}`, err); }
    }

    const subtaskSuffix = params.subtaskId !== undefined ? `-st${params.subtaskId}` : '';
    const sensorSlug = label.replace(/[^a-zA-Z0-9_-]/g, '-').toLowerCase();
    const outputPath = path.join(sensorsDir, `${hook}-${sensorSlug}${subtaskSuffix}.json`);

    const filesList = params.files.length > 0 ? params.files.join(' ') : '';

    const report: SensorReport = {
      sensor: label,
      command: sensor.command,
      exitCode: null,
      stdout: '',
      stderr: '',
      passed: false,
    };

    try {
      const { stdout, stderr } = await execFileAsync(
        process.env.SHELL || (process.platform === 'win32' ? 'cmd.exe' : '/bin/sh'),
        [process.platform === 'win32' ? '/c' : '-c', sensor.command],
        {
          cwd: params.cwd,
          timeout,
          env: {
            ...process.env,
            SENSOR_FILES: filesList,
            SENSOR_OUTPUT: outputPath,
            SENSOR_CWD: params.cwd,
          },
          maxBuffer: 1024 * 1024, // 1 MB
        },
      );

      report.exitCode = 0;
      report.stdout = stdout.slice(0, MAX_OUTPUT_CHARS);
      report.stderr = stderr.slice(0, MAX_OUTPUT_CHARS);
      report.passed = true;
    } catch (err: unknown) {
      const execErr = err as {
        code?: string;
        killed?: boolean;
        signal?: string;
        stdout?: string;
        stderr?: string;
        message?: string;
      };

      if (execErr.killed) {
        report.error = `Sensor timed out after ${timeout}ms`;
        report.exitCode = null;
      } else if (execErr.code === 'ENOENT') {
        report.error = `Command not found: ${sensor.command}`;
        report.exitCode = null;
      } else {
        const exitCode: unknown = (execErr as unknown as { code: unknown }).code;
        report.exitCode = typeof exitCode === 'number' ? exitCode : 1;
        report.stdout = (execErr.stdout || '').slice(0, MAX_OUTPUT_CHARS);
        report.stderr = (execErr.stderr || '').slice(0, MAX_OUTPUT_CHARS);
        report.passed = false;
        report.error = execErr.message?.slice(0, MAX_OUTPUT_CHARS);
      }
    }

    // Write the report to disk (idempotent — overwrites on re-runs)
    try {
      writeFileSync(outputPath, JSON.stringify(report, null, 2));
    } catch (err) {
      warn('sensors', `Failed to write sensor report ${outputPath}`, err);
    }

    // Append to the task's output log
    if (params.logFile) {
      try {
        const status = report.passed ? 'PASS' : (report.error ? 'ERROR' : 'FAIL');
        appendFileSync(
          params.logFile,
          `\n[SENSOR:${hook}] ${label} — ${status} (exit ${report.exitCode ?? 'null'})\n` +
          (report.error ? `  Error: ${report.error}\n` : '') +
          (report.stderr ? `  stderr: ${report.stderr.slice(0, 200)}\n` : ''),
        );
      } catch (err) {
        warn('sensors', 'Failed to append sensor result to output log', err);
      }
    }

    reports.push(report);
  }

  return {
    hook,
    reports,
    allPassed: reports.every(r => r.passed),
  };
}

/**
 * Produce a summary string for appending to output.log or a QA report.
 */
export function sensorRunSummary(result: SensorRunResult): string {
  if (result.reports.length === 0) return '';
  const lines = result.reports.map(r => {
    const status = r.passed ? 'PASS' : (r.error ? 'ERROR' : 'FAIL');
    return `  [${status}] ${r.sensor} (exit ${r.exitCode ?? 'null'})` +
      (r.error ? ` — ${r.error}` : '');
  });
  return `\nSensor results for ${result.hook}:\n${lines.join('\n')}\n`;
}

// ── Pipeline config reader ───────────────────────────────────────────────

/**
 * Read the sensors config from the project's pipeline.json.
 * Returns undefined if no sensors section is present (fully optional).
 */
export function readPipelineSensors(pipelineConfig: Record<string, unknown>): SensorsConfig | undefined {
  if (!pipelineConfig.sensors || typeof pipelineConfig.sensors !== 'object') {
    return undefined;
  }
  const raw = pipelineConfig.sensors as Record<string, unknown>;
  const result: SensorsConfig = {};

  for (const hook of ['pre_subtask', 'post_subtask', 'pre_merge', 'on_failure'] as const) {
    const arr = raw[hook];
    if (Array.isArray(arr)) {
      const sensors: SensorConfig[] = [];
      for (const item of arr) {
        if (typeof item === 'string') {
          sensors.push({ command: item });
        } else if (typeof item === 'object' && item !== null && typeof (item as SensorConfig).command === 'string') {
          sensors.push(item as SensorConfig);
        }
        // skip malformed entries silently
      }
      if (sensors.length > 0) result[hook] = sensors;
    }
  }

  return Object.keys(result).length > 0 ? result : undefined;
}
