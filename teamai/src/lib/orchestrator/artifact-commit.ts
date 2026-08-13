/**
 * Artifact commit logic extracted from Orchestrator class.
 *
 * Copies task artifacts (spec, plan, QA report, etc.) into the worktree
 * and commits them so the PR includes the full implementation story.
 *
 * Uses execFileSync directly (not through _execGit) because artifact
 * files are always written by the host-side Node.js process — no docker
 * exec needed for the git add/commit commands.
 */
import { execFileSync } from 'child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync, readdirSync } from 'fs';
import path from 'path';
import { phaseHeader, logToOutput } from './helpers';
import { truncate } from '../utils';
import { warn } from '../logger';
import type { TaskPipeline } from './types';

// ── Types ─────────────────────────────────────────────────────────────────

export interface CommitArtifactsDeps {
  /** Restore host-side paths in the worktree .git file. */
  restoreWorktreeGitFileToHostPaths: (hostWorktreePath: string) => void;
  /** Get GIT_DIR / GIT_WORK_TREE env vars for worktree git commands. */
  worktreeGitEnv: (hostCwd: string, containerWs?: string) => Record<string, string>;
}

type ArtifactPipeline = Pick<TaskPipeline, 'taskId' | 'description' | 'specPath' | 'worktreePath'>;

// ── Exclude set ───────────────────────────────────────────────────────────

/** Files excluded from artifact commit — internal/transient orchestrator state.
 *  Excludes output.log, all output-*.log variants (per-phase/per-subtask session
 *  logs), and .pipeline_state.json (crash-recovery state). */
export const ARTIFACT_EXCLUDE = new Set([
  'output.log',
  '.pipeline_state.json',
]);

/** Regex matching all raw session log filenames: output.log and output-*.log.
 *  Separate from ARTIFACT_EXCLUDE because the latter uses exact Set lookup. */
const OUTPUT_LOG_PATTERN = /^output(-.*)?\.log$/;

function isExcluded(filename: string): boolean {
  return ARTIFACT_EXCLUDE.has(filename) || OUTPUT_LOG_PATTERN.test(filename);
}

// ── Commit function ───────────────────────────────────────────────────────

/**
 * Recursively copy artifacts from sourceDir to destDir, applying
 * ARTIFACT_EXCLUDE by filename at every depth. Mirrors directory
 * structure and returns the total number of files copied.
 */
function copyArtifactsRecursive(sourceDir: string, destDir: string, specPath: string): number {
  let count = 0;
  const entries = readdirSync(sourceDir, { withFileTypes: true });
  for (const entry of entries) {
    if (isExcluded(entry.name)) continue;
    const srcPath = path.join(sourceDir, entry.name);
    const destPath = path.join(destDir, entry.name);
    if (entry.isDirectory()) {
      mkdirSync(destPath, { recursive: true });
      const subCount = copyArtifactsRecursive(srcPath, destPath, specPath);
      if (subCount > 0) {
        logToOutput(specPath, `[ARTIFACTS] Copied directory ${entry.name}/ (${subCount} file(s))\n`);
        count += subCount;
      }
    } else if (entry.isFile()) {
      copyFileSync(srcPath, destPath);
      count++;
    }
    // Symlinks and other entry types are intentionally skipped.
  }
  return count;
}

// ── Commit function ───────────────────────────────────────────────────────

/**
 * Copy the task's TeamAI artifacts into the worktree and commit them
 * so the PR includes the full story of the implementation.
 *
 * Throws on failure — the caller must catch and handle appropriately.
 */
export function commitArtifactsToWorktree(
  pipeline: ArtifactPipeline,
  deps: CommitArtifactsDeps,
): void {
  const logFile = path.join(pipeline.specPath, 'output.log');
  phaseHeader(logFile, 'artifacts — commit to worktree');

  // Use the task's actual directory name (derived from its title at creation time),
  // not slugify(description) — these differ and produce a second orphan directory.
  const slug = path.basename(pipeline.specPath);
  const targetDir = path.join(pipeline.worktreePath, '.teamai', slug);

  if (!existsSync(targetDir)) {
    mkdirSync(targetDir, { recursive: true });
  }

  // Recursively copy all files except excluded ones.
  // Handles nested subdirectories (e.g. generated report folders, log directories)
  // applying ARTIFACT_EXCLUDE by filename at every depth.
  const sourceDir = pipeline.specPath;
  let copied = 0;
  if (existsSync(sourceDir)) {
    copied = copyArtifactsRecursive(sourceDir, targetDir, pipeline.specPath);
  }

  // ── Rewrite task.json phase to "done" in the committed copy ──
  const committedTaskJson = path.join(targetDir, 'task.json');
  if (existsSync(committedTaskJson)) {
    try {
      const t = JSON.parse(readFileSync(committedTaskJson, 'utf-8'));
      t.phase = 'done';
      t.updatedAt = new Date().toISOString();
      try {
        writeFileSync(committedTaskJson, JSON.stringify(t, null, 2));
      } catch (err) {
        // A failed write leaves the committed snapshot with a stale phase,
        // which markTaskDone's restore detection relies on. Surface it.
        warn('artifacts', `Failed to stamp committed task.json phase=done at ${committedTaskJson}`, err);
      }
    } catch { /* best-effort */ }
  }

  if (copied === 0) {
    logToOutput(pipeline.specPath, '[ARTIFACTS] No artifacts to commit\n');
    return;
  }

  // Artifact files are always committed using HOST git (execFileSync directly).
  // Restore host-side .git file paths first so external tools continue to work.
  deps.restoreWorktreeGitFileToHostPaths(pipeline.worktreePath);

  const gitEnv = deps.worktreeGitEnv(pipeline.worktreePath);
  const gitOpts = Object.keys(gitEnv).length
    ? { cwd: pipeline.worktreePath, env: { ...process.env, ...gitEnv } }
    : { cwd: pipeline.worktreePath };

  execFileSync('git', ['add', '-f', `.teamai/${slug}`], gitOpts);

  // The task description can be an entire GitHub issue body (importIssues) or a
  // roadmap description — unbounded content that would blow Windows' ~32KB
  // CreateProcess argv limit if interpolated verbatim into a single -m arg.
  // Truncate it to a bounded commit subject.
  const MAX_COMMIT_SUBJECT = 200;
  const subject = truncate(pipeline.description, MAX_COMMIT_SUBJECT);

  try {
    execFileSync('git', ['commit', '-m', `Add TeamAI pipeline artifacts for "${subject}"`], gitOpts);
  } catch (gitErr) {
    // Classify the no-op failure from git *state*, not by pattern-matching
    // git's stderr (locale/version-dependent — a real failure like a hook or
    // permission error could match the same wording and be silently skipped).
    // If nothing is staged, either the path is gitignored or the files were
    // already committed unchanged.
    let staged = '';
    try {
      staged = execFileSync(
        'git', ['diff', '--cached', '--name-only', '--', `.teamai/${slug}`],
        gitOpts,
      ).toString().trim();
    } catch { /* can't inspect — fall through and rethrow the original error */ }

    if (!staged) {
      let ignored = false;
      try {
        execFileSync('git', ['check-ignore', path.join('.teamai', slug, 'task.json')], gitOpts);
        ignored = true;
      } catch { /* not ignored */ }

      if (ignored) {
        logToOutput(pipeline.specPath, '[ARTIFACTS] Warning: .teamai/ appears to be gitignored — skipping artifact commit\n');
      } else {
        logToOutput(pipeline.specPath, '[ARTIFACTS] Already committed — no new changes\n');
      }
      return;
    }

    // Staged changes exist but the commit failed — a real error, propagate.
    throw gitErr;
  }

  logToOutput(pipeline.specPath, `[ARTIFACTS] Committed ${copied} artifact file(s) to worktree\n`);
}
