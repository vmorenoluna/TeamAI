/**
 * Tests for orchestrator module-level functions and remaining edge cases.
 * Covers: detectGitPlatform, detectDefaultBranch, buildPlatformPrompt,
 * _execGit container path, handleRateLimit/timeout, getWorktreeBase container path.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { randomUUID } from 'crypto';

// ── Hoisted mocks ──

const { mockExecFileSync } = vi.hoisted(() => ({
  mockExecFileSync: vi.fn(),
}));

const { mockWarn } = vi.hoisted(() => ({
  mockWarn: vi.fn(),
}));

const { mockWriteFileSync, mockUnlinkSync } = vi.hoisted(() => ({
  mockWriteFileSync: vi.fn(),
  mockUnlinkSync: vi.fn(),
}));

const { mockLogToOutput } = vi.hoisted(() => ({
  mockLogToOutput: vi.fn(),
}));

// Mock child_process globally so all modules see the mock execFileSync
vi.mock('child_process', () => ({
  execFile: vi.fn(),
  execFileSync: mockExecFileSync,
  spawn: vi.fn(),
  ChildProcess: class MockCP {},
}));

// Mock fs write/unlink so createPRViaCLI's --body-file temp file is a no-op
// in tests, while preserving the real fs for every other consumer in this file.
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    writeFileSync: mockWriteFileSync,
    unlinkSync: mockUnlinkSync,
  };
});

vi.mock('../../src/lib/orchestrator/helpers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/orchestrator/helpers')>();
  return { ...actual, logToOutput: mockLogToOutput };
});

vi.mock('../../src/lib/logger', () => ({
  log: vi.fn(), warn: mockWarn,
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
  it('includes description and spec summary in output', () => {
    const result = buildPRBody('Add login feature', 'Chose signed tokens over sessions for statelessness.');
    expect(result).toContain('## Summary');
    expect(result).toContain('Add login feature');
    expect(result).toContain('## Specification Summary');
    expect(result).toContain('Chose signed tokens over sessions for statelessness.');
  });

  it('includes QA testing section', () => {
    const result = buildPRBody('Fix bug');
    expect(result).toContain('## Testing');
    expect(result).toContain('QA review passed.');
  });

  it('omits the Specification Summary section when no spec summary is given', () => {
    const result = buildPRBody('Empty spec');
    expect(result).toContain('## Summary');
    expect(result).toContain('Empty spec');
    expect(result).not.toContain('## Specification Summary');
  });

  it('omits the Specification Summary section for a null or empty spec summary', () => {
    expect(buildPRBody('Add login feature', null)).not.toContain('## Specification Summary');
    expect(buildPRBody('Add login feature', '')).not.toContain('## Specification Summary');
  });

  it('includes a "What Was Implemented" section when an implementation summary is given', () => {
    const result = buildPRBody('Add login feature', 'Spec summary text.', [], 'Added login via signed tokens.');
    expect(result).toContain('## What Was Implemented');
    expect(result).toContain('Added login via signed tokens.');
    // Ask, outcome, and reasoning are all present — the PR body is a
    // superset of the commit message, not just a copy of the description.
    expect(result.indexOf('## Summary')).toBeLessThan(result.indexOf('## What Was Implemented'));
    expect(result.indexOf('## What Was Implemented')).toBeLessThan(result.indexOf('## Specification Summary'));
  });

  it('omits the "What Was Implemented" section when no implementation summary is given', () => {
    const result = buildPRBody('Add login feature', 'Spec summary text.');
    expect(result).not.toContain('## What Was Implemented');
  });

  it('omits the "What Was Implemented" section for an empty/null implementation summary', () => {
    expect(buildPRBody('Add login feature', 'Spec summary text.', [], null)).not.toContain('## What Was Implemented');
    expect(buildPRBody('Add login feature', 'Spec summary text.', [], '')).not.toContain('## What Was Implemented');
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

    // Body is written to a temp file and passed via --body-file, never argv
    expect(mockWriteFileSync).toHaveBeenCalledWith(expect.any(String), 'PR body', 'utf-8');
    const bodyFile = mockWriteFileSync.mock.calls[0][0] as string;
    const ghCall = mockExecFileSync.mock.calls.find((c) => c[0] === 'gh');
    const args = ghCall![1] as string[];
    expect(args).toContain('--body-file');
    expect(args).toContain(bodyFile);
    expect(args).not.toContain('--body');
    expect(args).not.toContain('PR body');

    // Temp file is cleaned up after the PR is created
    expect(mockUnlinkSync).toHaveBeenCalledWith(bodyFile);
  });

  it('truncates an oversized PR title to stay within GitHub and argv limits', () => {
    mockExecFileSync
      .mockReturnValueOnce('refs/remotes/origin/main\n')
      .mockReturnValueOnce('https://github.com/owner/repo/pull/42\n');
    const oversizedTitle = 'A'.repeat(40_000);
    const result = createPRViaCLI('github', 'feat/test', oversizedTitle, 'PR body', '/test', logFile);
    expect(result).toBe('https://github.com/owner/repo/pull/42');

    const ghCall = mockExecFileSync.mock.calls.find((c) => c[0] === 'gh');
    const args = ghCall![1] as string[];
    const titleIdx = args.indexOf('--title');
    const passedTitle = args[titleIdx + 1];
    // Truncated to a GitHub-safe length (<= 255 chars) and never passed verbatim
    expect(passedTitle.length).toBeLessThan(256);
    expect(passedTitle).toContain('...');
    expect(args).not.toContain(oversizedTitle);
  });

  it('passes an oversized body via --body-file without hitting argv limits', () => {
    mockExecFileSync
      .mockReturnValueOnce('refs/remotes/origin/main\n')
      .mockReturnValueOnce('https://github.com/owner/repo/pull/42\n');
    // ~40KB body, above Windows' ~32KB CreateProcess command-line ceiling
    const oversizedBody = '# Spec\n\n' + 'x'.repeat(40_000);
    const result = createPRViaCLI('github', 'feat/test', 'Test PR', oversizedBody, '/test', logFile);
    expect(result).toBe('https://github.com/owner/repo/pull/42');

    // Body was written to disk, not passed as a CLI argument
    expect(mockWriteFileSync).toHaveBeenCalledWith(expect.any(String), oversizedBody, 'utf-8');
    const ghCall = mockExecFileSync.mock.calls.find((c) => c[0] === 'gh');
    const args = ghCall![1] as string[];
    expect(args).toContain('--body-file');
    expect(args).not.toContain('--body');
    expect(args).not.toContain(oversizedBody);
  });

  it('logs gh failures to output.log and re-throws', () => {
    mockExecFileSync
      .mockReturnValueOnce('refs/remotes/origin/main\n')  // detectDefaultBranch
      .mockImplementationOnce(() => {
        throw Object.assign(new Error('Command failed: gh pr create'), {
          stderr: 'ENAMETOOLONG: name too long',
        });
      });

    expect(() =>
      createPRViaCLI('github', 'feat/test', 'Test PR', 'PR body', '/test', logFile),
    ).toThrow();

    expect(mockLogToOutput).toHaveBeenCalledWith(
      dirname(logFile),
      expect.stringContaining('Failed to create GitHub PR'),
    );
    expect(mockLogToOutput).toHaveBeenCalledWith(
      dirname(logFile),
      expect.stringContaining('ENAMETOOLONG'),
    );
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
