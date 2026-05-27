import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, existsSync, readFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { createTestProject } from '../utils/test-project';

 
type AnyOrch = any; // Access private members for test setup

// We mock the process-manager module before importing orchestrator
vi.mock('../../src/lib/process-manager', () => ({
  processManager: {
    on: vi.fn(),
    off: vi.fn(),
    emit: vi.fn(),
    createSession: vi.fn(),
    sendMessage: vi.fn(),
    killSession: vi.fn(),
    getSession: vi.fn(),
    getAllSessions: vi.fn(() => []),
    getStaleSessions: vi.fn(() => []),
    removeStaleSession: vi.fn(),
    getTerminalSessions: vi.fn(() => []),
    killTerminalSession: vi.fn(),
    writeToSession: vi.fn(),
    terminateSession: vi.fn(),
  },
}));

vi.mock('../../src/lib/container-manager', () => ({
  readContainerConfig: vi.fn(() => ({ enabled: false })),
  readContainerRemoteUser: vi.fn(() => 'node'),
  containerManager: {
    getRunningContainer: vi.fn(() => null),
  },
  hostToContainerPath: vi.fn((p: string) => p),
}));

import { getOrchestrator } from '../../src/lib/orchestrator';
import { Orchestrator } from '../../src/lib/orchestrator';
import { processManager } from '../../src/lib/process-manager';

// Helper to create a test project directory with a task
function setupTestProject(): { root: string; taskId: string; clean: () => void } {
  const { root, clean } = createTestProject();
  mkdirSync(join(root, '.teamai'), { recursive: true });

  // Create default pipeline config
  writeFileSync(join(root, '.teamai', 'pipeline.json'), JSON.stringify({
    phases: ['spec', 'plan', 'implement', 'qa-review', 'merge'],
    maxQaAttempts: 3,
    parallelSubtasks: true,
  }));

  const taskId = randomUUID();
  const taskDir = join(root, '.teamai', 'my-test-task');
  mkdirSync(taskDir, { recursive: true });
  writeFileSync(join(taskDir, 'task.json'), JSON.stringify({
    id: taskId,
    title: 'My Test Task',
    description: 'A test task for unit tests',
    phase: 'backlog',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }));

  return { root, taskId, clean };
}

describe('getOrchestrator', () => {
  it('returns the same instance for the same project path (singleton)', () => {
    const { root: p, clean } = createTestProject();
    try {
      const orch1 = getOrchestrator(p);
      const orch2 = getOrchestrator(p);
      expect(orch1).toBe(orch2);
    } finally { clean(); }
  });

  it('returns different instances for different project paths', () => {
    const { root: p1, clean: c1 } = createTestProject();
    const { root: p2, clean: c2 } = createTestProject();
    try {
      const orch1 = getOrchestrator(p1);
      const orch2 = getOrchestrator(p2);
      expect(orch1).not.toBe(orch2);
    } finally { c1(); c2(); }
  });
});

describe('Orchestrator', () => {
  let orch: Orchestrator;
  let testData: ReturnType<typeof setupTestProject>;

  beforeEach(() => {
    vi.clearAllMocks();
    testData = setupTestProject();
    orch = getOrchestrator(testData.root);
  });

  afterEach(() => {
    testData.clean();
  });

  describe('isTaskActive', () => {
    it('returns false for unknown task', () => {
      expect(orch.isTaskActive('nonexistent')).toBe(false);
    });

    it('returns false for a task not currently running', () => {
      // Task exists but is not active (not in the activeTasks set)
      expect(orch.isTaskActive(testData.taskId)).toBe(false);
    });
  });

  describe('cancelPipeline', () => {
    it('does nothing when no pipeline exists for the task', () => {
      expect(() => orch.cancelPipeline('nonexistent')).not.toThrow();
      expect(processManager.killSession).not.toHaveBeenCalled();
    });

    it('calls killSession when pipeline has an active sessionId', () => {
      // Access private pipelines map to set up state
      const pipelines = (orch as AnyOrch).pipelines;
      const pipeline = {
        taskId: testData.taskId,
        description: 'test',
        phase: 'implement',
        specPath: '/test',
        worktreePath: '/test/wt',
        branch: 'feat/test',
        qaAttempt: 0,
        maxQaAttempts: 3,
        sessionId: 'session-abc',
      };
      pipelines.set(testData.taskId, pipeline);
      (orch as AnyOrch).activeTasks.add(testData.taskId);

      orch.cancelPipeline(testData.taskId);

      expect(processManager.killSession).toHaveBeenCalledWith('session-abc');
      expect(pipelines.has(testData.taskId)).toBe(false);
    });
  });

  describe('moveTaskToPhase', () => {
    it('throws for nonexistent task', async () => {
      await expect(orch.moveTaskToPhase('nonexistent', 'spec')).rejects.toThrow('not found');
    });

    it('handles done phase as a no-run phase without spawning', async () => {
      await orch.moveTaskToPhase(testData.taskId, 'done');

      // Should have emitted phase-change
      expect(processManager.emit).toHaveBeenCalledWith('phase-change', {
        taskId: testData.taskId,
        phase: 'done',
      });

      vi.mocked(processManager.emit).mockClear();

      await orch.moveTaskToPhase(testData.taskId, 'backlog');
      expect(processManager.emit).toHaveBeenCalledWith('phase-change', {
        taskId: testData.taskId,
        phase: 'backlog',
      });
    });
  });

  describe('approveTask', () => {
    it('throws when task is not awaiting review', async () => {
      await expect(orch.approveTask(testData.taskId, 'local-merge')).rejects.toThrow('is not awaiting-review');
    });
  });

  describe('rejectTask', () => {
    it('throws when task is not awaiting review', async () => {
      await expect(orch.rejectTask(testData.taskId, 'Needs more work')).rejects.toThrow('is not awaiting-review');
    });
  });

  // ── Private method coverage (via AnyOrch) ──

  describe('getWorktreeBase', () => {
    it('returns ..\worktrees path when container is disabled', () => {
      const base = (orch as AnyOrch).getWorktreeBase();
      expect(base).toContain('worktrees');
      expect(base).not.toContain('.worktrees');
    });
  });

  describe('sessionOpts', () => {
    it('returns session options object with expected shape', () => {
      const opts = (orch as AnyOrch).sessionOpts('coder', '/test/cwd', 'task-1', '/test/log.txt');
      expect(opts.taskId).toBe('task-1');
      expect(opts.role).toBe('coder');
      expect(opts.cwd).toBe('/test/cwd');
      expect(opts.permissionMode).toBe('bypassPermissions');
      expect(opts.logFile).toBe('/test/log.txt');
    });

    it('omits logFile when not provided', () => {
      const opts = (orch as AnyOrch).sessionOpts('planner', '/cwd', 'task-2');
      expect(opts.logFile).toBeUndefined();
    });
  });

  describe('_phaseHeader', () => {
    it('writes phase header to log file without throwing', () => {
      const logFile = join(testData.root, '.teamai', 'test-output.log');
      expect(() => (orch as AnyOrch)._phaseHeader(logFile, 'spec')).not.toThrow();
    });
  });

  describe('advancePhase', () => {
    it('updates phase and emits', () => {
      const pipeline = {
        taskId: testData.taskId,
        description: 'test',
        phase: 'spec',
        specPath: '/test',
        worktreePath: '/test/wt',
        branch: 'feat/test',
        qaAttempt: 0,
        maxQaAttempts: 3,
      };

      (orch as AnyOrch).advancePhase(pipeline, 'plan');

      expect(pipeline.phase).toBe('plan');
      expect(processManager.emit).toHaveBeenCalledWith('phase-change', {
        taskId: testData.taskId,
        phase: 'plan',
      });
    });
  });

  describe('_toAgentPath', () => {
    it('returns hostPath unchanged when container is disabled', () => {
      const result = (orch as AnyOrch)._toAgentPath('/test/path');
      expect(result).toBe('/test/path');
    });
  });

  // ── #6 _rotateOutputLog ─────────────────────────────────────────

  describe('_rotateOutputLog', () => {
    it('does nothing when the log file does not exist', () => {
      expect(() => {
        (orch as AnyOrch)._rotateOutputLog('/nonexistent/log/file.log');
      }).not.toThrow();
    });

    it('does nothing when log file is under the size threshold', () => {
      const logFile = join(testData.root, '.teamai', 'small-log.log');
      writeFileSync(logFile, 'a'.repeat(1000));
      const before = readFileSync(logFile, 'utf-8');
      (orch as AnyOrch)._rotateOutputLog(logFile);
      const after = readFileSync(logFile, 'utf-8');
      expect(after).toBe(before);
    });

    it('truncates to last ~50KB when the log exceeds 100KB', () => {
      const logFile = join(testData.root, '.teamai', 'large-log.log');
      // Write 150KB of content: 100KB of padding + 50KB of unique suffix
      const PAD = 'x'.repeat(102400); // 100 KB
      const SUFFIX = 'Y'.repeat(51200); // 50 KB
      writeFileSync(logFile, PAD + SUFFIX);
      (orch as AnyOrch)._rotateOutputLog(logFile);
      const after = readFileSync(logFile, 'utf-8');
      // Keeps last ~50K chars (= slice of suffix) + truncation message
      expect(after.length).toBeGreaterThan(49000); // ~50K chars
      expect(after.length).toBeLessThan(52000); // plus small message
      expect(after).toContain('LOG TRUNCATED');
      // The suffix is 51200 chars; the last 50000 chars are preserved
      expect(after).toContain('Y'.repeat(49000)); // bulk of suffix present
      // PAD (100KB of 'x') must have been truncated away
      expect(after).not.toContain('x'.repeat(100));
    });

    it('does not throw on permission errors (best-effort)', () => {
      // Non-existent directory — should not throw
      expect(() => {
        (orch as AnyOrch)._rotateOutputLog('/root/forbidden/log.log');
      }).not.toThrow();
    });
  });

  // ── #5 _persistAndEmitPhase ─────────────────────────────────────

  describe('_persistAndEmitPhase', () => {
    it('persists the current pipeline phase to disk and emits phase-change', () => {
      const pipeline = {
        taskId: testData.taskId,
        description: 'test',
        phase: 'implement' as const,
        specPath: join(testData.root, '.teamai', 'my-test-task'),
        worktreePath: '/test/wt',
        branch: 'feat/test',
        qaAttempt: 0,
        maxQaAttempts: 3,
      };

      vi.mocked(processManager.emit).mockClear();

      (orch as AnyOrch)._persistAndEmitPhase(pipeline);

      expect(processManager.emit).toHaveBeenCalledWith('phase-change', {
        taskId: testData.taskId,
        phase: 'implement',
      });

      // Verify task.json was actually updated on disk
      const taskJson = JSON.parse(readFileSync(join(pipeline.specPath, 'task.json'), 'utf-8'));
      expect(taskJson.phase).toBe('implement');
    });

    it('persists different phases correctly', () => {
      const pipeline = {
        taskId: testData.taskId,
        description: 'test',
        phase: 'merge' as const,
        specPath: join(testData.root, '.teamai', 'my-test-task'),
        worktreePath: '/test/wt',
        branch: 'feat/test',
        qaAttempt: 0,
        maxQaAttempts: 3,
      };

      vi.mocked(processManager.emit).mockClear();

      (orch as AnyOrch)._persistAndEmitPhase(pipeline);

      expect(processManager.emit).toHaveBeenCalledWith('phase-change', {
        taskId: testData.taskId,
        phase: 'merge',
      });

      // Verify task.json was actually updated on disk
      const taskJson = JSON.parse(readFileSync(join(pipeline.specPath, 'task.json'), 'utf-8'));
      expect(taskJson.phase).toBe('merge');
    });
  });

  // ── #7 _savePipelineState ───────────────────────────────────────

  describe('_savePipelineState', () => {
    it('writes pipeline state to .pipeline_state.json atomically', () => {
      const specPath = join(testData.root, '.teamai', 'my-test-task');
      const statePath = join(specPath, '.pipeline_state.json');
      const tmpPath = statePath + '.tmp';

      const pipeline = {
        taskId: testData.taskId,
        description: 'test',
        phase: 'implement' as const,
        specPath,
        worktreePath: '/test/wt',
        branch: 'feat/test',
        qaAttempt: 2,
        maxQaAttempts: 3,
        mergeStrategy: 'pull-request' as const,
        sessionId: 'sess-123',
      };

      (orch as AnyOrch)._savePipelineState(pipeline);

      // Tmp file should not exist (renamed to final path)
      expect(existsSync(tmpPath)).toBe(false);
      // Final file should exist
      expect(existsSync(statePath)).toBe(true);

      const saved = JSON.parse(readFileSync(statePath, 'utf-8'));
      expect(saved.taskId).toBe(testData.taskId);
      expect(saved.phase).toBe('implement');
      expect(saved.sessionId).toBe('sess-123');
      expect(saved.mergeStrategy).toBe('pull-request');
      expect(saved.qaAttempt).toBe(2);
      expect(saved.branch).toBe('feat/test');
      expect(saved.worktreePath).toBe('/test/wt');
      expect(saved.updatedAt).toBeDefined();
    });

    it('writes pipeline state with undefined sessionId gracefully', () => {
      const specPath = join(testData.root, '.teamai', 'my-test-task');
      const statePath = join(specPath, '.pipeline_state.json');

      const pipeline = {
        taskId: testData.taskId,
        description: 'test',
        phase: 'spec' as const,
        specPath,
        worktreePath: '/test/wt',
        branch: 'feat/test',
        qaAttempt: 0,
        maxQaAttempts: 3,
        // no sessionId, no mergeStrategy
      };

      (orch as AnyOrch)._savePipelineState(pipeline);

      const saved = JSON.parse(readFileSync(statePath, 'utf-8'));
      expect(saved.sessionId).toBeUndefined();
      expect(saved.mergeStrategy).toBeUndefined();
      expect(saved.qaAttempt).toBe(0);
    });

    it('does not throw on permission errors (best-effort)', () => {
      const pipeline = {
        taskId: testData.taskId,
        description: 'test',
        phase: 'spec' as const,
        specPath: '/root/forbidden',
        worktreePath: '/test/wt',
        branch: 'feat/test',
        qaAttempt: 0,
        maxQaAttempts: 3,
      };

      expect(() => {
        (orch as AnyOrch)._savePipelineState(pipeline);
      }).not.toThrow();
    });
  });

  // ── #7 _restorePipelineState ────────────────────────────────────

  describe('_restorePipelineState', () => {
    let specPath: string;
    let statePath: string;

    beforeEach(() => {
      specPath = join(testData.root, '.teamai', 'my-test-task');
      statePath = join(specPath, '.pipeline_state.json');
      // Ensure no leftover state file from other tests
      try { if (existsSync(statePath)) unlinkSync(statePath); } catch {}
    });

    it('returns null when no state file exists', () => {
      expect(existsSync(statePath)).toBe(false);
      const result = (orch as AnyOrch)._restorePipelineState(testData.taskId, specPath);
      expect(result).toBeNull();
    });

    it('returns parsed state and cleans up the file after reading', () => {
      const state = {
        taskId: testData.taskId,
        phase: 'implement',
        sessionId: 'sess-abc',
        mergeStrategy: 'local-merge',
        qaAttempt: 1,
        branch: 'feat/test',
        worktreePath: '/test/wt',
        updatedAt: new Date().toISOString(),
      };
      writeFileSync(statePath, JSON.stringify(state, null, 2));

      const result = (orch as AnyOrch)._restorePipelineState(testData.taskId, specPath);

      expect(result).not.toBeNull();
      expect(result!.sessionId).toBe('sess-abc');
      expect(result!.mergeStrategy).toBe('local-merge');
      expect(result!.qaAttempt).toBe(1);
      expect(result!.phase).toBe('implement');

      // File should be cleaned up after reading
      expect(existsSync(statePath)).toBe(false);
    });

    it('returns null for corrupt JSON (file stays on disk for debugging)', () => {
      writeFileSync(statePath, 'not valid json {{{');
      const result = (orch as AnyOrch)._restorePipelineState(testData.taskId, specPath);
      expect(result).toBeNull();
      // File is NOT cleaned up for corrupt JSON — left on disk for inspection
      expect(existsSync(statePath)).toBe(true);
    });

    it('returns null for empty state file', () => {
      writeFileSync(statePath, '');
      const result = (orch as AnyOrch)._restorePipelineState(testData.taskId, specPath);
      expect(result).toBeNull();
    });
  });

  // ── #4 _isWorktreeHealthy ───────────────────────────────────────

  describe('_isWorktreeHealthy', () => {
    it('returns false when .git file does not exist', () => {
      const wtPath = join(testData.root, 'no-git');
      mkdirSync(wtPath, { recursive: true });
      expect((orch as AnyOrch)._isWorktreeHealthy(wtPath)).toBe(false);
    });

    it('returns false when .git is not a worktree file (no gitdir: prefix)', () => {
      const wtPath = join(testData.root, 'bad-git-format');
      mkdirSync(wtPath, { recursive: true });
      writeFileSync(join(wtPath, '.git'), 'not a worktree file');
      expect((orch as AnyOrch)._isWorktreeHealthy(wtPath)).toBe(false);
    });

    it('returns false when gitdir points to a nonexistent path', () => {
      const wtPath = join(testData.root, 'broken-gitdir');
      mkdirSync(wtPath, { recursive: true });
      writeFileSync(join(wtPath, '.git'), 'gitdir: /nonexistent/git/worktrees/test');
      expect((orch as AnyOrch)._isWorktreeHealthy(wtPath)).toBe(false);
    });

    it('returns true for a valid worktree with an existing gitdir', () => {
      const wtPath = join(testData.root, 'healthy-worktree');
      mkdirSync(wtPath, { recursive: true });
      // Create a fake gitdir directory that actually exists
      const gitdirPath = join(testData.root, 'fake-gitdir');
      mkdirSync(gitdirPath, { recursive: true });
      writeFileSync(join(wtPath, '.git'), `gitdir: ${gitdirPath}`);
      expect((orch as AnyOrch)._isWorktreeHealthy(wtPath)).toBe(true);
    });
  });
});
