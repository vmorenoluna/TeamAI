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
import { existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync, copyFileSync, readdirSync } from 'fs';
import path from 'path';
import { phaseHeader } from './helpers';
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

/** Files excluded from artifact commit — internal/transient orchestrator state. */
export const ARTIFACT_EXCLUDE = new Set([
  'output.log',
  '.pipeline_state.json',
]);

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

  // Copy all files except excluded ones
  const sourceDir = pipeline.specPath;
  let copied = 0;
  if (existsSync(sourceDir)) {
    const entries = readdirSync(sourceDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (ARTIFACT_EXCLUDE.has(entry.name)) continue;
      copyFileSync(path.join(sourceDir, entry.name), path.join(targetDir, entry.name));
      copied++;
    }
  }

  // ── Rewrite task.json phase to "done" in the committed copy ──
  const committedTaskJson = path.join(targetDir, 'task.json');
  if (existsSync(committedTaskJson)) {
    try {
      const t = JSON.parse(readFileSync(committedTaskJson, 'utf-8'));
      t.phase = 'done';
      t.updatedAt = new Date().toISOString();
      writeFileSync(committedTaskJson, JSON.stringify(t, null, 2));
    } catch { /* best-effort */ }
  }

  if (copied === 0) {
    appendFileSync(logFile, '[ARTIFACTS] No artifacts to commit\n');
    return;
  }

  // Artifact files are always committed using HOST git (execFileSync directly).
  // Restore host-side .git file paths first so external tools continue to work.
  deps.restoreWorktreeGitFileToHostPaths(pipeline.worktreePath);

  const gitEnv = deps.worktreeGitEnv(pipeline.worktreePath);
  const gitOpts = Object.keys(gitEnv).length
    ? { cwd: pipeline.worktreePath, env: { ...process.env, ...gitEnv } }
    : { cwd: pipeline.worktreePath };

  execFileSync('git', ['add', '.teamai/'], gitOpts);

  try {
    execFileSync('git', ['commit', '-m', `Add TeamAI pipeline artifacts for "${pipeline.description}"`], gitOpts);
  } catch (gitErr) {
    const msg = gitErr instanceof Error ? gitErr.message : String(gitErr);
    if (/nothing\s+to\s+commit.*working\s+tree\s+clean/i.test(msg)) {
      appendFileSync(logFile, '[ARTIFACTS] Already committed — no new changes\n');
      return;
    }
    if (/nothing\s+added\s+to\s+commit/i.test(msg)) {
      appendFileSync(logFile, '[ARTIFACTS] Warning: .teamai/ appears to be gitignored — skipping artifact commit\n');
      return;
    }
    throw gitErr;
  }

  appendFileSync(logFile, `[ARTIFACTS] Committed ${copied} artifact file(s) to worktree\n`);
}
