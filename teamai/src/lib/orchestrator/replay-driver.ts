/**
 * Deterministic driver for git operations that replay commits and can stop on
 * conflicts: `git rebase` (syncing a branch with its base or its own remote)
 * and `git cherry-pick` (landing a subtask branch). Nothing here creates a
 * merge commit.
 *
 * The orchestrator does everything that does not need judgment: it detects the
 * stop, stages the resolution, runs the project's verification, continues the
 * operation (hooks bypassed), skips a replayed commit that became empty, and
 * aborts only on an error it cannot recover from. The merger agent is spawned
 * only for a stop that has conflicts, or whose verification failed after the
 * agent's resolution, and only to edit files. It is respawned — with the
 * failing output — until the stop is clean and verified: a rebase or cherry-pick
 * is expected to eventually succeed, so there is no attempt cap on conflicts or
 * failing checks.
 *
 * Failure policy for the session itself: a rate limit or a user stop propagates
 * (the operation is aborted so the worktree is left clean and the phase can be
 * resumed); a session that crashes, stalls or cannot start is retried with a
 * growing backoff, and only after `replayConfig.maxConsecutiveSessionFailures`
 * in a row does the driver throw a WorktreeError — an infrastructure problem
 * that more merger sessions cannot fix, surfaced loudly rather than looping.
 */
import { existsSync, readFileSync, unlinkSync } from 'fs';
import path from 'path';
import { processManager } from '../process-manager';
import { renderCommand } from '../command-templates';
import { runSensors, type SensorConfig } from '../sensors';
import { updateSessionMap, logToOutput, computePipelineConfig } from './helpers';
import { RateLimitError } from './rate-limit';
import { SessionKilledError, WorktreeError } from './errors';
import type { AgentSession } from '../process-manager';
import type { SessionOptsResult } from './types';

export type ReplayKind = 'rebase' | 'cherry-pick';

export interface ReplayDeps {
  execGit: (args: string[], hostCwd: string) => Promise<void>;
  execGitCapture: (args: string[], hostCwd: string) => Promise<string>;
  sessionOpts: (role: AgentSession['role'], cwd: string, taskId: string, logFile?: string) => SessionOptsResult;
  waitForCompletion: (sessionId: string) => Promise<void>;
}

export interface ReplayOptions {
  kind: ReplayKind;
  worktreePath: string;
  taskId: string;
  projectRoot: string;
  /** Directory holding output.log / output-merge.log / the session map (the spec dir). */
  logDir: string;
  /** Text handed to the merger command as $ARGUMENTS (e.g. the ref being rebased onto). */
  request: string;
  logPrefix?: string;
  /** Overrides the sensors read from the project's pipeline config (tests). */
  sensors?: SensorConfig[];
}

/** Tunables, exported so tests can zero the backoff. */
export const replayConfig = {
  maxConsecutiveSessionFailures: 5,
  /** Backoff before respawning after a failed session: base * 2^(n-1), capped. */
  sessionFailureBackoffMs: 2000,
  sessionFailureBackoffCapMs: 30_000,
  /** Safety bound on the stops one operation is driven through. */
  maxSteps: 5000,
};

/** File a merger writes (in the spec dir) to declare a failing check unrelated to its resolution. */
export const CHECKS_WAIVER_FILE = 'integration_checks_waiver.md';

const COMMAND_FOR: Record<ReplayKind, string> = {
  'rebase': 'resolve-rebase',
  'cherry-pick': 'resolve-cherry-pick',
};

const NO_VERIFICATION_NOTE =
  '\n\nNo verification command is configured for the orchestrator to run for you: before you finish, ' +
  'run the project\'s test suite ONCE and fix failures your resolution caused.';

/** `git -c … <kind> --continue` with hooks and the editor disabled. */
const continueArgs = (kind: ReplayKind) =>
  ['-c', 'core.editor=true', '-c', 'core.hooksPath=/dev/null', kind, '--continue'];

async function unmergedFiles(deps: ReplayDeps, wt: string): Promise<string> {
  return (await deps.execGitCapture(['diff', '--name-only', '--diff-filter=U'], wt)).trim();
}

/** True while the replay operation is stopped mid-way in the worktree. */
export async function replayInProgress(
  deps: Pick<ReplayDeps, 'execGitCapture'>, kind: ReplayKind, wt: string,
): Promise<boolean> {
  if (kind === 'cherry-pick') {
    try {
      // Require non-empty output: a real `git rev-parse --verify` either throws or prints a SHA.
      return (await deps.execGitCapture(['rev-parse', '--verify', 'CHERRY_PICK_HEAD'], wt)).trim().length > 0;
    } catch { return false; }
  }
  for (const dir of ['rebase-merge', 'rebase-apply']) {
    try {
      const p = (await deps.execGitCapture(['rev-parse', '--git-path', dir], wt)).trim();
      if (p && existsSync(path.resolve(wt, p))) return true;
    } catch { /* treat as not in progress */ }
  }
  return false;
}

export async function abortReplay(
  deps: Pick<ReplayDeps, 'execGit'>, kind: ReplayKind, wt: string,
): Promise<void> {
  try { await deps.execGit([kind, '--abort'], wt); } catch { /* nothing to abort */ }
}

function sensorsFor(o: ReplayOptions): SensorConfig[] {
  if (o.sensors) return o.sensors;
  try {
    const cfg = computePipelineConfig(o.projectRoot).sensors;
    return cfg?.post_integration ?? cfg?.pre_merge ?? [];
  } catch { return []; }
}

/**
 * Run the project's verification against the resolved worktree. Returns null
 * when it passes (or a failure was waived by the merger), otherwise the report
 * to hand back to the merger.
 */
async function verify(o: ReplayOptions, sensors: SensorConfig[]): Promise<string | null> {
  if (sensors.length === 0) return null;
  const result = await runSensors(sensors, 'post_integration', {
    cwd: o.worktreePath, specPath: o.logDir, files: [], logFile: path.join(o.logDir, 'output.log'),
  });
  if (result.allPassed) return null;

  const waiver = path.join(o.logDir, CHECKS_WAIVER_FILE);
  if (existsSync(waiver)) {
    let reason = '';
    try { reason = readFileSync(waiver, 'utf-8').trim(); } catch { /* best-effort */ }
    try { unlinkSync(waiver); } catch { /* best-effort */ }
    logToOutput(o.logDir,
      `\n${o.logPrefix ?? '[INFO] '}Verification failed after the resolution, but the merger declared it unrelated — proceeding:\n${reason}\n`);
    return null;
  }

  return result.reports.filter(r => !r.passed).map(r =>
    `- ${r.sensor} (\`${r.command}\`) — ${r.error ?? `exit ${r.exitCode}`}\n` +
    (r.stderr ? `  stderr:\n${indent(r.stderr)}\n` : '') +
    (r.stdout ? `  stdout:\n${indent(r.stdout)}\n` : '')).join('');
}

const indent = (s: string) => s.trimEnd().split('\n').map(l => '    ' + l).join('\n');

async function sleep(ms: number): Promise<void> {
  if (ms > 0) await new Promise(r => setTimeout(r, ms));
}

/**
 * Backoff before retry number `n` (1-based) after a failure: base * 2^(n-1), capped.
 * TEAMAI_REPLAY_BACKOFF_MS overrides the base (the test setup zeroes it).
 */
export function replayBackoffMs(n: number): number {
  const override = process.env.TEAMAI_REPLAY_BACKOFF_MS;
  const base = override !== undefined && override !== '' ? Number(override) : replayConfig.sessionFailureBackoffMs;
  return Math.min(base * 2 ** (n - 1), replayConfig.sessionFailureBackoffCapMs);
}

export const sleepBackoff = (n: number) => sleep(replayBackoffMs(n));

/**
 * Drive a replay operation that is currently stopped (conflicts and/or an
 * unverified resolution) to completion. Resolves when the operation has
 * finished; throws (after aborting the operation) only for the errors listed in
 * the module comment.
 */
export async function driveReplay(deps: ReplayDeps, o: ReplayOptions): Promise<void> {
  const wt = o.worktreePath;
  const prefix = o.logPrefix ?? '[INFO] ';
  const sensors = sensorsFor(o);
  const label = o.kind === 'rebase' ? 'rebase' : 'cherry-pick';

  let conflictsAtStop = false;       // a merger has touched the current stop
  let failureReport: string | null = null;
  let sessions = 0;
  let sessionFailures = 0;

  const spawnMerger = async (reason: string): Promise<void> => {
    sessions++;
    logToOutput(o.logDir, `\n${prefix}${reason} — spawning merger to resolve it in the ${label} (session ${sessions})\n`);
    let request = o.request;
    if (sensors.length === 0) request += NO_VERIFICATION_NOTE;
    if (failureReport) {
      request += '\n\n## Verification failed after your previous resolution\n\n' +
        'The orchestrator ran the project\'s verification on your resolution and it failed. Fix what your ' +
        'resolution broke, `git add` the files, and finish. If a failure is unrelated to the files you ' +
        `resolved (it fails on the base too), write a short explanation to \`$TEAMAI_SPEC_DIR/${CHECKS_WAIVER_FILE}\` ` +
        'instead.\n\n' + failureReport;
    }
    try {
      const mergeLogFile = path.join(o.logDir, 'output-merge.log');
      const sessionId = await processManager.createSession(deps.sessionOpts('merger', wt, o.taskId, mergeLogFile));
      updateSessionMap(o.logDir, 'merge', sessionId);
      processManager.sendMessage(sessionId, renderCommand(COMMAND_FOR[o.kind], request));
      await deps.waitForCompletion(sessionId);
      processManager.killSession(sessionId);
      sessionFailures = 0;
    } catch (err) {
      if (err instanceof RateLimitError) throw err;
      // A user stop kills the session without a reason; the stall detector kills with 'stalled'.
      if (err instanceof SessionKilledError && err.reason !== 'stalled') throw err;
      sessionFailures++;
      const msg = err instanceof Error ? err.message : String(err);
      logToOutput(o.logDir, `\n[WARN] Merger session failed (${sessionFailures}/${replayConfig.maxConsecutiveSessionFailures}): ${msg}\n`);
      if (sessionFailures >= replayConfig.maxConsecutiveSessionFailures) {
        throw new WorktreeError(
          `The merger session failed ${sessionFailures} times in a row while resolving a ${label}: ${msg}`,
          'MERGER_SESSION_FAILED',
        );
      }
      await sleepBackoff(sessionFailures);
    }
  };

  try {
    for (let step = 0; step < replayConfig.maxSteps; step++) {
      const unmerged = await unmergedFiles(deps, wt);
      if (unmerged) {
        conflictsAtStop = true;
        await spawnMerger(`${unmerged.split('\n').length} file(s) in conflict`);
        continue;
      }
      if (!(await replayInProgress(deps, o.kind, wt))) return;

      // No conflicts left at this stop. Verify a resolution the merger produced.
      if (conflictsAtStop) {
        failureReport = await verify(o, sensors);
        if (failureReport) {
          conflictsAtStop = true;
          await spawnMerger('Verification failed after the resolution');
          continue;
        }
      }

      // The orchestrator finishes the stop itself.
      await deps.execGit(['add', '-A', '--', '.', ':!.teamai'], wt);
      conflictsAtStop = false;
      failureReport = null;
      try {
        await deps.execGit(continueArgs(o.kind), wt);
      } catch {
        // Either the next commit conflicts (handled at the top of the loop) or
        // the replayed commit became empty after the resolution: skip it.
        if (!(await unmergedFiles(deps, wt)) && await replayInProgress(deps, o.kind, wt)) {
          logToOutput(o.logDir, `\n${prefix}Replayed commit is empty after the resolution — skipping it\n`);
          await deps.execGit([o.kind, '--skip'], wt);
        }
      }
    }
    throw new WorktreeError(`${label} still in progress after ${replayConfig.maxSteps} steps`, 'REPLAY_STEP_LIMIT');
  } catch (err) {
    await abortReplay(deps, o.kind, wt);
    throw err;
  }
}
