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
 * Read spec_summary.md — a short, decision-focused account of the spec's
 * intent, as opposed to the full spec.md, which is unbounded in size and
 * never committed to git. runSpecPhase treats writing this file as
 * mandatory (parks the task in awaiting-review otherwise), so callers should
 * treat a null return as a hard failure, not something to fall back around
 * — see runCreatePRPhase, which throws rather than building a PR body with
 * no Specification Summary section.
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

// ── Empty-branch detection ─────────────────────────────────────────────────

/**
 * Whether `worktreePath`'s HEAD has any commit beyond its merge-base with
 * `origin/<baseBranch>` — i.e. whether this task actually has anything left
 * to contribute to the base branch (a PR to open, a merge to perform).
 *
 * A task can legitimately reach the merge/create-pr phase with nothing to
 * merge: a pure verification ticket whose own acceptance criteria mandate an
 * empty `src/` diff (the code was already correct; the job was only to
 * confirm it) produces no code changes, and TeamAI's artifact-commit scheme
 * never commits the `.teamai/{slug}/` folder into the branch either (it's
 * encoded as commit-message trailers on the squash commit instead, which has
 * nothing to attach to when there's no commit to squash). After the phase's
 * pre-merge/pre-PR rebase, such a branch is bit-for-bit identical to the base
 * — callers should check this BEFORE squashing/pushing/opening a PR and
 * route straight to `done` instead, rather than attempting a squash/PR/merge
 * that has nothing to act on (squashWithMessage's own `head === mergeBase`
 * no-op silently produces a branch with zero commits, which e.g. GitHub's
 * createPullRequest correctly, but confusingly, rejects with "No commits
 * between <base> and <branch>").
 *
 * Fails open (returns true) on any git error, or if either `rev-parse` or
 * `merge-base` comes back blank — a real git success never returns an empty
 * SHA, so a blank result means the caller couldn't actually resolve one
 * (e.g. an unrelated test double stubbing every `execFileSync` call with
 * `''`), not a genuine "identical to base" answer. If we can't tell whether
 * there's anything to merge, don't silently mark the task done; let the
 * normal squash/PR/merge path run and surface its own error instead.
 */
export function hasCommitsBeyondBase(
  worktreePath: string,
  baseBranch: string,
  deps: CommitArtifactsDeps,
): boolean {
  if (!existsSync(worktreePath)) return true;
  deps.restoreWorktreeGitFileToHostPaths(worktreePath);
  const gitEnv = deps.worktreeGitEnv(worktreePath);
  const gitOpts = Object.keys(gitEnv).length
    ? { cwd: worktreePath, env: { ...process.env, ...gitEnv }, stdio: 'pipe' as const }
    : { cwd: worktreePath, stdio: 'pipe' as const };
  try {
    const mergeBase = execFileSync('git', ['merge-base', 'HEAD', `origin/${baseBranch}`], gitOpts).toString().trim();
    const head = execFileSync('git', ['rev-parse', 'HEAD'], gitOpts).toString().trim();
    if (!mergeBase || !head) return true;
    return head !== mergeBase;
  } catch (err) {
    warn('artifacts', `hasCommitsBeyondBase: could not resolve HEAD/merge-base in ${worktreePath}`, err);
    return true;
  }
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

  // Last-resort safety net: `git reset --soft` below only restages the tree
  // of the commit it resets to — it does not touch the working directory, so
  // any change that was never staged/committed in the first place is left
  // behind as an uncommitted diff, untouched by the squash commit that
  // follows and therefore never pushed. runSubtaskSession's own commit guard
  // is meant to catch this per-subtask, but a dirty worktree can still reach
  // here through other paths (a merger-agent session, a manual edit) — check
  // again immediately before the reset so nothing is ever silently dropped
  // at the one point in the pipeline that would otherwise do exactly that.
  try {
    const status = execFileSync('git', ['status', '--porcelain'], gitOpts).toString();
    if (status.trim()) {
      execFileSync('git', ['add', '-A', '--', '.', ':!.teamai'], gitOpts);
      execFileSync('git', ['commit', '-m', 'WIP: auto-commit uncommitted changes before squash'], gitOpts);
      warn('artifacts', `squashWithMessage: worktree ${worktreePath} had uncommitted changes — auto-committed before squashing`);
    }
  } catch (err) {
    warn('artifacts', `squashWithMessage: could not check/commit worktree status in ${worktreePath}`, err);
  }

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
    // --allow-empty: a verification-only task's sole commit can legitimately
    // have an empty tree (e.g. a deliberate `git commit --allow-empty` the
    // coder made to carry evidence in its message — see implement.md's
    // "empty (or absent) `files` array" guidance). Without this flag, `git
    // commit` refuses ("nothing to commit") whenever the squashed result's
    // tree matches mergeBase's — but by then the `reset --soft` above has
    // ALREADY discarded that original commit, and the catch below can only
    // log the failure, not undo it. That silently destroyed the very commit
    // a verification-only task depends on to still open a PR instead of
    // falling back to hasCommitsBeyondBase's done-directly path below.
    execFileSync('git', ['commit', '--allow-empty', '-F', msgFile], gitOpts);
    return true;
  } catch (err) {
    warn('artifacts', `squashWithMessage failed in ${worktreePath}`, err);
    return false;
  } finally {
    try { unlinkSync(msgFile); } catch { /* best-effort */ }
  }
}
