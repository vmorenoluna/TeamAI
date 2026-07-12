import { execFileSync } from 'child_process';
import { appendFileSync } from 'fs';
import { warn as logWarn } from './logger';
import { getToolPath } from './tool-checker';

/**
 * Detect the Git hosting platform from the remote origin URL.
 * @returns 'github', 'gitlab', 'bitbucket', or 'unknown'
 */
export function detectGitPlatform(projectRoot: string): 'github' | 'gitlab' | 'bitbucket' | 'unknown' {
  try {
    const url = execFileSync('git', ['remote', 'get-url', 'origin'], {
      cwd: projectRoot, encoding: 'utf-8', timeout: 5000,
    }).trim().toLowerCase();
    if (url.includes('github.com') || url.includes('github.')) return 'github';
    if (url.includes('gitlab.com') || url.includes('gitlab.')) return 'gitlab';
    if (url.includes('bitbucket.org') || url.includes('bitbucket.')) return 'bitbucket';
  } catch (err) { logWarn('orchestrator', 'Failed to detect git remote platform', err); }
  return 'unknown';
}

/**
 * Detect the default branch name from the remote HEAD reference.
 * Falls back to 'main' if detection fails.
 */
export function detectDefaultBranch(projectRoot: string): string {
  try {
    const ref = execFileSync('git', ['symbolic-ref', 'refs/remotes/origin/HEAD'], {
      cwd: projectRoot, encoding: 'utf-8', timeout: 3000,
    }).trim();
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
 * calls return the cached value. Callers can pass invalidate=true to force
 * a re-detection (e.g. after a remote rename).
 */
const _baseBranchCache = new Map<string, string>();
export function resolveBaseBranch(projectRoot: string, invalidate?: boolean): string {
  if (invalidate) _baseBranchCache.delete(projectRoot);
  if (!_baseBranchCache.has(projectRoot)) {
    _baseBranchCache.set(projectRoot, detectDefaultBranch(projectRoot));
  }
  return _baseBranchCache.get(projectRoot)!;
}

/**
 * Build a PR/MR body from the task description and spec content.
 * Used for direct CLI PR creation (no AI agent needed).
 */
export function buildPRBody(description: string, specContent: string): string {
  return [
    '## Summary',
    '',
    description,
    '',
    '## Testing',
    '',
    'QA review passed.',
    '',
    '---',
    '',
    '## Specification',
    '',
    specContent,
  ].join('\n');
}

/**
 * Check whether an open PR/MR already exists for the given branch.
 * Returns the PR URL if one exists, or null otherwise.
 */
export function checkExistingPRViaCLI(
  platform: 'github' | 'gitlab' | 'bitbucket' | 'unknown',
  branch: string,
  projectRoot: string,
): string | null {
  if (platform === 'github') {
    try {
      const result = execFileSync(getToolPath('gh'), [
        'pr', 'list',
        '--head', branch,
        '--state', 'open',
        '--json', 'url',
        '--jq', '.[0].url',
      ], { cwd: projectRoot, encoding: 'utf-8', stdio: 'pipe', timeout: 10_000 });
      const url = result.trim();
      return url || null;
    } catch (err) {
      logWarn('git-platform', 'Failed to check existing PR via gh CLI', err);
      return null;
    }
  }

  if (platform === 'gitlab') {
    try {
      const result = execFileSync(getToolPath('glab'), [
        'mr', 'list',
        '--source-branch', branch,
        '--state', 'opened',
        '--json', 'web_url',
        '--jq', '.[0].web_url',
      ], { cwd: projectRoot, encoding: 'utf-8', stdio: 'pipe', timeout: 10_000 });
      const url = result.trim();
      return url || null;
    } catch (err) {
      logWarn('git-platform', 'Failed to check existing MR via glab CLI', err);
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
 * verify Bitbucket/unknown platforms, and refusing to proceed there would be
 * a pure regression for projects that never had this check.
 */
export function isPrMerged(
  platform: 'github' | 'gitlab' | 'bitbucket' | 'unknown',
  prUrl: string,
  projectRoot: string,
): boolean | null {
  if (platform === 'github') {
    try {
      const result = execFileSync(getToolPath('gh'), [
        'pr', 'view', prUrl,
        '--json', 'state',
      ], { cwd: projectRoot, encoding: 'utf-8', stdio: 'pipe', timeout: 10_000 });
      return JSON.parse(result).state === 'MERGED';
    } catch (err) {
      logWarn('git-platform', `Failed to check PR merge state via gh CLI for ${prUrl}`, err);
      return null;
    }
  }

  if (platform === 'gitlab') {
    try {
      const result = execFileSync(getToolPath('glab'), [
        'mr', 'view', prUrl,
        '--output', 'json',
      ], { cwd: projectRoot, encoding: 'utf-8', stdio: 'pipe', timeout: 10_000 });
      return JSON.parse(result).state === 'merged';
    } catch (err) {
      logWarn('git-platform', `Failed to check MR merge state via glab CLI for ${prUrl}`, err);
      return null;
    }
  }

  return null;
}

/**
 * Create a PR/MR directly via CLI (`gh pr create` / `glab mr create`).
 * Returns the PR/MR URL on success.
 *
 * For Bitbucket and unknown platforms where no standard CLI exists, returns null
 * — the caller should fall back to constructing the create URL manually.
 */
export function createPRViaCLI(
  platform: 'github' | 'gitlab' | 'bitbucket' | 'unknown',
  branch: string,
  title: string,
  body: string,
  projectRoot: string,
  logFile: string,
): string | null {
  const defaultBranch = detectDefaultBranch(projectRoot);

  if (platform === 'github') {
    appendFileSync(logFile, `[PR] Creating GitHub PR via gh CLI: ${branch} → ${defaultBranch}\n`);
    const result = execFileSync(getToolPath('gh'), [
      'pr', 'create',
      '--title', title,
      '--body', body,
      '--base', defaultBranch,
      '--head', branch,
    ], { cwd: projectRoot, encoding: 'utf-8', stdio: 'pipe', timeout: 30_000 });
    const url = result.trim();
    appendFileSync(logFile, `[PR] Created: ${url}\n`);
    return url;
  }

  if (platform === 'gitlab') {
    appendFileSync(logFile, `[PR] Creating GitLab MR via glab CLI: ${branch} → ${defaultBranch}\n`);
    const result = execFileSync(getToolPath('glab'), [
      'mr', 'create',
      '--title', title,
      '--description', body,
      '--target-branch', defaultBranch,
      '--source-branch', branch,
      '--yes',
    ], { cwd: projectRoot, encoding: 'utf-8', stdio: 'pipe', timeout: 30_000 });
    const url = result.trim();
    appendFileSync(logFile, `[PR] Created: ${url}\n`);
    return url;
  }

  // Bitbucket / unknown: no standard CLI — return null for caller to handle
  appendFileSync(logFile, `[PR] Platform "${platform}" has no standard CLI — cannot auto-create PR\n`);
  return null;
}

/**
 * Generate platform-specific instructions for creating pull/merge requests.
 * @deprecated Used only by the old agent-based PR creation path. Kept for
 * backward compatibility (re-exported from orchestrator.ts).
 */
export function buildPlatformPrompt(
  platform: 'github' | 'gitlab' | 'bitbucket' | 'unknown',
  branch: string,
  description: string,
  specContent: string,
  projectRoot: string,
): string {
  const defaultBranch = detectDefaultBranch(projectRoot);
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
    case 'gitlab':
      return base +
        `Platform: GitLab. Create a Merge Request (not a PR).\n` +
        `If the "glab" CLI is available, run: glab mr create --title "..." --description "..."` +
        ` --target-branch ${defaultBranch} --source-branch ${branch}\n` +
        `Otherwise, use the GitLab API (project is from remote origin URL).\n\n` + meta;
    case 'bitbucket':
      return base +
        `Platform: Bitbucket Cloud. Create a Pull Request.\n` +
        `Use the Bitbucket REST API v2 (https://api.bitbucket.org/2.0) if credentials are available.\n` +
        `The repository slug can be parsed from the remote origin URL.\n\n` + meta;
    default:
      return base +
        `Platform: Unknown. Create a PR/MR manually using whatever tools are available.\n` +
        `Push the branch first: git push -u origin ${branch}\n` +
        `Then open the PR/MR URL in the browser.\n\n` + meta;
  }
}
