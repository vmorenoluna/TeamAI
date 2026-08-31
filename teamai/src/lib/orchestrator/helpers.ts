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
import type { PipelinePhase } from '@/constants/phases';

// ── Types ─────────────────────────────────────────────────────────────────

export interface PipelineConfig {
  maxQaAttempts: number;
  parallelSubtasks: boolean;
  sensors?: SensorsConfig;
  maxDeliverableFails: number;
  maxWakeupAttempts: number;
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
 * Restore qa_report.json from a snapshot if the report was deleted (Gap 4b).
 * Checks qa_report_before_failed.json and qa_report_before_bounce.json.
 * Best-effort — never blocks the pipeline.
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
        logToOutput(specPath, `\n[GUARD] Restored qa_report.json from ${snapName} — file was deleted\n`);
        break; // use the first available snapshot
      } catch { /* best-effort */ }
    }
  }
}

/**
 * Restore human_feedback.md from snapshot if the file was deleted (Gap 4b).
 * Checks human_feedback_before_bounce.md. Best-effort.
 */
export function restoreHumanFeedbackFromSnapshot(specPath: string): void {
  const feedbackPath = path.join(specPath, 'human_feedback.md');
  if (existsSync(feedbackPath)) return;
  const snapshotPath = path.join(specPath, 'human_feedback_before_bounce.md');
  if (existsSync(snapshotPath)) {
    try {
      const snapshot = readFileSync(snapshotPath, 'utf-8');
      writeFileSync(feedbackPath, snapshot);
      logToOutput(specPath, `\n[GUARD] Restored human_feedback.md from human_feedback_before_bounce.md — file was deleted\n`);
    } catch { /* best-effort */ }
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
  const cfgPath = path.join(projectRoot, '.teamai', 'pipeline.json');
  if (existsSync(cfgPath)) {
    try {
      const raw = JSON.parse(readFileSync(cfgPath, 'utf-8'));
      const sensors = readPipelineSensors(raw);
      return {
        maxQaAttempts: typeof raw.maxQaAttempts === 'number' ? raw.maxQaAttempts : 3,
        parallelSubtasks: typeof raw.parallelSubtasks === 'boolean' ? raw.parallelSubtasks : true,
        maxDeliverableFails: typeof raw.maxDeliverableFails === 'number' ? raw.maxDeliverableFails : 3,
        maxWakeupAttempts: typeof raw.maxWakeupAttempts === 'number' ? raw.maxWakeupAttempts : 3,
        maxStallRecoveries: typeof raw.maxStallRecoveries === 'number' ? raw.maxStallRecoveries : 3,
        idleStallMinutes: typeof raw.idleStallMinutes === 'number' ? raw.idleStallMinutes : 15,
        toolStallMinutes: typeof raw.toolStallMinutes === 'number' ? raw.toolStallMinutes : 30,
        autoMergeMethod: raw.autoMergeMethod === 'squash' || raw.autoMergeMethod === 'rebase' ? raw.autoMergeMethod : 'merge',
        recordHistoryInGit: typeof raw.recordHistoryInGit === 'boolean' ? raw.recordHistoryInGit : true,
        includePhasesTrailer: typeof raw.includePhasesTrailer === 'boolean' ? raw.includePhasesTrailer : true,
        demo: typeof raw.demo === 'boolean' ? raw.demo : undefined,
        ...(sensors ? { sensors } : {}),
      };
    } catch (err) { logWarn('orchestrator', 'Failed to parse pipeline config, using defaults', err); }
  }
  return { maxQaAttempts: 3, parallelSubtasks: true, maxDeliverableFails: 3, maxWakeupAttempts: 3, maxStallRecoveries: 3, idleStallMinutes: 15, toolStallMinutes: 30, autoMergeMethod: 'merge', recordHistoryInGit: true, includePhasesTrailer: true };
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
 */
export function buildSessionOpts(
  projectRoot: string,
  role: AgentSession['role'],
  cwd: string,
  taskId: string,
  logFile?: string,
) {
  const providerCfg = resolveProvider(projectRoot, role);
  const providerOpts = providerToSessionOpts(providerCfg);
  return { taskId, role, cwd, ...containerSessionOpts(projectRoot), logFile, ...providerOpts };
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
 */
export function startPhaseFromArtifacts(hasPlan: boolean, hasSpec: boolean): PipelinePhase {
  if (hasPlan) return 'implement';
  if (hasSpec) return 'plan';
  return 'spec';
}

/**
 * Guarantee spec_v1.md exists whenever spec.md does — a no-op if it's
 * already there.
 *
 * spec_v1.md is normally written by runSpecPhase's non-revision branch
 * (phase-runners.ts), which only runs when a task's pipeline actually goes
 * through the `spec` phase. A task whose spec.md was written before the
 * orchestrator ever saw it (see startPhaseFromArtifacts above) skips that
 * phase entirely — routed straight to `plan` — so that branch never runs,
 * and without this call, spec_v1.md would only ever get backfilled
 * reactively on the task's FIRST revision (see the `spec_v1.md` backfill in
 * phase-runners.ts's revision branch). That backfill is only correct if
 * nothing has touched spec.md yet by the time it runs; calling this here,
 * at the earliest point the orchestrator detects a pre-existing spec.md,
 * removes that timing dependency entirely — v1 is captured before a
 * revision could ever have a chance to run.
 */
export function ensureSpecV1Snapshot(specPath: string): void {
  const specMdPath = path.join(specPath, 'spec.md');
  const specV1Path = path.join(specPath, 'spec_v1.md');
  if (!existsSync(specMdPath) || existsSync(specV1Path)) return;
  try {
    writeFileSync(specV1Path, readFileSync(specMdPath, 'utf-8'));
  } catch (err) {
    // A failed snapshot leaves v1 missing rather than faked — the spec tab
    // already renders "original version unavailable" for that case.
    logWarn('orchestrator', `Failed to snapshot spec v1 for pre-seeded spec.md at ${specPath}`, err);
  }
}
