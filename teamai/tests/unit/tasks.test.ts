import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Hoisted mocks ─────────────────────────────────────────────────────

const { mockExistsSync, mockReadFileSync, mockExecFileSync } = vi.hoisted(() => ({
  mockExistsSync: vi.fn(),
  mockReadFileSync: vi.fn(),
  mockExecFileSync: vi.fn(),
}));

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    existsSync: mockExistsSync,
    readFileSync: mockReadFileSync,
  };
});

vi.mock('path', () => ({
  join: (...args: string[]) => args.join('/'),
}));

vi.mock('child_process', () => ({
  execFileSync: mockExecFileSync,
}));

// mock detectDefaultBranch
vi.mock('@/lib/orchestrator', () => ({
  detectDefaultBranch: () => 'main',
}));

// ── Dynamic import (after mocks are set up) ───────────────────────────

const { readCommonArtifacts } = await import('@/lib/task-artifacts');

// ── Tests ──────────────────────────────────────────────────────────────

describe('readCommonArtifacts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── human_feedback.md ──

  it('returns null for humanFeedback when file does not exist', () => {
    // Only spec.md exists
    mockExistsSync.mockImplementation((path: string) => {
      if (path.includes('human_feedback.md')) return false;
      return false;
    });
    mockReadFileSync.mockImplementation(() => {
      return '';
    });

    const result = readCommonArtifacts('/test/dir', '/project', null);

    expect(result.humanFeedback).toBeNull();
  });

  it('strips the header and returns trimmed human feedback', () => {
    mockExistsSync.mockImplementation((path: string) => {
      if (path.includes('human_feedback.md')) return true;
      return false;
    });
    mockReadFileSync.mockImplementation((path: string) => {
      if (path.includes('human_feedback.md')) {
        return '# Human Review Feedback\n\nFix the header alignment on mobile\n';
      }
      return '';
    });

    const result = readCommonArtifacts('/test/dir', '/project', null);

    expect(result.humanFeedback).toBe('Fix the header alignment on mobile');
  });

  it('trims whitespace from human feedback', () => {
    mockExistsSync.mockImplementation((path: string) => {
      if (path.includes('human_feedback.md')) return true;
      return false;
    });
    mockReadFileSync.mockImplementation((path: string) => {
      if (path.includes('human_feedback.md')) {
        return '# Human Review Feedback\n\n  Fix the button color  \n\n';
      }
      return '';
    });

    const result = readCommonArtifacts('/test/dir', '/project', null);

    expect(result.humanFeedback).toBe('Fix the button color');
  });

  it('returns null when humanFeedback is only the header', () => {
    mockExistsSync.mockImplementation((path: string) => {
      if (path.includes('human_feedback.md')) return true;
      return false;
    });
    mockReadFileSync.mockImplementation((path: string) => {
      if (path.includes('human_feedback.md')) {
        return '# Human Review Feedback\n\n';
      }
      return '';
    });

    const result = readCommonArtifacts('/test/dir', '/project', null);

    expect(result.humanFeedback).toBeNull();
  });

  it('returns null when humanFeedback is whitespace-only after header', () => {
    mockExistsSync.mockImplementation((path: string) => {
      if (path.includes('human_feedback.md')) return true;
      return false;
    });
    mockReadFileSync.mockImplementation((path: string) => {
      if (path.includes('human_feedback.md')) {
        return '# Human Review Feedback\n\n   \n';
      }
      return '';
    });

    const result = readCommonArtifacts('/test/dir', '/project', null);

    expect(result.humanFeedback).toBeNull();
  });

  it('returns null when humanFeedback file is empty', () => {
    mockExistsSync.mockImplementation((path: string) => {
      if (path.includes('human_feedback.md')) return true;
      return false;
    });
    mockReadFileSync.mockImplementation((path: string) => {
      if (path.includes('human_feedback.md')) return '';
      return '';
    });

    const result = readCommonArtifacts('/test/dir', '/project', null);

    expect(result.humanFeedback).toBeNull();
  });

  it('handles plain text without header', () => {
    mockExistsSync.mockImplementation((path: string) => {
      if (path.includes('human_feedback.md')) return true;
      return false;
    });
    mockReadFileSync.mockImplementation((path: string) => {
      if (path.includes('human_feedback.md')) {
        return 'Just some plain feedback text\n';
      }
      return '';
    });

    const result = readCommonArtifacts('/test/dir', '/project', null);

    expect(result.humanFeedback).toBe('Just some plain feedback text');
  });

  // ── spec.md ──

  it('returns spec when spec.md exists', () => {
    mockExistsSync.mockImplementation((path: string) => {
      return path.includes('spec.md');
    });
    mockReadFileSync.mockImplementation((path: string) => {
      if (path.includes('spec.md')) return '# Feature spec\n\nAdd dark mode';
      return '';
    });

    const result = readCommonArtifacts('/test/dir', '/project', null);

    expect(result.spec).toBe('# Feature spec\n\nAdd dark mode');
  });

  it('returns null spec when spec.md does not exist', () => {
    mockExistsSync.mockReturnValue(false);

    const result = readCommonArtifacts('/test/dir', '/project', null);

    expect(result.spec).toBeNull();
  });

  // ── qa_report.json ──

  it('returns parsed qaReport when valid JSON exists', () => {
    mockExistsSync.mockImplementation((path: string) => {
      if (path.includes('qa_report.json')) return true;
      return false;
    });
    mockReadFileSync.mockImplementation((path: string) => {
      if (path.includes('qa_report.json')) {
        return JSON.stringify({ overall: 'PASS', criteria: [] });
      }
      return '';
    });

    const result = readCommonArtifacts('/test/dir', '/project', null);

    expect(result.qaReport).toEqual({ overall: 'PASS', criteria: [] });
  });

  it('returns null qaReport when JSON is invalid (silently catches parse error)', () => {
    mockExistsSync.mockImplementation((path: string) => {
      if (path.includes('qa_report.json')) return true;
      return false;
    });
    mockReadFileSync.mockImplementation((path: string) => {
      if (path.includes('qa_report.json')) return '{invalid json';
      return '';
    });

    const result = readCommonArtifacts('/test/dir', '/project', null);

    expect(result.qaReport).toBeNull();
  });

  it('returns null qaReport when file does not exist', () => {
    mockExistsSync.mockReturnValue(false);

    const result = readCommonArtifacts('/test/dir', '/project', null);

    expect(result.qaReport).toBeNull();
  });

  // ── git diff ──

  it('computes git diff when branch is provided', () => {
    mockExistsSync.mockReturnValue(false);
    mockExecFileSync.mockReturnValue('diff --git a/file.ts b/file.ts\n+new line');

    const result = readCommonArtifacts('/test/dir', '/project', 'feature-branch');

    expect(result.diff).toBe('diff --git a/file.ts b/file.ts\n+new line');
    expect(mockExecFileSync).toHaveBeenCalledWith('git', ['diff', 'main...feature-branch'], {
      cwd: '/project',
      encoding: 'utf-8',
    });
  });

  it('falls back to diff.txt when branch is null', () => {
    mockExistsSync.mockImplementation((path: string) => {
      return path.includes('diff.txt');
    });
    mockReadFileSync.mockImplementation((path: string) => {
      if (path.includes('diff.txt')) return 'canned diff content';
      return '';
    });

    const result = readCommonArtifacts('/test/dir', '/project', null);

    expect(result.diff).toBe('canned diff content');
  });

  it('returns null diff when no branch and no diff.txt', () => {
    mockExistsSync.mockReturnValue(false);

    const result = readCommonArtifacts('/test/dir', '/project', null);

    expect(result.diff).toBeNull();
  });
});
