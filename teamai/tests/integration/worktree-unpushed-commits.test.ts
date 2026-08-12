/**
 * Integration tests for worktree unpushed-commit detection.
 *
 * Tests verify that:
 *  - getUnpushedCommits() detects local-only commits ahead of origin
 *  - removeWorktree() logs a warning when unpushed commits exist
 *  - Worktree teardown is non-blocking — the warning is best-effort
 *
 * Uses a real temporary git repository with a remote to simulate
 * the exact scenario from the bug report.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { execFileSync } from 'child_process';
import { getUnpushedCommits } from '@/lib/orchestrator/worktree-ops';

// ── Mocks ────────────────────────────────────────────────────────────────────

const mockCreateSession = vi.fn();
const mockSendMessage = vi.fn();
const mockKillSession = vi.fn();
const mockEmit = vi.fn();

vi.mock('@/lib/process-manager', () => ({
  processManager: {
    createSession: (...args: unknown[]) => mockCreateSession(...args),
    sendMessage: (...args: unknown[]) => mockSendMessage(...args),
    killSession: (...args: unknown[]) => mockKillSession(...args),
    writeToSession: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
    emit: (...args: unknown[]) => mockEmit(...args),
    getStaleSessions: () => [],
    getAllSessions: () => [],
  },
  containerSessionOpts: (projectRoot: string) => ({ projectRoot, permissionMode: 'bypassPermissions' as const }),
}));

vi.mock('@/lib/container-manager', () => ({
  containerManager: {
    on: vi.fn(),
    off: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
    getStatus: vi.fn().mockReturnValue('stopped'),
    emit: vi.fn(),
  },
  readContainerConfig: vi.fn().mockReturnValue({ enabled: false }),
  readContainerRemoteUser: vi.fn(() => 'node'),
  hostToContainerPath: vi.fn((p: string) => p),
  dockerAvailable: vi.fn(() => false),
  _resetDockerAvailableCache: vi.fn(),
}));

vi.mock('@/lib/recovery', () => ({
  findInterruptedTasks: () => [],
  findOrphanedWorktrees: () => [],
  startupCleanup: () => ({ interruptedTasks: [], staleSessions: 0, orphanedWorktrees: [], autoClearedRateLimits: 0, artifactInconsistencies: [] }),
  autoClearExpiredRateLimits: () => 0,
  reconcileTaskArtifacts: () => [],
  autoResumeInterruptedTasks: () => Promise.resolve(0),
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

let testDir: string;
let remoteDir: string;
let taskId: string;

function setupGitRepo() {
  testDir = join(tmpdir(), `teamai-wt-test-${randomUUID().slice(0, 8)}`);
  remoteDir = join(tmpdir(), `teamai-wt-remote-${randomUUID().slice(0, 8)}`);

  // Create bare remote
  mkdirSync(remoteDir, { recursive: true });
  execFileSync('git', ['init', '--bare'], { cwd: remoteDir, stdio: 'ignore' });

  // Clone from remote
  execFileSync('git', ['clone', remoteDir, testDir], { stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@teamai.dev'], { cwd: testDir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'TeamAI Test'], { cwd: testDir, stdio: 'ignore' });

  // Initial commit and push to set up origin/main
  writeFileSync(join(testDir, '.gitkeep'), '');
  execFileSync('git', ['add', '.gitkeep'], { cwd: testDir, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', 'initial'], { cwd: testDir, stdio: 'ignore' });
  execFileSync('git', ['push', '-u', 'origin', 'main'], { cwd: testDir, stdio: 'ignore' });

  // Create .teamai directory structure
  const teamaiDir = join(testDir, '.teamai');
  mkdirSync(teamaiDir, { recursive: true });

  taskId = randomUUID();
  const taskDir = join(teamaiDir, taskId);
  mkdirSync(taskDir, { recursive: true });

  writeFileSync(
    join(teamaiDir, 'pipeline.json'),
    JSON.stringify({
      phases: ['spec', 'plan', 'implement', 'qa-review', 'merge'],
      maxQaAttempts: 3,
      parallelSubtasks: true,
    }),
  );

  writeFileSync(
    join(taskDir, 'task.json'),
    JSON.stringify({
      id: taskId,
      title: 'Worktree Unpushed Commit Test',
      description: 'Integration test for unpushed commit detection',
      phase: 'backlog',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }),
  );
}

function cleanup() {
  vi.clearAllMocks();
  for (const d of [testDir, remoteDir]) {
    if (d && existsSync(d)) {
      try { rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
  }
}

/** Run getUnpushedCommits directly on a branch */
function checkUnpushed(projectRoot: string, branch: string): string | null {
  return getUnpushedCommits(projectRoot, branch);
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Worktree unpushed-commit detection', () => {
  describe('getUnpushedCommits', () => {
    beforeEach(() => {
      setupGitRepo();
    });

    afterEach(() => {
      cleanup();
    });

    it('returns null when the branch has no unpushed commits (clean)', () => {
      // Create a branch from main — no new commits
      execFileSync('git', ['checkout', '-b', 'feat/clean'], { cwd: testDir, stdio: 'ignore' });
      execFileSync('git', ['push', '-u', 'origin', 'feat/clean'], { cwd: testDir, stdio: 'ignore' });

      const result = checkUnpushed(testDir, 'feat/clean');
      expect(result).toBeNull();
    });

    it('returns the commit log when local branch is ahead of origin', () => {
      // Push first to establish origin tracking, then add an unpushed commit
      execFileSync('git', ['checkout', '-b', 'feat/unpushed'], { cwd: testDir, stdio: 'ignore' });
      execFileSync('git', ['push', '-u', 'origin', 'feat/unpushed'], { cwd: testDir, stdio: 'ignore' });

      writeFileSync(join(testDir, 'new-file.ts'), 'export const x = 1;');
      execFileSync('git', ['add', 'new-file.ts'], { cwd: testDir, stdio: 'ignore' });
      execFileSync('git', ['commit', '-m', 'feat: add new module'], { cwd: testDir, stdio: 'ignore' });

      const result = checkUnpushed(testDir, 'feat/unpushed');
      expect(result).not.toBeNull();
      expect(result!).toContain('feat: add new module');
    });

    it('returns null when the remote branch does not exist yet', () => {
      // Create a branch but never push — origin/<branch> doesn't exist
      execFileSync('git', ['checkout', '-b', 'feat/never-pushed'], { cwd: testDir, stdio: 'ignore' });
      writeFileSync(join(testDir, 'orphan.ts'), '// no remote tracking');
      execFileSync('git', ['add', 'orphan.ts'], { cwd: testDir, stdio: 'ignore' });
      execFileSync('git', ['commit', '-m', 'orphan commit'], { cwd: testDir, stdio: 'ignore' });

      const result = checkUnpushed(testDir, 'feat/never-pushed');
      // origin/feat/never-pushed doesn't exist → null (can't compare)
      expect(result).toBeNull();
    });

    it('detects multiple unpushed commits', () => {
      execFileSync('git', ['checkout', '-b', 'feat/multi'], { cwd: testDir, stdio: 'ignore' });

      writeFileSync(join(testDir, 'a.ts'), '1');
      execFileSync('git', ['add', 'a.ts'], { cwd: testDir, stdio: 'ignore' });
      execFileSync('git', ['commit', '-m', 'commit one'], { cwd: testDir, stdio: 'ignore' });

      writeFileSync(join(testDir, 'b.ts'), '2');
      execFileSync('git', ['add', 'b.ts'], { cwd: testDir, stdio: 'ignore' });
      execFileSync('git', ['commit', '-m', 'commit two'], { cwd: testDir, stdio: 'ignore' });

      // Push so origin tracking is established, then add another commit
      execFileSync('git', ['push', '-u', 'origin', 'feat/multi'], { cwd: testDir, stdio: 'ignore' });

      writeFileSync(join(testDir, 'c.ts'), '3');
      execFileSync('git', ['add', 'c.ts'], { cwd: testDir, stdio: 'ignore' });
      execFileSync('git', ['commit', '-m', 'commit three — unpushed'], { cwd: testDir, stdio: 'ignore' });

      const result = checkUnpushed(testDir, 'feat/multi');
      expect(result).not.toBeNull();
      expect(result!).toContain('commit three');
      expect(result!).not.toContain('commit two'); // already pushed
    });
  });

  describe('removeWorktree warns on unpushed commits', () => {
    let orch: any;

    beforeEach(async () => {
      setupGitRepo();

      // Create a task with a real branch and worktree
      const slug = `wt-test-${randomUUID().slice(0, 8)}`;
      const branch = `feat/${slug}`;
      const worktreePath = join(testDir, '..', 'worktrees', slug);

      // Ensure no stale worktree
      try {
        execFileSync('git', ['worktree', 'remove', '--force', worktreePath], { cwd: testDir, stdio: 'ignore' });
      } catch { /* ok */ }

      // Create branch + worktree.  Must checkout main first so the new
      // branch isn't already occupied by the clone's working tree.
      execFileSync('git', ['checkout', '-b', branch], { cwd: testDir, stdio: 'ignore' });
      execFileSync('git', ['push', '-u', 'origin', branch], { cwd: testDir, stdio: 'ignore' });
      execFileSync('git', ['checkout', 'main'], { cwd: testDir, stdio: 'ignore' });
      // Ensure the worktrees parent directory exists (git worktree add
      // creates the target directory but not its parents)
      const worktreesDir = join(testDir, '..', 'worktrees');
      mkdirSync(worktreesDir, { recursive: true });

      // On Windows, git worktree add can hit a race where git tries to
      // create index.lock inside .git/ before that directory exists.
      // Retry with full cleanup of git's internal state between attempts.
      let lastErr: unknown;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          execFileSync('git', ['worktree', 'add', worktreePath, branch], { cwd: testDir, stdio: 'ignore' });
          lastErr = null;
          break;
        } catch (e) {
          lastErr = e;
          try { execFileSync('git', ['branch', '-D', branch], { cwd: testDir, stdio: 'pipe' }); } catch { /* ok */ }
          try { rmSync(worktreePath, { recursive: true, force: true }); } catch { /* ok */ }
          try { execFileSync('git', ['worktree', 'prune'], { cwd: testDir, stdio: 'pipe' }); } catch { /* ok */ }
          const end = Date.now() + 500;
          while (Date.now() < end) { /* busy-wait */ }
        }
      }
      if (lastErr) throw lastErr;

      // Make an unpushed commit in the worktree
      writeFileSync(join(worktreePath, 'secret.ts'), '// this should not be lost');
      execFileSync('git', ['add', 'secret.ts'], { cwd: worktreePath, stdio: 'ignore' });
      execFileSync('git', ['commit', '-m', 'secret commit — unpushed'], { cwd: worktreePath, stdio: 'ignore' });

      // Update task.json with the real branch name
      const taskDir = join(testDir, '.teamai', taskId);
      const task = JSON.parse(readFileSync(join(taskDir, 'task.json'), 'utf-8'));
      task.branch = branch;
      task.slug = slug;
      writeFileSync(join(taskDir, 'task.json'), JSON.stringify(task, null, 2));

      // Import orchestrator
      const mod = await import('@/lib/orchestrator');
      orch = mod.getOrchestrator(testDir);
    });

    afterEach(() => {
      // Remove the worktree before deleting testDir (worktrees live
      // outside testDir so cleanup() alone would leak them)
      try {
        const taskPath = join(testDir, '.teamai', taskId, 'task.json');
        if (existsSync(taskPath)) {
          const task = JSON.parse(readFileSync(taskPath, 'utf-8'));
          if (task.branch && task.slug) {
            const worktreePath = join(testDir, '..', 'worktrees', task.slug);
            if (existsSync(worktreePath)) {
              try { execFileSync('git', ['worktree', 'remove', '--force', worktreePath], { cwd: testDir, stdio: 'ignore' }); } catch { /* ok */ }
            }
          }
        }
      } catch { /* best-effort — cleanup must not mask test failures */ }
      cleanup();
      vi.resetModules();
    });

    it('logs a warning to output.log when removing a worktree with unpushed commits', () => {
      const taskDir = join(testDir, '.teamai', taskId);
      const outputLog = join(taskDir, 'output.log');

      // Verify the branch has unpushed commits
      const task = JSON.parse(readFileSync(join(taskDir, 'task.json'), 'utf-8'));
      const unpushed = checkUnpushed(testDir, task.branch);
      expect(unpushed).not.toBeNull();
      expect(unpushed!).toContain('secret commit');

      // Remove the worktree — this should log a warning but not throw
      expect(() => {
        orch._ctx.removeWorktree(taskId);
      }).not.toThrow();

      // output.log should contain the warning
      expect(existsSync(outputLog)).toBe(true);
      const log = readFileSync(outputLog, 'utf-8');
      expect(log).toContain('[WORKTREE]');
      expect(log).toContain('unpushed commits');
      expect(log).toContain('secret commit');
    });

    it('does not log a warning when worktree has no unpushed commits', () => {
      const taskDir = join(testDir, '.teamai', taskId);
      const outputLog = join(taskDir, 'output.log');

      // Push the dangling commit
      const task = JSON.parse(readFileSync(join(taskDir, 'task.json'), 'utf-8'));
      execFileSync('git', ['push', 'origin', task.branch], { cwd: testDir, stdio: 'ignore' });

      // Now removeWorktree should proceed silently
      expect(() => {
        orch._ctx.removeWorktree(taskId);
      }).not.toThrow();

      // If output.log was created, it should NOT contain a warning
      if (existsSync(outputLog)) {
        const log = readFileSync(outputLog, 'utf-8');
        expect(log).not.toContain('unpushed commits');
      }
    });
  });
});
