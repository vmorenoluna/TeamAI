/**
 * Integration tests for runCreatePR merger conflict resolution.
 *
 * Uses real git repositories with actual merge conflicts (not mocked git)
 * to verify that the merger agent is spawned when rebase fails, falls back
 * gracefully when the merger cannot resolve conflicts, and is NOT spawned
 * when the rebase succeeds cleanly.
 *
 * The processManager is mocked so no real Claude sessions are spawned.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, writeFileSync, existsSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { execFileSync } from 'child_process';

// ── Hoisted mocks ────────────────────────────────────────────────────────────

const onHandlers = vi.hoisted(() => new Map<string, Array<(...args: any[]) => void>>());
const mockCreateSession = vi.hoisted(() => vi.fn());
const mockSendMessage = vi.hoisted(() => vi.fn());
const mockKillSession = vi.hoisted(() => vi.fn());
const mockGetSession = vi.hoisted(() => vi.fn());

vi.mock('@/lib/process-manager', () => ({
  processManager: {
    createSession: (...args: unknown[]) => mockCreateSession(...args),
    sendMessage: (...args: unknown[]) => mockSendMessage(...args),
    killSession: (...args: unknown[]) => mockKillSession(...args),
    writeToSession: vi.fn(),
    on: (event: string, handler: (...args: unknown[]) => void) => {
      if (!onHandlers.has(event)) onHandlers.set(event, []);
      onHandlers.get(event)!.push(handler);
    },
    off: (event: string, handler: (...args: unknown[]) => void) => {
      const handlers = onHandlers.get(event);
      if (handlers) {
        const idx = handlers.indexOf(handler);
        if (idx >= 0) handlers.splice(idx, 1);
      }
    },
    emit: vi.fn(),
    getSession: (...args: unknown[]) => mockGetSession(...args),
    getStaleSessions: () => [],
    getAllSessions: () => [],
    getTerminalSessions: () => [],
    killTerminalSession: vi.fn(),
    removeStaleSession: vi.fn(),
    terminateSession: vi.fn(),
  },
  containerSessionOpts: (projectRoot: string) => ({ projectRoot, permissionMode: 'bypassPermissions' as const }),
}));

vi.mock('@/lib/container-manager', () => ({
  readContainerConfig: vi.fn(() => ({ enabled: false, explicit: false })),
  readContainerRemoteUser: vi.fn(() => 'node'),
  containerManager: {
    getRunningContainer: vi.fn(() => null),
    ensureContainer: vi.fn(),
  },
  hostToContainerPath: vi.fn((p: string) => p),
  dockerAvailable: vi.fn(() => true),
  _resetDockerAvailableCache: vi.fn(),
}));

vi.mock('@/lib/recovery', () => ({
  findInterruptedTasks: () => [],
  findOrphanedWorktrees: () => [],
  startupCleanup: () => ({ interruptedTasks: [], staleSessions: 0, orphanedWorktrees: [], autoClearedRateLimits: 0, artifactInconsistencies: [] }),
  autoClearExpiredRateLimits: () => 0,
  reconcileTaskArtifacts: () => [],
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

type AnyOrch = any;

function fireEvent(event: string, data: any) {
  const handlers = onHandlers.get(event);
  if (handlers) {
    for (const h of [...handlers]) h(data);
  }
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('CreatePR Conflict Resolution Integration', () => {
  let originDir: string;
  let projectDir: string;
  let specPath: string;
  let taskId: string;
  let slug: string;
  let orch: any;

  /** Create a real git bare repo as origin, clone it, init TeamAI structure */
  function setupRepo() {
    // Bare origin repo
    originDir = join(tmpdir(), `teamai-origin-${randomUUID().slice(0, 8)}`);
    mkdirSync(originDir, { recursive: true });
    execFileSync('git', ['init', '--bare', '-b', 'master'], { cwd: originDir, stdio: 'ignore' });

    // Clone into project
    projectDir = join(tmpdir(), `teamai-project-${randomUUID().slice(0, 8)}`);
    execFileSync('git', ['clone', originDir, projectDir], { stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'test@teamai.dev'], { cwd: projectDir, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.name', 'TeamAI Test'], { cwd: projectDir, stdio: 'ignore' });

    // Initial commit on master (needed for branching)
    writeFileSync(join(projectDir, 'base.txt'), 'base content\n');
    execFileSync('git', ['add', '.'], { cwd: projectDir, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'initial commit'], { cwd: projectDir, stdio: 'ignore' });
    execFileSync('git', ['push', 'origin', 'master'], { cwd: projectDir, stdio: 'ignore' });

    // TeamAI directory structure
    mkdirSync(join(projectDir, '.teamai'), { recursive: true });
    writeFileSync(
      join(projectDir, '.teamai', 'pipeline.json'),
      JSON.stringify({ maxQaAttempts: 3, parallelSubtasks: true }),
    );

    specPath = join(projectDir, '.teamai', taskId);
    mkdirSync(specPath, { recursive: true });
    writeFileSync(
      join(specPath, 'task.json'),
      JSON.stringify({
        id: taskId,
        title: 'Test Feature',
        description: slug,
        phase: 'backlog',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }),
    );
    writeFileSync(join(specPath, 'spec.md'), '# Test Feature\n\nImplement this feature.\n');
  }

  /** Create the feature branch worktree and return its path */
  function createFeatureWorktree(): string {
    const worktreePath = join(projectDir, '..', 'worktrees', slug);
    // Clean up any stale worktree from previous run
    if (existsSync(worktreePath)) {
      try { rmSync(worktreePath, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
    try {
      execFileSync('git', ['worktree', 'remove', '--force', worktreePath], { cwd: projectDir, stdio: 'ignore' });
    } catch { /* best-effort — may not exist in metadata */ }
    try {
      execFileSync('git', ['branch', '-D', `feat/${slug}`], { cwd: projectDir, stdio: 'ignore' });
    } catch { /* best-effort */ }

    execFileSync('git', ['worktree', 'add', worktreePath, '-b', `feat/${slug}`], { cwd: projectDir, stdio: 'ignore' });
    return worktreePath;
  }

  /** Create an output.log with a PR URL so _extractPrUrl succeeds */
  function writePrOutput() {
    writeFileSync(join(specPath, 'output.log'), 'Created: https://github.com/test/repo/pull/42\n');
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    onHandlers.clear();
    mockGetSession.mockReturnValue(undefined);

    taskId = randomUUID();
    slug = `test-feat-${randomUUID().slice(0, 6)}`;
    setupRepo();

    const mod = await import('@/lib/orchestrator');
    orch = mod.getOrchestrator(projectDir);
  });

  afterEach(() => {
    // Clean up the feature worktree if it still exists (worktrees live outside projectDir)
    const worktreePath = join(projectDir, '..', 'worktrees', slug);
    if (existsSync(worktreePath)) {
      try {
        execFileSync('git', ['worktree', 'remove', '--force', worktreePath], { cwd: projectDir, stdio: 'ignore' });
      } catch { /* best-effort */ }
      try { rmSync(worktreePath, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
    try {
      execFileSync('git', ['worktree', 'prune'], { cwd: projectDir, stdio: 'ignore' });
    } catch { /* best-effort */ }
    try { rmSync(projectDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    try { rmSync(originDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    vi.resetModules();
  });

  // ── Test 1: Real conflict → merger resolves it → PR created ─────────────────

  it('spawns merger agent when rebase has conflicts, completes merge, advances to pr-open', async () => {
    const worktreePath = createFeatureWorktree();

    // Make a change on the feature branch
    writeFileSync(join(worktreePath, 'conflict.txt'), 'FEATURE CHANGE\n');
    execFileSync('git', ['add', '.'], { cwd: worktreePath, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'feature work'], { cwd: worktreePath, stdio: 'ignore' });

    // Make a conflicting change on master and push to origin
    writeFileSync(join(projectDir, 'conflict.txt'), 'MASTER CHANGE\n');
    execFileSync('git', ['add', '.'], { cwd: projectDir, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'master update'], { cwd: projectDir, stdio: 'ignore' });
    execFileSync('git', ['push', 'origin', 'master'], { cwd: projectDir, stdio: 'ignore' });
    // Now pull master into the project repo so origin/master ref is current
    execFileSync('git', ['fetch', 'origin', 'master'], { cwd: projectDir, stdio: 'ignore' });

    // Mock sessions: first = merger, second = PR creation
    let mergeSessionCreated = false;
    mockCreateSession.mockImplementation(() => {
      if (!mergeSessionCreated) {
        mergeSessionCreated = true;
        return Promise.resolve('sess-merge');
      }
      return Promise.resolve('sess-pr');
    });

    // Start runCreatePR
    const pipeline = {
      taskId,
      description: slug,
      phase: 'create-pr' as const,
      specPath,
      worktreePath,
      branch: `feat/${slug}`,
      qaAttempt: 0,
      maxQaAttempts: 3,
    };
    const promise = (orch as AnyOrch).runCreatePR(pipeline);
    // Allow async work to reach the merger session creation
    await new Promise(r => setTimeout(r, 100));

    // Verify the merger agent was spawned
    expect(mockSendMessage).toHaveBeenCalledWith('sess-merge', '/merge origin/master');

    // Simulate the merger agent resolving the conflict:
    // merge origin/master into feature, fix conflict, commit
    try {
      // This will produce a conflict — that's expected
      execFileSync('git', ['merge', 'origin/master'], { cwd: worktreePath, stdio: 'ignore' });
    } catch {
      // Resolve the conflict by writing a combined file
      writeFileSync(join(worktreePath, 'conflict.txt'), 'RESOLVED BY MERGER\n');
      execFileSync('git', ['add', 'conflict.txt'], { cwd: worktreePath, stdio: 'ignore' });
      execFileSync('git', ['commit', '-m', 'merge resolved by merger agent'], { cwd: worktreePath, stdio: 'ignore' });
    }

    // Complete the merger session
    fireEvent('event', { sessionId: 'sess-merge', event: { type: 'result' } });
    await new Promise(r => setTimeout(r, 50));

    // The pipeline should now be running _commitArtifactsToWorktree → push → PR creation
    // Add PR URL to output.log so _extractPrUrl finds it
    writePrOutput();

    // Complete the PR creation session
    fireEvent('event', { sessionId: 'sess-pr', event: { type: 'result' } });
    await promise;

    // Verify both sessions were killed
    expect(mockKillSession).toHaveBeenCalledWith('sess-merge');
    expect(mockKillSession).toHaveBeenCalledWith('sess-pr');

    // Verify pipeline advanced to pr-open
    expect(pipeline.phase).toBe('pr-open');
  });

  // ── Test 2: Real conflict → merger fails → graceful fallback ────────────────

  it('falls back gracefully when merger agent cannot resolve conflicts', async () => {
    const worktreePath = createFeatureWorktree();

    // Feature branch change
    writeFileSync(join(worktreePath, 'conflict.txt'), 'FEATURE CHANGE\n');
    execFileSync('git', ['add', '.'], { cwd: worktreePath, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'feature work'], { cwd: worktreePath, stdio: 'ignore' });

    // Conflicting master change
    writeFileSync(join(projectDir, 'conflict.txt'), 'MASTER CHANGE\n');
    execFileSync('git', ['add', '.'], { cwd: projectDir, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'master update'], { cwd: projectDir, stdio: 'ignore' });
    execFileSync('git', ['push', 'origin', 'master'], { cwd: projectDir, stdio: 'ignore' });
    execFileSync('git', ['fetch', 'origin', 'master'], { cwd: projectDir, stdio: 'ignore' });

    // Mock sessions
    let mergeSessionCreated = false;
    mockCreateSession.mockImplementation(() => {
      if (!mergeSessionCreated) {
        mergeSessionCreated = true;
        return Promise.resolve('sess-merge');
      }
      return Promise.resolve('sess-pr');
    });

    const pipeline = {
      taskId,
      description: slug,
      phase: 'create-pr' as const,
      specPath,
      worktreePath,
      branch: `feat/${slug}`,
      qaAttempt: 0,
      maxQaAttempts: 3,
    };
    const promise = (orch as AnyOrch).runCreatePR(pipeline);
    await new Promise(r => setTimeout(r, 100));

    // Verify merger was spawned
    expect(mockSendMessage).toHaveBeenCalledWith('sess-merge', '/merge origin/master');

    // Simulate merger failure — exit with non-zero code
    fireEvent('exit', { sessionId: 'sess-merge', code: 1 });
    await new Promise(r => setTimeout(r, 50));

    // Write PR output and complete PR session
    writePrOutput();
    fireEvent('event', { sessionId: 'sess-pr', event: { type: 'result' } });
    await promise;

    // Despite merger failure, pipeline should still advance to pr-open
    expect(pipeline.phase).toBe('pr-open');
  });

  // ── Test 3: Clean rebase → no merger spawned ────────────────────────────────

  it('does not spawn merger agent when rebase succeeds cleanly', async () => {
    const worktreePath = createFeatureWorktree();

    // Feature branch change — different file than master
    writeFileSync(join(worktreePath, 'feature-file.txt'), 'feature content\n');
    execFileSync('git', ['add', '.'], { cwd: worktreePath, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'feature work'], { cwd: worktreePath, stdio: 'ignore' });

    // Master change — different file, no conflict
    writeFileSync(join(projectDir, 'master-file.txt'), 'master content\n');
    execFileSync('git', ['add', '.'], { cwd: projectDir, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'master update'], { cwd: projectDir, stdio: 'ignore' });
    execFileSync('git', ['push', 'origin', 'master'], { cwd: projectDir, stdio: 'ignore' });
    execFileSync('git', ['fetch', 'origin', 'master'], { cwd: projectDir, stdio: 'ignore' });

    // Only one session — PR creation (no merger needed)
    mockCreateSession.mockResolvedValue('sess-pr');

    const pipeline = {
      taskId,
      description: slug,
      phase: 'create-pr' as const,
      specPath,
      worktreePath,
      branch: `feat/${slug}`,
      qaAttempt: 0,
      maxQaAttempts: 3,
    };
    const promise = (orch as AnyOrch).runCreatePR(pipeline);
    await new Promise(r => setTimeout(r, 100));

    // Should NOT have sent /merge origin/master
    const sendCalls = mockSendMessage.mock.calls as any[][];
    const mergeCalls = sendCalls.filter(
      (c) => c[1] && typeof c[1] === 'string' && c[1].includes('/merge origin/master'),
    );
    expect(mergeCalls.length).toBe(0);

    // Should have sent PR creation prompt instead
    expect(mockSendMessage).toHaveBeenCalledWith('sess-pr', expect.stringContaining('Pull Request'));

    // Write PR output and complete
    writePrOutput();
    fireEvent('event', { sessionId: 'sess-pr', event: { type: 'result' } });
    await promise;

    expect(pipeline.phase).toBe('pr-open');
    expect(mockCreateSession).toHaveBeenCalledTimes(1);
  });
});
