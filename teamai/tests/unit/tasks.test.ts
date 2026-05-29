import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Hoisted mocks ─────────────────────────────────────────────────────

const { mockExistsSync, mockReadFileSync } = vi.hoisted(() => ({
  mockExistsSync: vi.fn(),
  mockReadFileSync: vi.fn(),
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

// ── Dynamic import (after mocks are set up) ───────────────────────────

const { readHumanFeedback } = await import('@/app/actions/tasks');

// ── Tests ──────────────────────────────────────────────────────────────

describe('readHumanFeedback', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns null when human_feedback.md does not exist', async () => {
    mockExistsSync.mockReturnValue(false);

    const result = await readHumanFeedback('/test/dir');

    expect(result).toBeNull();
    expect(mockExistsSync).toHaveBeenCalledWith('/test/dir/human_feedback.md');
    expect(mockReadFileSync).not.toHaveBeenCalled();
  });

  it('strips the "# Human Review Feedback" header and returns trimmed content', async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(
      '# Human Review Feedback\n\nFix the header alignment on mobile\n'
    );

    const result = await readHumanFeedback('/test/dir');

    expect(result).toBe('Fix the header alignment on mobile');
  });

  it('trims whitespace from the result', async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(
      '# Human Review Feedback\n\n  Fix the button color  \n\n'
    );

    const result = await readHumanFeedback('/test/dir');

    expect(result).toBe('Fix the button color');
  });

  it('returns null when the file content is only the header (no actual feedback)', async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(
      '# Human Review Feedback\n\n'
    );

    const result = await readHumanFeedback('/test/dir');

    expect(result).toBeNull();
  });

  it('returns null when the file content is whitespace-only after stripping header', async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(
      '# Human Review Feedback\n\n   \n'
    );

    const result = await readHumanFeedback('/test/dir');

    expect(result).toBeNull();
  });

  it('returns null when the file exists but is completely empty', async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue('');

    const result = await readHumanFeedback('/test/dir');

    expect(result).toBeNull();
  });

  it('handles content without the markdown header (no replacement needed)', async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(
      'Just some plain feedback text\n'
    );

    const result = await readHumanFeedback('/test/dir');

    expect(result).toBe('Just some plain feedback text');
  });
});
