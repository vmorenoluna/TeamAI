import { execFileSync } from 'child_process';
import { existsSync, readFileSync, writeFileSync, unlinkSync, renameSync } from 'fs';
import path from 'path';
import { readContainerConfig, readContainerRemoteUser, containerManager, hostToContainerPath } from '../container-manager';
import { getToolPath } from '../tool-checker';

/**
 * Verify the worktree is a valid git worktree (#4).
 * Checks that .git file exists inside the worktree and points to a valid gitdir.
 * Returns true if the worktree is healthy, false if it needs to be recreated.
 *
 * Container mode: the .git file may contain a Linux container path (e.g.
 * /workspaces/…) that doesn't resolve on the Windows host. In that case we
 * extract the worktree name from the path and check the host-side git metadata
 * directory — if it exists the worktree is healthy and patchWorktreeGitFile
 * will update the pointer before the agent session starts.
 */
export function isWorktreeHealthy(worktreePath: string, projectRoot: string): boolean {
  try {
    const gitFile = path.join(worktreePath, '.git');
    if (!existsSync(gitFile)) return false;
    const content = readFileSync(gitFile, 'utf-8').trim();
    if (!content.startsWith('gitdir:')) return false;
    const gitdir = content.slice('gitdir:'.length).trim();
    // Direct check: gitdir exists at the stated path (host mode or already-patched container path).
    if (existsSync(gitdir)) return true;
    // Container mode: gitdir is a Linux container path — translate to host and check.
    if (readContainerConfig(projectRoot).enabled) {
      const m = gitdir.replace(/\\/g, '/').match(/\/worktrees\/([^/]+)$/);
      if (m) {
        const hostGitdir = path.join(projectRoot, '.git', 'worktrees', m[1]);
        if (existsSync(hostGitdir)) return true;
      }
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Like writeFileSync but works around the Windows security descriptor git
 * places on linked-worktree metadata files (.git, gitdir, commondir).
 * Neither chmodSync nor attrib -R can clear it, but writing to a temp file
 * and atomically renaming over the target bypasses the descriptor.
 */
export function writeFileEnsuringWritable(filePath: string, content: string): void {
  try {
    writeFileSync(filePath, content);
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException)?.code !== 'EPERM') throw e;
    // Write to a temp file, then atomically rename over the locked file.
    // renameSync uses MoveFileEx with REPLACE_EXISTING, which bypasses
    // the security descriptor git places on linked-worktree metadata files.
    const tmpPath = filePath + '.tmp';
    writeFileSync(tmpPath, content);
    try {
      renameSync(tmpPath, filePath);
    } catch (renameErr) {
      // Clean up the temp file on rename failure so it doesn't leak.
      try { unlinkSync(tmpPath); } catch { /* best-effort */ }
      throw renameErr;
    }
  }
}

/**
 * Rewrite .git/worktrees/<name>/commondir to the relative path '../..'.
 * Since .git/worktrees/<name> is always two levels deep inside .git,
 * this path resolves correctly on every OS. No-op if already correct.
 */
export function patchCommondirToRelative(worktreeName: string, projectRoot: string): void {
  const commondirFile = path.join(projectRoot, '.git', 'worktrees', worktreeName, 'commondir');
  if (existsSync(commondirFile)) {
    const current = readFileSync(commondirFile, 'utf-8').trim().replace(/\\/g, '/');
    if (current !== '../..') {
      writeFileEnsuringWritable(commondirFile, '../..\n');
    }
  }
}

export function restoreWorktreeGitFileToHostPaths(hostWorktreePath: string, projectRoot: string): void {
  const gitFile = path.join(hostWorktreePath, '.git');
  if (!existsSync(gitFile)) return;
  try {
    const content = readFileSync(gitFile, 'utf-8').trim();
    if (!content.startsWith('gitdir:')) return;
    const currentGitdir = content.slice('gitdir:'.length).trim().replace(/\\/g, '/');
    const m = currentGitdir.match(/\/worktrees\/([^/]+)$/);
    if (!m) return;
    const worktreeName = m[1];
    // Normalise the host project root to forward slashes so git on Windows can read it.
    const hostRoot = projectRoot.replace(/\\/g, '/');
    const hostGitdir = `${hostRoot}/.git/worktrees/${worktreeName}`;
    if (currentGitdir === hostGitdir) return; // already correct
    writeFileEnsuringWritable(gitFile, `gitdir: ${hostGitdir}\n`);
    // Restore the back-reference so git worktree commands from the host work.
    const backRefFile = path.join(projectRoot, '.git', 'worktrees', worktreeName, 'gitdir');
    if (existsSync(backRefFile)) {
      const hostWorktreeGitFile = `${hostWorktreePath.replace(/\\/g, '/')}/.git`;
      writeFileEnsuringWritable(backRefFile, `${hostWorktreeGitFile}\n`);
    }
    patchCommondirToRelative(worktreeName, projectRoot);
  } catch { /* best-effort — don't break the pipeline on a patch failure */ }
}

/**
 * Rewrite the worktree's .git file and its back-reference so both point to
 * container-relative paths. Compares current file content to the expected value
 * derived from containerWorkspace (runtime value from docker inspect) and is a
 * no-op when already correct — safe to call unconditionally before any docker exec.
 *
 * Also rewrites commondir to the relative path '../..' — correct on every OS since
 * .git/worktrees/<name> is always two levels deep inside .git.
 */
export function patchWorktreeGitFile(hostWorktreePath: string, containerWorkspace: string, projectRoot: string): void {
  const gitFile = path.join(hostWorktreePath, '.git');
  if (!existsSync(gitFile)) return;
  try {
    const content = readFileSync(gitFile, 'utf-8').trim();
    if (!content.startsWith('gitdir:')) return;
    const currentGitdir = content.slice('gitdir:'.length).trim();
    // Extract worktree name — the segment after /worktrees/ in the gitdir path.
    const m = currentGitdir.replace(/\\/g, '/').match(/\/worktrees\/([^/]+)$/);
    if (!m) return;
    const worktreeName = m[1];
    const correctGitdir = `${containerWorkspace}/.git/worktrees/${worktreeName}`;
    if (currentGitdir.replace(/\\/g, '/') === correctGitdir) return; // already correct
    writeFileEnsuringWritable(gitFile, `gitdir: ${correctGitdir}\n`);
    // Patch the back-reference so git worktree commands from inside the container work.
    const backRefFile = path.join(projectRoot, '.git', 'worktrees', worktreeName, 'gitdir');
    if (existsSync(backRefFile)) {
      const containerWorktreePath = hostToContainerPath(hostWorktreePath, projectRoot, containerWorkspace);
      writeFileEnsuringWritable(backRefFile, `${containerWorktreePath}/.git\n`);
    }
    patchCommondirToRelative(worktreeName, projectRoot);
  } catch { /* best-effort — don't break the pipeline on a patch failure */ }
}

/**
 * Clean up ONE stale worktree registration after its directory has already
 * been force-removed with rmSync — scoped to exactly that worktree, unlike
 * `git worktree prune`, which takes no path argument to limit its blast
 * radius (confirmed via `git worktree prune --help`: only
 * `-n`/`-v`/`--expire`) and therefore always sweeps every registered
 * worktree in the shared .git directory.
 *
 * That matters because a worktree that's currently container-patched
 * (patchWorktreeGitFile has rewritten both its own .git file and the admin
 * back-reference to container-only paths, for an active docker-exec
 * session) looks IDENTICAL to a genuinely-removed worktree from the host's
 * perspective — `git worktree list` reports "prunable: gitdir file points
 * to non-existent location" — even though it's alive and in use by another
 * task entirely. An unscoped `git worktree prune` call from ANY task's
 * cleanup path can silently destroy ANY OTHER concurrently-running task's
 * worktree registration this way (confirmed directly: two preserved
 * per-subtask worktrees from an unrelated failed task showed exactly this
 * "prunable" state while genuinely active moments earlier).
 *
 * `git worktree remove --force <path>` has no such problem — verified
 * empirically (not just read from docs) against a real repo: it cleans up
 * the admin entry whether the directory is already fully gone or still has
 * leftover locked/untracked files, and in both cases leaves every sibling
 * worktree's registration completely untouched, because it only ever acts
 * on the exact path given.
 *
 * That "exact path given" requirement is itself a hazard once a worktree
 * has been container-patched: git resolves the `<path>` argument by
 * matching it against what it has recorded for the worktree, and a
 * container-patched entry has that recorded path rewritten to a
 * container-only location (e.g. /workspaces/...). Passing the host-computed
 * path in that state fails outright — verified empirically in a scratch
 * repo: `git worktree remove --force <original host path>` errors with
 * "is not a working tree" once the gitdir has been repointed, even though
 * the worktree is still fully registered. `git worktree remove --force
 * <bare worktree name>` (the basename under .git/worktrees/) succeeds
 * regardless of what the recorded path currently is — also verified
 * empirically, in both the container-patched and the ordinary case — so
 * resolve to the basename here rather than trusting the caller's path to
 * still match git's records.
 */
export function removeStaleWorktreeRegistration(projectRoot: string, worktreePath: string): void {
  try {
    execFileSync('git', ['worktree', 'remove', '--force', path.basename(worktreePath)], { cwd: projectRoot, stdio: 'pipe' });
  } catch { /* best-effort */ }
}

/**
 * Returns GIT_DIR and GIT_WORK_TREE environment variables for git commands
 * running inside a linked worktree, bypassing the .git pointer file entirely.
 *
 * Looks up the worktree metadata at
 * <projectRoot>/.git/worktrees/<basename(hostCwd)>. Returns {} when that
 * directory does not exist (e.g. hostCwd is the main project root), so
 * standard git path resolution applies for non-worktree invocations.
 *
 * This is safe across all host/container OS combinations: each execution
 * context receives paths in its own format — host paths for host git,
 * container paths (via hostToContainerPath) for docker exec git — so there
 * is never a cross-OS path mismatch.
 */
export function worktreeGitEnv(hostCwd: string, projectRoot: string, containerWs?: string): Record<string, string> {
  const worktreeName = path.basename(hostCwd);
  const hostGitDir = path.join(projectRoot, '.git', 'worktrees', worktreeName);
  if (!existsSync(hostGitDir)) return {};

  if (containerWs) {
    return {
      GIT_DIR: `${containerWs}/.git/worktrees/${worktreeName}`,
      GIT_WORK_TREE: hostToContainerPath(hostCwd, projectRoot, containerWs),
    };
  }

  return {
    GIT_DIR: hostGitDir.replace(/\\/g, '/'),
    GIT_WORK_TREE: hostCwd.replace(/\\/g, '/'),
  };
}

/**
 * Run a git command either directly on the host or via docker exec inside the container.
 */
export function execGit(args: string[], hostCwd: string, projectRoot: string): void {
  if (readContainerConfig(projectRoot).enabled && args[0] !== 'worktree') {
    const info = containerManager.getRunningContainer(projectRoot);
    if (info) {
      const containerCwd = hostToContainerPath(hostCwd, projectRoot, info.remoteWorkspaceFolder);
      const mappedArgs = args.map(a =>
        path.isAbsolute(a) && a.startsWith(projectRoot)
          ? hostToContainerPath(a, projectRoot, info.remoteWorkspaceFolder)
          : a
      );
      const remoteUser = readContainerRemoteUser(projectRoot);
      const gitEnv = worktreeGitEnv(hostCwd, projectRoot, info.remoteWorkspaceFolder);
      const envFlags = Object.entries(gitEnv).flatMap(([k, v]) => ['-e', `${k}=${v}`]);
      execFileSync(getToolPath('docker'), ['exec', '-u', remoteUser, ...envFlags, '-w', containerCwd, info.containerId, 'git', ...mappedArgs]);
      return;
    }
  }
  const gitEnv = args[0] !== 'worktree' ? worktreeGitEnv(hostCwd, projectRoot) : {};
  execFileSync('git', args, { cwd: hostCwd, ...(Object.keys(gitEnv).length ? { env: { ...process.env, ...gitEnv } } : {}) });
}

/**
 * Same routing as execGit, but captures and returns stdout instead of
 * discarding it — for read commands (status, log, diff) run against a
 * worktree that may be container-patched, where a plain host-side
 * execFileSync would fail to resolve the worktree's .git linkage at all.
 */
export function execGitCapture(args: string[], hostCwd: string, projectRoot: string): string {
  if (readContainerConfig(projectRoot).enabled && args[0] !== 'worktree') {
    const info = containerManager.getRunningContainer(projectRoot);
    if (info) {
      const containerCwd = hostToContainerPath(hostCwd, projectRoot, info.remoteWorkspaceFolder);
      const mappedArgs = args.map(a =>
        path.isAbsolute(a) && a.startsWith(projectRoot)
          ? hostToContainerPath(a, projectRoot, info.remoteWorkspaceFolder)
          : a
      );
      const remoteUser = readContainerRemoteUser(projectRoot);
      const gitEnv = worktreeGitEnv(hostCwd, projectRoot, info.remoteWorkspaceFolder);
      const envFlags = Object.entries(gitEnv).flatMap(([k, v]) => ['-e', `${k}=${v}`]);
      return execFileSync(getToolPath('docker'), ['exec', '-u', remoteUser, ...envFlags, '-w', containerCwd, info.containerId, 'git', ...mappedArgs], { encoding: 'utf-8' });
    }
  }
  const gitEnv = args[0] !== 'worktree' ? worktreeGitEnv(hostCwd, projectRoot) : {};
  return execFileSync('git', args, { cwd: hostCwd, encoding: 'utf-8', ...(Object.keys(gitEnv).length ? { env: { ...process.env, ...gitEnv } } : {}) });
}
