/**
 * Ticket history via commit trailers.
 *
 * Builds a structured commit message with trailers (Task/Task-ID/QA/Phases/
 * Reviewed-by) and provides a pre-merge squash helper that collapses the
 * feature branch to a single commit carrying that message. The artifact
 * folder itself is never committed — it stays local and is deleted when the
 * task reaches done.
 *
 * Uses execFileSync directly (not through _execGit) because the messages and
 * git state are handled host-side by the Node.js process — no docker exec
 * needed for these git commands.
 */
import { execFileSync } from 'child_process';
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'fs';
import path from 'path';
import { truncate } from '../utils';
import { warn } from '../logger';
import type { TaskPipeline, QaReport } from './types';

// ── Types ─────────────────────────────────────────────────────────────────

export interface CommitArtifactsDeps {
  /** Restore host-side paths in the worktree .git file. */
  restoreWorktreeGitFileToHostPaths: (hostWorktreePath: string) => void;
  /** Get GIT_DIR / GIT_WORK_TREE env vars for worktree git commands. */
  worktreeGitEnv: (hostCwd: string, containerWs?: string) => Record<string, string>;
}

type ArtifactPipeline = Pick<TaskPipeline, 'taskId' | 'title' | 'description' | 'specPath'>;

/** Data the message builder needs, all read-only. */
export interface TicketMessageInput {
  /** Short human-readable task title (task.title). */
  title: string;
  /** Full task description — fallback body when implementation_summary.md is missing. */
  description: string;
  /** Task directory (`.teamai/<slug>/`) — source for qa_report.json / events.jsonl / implementation_summary.md. */
  specPath: string;
  /** Task-ID trailer value. */
  taskId: string;
  /** qa_report.json content if already loaded; loaded from specPath when omitted. */
  qaReport?: QaReport | null;
  /** events.jsonl entries if already loaded; loaded from specPath when omitted. */
  events?: Array<{ phase: string; [key: string]: unknown }> | null;
  /** Conventional-Commits type (feat/fix/refactor/chore/docs). Falls back to 'feat'. */
  taskType?: string | null;
  /** Whether to include the `Phases:` trailer (default true). */
  includePhasesTrailer?: boolean;
  /** Master switch — when false, the whole trailer block is skipped. */
  recordHistoryInGit?: boolean;
}

export interface TicketMessageResult {
  /** Full commit message with trailing newline, ready for `git commit -F <file>`. */
  message: string;
  /** Trailer block lines, for embedding in the PR body (buildPRBody). */
  trailerLines: string[];
}

// ── Shared trailer-block builder ──────────────────────────────────────────

/**
 * Build the trailer block lines (without a trailing newline). Shared by the
 * commit message builder and the PR body builder so the two cannot drift.
 *
 * Returns an empty list when recordHistoryInGit is false.
 */
export function buildTrailerBlock(
  slug: string,
  taskId: string,
  qaReport: QaReport | null,
  events: Array<{ phase: string }> | null,
  opts: { includePhasesTrailer?: boolean } = {},
): string[] {
  const lines = [
    `Task: ${slug}`,
    `Task-ID: ${taskId}`,
  ];

  // QA: trailer — overall comes straight from qa_report.json's top-level
  // `overall` field, never recomputed from criteria[].
  // Format: QA: PASS (x/y criteria[, n deferred][, retried N times])
  let qaLine = 'QA: ?';
  if (qaReport && typeof qaReport.overall === 'string' && qaReport.overall) {
    const counts = { pass: 0, fail: 0, other: 0 };
    for (const c of qaReport.criteria || []) {
      const status = String(c.status || '').toUpperCase();
      if (status === 'PASS') counts.pass++;
      else if (status === 'FAIL') counts.fail++;
      else counts.other++;
    }
    const segs: string[] = [];
    const total = counts.pass + counts.fail;
    if (total > 0) segs.push(`${counts.pass}/${total} criteria`);
    if (counts.other > 0) segs.push(`${counts.other} deferred`);
    // Retry count: number of qa-review phase re-entries in events minus 1.
    const qaEntries = (events || []).filter(e => e.phase === 'qa-review').length;
    const retries = qaEntries > 1 ? qaEntries - 1 : 0;
    if (retries > 0) segs.push(`retried ${retries} times`);
    qaLine = `QA: ${qaReport.overall}` + (segs.length ? ` (${segs.join(', ')})` : '');
  }
  lines.push(qaLine);

  // Phases: trailer — the actual path taken, including loops.
  if (opts.includePhasesTrailer !== false && events && events.length) {
    const seen = new Map<string, number>();
    for (const e of events) {
      const ph = String(e.phase || '');
      if (!ph) continue;
      seen.set(ph, (seen.get(ph) || 0) + 1);
    }
    const chain = [...seen.entries()]
      .map(([ph, n]) => (n > 1 ? `${ph}(x${n})` : ph))
      .join('>');
    if (chain) lines.push(`Phases: ${chain}`);
  }

  lines.push('Reviewed-by: TeamAI QA agent');
  return lines;
}

// ── Message builder (loads inputs from specPath) ──────────────────────────

/**
 * Read implementation_summary.md if the qa-reviewer wrote one (§3i, PASS
 * verdict only). Returns null when missing/empty/unreadable so callers
 * decide their own fallback — a commit needs *some* body (falls back to the
 * task description), while a PR section that would just restate the
 * description verbatim should be omitted instead of duplicated.
 */
export function readImplementationSummary(specPath: string): string | null {
  const summaryPath = path.join(specPath, 'implementation_summary.md');
  if (!existsSync(summaryPath)) return null;
  try {
    const content = readFileSync(summaryPath, 'utf-8').trim();
    return content || null;
  } catch {
    return null;
  }
}

/**
 * Read spec_summary.md if the analyst wrote one (the spec command's final
 * step) — a short, decision-focused account of the spec's intent, as
 * opposed to the full spec.md, which is unbounded in size and never
 * committed to git. Returns null when missing/empty/unreadable so callers
 * (buildPRBody) omit the Specification Summary section entirely rather than
 * falling back to the raw spec content.
 */
export function readSpecSummary(specPath: string): string | null {
  const summaryPath = path.join(specPath, 'spec_summary.md');
  if (!existsSync(summaryPath)) return null;
  try {
    const content = readFileSync(summaryPath, 'utf-8').trim();
    return content || null;
  } catch {
    return null;
  }
}

/**
 * Build the trailer-bearing commit message for a task, loading
 * qa_report.json / events.jsonl / implementation_summary.md from specPath.
 * Returns null when recordHistoryInGit is off — no message, no squash, no
 * trailer block anywhere.
 */
export function buildTicketMessageForPipeline(
  pipeline: ArtifactPipeline,
  opts: { recordHistoryInGit?: boolean; includePhasesTrailer?: boolean; taskType?: string | null } = {},
): TicketMessageResult | null {
  if (opts.recordHistoryInGit === false) return null;

  const slug = path.basename(pipeline.specPath);

  // Load qa_report.json (best-effort).
  let qaReport: QaReport | null = null;
  try {
    qaReport = JSON.parse(readFileSync(path.join(pipeline.specPath, 'qa_report.json'), 'utf-8'));
  } catch { qaReport = null; }

  // Load events.jsonl (best-effort).
  let events: Array<{ phase: string }> | null = null;
  try {
    events = readFileSync(path.join(pipeline.specPath, 'events.jsonl'), 'utf-8')
      .split('\n')
      .filter(l => l.trim())
      .map(l => JSON.parse(l));
  } catch { events = null; }

  const trailerLines = buildTrailerBlock(
    slug,
    pipeline.taskId,
    qaReport,
    events,
    { includePhasesTrailer: opts.includePhasesTrailer },
  );

  // Body: from implementation_summary.md, falling back to the task description.
  const body = readImplementationSummary(pipeline.specPath) || (pipeline.description || '').trim();

  // Subject: "<type>: <task title — imperative, ≤72 chars>"
  const taskType = opts.taskType || 'feat';
  const lines: string[] = [
    `${taskType}: ${truncate(pipeline.title || pipeline.description, 72)}`,
    '',
  ];
  if (body) lines.push(body, '');
  lines.push(...trailerLines);

  return { message: lines.join('\n') + '\n', trailerLines };
}

// ── Pre-merge squash helper ───────────────────────────────────────────────

/**
 * Collapse the feature branch to a single commit carrying the given message,
 * so the trailers survive any merge method (merge/rebase keep messages
 * verbatim; squash pre-fills from the sole commit).
 *
 * Sequence per plan §3b: `git reset --soft <merge-base>` then
 * `git commit -F <msg-file>`. The message file is written to the task's
 * specPath (host-side, outside the worktree) so it can never be staged by
 * the branch commit itself.
 *
 * Returns true when a squash commit was created; false when there was
 * nothing to collapse (no worktree, no branch commits beyond the base) or
 * the git operations failed.
 */
export function squashWithMessage(
  worktreePath: string,
  message: string,
  baseBranch: string,
  specPath: string,
  deps: CommitArtifactsDeps,
): boolean {
  if (!existsSync(worktreePath)) return false;

  // Restore host-side .git file paths first so host git works on the worktree.
  deps.restoreWorktreeGitFileToHostPaths(worktreePath);
  const gitEnv = deps.worktreeGitEnv(worktreePath);
  const gitOpts = Object.keys(gitEnv).length
    ? { cwd: worktreePath, env: { ...process.env, ...gitEnv }, stdio: 'pipe' as const }
    : { cwd: worktreePath, stdio: 'pipe' as const };

  // Find the merge-base with the base branch — the point the branch diverged.
  let mergeBase: string;
  try {
    mergeBase = execFileSync(
      'git', ['merge-base', 'HEAD', `origin/${baseBranch}`],
      gitOpts,
    ).toString().trim();
  } catch (err) {
    warn('artifacts', `squashWithMessage: could not resolve merge-base in ${worktreePath}`, err);
    return false;
  }

  // Nothing to collapse — the branch has no commits beyond the base.
  let head: string;
  try {
    head = execFileSync('git', ['rev-parse', 'HEAD'], gitOpts).toString().trim();
  } catch (err) {
    warn('artifacts', `squashWithMessage: could not resolve HEAD in ${worktreePath}`, err);
    return false;
  }
  if (head === mergeBase) return false;

  // Write the message to the task dir (host-side, outside the worktree) —
  // `git commit -F <file>` avoids Windows argv limits, and keeping the file
  // out of the worktree means it can never be swept into the branch commit.
  const msgFile = path.join(specPath, 'commit-msg.txt');
  writeFileSync(msgFile, message, 'utf-8');
  try {
    execFileSync('git', ['reset', '--soft', mergeBase], gitOpts);
    execFileSync('git', ['commit', '-F', msgFile], gitOpts);
    return true;
  } catch (err) {
    warn('artifacts', `squashWithMessage failed in ${worktreePath}`, err);
    return false;
  } finally {
    try { unlinkSync(msgFile); } catch { /* best-effort */ }
  }
}
