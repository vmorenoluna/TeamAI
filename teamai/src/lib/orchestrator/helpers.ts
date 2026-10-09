/**
 * Pure helpers and simple utilities extracted from Orchestrator class.
 *
 * These functions have no `this` dependencies — they take all context
 * as parameters and import external modules directly.
 */
import { existsSync, readFileSync, writeFileSync, appendFileSync } from 'fs';
import path from 'path';
import { warn as logWarn } from '../logger';
import { slugify } from '../utils';
import { readContainerConfig } from '../container-manager';
import { resolveProvider, providerToSessionOpts } from '../providers';
import { containerSessionOpts, type AgentSession } from '../process-manager';
import { readPipelineSensors, type SensorsConfig } from '../sensors';
import { MAX_REVISION_SNAPSHOTS } from './artifacts';
import type { PipelinePhase } from '@/constants/phases';

// ── Types ─────────────────────────────────────────────────────────────────

export interface PipelineConfig {
  maxQaAttempts: number;
  parallelSubtasks: boolean;
  sensors?: SensorsConfig;
  /** Single cap governing every retry-and-give-up circuit breaker inside
   *  the implement phase — the same category of question ("how persistent
   *  should coding be before giving up?") at three different granularities:
   *  - a subtask's `files_to_create` deliverable still missing after its
   *    session ends (previously maxDeliverableFails, per-subtask)
   *  - a wakeup-pending subtask's background job never producing its
   *    artifact (previously maxWakeupAttempts, per-wakeup-cycle)
   *  - a full implement pass ending with any subtask still `!completed`
   *    (previously maxIncompleteImplementPasses, per-pass)
   *  All three bypass QA entirely and advance straight to `failed` once
   *  exceeded — QA is an expensive full review; a failure the orchestrator
   *  can already see structurally from plan.json alone would only confirm
   *  that at QA's cost, and with a low maxQaAttempts could fail the whole
   *  task on a review that was doomed before it started. Default 3. */
  maxImplementRetries: number;
  /** Consecutive stall-detector kills a subtask may recover from (fresh
   *  session + retry) before the subtask fails outright. */
  maxStallRecoveries: number;
  /** Minutes a session can be idle (no tool running, no new message) before
   *  the stall-detector kills it. Default 15. */
  idleStallMinutes: number;
  /** Minutes a single tool call can run with no output before the
   *  stall-detector kills the session. Default 30. */
  toolStallMinutes: number;
  /** Merge strategy auto mode uses when auto-merging a green PR/MR (default 'merge'). */
  autoMergeMethod?: 'merge' | 'squash' | 'rebase';
  /** When true, all pipeline processing is skipped — demo data stays pristine. */
  demo?: boolean;
  /** When true (default), completed tasks get a trailer-bearing commit message
   *  (Task/Task-ID/QA/Phases/Reviewed-by) and the PR body gets the same block —
   *  the basis for DONE-ticket reconstruction from git/PR history. When false,
   *  no trailer block is written and no DONE-history reconstruction happens. */
  recordHistoryInGit: boolean;
  /** When true (default), the `Phases:` trailer line is included in the
   *  trailer block. Only meaningful when recordHistoryInGit is true. */
  includePhasesTrailer: boolean;
  /** Milliseconds to wait between retries when a post-session scan for
   *  subtask_wakeup-st<ID>.json finds nothing, before concluding none was
   *  written. In container mode a coder session's writes only reach the
   *  host once the bind mount syncs — not instantaneous, particularly on
   *  Windows/Docker Desktop under I/O contention — so a scan taken
   *  immediately after the session ends can race a wakeup file the coder
   *  definitely wrote (see implement.ts's scanWakeupFiles retry loop).
   *  Optional and defaulting to 0 (no retry) so test deps that don't set
   *  it aren't slowed down; computePipelineConfig gives real pipelines a
   *  production default. */
  wakeupScanRetryDelayMs?: number;
  /** When true (default), every ticket-capable session must write a verified
   *  backlog check (orchestrator/backlog-check.ts) before its phase can
   *  advance. Optional so test deps that don't set it run without the check;
   *  computePipelineConfig gives real pipelines the `true` default. */
  backlogCheck?: boolean;
}

// ── Pure: session-limit parsing ───────────────────────────────────────────

/**
 * Parse a Claude Code session-limit reset time from a log line like
 * "resets 4:30pm (UTC)".  Returns a Unix timestamp (seconds) or null.
 */
export function parseSessionLimitReset(line: string): number | null {
  const m = line.match(/resets\s+(\d+):(\d+)\s*(am|pm)\s*(?:\(UTC\))?/i);
  if (!m) return null;
  let hours = parseInt(m[1], 10);
  const minutes = parseInt(m[2], 10);
  const ampm = m[3].toLowerCase();
  if (ampm === 'pm' && hours !== 12) hours += 12;
  if (ampm === 'am' && hours === 12) hours = 0;
  const now = new Date();
  const reset = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hours, minutes, 0));
  // If the reset time is already in the past today, it must be tomorrow
  if (reset.getTime() <= Date.now()) reset.setUTCDate(reset.getUTCDate() + 1);
  return Math.floor(reset.getTime() / 1000);
}

// ── Pure: PR URL extraction ───────────────────────────────────────────────

/**
 * Scan a log file for a PR/MR URL created by an agent.
 * Supports GitHub PR URLs.
 */
export function extractPrUrl(logFile: string): string | null {
  try {
    if (!existsSync(logFile)) return null;
    const content = readFileSync(logFile, 'utf-8');
    const patterns = [
      /https?:\/\/github\.com\/[^\s<>"')\]]+\/pull\/\d+/gi,
    ];
    for (const pattern of patterns) {
      const match = content.match(pattern);
      if (match) return match[0];
    }
  } catch { /* best-effort */ }
  return null;
}

// ── Pure: timestamp helpers ────────────────────────────────────────────────

/** Format a YYYY-MM-DDTHH:MM:SS timestamp matching process-manager.ts format. */
function formatTimestamp(): string {
  return new Date().toISOString().slice(0, 19);
}

/**
 * Append a timestamped message to the task's output.log.
 *
 * Any leading \n in the message is preserved before the timestamp (for
 * visual spacing in the log), then the timestamp is written in the same
 * `[YYYY-MM-DDTHH:MM:SS]` format that process-manager.ts uses, so
 * parseTimestamp() in unified-terminal.tsx picks it up and sorts lines
 * chronologically.
 */
export function logToOutput(specPath: string, message: string): void {
  try {
    const logFile = path.join(specPath, 'output.log');
    const leadingNewlines = message.match(/^\n+/)?.[0] ?? '';
    const body = message.slice(leadingNewlines.length);
    appendFileSync(logFile, `${leadingNewlines}[${formatTimestamp()}] ${body}`);
  } catch (err) {
    // Never throw (a log write must not block the pipeline), but surface it
    // so a broken output.log is diagnosable — matching phaseHeader()'s warn.
    logWarn('orchestrator', `Failed to write to output log at ${path.join(specPath, 'output.log')}`, err);
  }
}

// ── Pure: phase header ────────────────────────────────────────────────────

/** Write a timestamped phase separator header to the log file. */
export function phaseHeader(logFile: string, phase: string): void {
  try {
    // Split into header line + separator dashes, timestamp goes on the header line
    appendFileSync(logFile, `\n[${formatTimestamp()}] ${'─'.repeat(40)}\n▶ ${phase.toUpperCase()}\n${'─'.repeat(40)}\n`);
  } catch (err) { logWarn('orchestrator', 'Failed to write phase header to log file', err); }
}

// ── Snapshot restoration ──────────────────────────────────────────────────

/**
 * Restore qa_report.json from a snapshot if the report is missing (Gap 4b).
 * Checks qa_report_before_failed.json and qa_report_before_bounce.json.
 * Non-blocking — a restore failure must never stop the pipeline — but not
 * silent: it's logged, since a failed restore permanently loses the QA
 * audit trail with no other record of it.
 *
 * Called unconditionally at the start of every implement phase, so the
 * common case here is routine, not a crash: a spec/plan revision or a
 * reject-bounce always deletes qa_report.json as part of clearing QA-level
 * artifacts (see trimArtifactsForTarget), and this restores a working copy
 * from the snapshot preserved just before that cleanup so the report stays
 * visible in the UI and as an audit trail until the next QA round overwrites
 * it. A true crash-recovery restore (the file vanishing outside that flow)
 * looks identical in the log — the message can't tell them apart.
 */
export function restoreQaReportFromSnapshot(specPath: string): void {
  const reportPath = path.join(specPath, 'qa_report.json');
  if (existsSync(reportPath)) return;
  for (const snapName of ['qa_report_before_failed.json', 'qa_report_before_bounce.json']) {
    const snapshotPath = path.join(specPath, snapName);
    if (existsSync(snapshotPath)) {
      try {
        const snapshot = readFileSync(snapshotPath, 'utf-8');
        writeFileSync(reportPath, snapshot);
        logToOutput(specPath,
          `\n[GUARD] qa_report.json restored\n`);
        break; // use the first available snapshot
      } catch (err) {
        logWarn('orchestrator', `Failed to restore qa_report.json from ${snapName} at ${specPath}`, err);
      }
    }
  }
}

/**
 * Restore human_feedback.md from snapshot if the file is missing (Gap 4b).
 * Checks human_feedback_before_bounce.md. Non-blocking — a restore failure
 * must never stop the pipeline — but not silent: it's logged, since a
 * failed restore permanently loses that feedback with no other record of it.
 *
 * Same routine-not-crash caveat as restoreQaReportFromSnapshot: the
 * implement-phase cleanup that follows a rework cycle normally removes
 * human_feedback.md once its directive has been applied, and this restores
 * a working copy so the feedback stays visible in the UI/audit trail.
 */
export function restoreHumanFeedbackFromSnapshot(specPath: string): void {
  const feedbackPath = path.join(specPath, 'human_feedback.md');
  if (existsSync(feedbackPath)) return;
  const snapshotPath = path.join(specPath, 'human_feedback_before_bounce.md');
  if (existsSync(snapshotPath)) {
    try {
      const snapshot = readFileSync(snapshotPath, 'utf-8');
      writeFileSync(feedbackPath, snapshot);
      logToOutput(specPath,
        '\n[GUARD] human_feedback.md is missing (expected after implement-phase cleanup consumes it) — restored a working copy from human_feedback_before_bounce.md so it stays visible\n');
    } catch (err) {
      logWarn('orchestrator', `Failed to restore human_feedback.md from human_feedback_before_bounce.md at ${specPath}`, err);
    }
  }
}

// ── Worktree base path ────────────────────────────────────────────────────

/** Compute the worktree base directory for the project. */
export function getWorktreeBase(projectRoot: string): string {
  return readContainerConfig(projectRoot).enabled
    ? path.join(projectRoot, '.worktrees')
    : path.join(projectRoot, '..', 'worktrees');
}

/**
 * Resolve the directory *name* (not full path) for a task's git worktree.
 * Prefers `worktreeDirName` — set when the canonical `<slug>` path
 * couldn't be reclaimed (a file locked open by an external process, most
 * commonly an IDE indexer or antivirus scanner holding a build artifact —
 * see ensureWorktree's relocation logic in implement.ts) and the pipeline
 * moved to a suffixed directory instead of fighting for the original one.
 * Falls back to the stable slug (which still derives the branch name and
 * task directory name) so a task without an override behaves exactly as
 * before. Every worktree-path computation should go through this function
 * rather than reading `task.slug` directly, so a relocation is honored
 * consistently everywhere a task's worktree path is derived.
 */
export function resolveWorktreeDirName(task: { slug?: string; description: string; worktreeDirName?: string }): string {
  return task.worktreeDirName ?? task.slug ?? slugify(task.description);
}

// ── Pipeline config ───────────────────────────────────────────────────────

/**
 * Compute pipeline configuration from pipeline.json.
 * Does NOT cache — the caller (orchestrator) handles caching via a delegate.
 */
export function computePipelineConfig(projectRoot: string): PipelineConfig {
  // Vitest sets this itself on every test run (no code here opts in). Real
  // pipelines never have it set, so this only ever changes the DEFAULT below
  // — an explicit wakeupScanRetryDelayMs in pipeline.json always wins, test
  // or not, so a test that wants to exercise the retry loop itself can still
  // do so by writing one. Without this, every test that drives runImplement
  // through the real Orchestrator (rather than a lightweight deps mock) gets
  // the real multi-second retry delay under fake timers that are never
  // advanced far enough to cover it, and hangs mid-`runSubtaskSession`
  // instead of completing — not a behavior change worth forcing onto every
  // such test, since the delay exists purely to absorb container/bind-mount
  // write latency that doesn't exist in-process.
  const defaultWakeupScanRetryDelayMs = process.env.VITEST ? 0 : 2000;
  // Same pattern: tests that drive the real Orchestrator simulate agents that
  // predate the backlog check, so it defaults off under Vitest only. Its own
  // tests (backlog-check.test.ts) exercise it directly or opt in explicitly.
  const defaultBacklogCheck = !process.env.VITEST;
  const cfgPath = path.join(projectRoot, '.teamai', 'pipeline.json');
  if (existsSync(cfgPath)) {
    try {
      const raw = JSON.parse(readFileSync(cfgPath, 'utf-8'));
      const sensors = readPipelineSensors(raw);
      return {
        maxQaAttempts: typeof raw.maxQaAttempts === 'number' ? raw.maxQaAttempts : 3,
        parallelSubtasks: typeof raw.parallelSubtasks === 'boolean' ? raw.parallelSubtasks : true,
        maxImplementRetries: typeof raw.maxImplementRetries === 'number' ? raw.maxImplementRetries : 3,
        maxStallRecoveries: typeof raw.maxStallRecoveries === 'number' ? raw.maxStallRecoveries : 3,
        idleStallMinutes: typeof raw.idleStallMinutes === 'number' ? raw.idleStallMinutes : 15,
        toolStallMinutes: typeof raw.toolStallMinutes === 'number' ? raw.toolStallMinutes : 30,
        autoMergeMethod: raw.autoMergeMethod === 'squash' || raw.autoMergeMethod === 'rebase' ? raw.autoMergeMethod : 'merge',
        recordHistoryInGit: typeof raw.recordHistoryInGit === 'boolean' ? raw.recordHistoryInGit : true,
        includePhasesTrailer: typeof raw.includePhasesTrailer === 'boolean' ? raw.includePhasesTrailer : true,
        demo: typeof raw.demo === 'boolean' ? raw.demo : undefined,
        wakeupScanRetryDelayMs: typeof raw.wakeupScanRetryDelayMs === 'number' ? raw.wakeupScanRetryDelayMs : defaultWakeupScanRetryDelayMs,
        backlogCheck: typeof raw.backlogCheck === 'boolean' ? raw.backlogCheck : defaultBacklogCheck,
        ...(sensors ? { sensors } : {}),
      };
    } catch (err) { logWarn('orchestrator', 'Failed to parse pipeline config, using defaults', err); }
  }
  return { maxQaAttempts: 3, parallelSubtasks: true, maxImplementRetries: 3, maxStallRecoveries: 3, idleStallMinutes: 15, toolStallMinutes: 30, autoMergeMethod: 'merge', recordHistoryInGit: true, includePhasesTrailer: true, wakeupScanRetryDelayMs: defaultWakeupScanRetryDelayMs, backlogCheck: defaultBacklogCheck };
}

// ── Session map ───────────────────────────────────────────────────────────

/**
 * Write a session → role mapping to session_map.json for live streaming in
 * the UI. Best-effort — never blocks the pipeline on write failures.
 *
 * Used by spec, plan, implement (subtask + merge sessions), qa-review, and
 * rebase/cherry-pick merger sessions.  Previously copy-pasted 7×.
 */
export function updateSessionMap(
  specPath: string,
  roleOrSubtaskId: string,
  sessionId: string,
): void {
  try {
    const sessionMapPath = path.join(specPath, 'session_map.json');
    const map: Record<string, string> = existsSync(sessionMapPath)
      ? JSON.parse(readFileSync(sessionMapPath, 'utf-8'))
      : {};
    map[roleOrSubtaskId] = sessionId;
    writeFileSync(sessionMapPath, JSON.stringify(map, null, 2));
  } catch (err) {
    // Never throw (live streaming must not block the pipeline), but surface
    // the failure so a stale session map is diagnosable.
    logWarn('orchestrator', 'Failed to persist session_map.json', err);
  }
}

// ── Session options ───────────────────────────────────────────────────────

/**
 * Build session creation options for processManager.createSession().
 * Resolves the provider config and merges container-session and provider opts.
 * `specDir` is the task's real `.teamai/{slug}/` directory in the project root;
 * createSession exports it to the agent as `$TEAMAI_SPEC_DIR` (translated to the
 * container path in container mode) so job logs, PID files, and wakeup files
 * land where the orchestrator scans rather than in a worktree's own copy.
 */
export function buildSessionOpts(
  projectRoot: string,
  role: AgentSession['role'],
  cwd: string,
  taskId: string,
  logFile?: string,
  specDir?: string,
) {
  const providerCfg = resolveProvider(projectRoot, role);
  const providerOpts = providerToSessionOpts(providerCfg);
  return { taskId, role, cwd, ...containerSessionOpts(projectRoot), logFile, specDir, ...providerOpts };
}

// ── Artifact-based phase resolution ───────────────────────────────────────

/**
 * Determine which phase to start (or resume) a task's pipeline at, based on
 * which artifacts already exist on disk.
 *
 * A task's spec.md and/or plan.json can exist before the orchestrator's own
 * `spec`/`plan` phases ever run against it — e.g. a ticket authored outside
 * the pipeline with its spec already written, or a task resumed after a
 * crash. `moveTaskToPhase` and `resumeTask` both need this exact fallback
 * chain (previously duplicated 4x across those two methods); consolidated
 * here so a future change to the rule only needs to happen once.
 *
 * `pendingSpecRevision` (see hasPendingSpecRevision) wins over everything:
 * a revision prepared while no pipeline was running must run before any
 * plan written against the old spec is executed.
 */
export function startPhaseFromArtifacts(hasPlan: boolean, hasSpec: boolean, pendingSpecRevision = false): PipelinePhase {
  if (pendingSpecRevision) return 'spec';
  if (hasPlan) return 'implement';
  if (hasSpec) return 'plan';
  return 'spec';
}

/**
 * True when a spec revision was prepared on disk (prepareSpecRevisionArtifacts:
 * feedback written, spec.md archived to spec_v{N}.md) but the revising
 * analyst has not yet written the new spec.md. Set outside a live pipeline
 * by an `[INVALIDATES]` directive (orchestrator/backlog-check.ts), so the
 * task's next start or retry re-specs against the changed context.
 */
export function hasPendingSpecRevision(specDir: string): boolean {
  return existsSync(path.join(specDir, 'spec_revision_feedback.md'))
    && !existsSync(path.join(specDir, 'spec.md'));
}

/**
 * The task's current live spec version, recovered from `.pipeline_state.json`
 * or, failing that, from the spec_v{N}.md snapshots on disk. Backs
 * Orchestrator._restoreSpecRevision (whose doc comment has the precedence
 * rationale) and is shared with callers that prepare a spec revision for a
 * task with no pipeline running (orchestrator/backlog-check.ts).
 */
export function restoreSpecRevisionFromDir(dir: string): number {
  // Prefer the persisted pipeline state (most accurate)
  try {
    const statePath = path.join(dir, '.pipeline_state.json');
    if (existsSync(statePath)) {
      const state = JSON.parse(readFileSync(statePath, 'utf-8'));
      if (typeof state.specRevision === 'number' && state.specRevision > 0) {
        return state.specRevision;
      }
    }
  } catch { /* fall through to on-disk counting */ }
  // Fallback: find the highest existing spec_v{N}.md on disk. Scan a fixed
  // range and take the max instead of stopping at the first gap — v1 can
  // legitimately be missing on tasks whose pipeline entered tracked
  // execution after spec.md already existed, and breaking at the first
  // missing file would return 0 for a task with v2..v4 on disk, silently
  // resetting revision numbering if .pipeline_state.json is ever lost.
  let maxN = 0;
  for (let v = 1; v <= MAX_REVISION_SNAPSHOTS; v++) {
    if (existsSync(path.join(dir, `spec_v${v}.md`))) {
      maxN = v;
    }
  }
  // Under the rename-at-revision scheme the live spec.md is one version
  // AHEAD of the highest snapshot (snapshots = completed revisions − the
  // pre-revision archives; the current spec is always un-archived at
  // spec.md). The next beginSpecRevision renames spec.md to
  // spec_v{maxN + 1}.md, so the restored counter must be maxN + 1 — under
  // the old copy scheme maxN alone was correct, and reusing it here would
  // clobber the highest snapshot on the next revision.
  return maxN + 1;
}
