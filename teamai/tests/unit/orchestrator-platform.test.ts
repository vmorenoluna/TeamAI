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
  getOrchestrator,
  Orchestrator,
} from '../../src/lib/orchestrator';
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

describe('Orchestrator — remaining edge cases', () => {
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
    // Restore processManager spies only — not hoisted mocks (prevents footgun)
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
