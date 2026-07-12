/**
 * Tests for orchestrator module-level functions and remaining edge cases.
 * Covers: detectGitPlatform, detectDefaultBranch, buildPlatformPrompt,
 * _execGit container path, handleRateLimit/timeout, getWorktreeBase container path.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'os';
import { join } from 'path';
import { randomUUID } from 'crypto';

// ── Hoisted mocks ──

const { mockExecFileSync } = vi.hoisted(() => ({
  mockExecFileSync: vi.fn(),
}));

const { mockWarn } = vi.hoisted(() => ({
  mockWarn: vi.fn(),
}));

// Mock child_process globally so all modules see the mock execFileSync
vi.mock('child_process', () => ({
  execFile: vi.fn(),
  execFileSync: mockExecFileSync,
  spawn: vi.fn(),
  ChildProcess: class MockCP {},
}));

vi.mock('../../src/lib/logger', () => ({
  warn: mockWarn,
  error: vi.fn(),
}));

// ── Imports ──

import {
  detectGitPlatform,
  detectDefaultBranch,
  buildPlatformPrompt,
  checkExistingPRViaCLI,
  createPRViaCLI,
  buildPRBody,
  getOrchestrator,
  Orchestrator,
} from '../../src/lib/orchestrator';
import { resolveBaseBranch } from '../../src/lib/git-platform';
import { processManager } from '../../src/lib/process-manager';

// ── Tests ──

describe('detectGitPlatform', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('detects github from remote URL', () => {
    mockExecFileSync.mockReturnValue('https://github.com/user/repo.git\n');
    expect(detectGitPlatform('/test')).toBe('github');
  });

  it('detects gitlab from remote URL', () => {
    mockExecFileSync.mockReturnValue('https://gitlab.com/user/repo.git\n');
    expect(detectGitPlatform('/test')).toBe('gitlab');
  });

  it('detects bitbucket from remote URL', () => {
    mockExecFileSync.mockReturnValue('https://bitbucket.org/user/repo.git\n');
    expect(detectGitPlatform('/test')).toBe('bitbucket');
  });

  it('returns unknown for unmatched remote URL', () => {
    mockExecFileSync.mockReturnValue('https://dev.azure.com/user/repo\n');
    expect(detectGitPlatform('/test')).toBe('unknown');
  });

  it('returns unknown and logs warning when git command fails', () => {
    mockExecFileSync.mockImplementation(() => { throw new Error('Not a git repository'); });
    expect(detectGitPlatform('/test')).toBe('unknown');
    expect(mockWarn).toHaveBeenCalledWith('orchestrator', 'Failed to detect git remote platform', expect.any(Error));
  });

  it('detects github with custom domain (github.mycompany.com)', () => {
    mockExecFileSync.mockReturnValue('https://github.mycompany.com/user/repo.git\n');
    expect(detectGitPlatform('/test')).toBe('github');
  });

  it('detects gitlab with self-hosted domain', () => {
    mockExecFileSync.mockReturnValue('https://gitlab.internal.company.com/project/repo.git\n');
    expect(detectGitPlatform('/test')).toBe('gitlab');
  });

  it('handles git@ SSH URLs for github', () => {
    mockExecFileSync.mockReturnValue('git@github.com:user/repo.git\n');
    expect(detectGitPlatform('/test')).toBe('github');
  });

  it('is case-insensitive when detecting platforms', () => {
    mockExecFileSync.mockReturnValue('https://GITHUB.COM/user/repo.git\n');
    expect(detectGitPlatform('/test')).toBe('github');
  });
});

describe('detectDefaultBranch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns the branch name from symbolic-ref', () => {
    mockExecFileSync.mockReturnValue('refs/remotes/origin/main\n');
    expect(detectDefaultBranch('/test')).toBe('main');
  });

  it('returns the leaf branch name even when ref has multiple path segments', () => {
    mockExecFileSync.mockReturnValue('refs/remotes/origin/feature/main\n');
    // detectDefaultBranch splits by '/' and takes the last element
    expect(detectDefaultBranch('/test')).toBe('main');
  });

  it('falls back to main when git command fails', () => {
    mockExecFileSync.mockImplementation(() => { throw new Error('No upstream'); });
    expect(detectDefaultBranch('/test')).toBe('main');
    expect(mockWarn).toHaveBeenCalledWith('orchestrator', 'Failed to detect default branch, falling back to main', expect.any(Error));
  });

  it('falls back to main when ref is empty', () => {
    mockExecFileSync.mockReturnValue('');
    expect(detectDefaultBranch('/test')).toBe('main');
  });
});

// ═══════════════════════════════════════════════════════════════════════
//  T32 regression — resolveBaseBranch (T2 companion)
// ═══════════════════════════════════════════════════════════════════════

describe('resolveBaseBranch', () => {
  // Module-level cache persists across tests — each test uses a unique
  // projectRoot to avoid cross-test contamination.
  let root: string;

  beforeEach(() => {
    vi.clearAllMocks();
    root = `/test-${randomUUID().slice(0, 8)}`;
  });

  it('returns the detected default branch from detectDefaultBranch', () => {
    mockExecFileSync.mockReturnValue('refs/remotes/origin/main\n');
    expect(resolveBaseBranch(root)).toBe('main');
    // detectDefaultBranch was called via execFileSync
    expect(mockExecFileSync).toHaveBeenCalledWith(
      'git',
      ['symbolic-ref', 'refs/remotes/origin/HEAD'],
      expect.objectContaining({ cwd: root }),
    );
  });

  it('returns main when detectDefaultBranch falls back to main', () => {
    mockExecFileSync.mockImplementation(() => { throw new Error('No upstream'); });
    expect(resolveBaseBranch(root)).toBe('main');
  });

  it('returns master when the default branch is master', () => {
    mockExecFileSync.mockReturnValue('refs/remotes/origin/master\n');
    expect(resolveBaseBranch(root)).toBe('master');
  });

  it('returns develop when the default branch is develop', () => {
    mockExecFileSync.mockReturnValue('refs/remotes/origin/develop\n');
    expect(resolveBaseBranch(root)).toBe('develop');
  });

  it('caches the result \u2014 second call does not re-exec git', () => {
    mockExecFileSync.mockReturnValue('refs/remotes/origin/main\n');
    expect(resolveBaseBranch(root)).toBe('main');
    expect(mockExecFileSync).toHaveBeenCalledTimes(1);

    // Second call returns cached value without re-execing git
    mockExecFileSync.mockClear();
    expect(resolveBaseBranch(root)).toBe('main');
    expect(mockExecFileSync).not.toHaveBeenCalled();
  });

  it('invalidates cache when invalidate=true, forcing re-detection', () => {
    mockExecFileSync.mockReturnValue('refs/remotes/origin/main\n');
    expect(resolveBaseBranch(root)).toBe('main');
    expect(mockExecFileSync).toHaveBeenCalledTimes(1);

    // Invalidate and re-detect
    mockExecFileSync.mockClear();
    mockExecFileSync.mockReturnValue('refs/remotes/origin/develop\n');
    expect(resolveBaseBranch(root, true)).toBe('develop');
    expect(mockExecFileSync).toHaveBeenCalledTimes(1);
  });

  it('caches per projectRoot \u2014 different roots get independent cache entries', () => {
    const rootA = `/proj-a-${randomUUID().slice(0, 8)}`;
    const rootB = `/proj-b-${randomUUID().slice(0, 8)}`;

    mockExecFileSync.mockReturnValueOnce('refs/remotes/origin/main\n');
    mockExecFileSync.mockReturnValueOnce('refs/remotes/origin/master\n');

    expect(resolveBaseBranch(rootA)).toBe('main');
    expect(resolveBaseBranch(rootB)).toBe('master');

    expect(mockExecFileSync).toHaveBeenCalledTimes(2);
  });

  it('does not share cache between project roots', () => {
    const rootA = `/cache-a-${randomUUID().slice(0, 8)}`;
    const rootB = `/cache-b-${randomUUID().slice(0, 8)}`;

    mockExecFileSync.mockReturnValue('refs/remotes/origin/main\n');
    expect(resolveBaseBranch(rootA)).toBe('main');

    mockExecFileSync.mockReturnValue('refs/remotes/origin/develop\n');
    expect(resolveBaseBranch(rootB)).toBe('develop');

    // rootA is still cached as main
    mockExecFileSync.mockClear();
    expect(resolveBaseBranch(rootA)).toBe('main');
    expect(mockExecFileSync).not.toHaveBeenCalled();

    // rootB is still cached as develop
    expect(resolveBaseBranch(rootB)).toBe('develop');
    expect(mockExecFileSync).not.toHaveBeenCalled();
  });
});

describe('buildPlatformPrompt', () => {
  const defaultBranch = 'main';
  const branch = 'feat/new-feature';
  const description = 'Add new feature';
  const specContent = '# Feature: New Feature\n\nThis adds a new feature.';

  it('builds github PR prompt', () => {
    mockExecFileSync.mockReturnValue('refs/remotes/origin/main\n');
    const prompt = buildPlatformPrompt('github', branch, description, specContent, '/test');
    expect(prompt).toContain('GitHub');
    expect(prompt).toContain('create_pull_request');
    expect(prompt).toContain(branch);
    expect(prompt).toContain(description);
    expect(prompt).toContain(specContent);
    expect(prompt).toContain(defaultBranch);
  });

  it('builds gitlab MR prompt', () => {
    mockExecFileSync.mockReturnValue('refs/remotes/origin/main\n');
    const prompt = buildPlatformPrompt('gitlab', branch, description, specContent, '/test');
    expect(prompt).toContain('GitLab');
    expect(prompt).toContain('Merge Request');
    expect(prompt).toContain('glab mr create');
    expect(prompt).toContain(branch);
    expect(prompt).toContain(description);
  });

  it('builds bitbucket PR prompt', () => {
    mockExecFileSync.mockReturnValue('refs/remotes/origin/main\n');
    const prompt = buildPlatformPrompt('bitbucket', branch, description, specContent, '/test');
    expect(prompt).toContain('Bitbucket');
    expect(prompt).toContain('api.bitbucket.org');
    expect(prompt).toContain(branch);
    expect(prompt).toContain(description);
  });

  it('builds unknown platform prompt', () => {
    mockExecFileSync.mockReturnValue('refs/remotes/origin/main\n');
    const prompt = buildPlatformPrompt('unknown', branch, description, specContent, '/test');
    expect(prompt).toContain('Unknown');
    expect(prompt).toContain('whatever tools are available');
    expect(prompt).toContain(branch);
    expect(prompt).toContain(description);
  });
});

describe('Orchestrator \u2014 remaining edge cases', () => {
  let orch: Orchestrator;
  let pmSpies: ReturnType<typeof vi.spyOn>[] = [];

  beforeEach(() => {
    vi.clearAllMocks();
    // Mock the processManager methods needed for pipeline execution
    pmSpies = [
      vi.spyOn(processManager, 'on' as any).mockReturnValue(processManager),
      vi.spyOn(processManager, 'off' as any).mockReturnValue(processManager),
      vi.spyOn(processManager, 'emit' as any).mockReturnValue(true),
      vi.spyOn(processManager, 'sendMessage' as any).mockImplementation(() => {}),
      vi.spyOn(processManager, 'killSession' as any).mockImplementation(() => {}),
    ];

    orch = new Orchestrator(join(tmpdir(), `teamai-plat-${randomUUID().slice(0, 8)}`));
  });

  afterEach(() => {
    // Restore processManager spies only \u2014 not hoisted mocks (prevents footgun)
    pmSpies.forEach(s => s.mockRestore());
  });

  describe('isTaskActive / cancelPipeline', () => {
    it('returns false for a task that was never started', () => {
      expect(orch.isTaskActive('nonexistent')).toBe(false);
    });

    it('cancelPipeline does nothing for a nonexistent task', () => {
      // Should not throw
      (orch as any).cancelPipeline('nonexistent');
    });
  });
});

describe('buildPRBody', () => {
  it('includes description and spec content in output', () => {
    const result = buildPRBody('Add login feature', '# Feature: Login\n\nImplement login.');
    expect(result).toContain('## Summary');
    expect(result).toContain('Add login feature');
    expect(result).toContain('## Specification');
    expect(result).toContain('# Feature: Login');
    expect(result).toContain('Implement login.');
  });

  it('includes QA testing section', () => {
    const result = buildPRBody('Fix bug', '# Bug Fix');
    expect(result).toContain('## Testing');
    expect(result).toContain('QA review passed.');
  });

  it('handles empty spec content', () => {
    const result = buildPRBody('Empty spec', '');
    expect(result).toContain('## Summary');
    expect(result).toContain('Empty spec');
    expect(result).toContain('## Specification');
  });
});

describe('checkExistingPRViaCLI', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns PR URL when gh pr list finds an open PR', () => {
    mockExecFileSync.mockReturnValue('https://github.com/owner/repo/pull/42\n');
    const result = checkExistingPRViaCLI('github', 'feat/test', '/test');
    expect(result).toBe('https://github.com/owner/repo/pull/42');
    expect(mockExecFileSync).toHaveBeenCalledWith(
      'gh',
      expect.arrayContaining(['pr', 'list', '--head', 'feat/test', '--state', 'open']),
      expect.any(Object),
    );
  });

  it('returns null when gh pr list returns empty', () => {
    mockExecFileSync.mockReturnValue('\n');
    const result = checkExistingPRViaCLI('github', 'feat/test', '/test');
    expect(result).toBeNull();
  });

  it('returns null when gh CLI fails, logs warning', () => {
    mockExecFileSync.mockImplementation(() => { throw new Error('gh not found'); });
    const result = checkExistingPRViaCLI('github', 'feat/test', '/test');
    expect(result).toBeNull();
    expect(mockWarn).toHaveBeenCalledWith('git-platform', 'Failed to check existing PR via gh CLI', expect.any(Error));
  });

  it('returns MR URL when glab mr list finds an open MR', () => {
    mockExecFileSync.mockReturnValue('https://gitlab.com/group/project/-/merge_requests/99\n');
    const result = checkExistingPRViaCLI('gitlab', 'feat/test', '/test');
    expect(result).toBe('https://gitlab.com/group/project/-/merge_requests/99');
    expect(mockExecFileSync).toHaveBeenCalledWith(
      'glab',
      expect.arrayContaining(['mr', 'list', '--source-branch', 'feat/test', '--state', 'opened']),
      expect.any(Object),
    );
  });

  it('returns null when glab CLI fails, logs warning', () => {
    mockExecFileSync.mockImplementation(() => { throw new Error('glab not found'); });
    const result = checkExistingPRViaCLI('gitlab', 'feat/test', '/test');
    expect(result).toBeNull();
    expect(mockWarn).toHaveBeenCalledWith('git-platform', 'Failed to check existing MR via glab CLI', expect.any(Error));
  });

  it('returns null for unknown platform', () => {
    const result = checkExistingPRViaCLI('unknown', 'feat/test', '/test');
    expect(result).toBeNull();
  });
});

describe('createPRViaCLI', () => {
  const logFile = '/tmp/test-output.log';

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('creates GitHub PR via gh CLI with correct args', () => {
    mockExecFileSync
      .mockReturnValueOnce('refs/remotes/origin/main\n')  // detectDefaultBranch
      .mockReturnValueOnce('https://github.com/owner/repo/pull/42\n');
    const result = createPRViaCLI('github', 'feat/test', 'Test PR', 'PR body', '/test', logFile);
    expect(result).toBe('https://github.com/owner/repo/pull/42');
    expect(mockExecFileSync).toHaveBeenCalledWith(
      'gh',
      expect.arrayContaining(['pr', 'create', '--title', 'Test PR', '--body', 'PR body']),
      expect.any(Object),
    );
  });

  it('creates GitLab MR via glab CLI with correct args', () => {
    mockExecFileSync
      .mockReturnValueOnce('refs/remotes/origin/main\n')
      .mockReturnValueOnce('https://gitlab.com/group/project/-/merge_requests/99\n');
    const result = createPRViaCLI('gitlab', 'feat/test', 'Test MR', 'MR body', '/test', logFile);
    expect(result).toBe('https://gitlab.com/group/project/-/merge_requests/99');
    expect(mockExecFileSync).toHaveBeenCalledWith(
      'glab',
      expect.arrayContaining(['mr', 'create', '--title', 'Test MR', '--description', 'MR body', '--yes']),
      expect.any(Object),
    );
  });

  it('returns null for Bitbucket platform', () => {
    // detectDefaultBranch still runs
    mockExecFileSync.mockReturnValueOnce('refs/remotes/origin/main\n');
    const result = createPRViaCLI('bitbucket', 'feat/test', 'Test', 'Body', '/test', logFile);
    expect(result).toBeNull();
  });

  it('returns null for unknown platform', () => {
    mockExecFileSync.mockReturnValueOnce('refs/remotes/origin/main\n');
    const result = createPRViaCLI('unknown', 'feat/test', 'Test', 'Body', '/test', logFile);
    expect(result).toBeNull();
  });
});

describe('getOrchestrator singleton', () => {
  it('returns the same instance for the same project path', () => {
    const p = join(tmpdir(), `teamai-sing-${randomUUID().slice(0, 8)}`);
    const o1 = getOrchestrator(p);
    const o2 = getOrchestrator(p);
    expect(o1).toBe(o2);
  });

  it('returns different instances for different project paths', () => {
    const p1 = join(tmpdir(), `teamai-sing-${randomUUID().slice(0, 8)}`);
    const p2 = join(tmpdir(), `teamai-sing-${randomUUID().slice(0, 8)}`);
    const o1 = getOrchestrator(p1);
    const o2 = getOrchestrator(p2);
    expect(o1).not.toBe(o2);
  });
});
