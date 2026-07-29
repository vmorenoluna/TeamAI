/**
 * Pure helpers and simple utilities extracted from Orchestrator class.
 *
 * These functions have no `this` dependencies — they take all context
 * as parameters and import external modules directly.
 */
import { existsSync, readFileSync, writeFileSync, appendFileSync } from 'fs';
import path from 'path';
import { warn as logWarn } from '../logger';
import { readContainerConfig } from '../container-manager';
import { resolveProvider, providerToSessionOpts } from '../providers';
import { containerSessionOpts, type AgentSession } from '../process-manager';
import { readPipelineSensors, type SensorsConfig } from '../sensors';

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
  /** Merge strategy auto mode uses when auto-merging a green PR/MR (default 'merge'). */
  autoMergeMethod?: 'merge' | 'squash' | 'rebase';
  /** When true, all pipeline processing is skipped — demo data stays pristine. */
  demo?: boolean;
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
  } catch { /* best-effort */ }
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
        autoMergeMethod: raw.autoMergeMethod === 'squash' || raw.autoMergeMethod === 'rebase' ? raw.autoMergeMethod : 'merge',
        demo: typeof raw.demo === 'boolean' ? raw.demo : undefined,
        ...(sensors ? { sensors } : {}),
      };
    } catch (err) { logWarn('orchestrator', 'Failed to parse pipeline config, using defaults', err); }
  }
  return { maxQaAttempts: 3, parallelSubtasks: true, maxDeliverableFails: 3, maxWakeupAttempts: 3, maxStallRecoveries: 3, autoMergeMethod: 'merge' };
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
  } catch { /* best-effort */ }
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
