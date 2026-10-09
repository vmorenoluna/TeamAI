/**
 * Shared ADR-002 wakeup primitives.
 *
 * ADR-002 originally shipped implement-only: a coder subtask that starts a
 * long-running background job — a script, benchmark, verification run, or
 * data pipeline; what the job actually does is project-specific, the
 * orchestrator only cares that it outlives the session — can write
 * `subtask_wakeup-st<ID>.json` and end its session; the orchestrator pauses
 * just that subtask, schedules a timer, and re-enters with a
 * `⚠️ WAKEUP RE-ENTRY` prompt instead of treating the missing deliverable as
 * a failure. The scheduling/timer/resume half of that mechanism
 * (`_scheduleWakeup`/`_fireWakeup` in orchestrator.ts, `handleRateLimit`'s
 * sibling) was always phase-agnostic — it operates on the generic
 * `TaskPipeline` and just re-invokes `executePhase`, whatever phase that
 * currently is. Only the DETECTION half (scanning for the file, parsing it,
 * tracking attempt counts, building the re-entry prompt) lived exclusively
 * inside implement.ts's per-subtask loop.
 *
 * That gap surfaced for real: an analyst session (spec phase) launched a
 * multi-hour deterministic verification job, correctly said it would wait
 * for it to finish, and then its turn simply ended — headless pipeline
 * sessions have no interactive `ScheduleWakeup`-style capability to actually
 * wait across turns. `runSpecPhase` had no wakeup detection at all, so it
 * treated the missing `spec.md` as a hard failure and parked the task for
 * human review, discarding a legitimate multi-hour job that was still
 * running.
 *
 * This module extracts the phase-agnostic detection primitives so
 * implement.ts, runSpecPhase, runPlanPhase, and runQaReview all drive the
 * exact same wakeup-file contract instead of each phase growing its own copy
 * (or, as before, some phases growing none at all). implement.ts keeps its
 * own subtask-multiplicity orchestration (isolating to one subtask among
 * many, adopting the earliest wakeup when several subtasks in a parallel
 * group each schedule one) — that concern doesn't exist for the single-session
 * phases — but calls into these same primitives for the actual file
 * scanning, parsing, attempt-count bookkeeping, staleness verification, and
 * prompt text.
 *
 * A second gap surfaced later, on the same task, twice in a row: an analyst
 * session detached a multi-hour A/B benchmark, narrated an intent to wait for it,
 * and then its turn simply ended — without ever writing phase_wakeup.json.
 * The file-based contract above only has a safety net for a session that was
 * ALREADY mid-wakeup-cycle going silent (`checkStaleWakeupReentry`); a FIRST
 * session that launches background work and goes silent without ever writing
 * the file once had no net at all, so the orchestrator correctly, but
 * wastefully, treated it as a missing artifact and parked for human review —
 * discarding hours of still-running (or already-finished, uncollected) real
 * work both times. `findLiveOrphanedJob` below closes that gap: it looks for
 * a still-alive process behind one of the `*.pid` files the wakeup protocol
 * already asks agents to record, and — if found — synthesizes a wakeup cycle
 * instead of trusting the agent's silence as "nothing to wait for."
 */
import { existsSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'fs';
import path from 'path';
import { logToOutput } from './helpers';
import type { TaskPipeline } from './types';
import type { FailureReason } from './qa-feedback';

// ── Wakeup file contract ─────────────────────────────────────────────────

/** Shape of a `*_wakeup.json` file, written by an agent session that needs
 *  to pause for a background process. `subtask_id` is only meaningful for
 *  implement.ts's per-subtask files — the single-session phases (spec, plan,
 *  qa-review) never populate it. */
export interface WakeupFileData {
  wakeup_at: string;
  subtask_id?: number;
  background_command?: string;
  expected_artifact?: string;
  progress_log_path?: string;
}

/** Filename a spec/plan/qa-review session writes when it needs to pause for
 *  a background process. Unlike implement's per-subtask
 *  `subtask_wakeup-st<ID>.json` files, these phases run exactly one session
 *  at a time, so a single fixed name is unambiguous. Deliberately distinct
 *  from implement's `subtask_wakeup.json` legacy name so the two mechanisms
 *  can never collide on disk. */
export const PHASE_WAKEUP_FILENAME = 'phase_wakeup.json';

/**
 * Parse a wakeup file's contents. Returns null when the JSON is malformed or
 * missing the one field every caller requires (`wakeup_at`) — callers that
 * also require `subtask_id` (implement.ts) check that themselves on the
 * returned object, since that requirement doesn't apply to single-session
 * phases.
 */
export function parseWakeupFile(raw: string): WakeupFileData | null {
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && typeof parsed.wakeup_at === 'string') {
      return parsed as WakeupFileData;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * List wakeup files in `dir` matching `pattern` (skipped when null — the
 * single-session phases have no per-unit pattern, only a fixed filename),
 * plus `legacyFilename` if it exists. Best-effort: an unreadable directory
 * yields an empty pattern match rather than throwing.
 */
export function scanWakeupFiles(dir: string, pattern: RegExp | null, legacyFilename?: string): string[] {
  const found: string[] = [];
  if (pattern) {
    try {
      for (const f of readdirSync(dir)) {
        if (pattern.test(f)) found.push(path.join(dir, f));
      }
    } catch { /* best-effort */ }
  }
  if (legacyFilename) {
    const legacyPath = path.join(dir, legacyFilename);
    if (existsSync(legacyPath)) found.push(legacyPath);
  }
  return found;
}

/**
 * Same as {@link scanWakeupFiles}, with an optional retry loop for the
 * bind-mount sync race: in container mode, a session's writes only become
 * visible on the host once the bind mount syncs — not instantaneous,
 * particularly on Windows/Docker Desktop, worse under I/O contention. A scan
 * taken immediately after the session's process exits can race a wakeup file
 * the session definitely wrote. Retries up to 4 times, `retryDelayMs` apart,
 * only when the first scan comes back empty and `shouldRetry` says a miss
 * would actually change the outcome (a re-entry session, or a check about to
 * treat "no wakeup file" as "produce the required artifact or fail").
 */
export async function scanWakeupFilesWithRetry(
  dir: string,
  pattern: RegExp | null,
  legacyFilename: string | undefined,
  retryDelayMs: number,
  shouldRetry: boolean,
): Promise<string[]> {
  let found = scanWakeupFiles(dir, pattern, legacyFilename);
  if (retryDelayMs > 0 && found.length === 0 && shouldRetry) {
    for (let attempt = 0; attempt < 4 && found.length === 0; attempt++) {
      await new Promise(resolve => setTimeout(resolve, retryDelayMs));
      found = scanWakeupFiles(dir, pattern, legacyFilename);
    }
  }
  return found;
}

/**
 * True when a wakeup re-entry relaunched the background job under a
 * MATERIALLY DIFFERENT command rather than just rescheduling the same
 * still-running one. That's forward progress (the engineer diagnosed and
 * fixed a real blocker) and earns a fresh attempt budget instead of
 * consuming the old one — see `computeAttemptCount`'s doc for why this
 * matters for the circuit breaker.
 */
export function isGenuineRelaunch(previousCommand: string | undefined, newCommand: string | undefined): boolean {
  return !!previousCommand && !!newCommand && newCommand !== previousCommand;
}

/**
 * Compute the next `wakeupAttemptCount` for a freshly detected wakeup file.
 * Resets to 1 (not merely decremented) on a genuine relaunch so the
 * relaunched job gets the full cap's worth of checks, matching the budget
 * any fresh background attempt is expected to need. Otherwise increments —
 * "still waiting on the same job" keeps consuming the shared attempt budget.
 */
export function computeNextAttemptCount(previousCommand: string | undefined, wd: WakeupFileData, currentCount: number): number {
  return isGenuineRelaunch(previousCommand, wd.background_command) ? 1 : currentCount + 1;
}

/** Safe mtime lookup — null if the file doesn't exist or can't be stat'd. */
export function snapshotMtime(absPath: string): number | null {
  try {
    return existsSync(absPath) ? statSync(absPath).mtimeMs : null;
  } catch {
    return null;
  }
}

/**
 * Check whether a declared wakeup artifact actually advanced since it was
 * last snapshotted. A wakeup re-entry session that ends WITHOUT writing a
 * fresh wakeup file is normally trusted as "the job genuinely finished," but
 * a session monitoring a long-running background job can run out of turns
 * mid-check and simply stop without ever reaching its own "if still running,
 * reschedule" instruction — leaving the job still running, uncollected,
 * while the orchestrator silently moves on. An unchanged (or still missing)
 * mtime means nothing new was produced during this cycle.
 */
export function checkArtifactProgress(
  cwd: string,
  relArtifact: string | undefined,
  mtimeAtSchedule: number | null | undefined,
): { producedThisCycle: boolean; currentMtime: number | null } {
  if (!relArtifact) return { producedThisCycle: false, currentMtime: null };
  const currentMtime = snapshotMtime(path.join(cwd, relArtifact));
  const producedThisCycle = currentMtime != null && (mtimeAtSchedule == null || currentMtime > mtimeAtSchedule);
  return { producedThisCycle, currentMtime };
}

/**
 * Tolerance subtracted from `sinceMtimeMs` before comparing against a pid
 * file's mtime in {@link findLiveOrphanedJob}. Some filesystems (observed on
 * CI's Linux runners, not reproduced locally on Windows/NTFS) round a
 * just-written file's mtime down to a coarser boundary than `Date.now()`'s
 * millisecond precision, so a file written a genuine instant after
 * `sinceMtimeMs` can still stat back with an mtime that compares earlier.
 * A few seconds of slack costs nothing against the case this guards —
 * rejecting a leftover pid file from an actually earlier, unrelated run of
 * the same task, which is stale by minutes or hours, not low single-digit
 * seconds.
 */
const MTIME_TOLERANCE_MS = 5000;

/**
 * Scan `dir` (recursively — agents organize their own subdirectories, e.g. a
 * `ab-run/` folder for an A/B job) for `*.pid` files written no earlier than
 * `sinceMtimeMs` (within {@link MTIME_TOLERANCE_MS}), and return the first
 * one whose recorded process is still alive. The mtime floor matters:
 * without it, a leftover `*.pid` from a long-finished, unrelated earlier run
 * of this same task could falsely match if the OS has since recycled that
 * PID number onto some other running process — restricting the scan to
 * files this session could plausibly have written removes that
 * false-positive window.
 *
 * Best-effort throughout: an unreadable directory, a malformed/empty pid
 * file, or a liveness check that fails for a reason other than "no such
 * process" are all treated as "nothing found here" rather than throwing —
 * the caller's fallback (park for human review) is always a safe direction
 * to fail in.
 */
export function findLiveOrphanedJob(dir: string, sinceMtimeMs: number): { pidFile: string; pid: number } | null {
  let entries: string[];
  try {
    entries = readdirSync(dir, { recursive: true }) as string[];
  } catch {
    return null;
  }
  for (const entry of entries) {
    if (!entry.endsWith('.pid')) continue;
    const pidFile = path.join(dir, entry);
    try {
      if (statSync(pidFile).mtimeMs < sinceMtimeMs - MTIME_TOLERANCE_MS) continue;
    } catch {
      continue;
    }
    let raw: string;
    try {
      raw = readFileSync(pidFile, 'utf-8').trim();
    } catch {
      continue;
    }
    const pid = Number(raw);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    try {
      process.kill(pid, 0);
      return { pidFile, pid };
    } catch (err) {
      // EPERM means the process exists but we lack permission to signal it —
      // still alive from our perspective. ESRCH (or anything else) means no
      // such process — keep scanning other pid files.
      if ((err as NodeJS.ErrnoException).code === 'EPERM') return { pidFile, pid };
    }
  }
  return null;
}

/** Clear every wakeup-related field on the pipeline. Shared by every phase's
 *  "wakeup cycle genuinely completed" and "wakeup attempt cap exceeded"
 *  paths — `wakeupSubtaskId` is a no-op reset for the single-session phases
 *  (spec/plan/qa-review never set it), so this is safe to call unconditionally. */
export function clearWakeupState(pipeline: TaskPipeline): void {
  pipeline.wakeupUntil = undefined;
  pipeline.wakeupSubtaskId = undefined;
  pipeline.wakeupCommand = undefined;
  pipeline.wakeupArtifact = undefined;
  pipeline.wakeupProgressPath = undefined;
  pipeline.wakeupAttemptCount = 0;
  pipeline.wakeupArtifactMtimeAtSchedule = undefined;
  pipeline.wakeupHeadAtSchedule = undefined;
}

/** True once `wakeupAttemptCount` reaches the configured cap — the shared
 *  circuit breaker check for every phase's wakeup timer block. */
export function wakeupAttemptsExceeded(pipeline: TaskPipeline, maxAttempts: number): boolean {
  return (pipeline.wakeupAttemptCount || 0) >= maxAttempts;
}

// ── Re-entry prompt ──────────────────────────────────────────────────────

export interface WakeupReentryHeaderOptions {
  /** What was paused — "this subtask" (implement) or "the spec phase" / "the
   *  plan phase" / "the QA review" (single-session phases). */
  unitLabel: string;
  /** The wakeup filename to name in the "still running" instruction, e.g.
   *  `subtask_wakeup-st3.json` or `phase_wakeup.json`. */
  wakeupFilename: string;
  command?: string;
  artifact?: string;
  /** Include the "run verification from this worktree, not the project
   *  root" note — relevant when the re-entered session runs in a worktree
   *  (implement, qa-review) but not spec/plan, which run in the project root
   *  and haven't created (or don't use) a worktree yet. */
  worktreeNote?: boolean;
  /** Worktree HEAD when the wakeup was scheduled vs. now. Rendered as a
   *  warning only when both are known and differ. */
  headAtSchedule?: string;
  currentHead?: string;
}

/** Warning appended to a re-entry prompt when the branch HEAD moved while the
 *  task was paused (typically a rebase onto a base that gained commits).
 *  Empty when either SHA is unknown or they match. */
export function buildHeadMovedNote(headAtSchedule?: string, currentHead?: string): string {
  if (!headAtSchedule || !currentHead || headAtSchedule === currentHead) return '';
  return "WARNING: this branch's HEAD moved while you were paused (" + headAtSchedule.slice(0, 7) + ' → ' +
    currentHead.slice(0, 7) + ') — e.g. a rebase onto a base that gained commits. The background job was\n' +
    'started against ' + headAtSchedule.slice(0, 7) + ', so whatever it produced describes that revision, not\n' +
    'this one. If your deliverables must be recorded at the current HEAD (a build SHA in a log, a benchmark\n' +
    'baseline), do not collect that output as evidence: stop the old job, relaunch it against the current\n' +
    'HEAD, and schedule a new wakeup.\n\n';
}

/** Build the `⚠️ WAKEUP RE-ENTRY` prompt header injected ahead of a
 *  re-entered session's normal instructions. Shared verbatim structure
 *  across implement/spec/plan/qa-review so the re-entry contract — check the
 *  artifact, reschedule if still running, report failure if crashed, never
 *  call an interactive ScheduleWakeup-style tool — reads identically no
 *  matter which phase paused. */
export function buildWakeupReentryHeader(opts: WakeupReentryHeaderOptions): string {
  return '⚠️ WAKEUP RE-ENTRY\n\n' +
    'Your previous session for ' + opts.unitLabel + ' was paused to wait for a background process.\n' +
    'Background command: ' + (opts.command || 'unknown') + '\n' +
    'Expected artifact to verify: ' + (opts.artifact || 'unknown') + '\n\n' +
    (opts.worktreeNote
      ? 'CRITICAL: Run ALL verification commands, scripts, and servers from the current\n' +
        'working directory (this worktree) — NOT from the base project root. The code in\n' +
        'this worktree is your branch\'s revision; running from the project root would\n' +
        'exercise the wrong code and produce meaningless results.\n\n'
      : '') +
    buildHeadMovedNote(opts.headAtSchedule, opts.currentHead) +
    'Check if the artifact exists and is complete. If it is: verify it and finish your\n' +
    'normal end-of-session work (commit, write the required file, etc). If it is missing\n' +
    'or incomplete, first check whether the background process is still running:\n' +
    '- If the process is still running: estimate remaining time, write an updated\n' +
    '  ' + opts.wakeupFilename + ' with a new wakeup_at, and end.\n' +
    '- If the process has crashed or exited with an error: do NOT write another wakeup\n' +
    '  file. Report the failure immediately so the task can advance to failed without\n' +
    '  wasting the remaining wakeup attempts.\n\n';
}

// ── Single-session phase detection (spec / plan / qa-review) ────────────

export interface PhaseWakeupCheckOptions {
  pipeline: TaskPipeline;
  /** `.teamai/{taskId}/` — where the agent writes `phase_wakeup.json`. */
  specDir: string;
  /** Directory `expected_artifact` is resolved against for mtime snapshots —
   *  the project root for spec/plan, the worktree for qa-review. */
  cwd: string;
  wakeupScanRetryDelayMs: number;
}

/**
 * Detect and consume a `phase_wakeup.json` written by a spec/plan/qa-review
 * session that needs to pause for a background process. Mirrors implement's
 * per-subtask detection (parse, snapshot the artifact's mtime, apply the
 * genuine-relaunch attempt-count reset, delete the file) without the
 * multi-file/subtask-isolation machinery those phases don't have — there is
 * at most one such file at a time, since only one session runs per phase.
 *
 * Returns true when a (well-formed or malformed) wakeup file was found —
 * malformed files are logged and deleted, same as implement's handling,
 * without arming a wakeup.
 */
export async function checkForPhaseWakeup(opts: PhaseWakeupCheckOptions): Promise<boolean> {
  const wakeupPaths = await scanWakeupFilesWithRetry(
    opts.specDir, null, PHASE_WAKEUP_FILENAME, opts.wakeupScanRetryDelayMs, true,
  );
  if (wakeupPaths.length === 0) return false;

  const wakeupPath = wakeupPaths[0];
  let detected = false;
  try {
    const wd = parseWakeupFile(readFileSync(wakeupPath, 'utf-8'));
    if (wd) {
      const previousCommand = opts.pipeline.wakeupCommand;
      opts.pipeline.wakeupUntil = wd.wakeup_at;
      opts.pipeline.wakeupCommand = wd.background_command;
      opts.pipeline.wakeupArtifact = wd.expected_artifact;
      opts.pipeline.wakeupProgressPath = wd.progress_log_path;
      opts.pipeline.wakeupArtifactMtimeAtSchedule = wd.expected_artifact
        ? snapshotMtime(path.join(opts.cwd, wd.expected_artifact))
        : null;
      opts.pipeline.wakeupAttemptCount = computeNextAttemptCount(
        previousCommand, wd, opts.pipeline.wakeupAttemptCount || 0,
      );
      if (isGenuineRelaunch(previousCommand, wd.background_command)) {
        logToOutput(opts.pipeline.specPath,
          '[WAKEUP] Background command changed since the last wakeup — treating as a fresh attempt ' +
          '(progress was made) and resetting the wakeup attempt budget to 1\n');
      }
      detected = true;
      logToOutput(opts.pipeline.specPath,
        '[WAKEUP] Wakeup scheduled for ' + wd.wakeup_at + ' (attempt ' + opts.pipeline.wakeupAttemptCount +
        ') — background process: ' + (wd.background_command || 'unknown') +
        (wd.progress_log_path ? ' — progress log: ' + wd.progress_log_path : '') + '\n');
    } else {
      logToOutput(opts.pipeline.specPath, '[WAKEUP] Malformed ' + PHASE_WAKEUP_FILENAME + ' — treating as missing\n');
    }
  } catch {
    logToOutput(opts.pipeline.specPath, '[WAKEUP] Malformed ' + PHASE_WAKEUP_FILENAME + ' — treating as missing\n');
  }
  try { unlinkSync(wakeupPath); } catch { /* best-effort */ }
  return detected;
}

export interface StaleWakeupReentryOptions {
  pipeline: TaskPipeline;
  /** Was this session's phase re-entered mid-wakeup-cycle? */
  wasReentry: boolean;
  /** Did THIS session write a fresh wakeup file (checkForPhaseWakeup result)? */
  wakeupDetected: boolean;
  cwd: string;
  rescheduleDelayMs?: number;
  /** Prefixes the log line, e.g. "Subtask 3" or "The spec phase". */
  unitLabel: string;
}

/**
 * Auto-reschedule a follow-up check when a wakeup re-entry session ends
 * without writing a fresh wakeup file AND without the declared artifact
 * having advanced — see `checkArtifactProgress`'s doc for why silence alone
 * isn't trustworthy. No-ops when this wasn't a re-entry, a fresh wakeup was
 * already detected this session, or no artifact was ever declared. Returns
 * true when it rescheduled (caller should treat this exactly like a fresh
 * wakeup detection: pause instead of advancing).
 */
export function checkStaleWakeupReentry(opts: StaleWakeupReentryOptions): boolean {
  if (!opts.wasReentry || opts.wakeupDetected || !opts.pipeline.wakeupArtifact) return false;
  const { producedThisCycle, currentMtime } = checkArtifactProgress(
    opts.cwd, opts.pipeline.wakeupArtifact, opts.pipeline.wakeupArtifactMtimeAtSchedule,
  );
  if (producedThisCycle) return false;

  const attemptCount = (opts.pipeline.wakeupAttemptCount || 0) + 1;
  opts.pipeline.wakeupAttemptCount = attemptCount;
  opts.pipeline.wakeupArtifactMtimeAtSchedule = currentMtime;
  opts.pipeline.wakeupUntil = new Date(Date.now() + (opts.rescheduleDelayMs ?? 15 * 60_000)).toISOString();
  logToOutput(opts.pipeline.specPath,
    '[WAKEUP] ' + opts.unitLabel + ' re-entry ended without a fresh wakeup file, but the expected artifact (' +
    opts.pipeline.wakeupArtifact + ') was not updated since the last check — the background job is likely ' +
    'still running. Auto-rescheduling a follow-up check in 15 minutes (attempt ' + attemptCount + ')\n');
  return true;
}

// ── Single-session phase orchestration (spec / plan / qa-review) ────────

export interface PhaseWakeupDeps {
  getPipelineConfig: () => { wakeupScanRetryDelayMs?: number; maxImplementRetries: number };
  scheduleWakeup: (pipeline: TaskPipeline) => void;
  savePipelineState: (pipeline: TaskPipeline) => void;
  writeCompletionSummary: (pipeline: TaskPipeline, reason: FailureReason, detail?: string) => void;
  /** Only ever called with 'failed' here — typed narrowly so this module
   *  doesn't need to import the full PipelinePhase union. */
  advancePhase: (pipeline: TaskPipeline, phase: 'failed', eventExtra?: Record<string, unknown>) => void;
}

export interface ResolvePhaseWakeupOptions {
  pipeline: TaskPipeline;
  /** `.teamai/{taskId}/` — where `phase_wakeup.json` and qa_report.json live. */
  specDir: string;
  /** Directory `expected_artifact` resolves against (project root for
   *  spec/plan, the worktree for qa-review). */
  cwd: string;
  /** Was this phase invocation a wakeup re-entry (i.e. did `wakeupCommand`
   *  already carry over from a previous cycle when this session started)? */
  wasReentry: boolean;
  /** `Date.now()` captured just before this phase's session was dispatched —
   *  the mtime floor for `findLiveOrphanedJob`'s pid-file scan, so a stale
   *  pid file from an earlier, unrelated run of this task can't false-match. */
  sessionStartedAt: number;
  /** Named in logs and the synthetic FAIL report, e.g. "The spec phase". */
  unitLabel: string;
  /** Absolute paths of the files that constitute this phase's finished
   *  output (spec.md + spec_summary.md, plan.json, qa_report.json). A
   *  re-entry that ends silently with every one of them written during
   *  that session has finished its work — whatever background job it once
   *  waited on is no longer what the phase is blocked on. */
  deliverables?: string[];
  deps: PhaseWakeupDeps;
}

/** True when every deliverable exists and was written during the session
 *  that started at `sessionStartedAt` (same mtime slack as the pid scan). */
function deliverablesWrittenSince(deliverables: string[] | undefined, sessionStartedAt: number): boolean {
  if (!deliverables || deliverables.length === 0) return false;
  return deliverables.every(f => {
    const mtime = snapshotMtime(f);
    return mtime != null && mtime >= sessionStartedAt - MTIME_TOLERANCE_MS;
  });
}

/**
 * Full post-session wakeup resolution for a single-session phase (spec,
 * plan, qa-review) — the phase-agnostic counterpart to implement.ts's
 * per-subtask wakeup handling. Call this immediately after the phase's
 * session ends (after `killSession`), before treating a missing expected
 * artifact as a failure.
 *
 * Detects a fresh `phase_wakeup.json`, falls back to the artifact-staleness
 * auto-reschedule when a re-entry ended silently, falls back further to a
 * live-orphaned-job pid scan when the session never wrote a wakeup file at
 * all (see this module's doc for the incident that motivated it), clears
 * wakeup state on a genuine completion, and enforces the same attempt-cap
 * circuit breaker implement.ts uses (reusing `maxImplementRetries` — the
 * existing knob for "how many wakeup cycles before giving up," not
 * implement-specific despite the name).
 *
 * Returns `'pending'` when the caller must return immediately — either a
 * wakeup was scheduled (the timer will re-invoke this same phase) or the
 * attempt cap was exceeded and the task was advanced to `failed`. Returns
 * `'clear'` when there is no pending wakeup and the caller should proceed
 * with its normal post-session artifact checks.
 */
export async function resolvePhaseWakeup(opts: ResolvePhaseWakeupOptions): Promise<'pending' | 'clear'> {
  const pipelineConfig = opts.deps.getPipelineConfig();
  const wakeupDetected = await checkForPhaseWakeup({
    pipeline: opts.pipeline,
    specDir: opts.specDir,
    cwd: opts.cwd,
    wakeupScanRetryDelayMs: pipelineConfig.wakeupScanRetryDelayMs ?? 0,
  });
  // A silent re-entry that wrote the phase's deliverables is a completed
  // phase, not a job still running: the stale-artifact heuristic below only
  // sees the wakeup's *old* expected artifact (e.g. a log from a job that a
  // host restart interrupted and the agent re-ran under new names), which
  // never updates, so it would re-arm until the attempt cap and fail a
  // finished spec as 'wakeup-exhausted'.
  const deliverablesDone = opts.wasReentry && !wakeupDetected &&
    deliverablesWrittenSince(opts.deliverables, opts.sessionStartedAt);
  if (deliverablesDone) {
    logToOutput(opts.pipeline.specPath,
      '[WAKEUP] ' + opts.unitLabel + ' re-entry ended without a wakeup file but wrote its deliverables — ' +
      'treating the phase as complete instead of waiting on ' + (opts.pipeline.wakeupArtifact || 'the old artifact') + '\n');
  }
  const staleRescheduled = !wakeupDetected && !deliverablesDone && checkStaleWakeupReentry({
    pipeline: opts.pipeline, wasReentry: opts.wasReentry, wakeupDetected, cwd: opts.cwd, unitLabel: opts.unitLabel,
  });
  let pending = wakeupDetected || staleRescheduled;

  // Last-resort safety net: the session never wrote phase_wakeup.json at
  // all (so there's nothing to detect or compare staleness against above),
  // but a process behind one of its own recorded pid files is still alive —
  // treat that as hard evidence of in-flight work rather than trusting the
  // silence as "there was nothing to wait for."
  if (!pending && !deliverablesDone) {
    const orphan = findLiveOrphanedJob(opts.specDir, opts.sessionStartedAt);
    if (orphan) {
      pending = true;
      opts.pipeline.wakeupUntil = new Date(Date.now() + 15 * 60_000).toISOString();
      opts.pipeline.wakeupCommand = `auto-detected orphaned background job (PID ${orphan.pid}, ${path.relative(opts.specDir, orphan.pidFile)})`;
      opts.pipeline.wakeupArtifact = undefined;
      opts.pipeline.wakeupAttemptCount = (opts.pipeline.wakeupAttemptCount || 0) + 1;
      logToOutput(opts.pipeline.specPath,
        '[WAKEUP] ' + opts.unitLabel + ' ended without writing phase_wakeup.json, but PID ' + orphan.pid +
        ' (from ' + path.relative(opts.specDir, orphan.pidFile) + ') is still running — auto-scheduling a ' +
        're-entry in 15 minutes instead of treating this as a failure (attempt ' +
        opts.pipeline.wakeupAttemptCount + ')\n');
    }
  }

  if (opts.wasReentry && !pending) {
    clearWakeupState(opts.pipeline);
    logToOutput(opts.pipeline.specPath, '[WAKEUP] ' + opts.unitLabel + ' completed after wakeup — clearing wakeup state\n');
  }

  if (!pending) return 'clear';

  if (wakeupAttemptsExceeded(opts.pipeline, pipelineConfig.maxImplementRetries)) {
    logToOutput(opts.pipeline.specPath,
      '[WAKEUP] ' + opts.unitLabel + ' exceeded wakeup attempt cap (' + pipelineConfig.maxImplementRetries + ') — advancing to failed\n');
    const detail = opts.unitLabel + ' failed to produce its artifact after ' + pipelineConfig.maxImplementRetries +
      ' wakeup attempts. Expected artifact: ' + (opts.pipeline.wakeupArtifact || 'unknown') + '.';
    try {
      writeFileSync(path.join(opts.specDir, 'qa_report.json'), JSON.stringify({
        overall: 'FAIL',
        criteria: [{
          criterion: 'Wakeup attempt limit exceeded',
          name: 'Wakeup attempt limit exceeded',
          status: 'FAIL',
          notes: detail,
        }],
      }, null, 2));
    } catch { /* best-effort — writeCompletionSummary below still records the failure */ }
    clearWakeupState(opts.pipeline);
    opts.deps.writeCompletionSummary(opts.pipeline, 'wakeup-exhausted', detail);
    opts.deps.advancePhase(opts.pipeline, 'failed');
    return 'pending';
  }

  opts.deps.savePipelineState(opts.pipeline);
  opts.deps.scheduleWakeup(opts.pipeline);
  return 'pending';
}
