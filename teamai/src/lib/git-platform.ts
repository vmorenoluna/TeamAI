import { execFile } from 'child_process';
import { promisify } from 'util';
import { writeFileSync, unlinkSync } from 'fs';
import { randomUUID } from 'crypto';
import { warn as logWarn } from './logger';
import { getToolPath } from './tool-checker';
import { logToOutput } from './orchestrator/helpers';
import { truncate } from './utils';
import path from 'path';

// Async (non-blocking) execFile — the sync variant froze the shared Node server
// event loop for the duration of each git/gh call (up to 30 s for `gh pr create`).
const execFileAsync = promisify(execFile);

/**
 * Detect the Git hosting platform from the remote origin URL.
 * @returns 'github' or 'unknown'
 */
export async function detectGitPlatform(projectRoot: string): Promise<'github' | 'unknown'> {
  try {
    const { stdout } = await execFileAsync('git', ['remote', 'get-url', 'origin'], {
      cwd: projectRoot, encoding: 'utf-8', timeout: 5000,
    });
    const url = stdout.trim().toLowerCase();
    if (url.includes('github.com') || url.includes('github.')) return 'github';
  } catch (err) { logWarn('orchestrator', 'Failed to detect git remote platform', err); }
  return 'unknown';
}

/**
 * Detect the default branch name from the remote HEAD reference.
 * Falls back to 'main' if detection fails.
 */
export async function detectDefaultBranch(projectRoot: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', ['symbolic-ref', 'refs/remotes/origin/HEAD'], {
      cwd: projectRoot, encoding: 'utf-8', timeout: 3000,
    });
    const ref = stdout.trim();
    // Extract branch name from refs/remotes/origin/main → main
    const parts = ref.split('/');
    return parts[parts.length - 1] || 'main';
  } catch (err) {
    logWarn('orchestrator', 'Failed to detect default branch, falling back to main', err);
    return 'main';
  }
}

/**
 * Resolve the repository's default branch name with in-memory caching.
 * Calls detectDefaultBranch on first invocation per projectRoot; subsequent
 * (including concurrent) calls return the same cached Promise. Callers can pass invalidate=true to force
 * a re-detection (e.g. after a remote rename).
 */
const _baseBranchCache = new Map<string, Promise<string>>();
export function resolveBaseBranch(projectRoot: string, invalidate?: boolean): Promise<string> {
  if (invalidate) _baseBranchCache.delete(projectRoot);
  let pending = _baseBranchCache.get(projectRoot);
  if (!pending) {
    // Cache the in-flight promise so concurrent callers share one git spawn.
    pending = detectDefaultBranch(projectRoot);
    _baseBranchCache.set(projectRoot, pending);
  }
  return pending;
}

/**
 * Build a PR/MR body from the task description and spec summary.
 * Used for direct CLI PR creation (no AI agent needed).
 *
 * `specSummary` — the analyst's own account of the spec's intent and key
 * decisions (spec_summary.md, written as the spec command's final step),
 * NOT the full spec.md. spec.md itself is never committed to git and is
 * deleted once the task reaches done, so embedding it verbatim used to be
 * the PR body's only way to preserve a durable record of it — but specs are
 * unbounded in size while GitHub hard-caps a PR body at 65,536 characters
 * server-side (independent of any local argv limit), so a large spec broke
 * PR creation outright. A short, decision-focused summary is bounded by
 * construction (same shape as implementationSummary below) and is what
 * actually survives as the durable record now. Required, not optional:
 * runSpecPhase treats writing this file as mandatory for every task (parks
 * the task in awaiting-review otherwise), so the caller (runCreatePRPhase)
 * is expected to have already confirmed spec_summary.md exists — reading it
 * is not this function's job. There is no silent fallback to the raw spec
 * for a missing summary; that would reintroduce the exact unbounded-size
 * problem this fix exists to close.
 *
 * `trailerLines` — optional trailer block lines (Task/Task-ID/QA/Phases/
 * Reviewed-by), built via buildTrailerBlock() and shared with the commit
 * message builder so the two cannot drift. Appended after the spec section.
 *
 * `implementationSummary` — the qa-reviewer's own account of what was built
 * (implementation_summary.md, §3i), the same text used for the squashed
 * commit's body. Omitted from the PR body entirely when absent, rather than
 * falling back to the description — repeating the description under a new
 * heading would just be noise, not additional coverage. This is what makes
 * the PR body the fuller of the two: description (the ask) + this section
 * (the outcome) + the spec summary (the reasoning) + trailers, vs. the
 * commit's message + trailers alone.
 */
export function buildPRBody(
  description: string,
  specSummary: string,
  trailerLines: string[] = [],
  implementationSummary?: string | null,
): string {
  const parts = [
    '## Summary',
    '',
    description,
  ];
  if (implementationSummary) {
    parts.push('', '## What Was Implemented', '', implementationSummary);
  }
  parts.push(
    '',
    '## Testing',
    '',
    'QA review passed.',
    '',
    '---',
    '',
    '## Specification Summary',
    '',
    specSummary,
  );
  if (trailerLines.length) {
    parts.push('', '---', '', ...trailerLines);
  }
  return parts.join('\n');
}

/**
 * Check whether an open PR/MR already exists for the given branch.
 * Returns the PR URL if one exists, or null otherwise.
 */
export async function checkExistingPRViaCLI(
  platform: 'github' | 'unknown',
  branch: string,
  projectRoot: string,
): Promise<string | null> {
  if (platform === 'github') {
    try {
      const { stdout } = await execFileAsync(getToolPath('gh'), [
        'pr', 'list',
        '--head', branch,
        '--state', 'open',
        '--json', 'url',
        '--jq', '.[0].url',
      ], { cwd: projectRoot, encoding: 'utf-8', timeout: 10_000 });
      const url = stdout.trim();
      return url || null;
    } catch (err) {
      logWarn('git-platform', 'Failed to check existing PR via gh CLI', err);
      return null;
    }
  }

  return null;
}

/**
 * Check whether a PR/MR has actually been merged.
 *
 * Returns `true`/`false` when the platform's CLI can give a definitive
 * answer, or `null` when the merge state couldn't be determined (unsupported
 * platform, or the CLI call itself failed — e.g. offline, rate-limited).
 * Callers that use this as a safety guard should treat `null` as "unknown,
 * don't block" rather than "not merged" — there is no CLI-backed way to
 * verify non-GitHub platforms, and refusing to proceed there would be
 * a pure regression for projects that never had this check.
 */
export async function isPrMerged(
  platform: 'github' | 'unknown',
  prUrl: string,
  projectRoot: string,
): Promise<boolean | null> {
  if (platform === 'github') {
    try {
      const { stdout } = await execFileAsync(getToolPath('gh'), [
        'pr', 'view', prUrl,
        '--json', 'state',
      ], { cwd: projectRoot, encoding: 'utf-8', timeout: 10_000 });
      return JSON.parse(stdout).state === 'MERGED';
    } catch (err) {
      logWarn('git-platform', `Failed to check PR merge state via gh CLI for ${prUrl}`, err);
      return null;
    }
  }

  return null;
}

/**
 * Create a PR directly via CLI (`gh pr create`).
 * Returns the PR/MR URL on success.
 *
 * For non-GitHub platforms where no standard CLI exists, returns null
 * — the caller should fall back to constructing the create URL manually.
 */
export async function createPRViaCLI(
  platform: 'github' | 'unknown',
  branch: string,
  title: string,
  body: string,
  projectRoot: string,
  logFile: string,
): Promise<string | null> {
  const defaultBranch = await detectDefaultBranch(projectRoot);
  const specPath = path.dirname(logFile);

  if (platform === 'github') {
    // gh's --body flag puts the entire body on the command line. On Windows,
    // CreateProcess caps the total command line at ~32,767 characters, so a
    // long body (implementation summary, trailers, etc.) could trip
    // ENAMETOOLONG before gh even starts. --body-file sidesteps argv entirely
    // by reading the body from a temp file on disk. This is independent of
    // GitHub's own server-side 65,536-character cap on the body content
    // itself (GraphQL createPullRequest) — buildPRBody keeps the body under
    // that by construction (see its docstring), so no length check is needed
    // here.
    const bodyFile = path.join(specPath, `pr-body-${randomUUID().slice(0, 8)}.md`);
    writeFileSync(bodyFile, body, 'utf-8');
    try {
      // The title is the task description, which for GitHub-imported tasks is the
      // entire issue body — unbounded content that both risks Windows' ~32KB argv
      // limit and exceeds GitHub's 256-char PR title cap. Truncate to be safe.
      const MAX_PR_TITLE = 255;
      const safeTitle = truncate(title, MAX_PR_TITLE);
      logToOutput(specPath, `[PR] Creating GitHub PR via gh CLI: ${branch} → ${defaultBranch}\n`);
      const { stdout } = await execFileAsync(getToolPath('gh'), [
        'pr', 'create',
        '--title', safeTitle,
        '--body-file', bodyFile,
        '--base', defaultBranch,
        '--head', branch,
      ], { cwd: projectRoot, encoding: 'utf-8', timeout: 30_000 });
      const url = stdout.trim();
      logToOutput(specPath, `[PR] Created: ${url}\n`);
      return url;
    } catch (err) {
      // Surface the failure in the task's output.log. Previously the error only
      // reached the server console (auto-mode's .catch → console.error), leaving
      // the task stuck in an opaque awaiting-review → create-pr loop with no
      // visible cause. gh writes its diagnostics to stderr, so include it.
      const msg = err instanceof Error ? err.message : String(err);
      const stderr = (err as { stderr?: unknown })?.stderr;
      const stderrTrim = typeof stderr === 'string' ? stderr.trim() : '';
      const stderrText = stderrTrim && !msg.includes(stderrTrim) ? `\n${stderrTrim}` : '';
      logToOutput(specPath, `[PR] Failed to create GitHub PR via gh CLI: ${msg}${stderrText}\n`);
      throw err;
    } finally {
      try { unlinkSync(bodyFile); } catch { /* best-effort */ }
    }
  }

  // non-GitHub: no standard CLI — return null for caller to handle
  logToOutput(specPath, `[PR] Platform "${platform}" has no standard CLI — cannot auto-create PR\n`);
  return null;
}

/**
 * Generate platform-specific instructions for creating pull/merge requests.
 * @deprecated Used only by the old agent-based PR creation path. Kept for
 * backward compatibility (re-exported from orchestrator.ts).
 */
export async function buildPlatformPrompt(
  platform: 'github' | 'unknown',
  branch: string,
  description: string,
  specContent: string,
  projectRoot: string,
): Promise<string> {
  const defaultBranch = await detectDefaultBranch(projectRoot);
  const base = `Create a Pull Request for branch "${branch}" targeting the ${defaultBranch} branch.\n\n` +
    `IMPORTANT: First check whether an open PR already exists for branch "${branch}".\n` +
    `- If an open PR exists: report its URL and stop — do not create a duplicate.\n` +
    `- If a previously merged PR exists for this branch: ignore it and CREATE A NEW PR now.\n` +
    `  A merged PR does not mean the current branch commits have been reviewed.\n` +
    `  The branch has been re-pushed with new commits that need a fresh PR.\n\n`;
  const meta = `Title: ${description}\n\n` +
    `Body: Generate a clear PR description from this spec:\n\n${specContent}\n\n` +
    `Include a summary of changes, testing done (QA passed), and any notes for reviewers.`;

  switch (platform) {
    case 'github':
      return base + `Use the GitHub MCP server's create_pull_request tool.\n\n` + meta;
    default:
      return base +
        `Platform: Unknown. Create a PR/MR manually using whatever tools are available.\n` +
        `Push the branch first: git push -u origin ${branch}\n` +
        `Then open the PR/MR URL in the browser.\n\n` + meta;
  }
}
