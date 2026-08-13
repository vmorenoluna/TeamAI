// @vitest-environment node

/**
 * Tests the committed snapshot task.json phase="done" stamp in
 * commitArtifactsToWorktree: a failed write must warn (not swallow),
 * since markTaskDone's restore detection relies on that phase.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, readFileSync } from 'fs';
import { join, basename } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';

const { mockWarn, mockWriteFileSync } = vi.hoisted(() => ({
  mockWarn: vi.fn(),
  mockWriteFileSync: vi.fn(),
}));

vi.mock('../../src/lib/logger', () => ({
  log: vi.fn(),
  warn: mockWarn,
  error: vi.fn(),
  info: vi.fn(),
}));

vi.mock('../../src/lib/orchestrator/helpers', () => ({
  phaseHeader: vi.fn(),
  logToOutput: vi.fn(),
}));

vi.mock('child_process', () => ({
  execFileSync: vi.fn(),
}));

// Override only writeFileSync with a controllable mock that defaults to the
// real implementation, so setup writes still land on disk.
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  const realWrite = actual.writeFileSync;
  (mockWriteFileSync as unknown as { mockImplementation: (f: (...a: unknown[]) => void) => void })
    .mockImplementation((...args: unknown[]) => realWrite(...(args as Parameters<typeof realWrite>)));
  return { ...actual, writeFileSync: mockWriteFileSync };
});

import { commitArtifactsToWorktree } from '../../src/lib/orchestrator/artifact-commit';
import { writeFileSync } from 'fs';

// ── Helpers ──

function setup() {
  const root = join(tmpdir(), `teamai-artifacts-${randomUUID().slice(0, 8)}`);
  const specPath = join(root, 'task-slug');
  const worktreePath = join(root, 'worktree');
  mkdirSync(specPath, { recursive: true });
  mkdirSync(worktreePath, { recursive: true });

  writeFileSync(join(specPath, 'task.json'), JSON.stringify({
    id: 't1', title: 'T', description: 'd', phase: 'qa-review',
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  }));
  writeFileSync(join(specPath, 'spec.md'), '# Spec');

  return { root, specPath, worktreePath };
}

// ── Tests ──

describe('commitArtifactsToWorktree — committed task.json phase stamp', () => {
  let ctx: ReturnType<typeof setup>;

  beforeEach(() => {
    vi.clearAllMocks();
    ctx = setup();
  });

  afterEach(() => {
    try { rmSync(ctx.root, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  const deps = {
    restoreWorktreeGitFileToHostPaths: vi.fn(),
    worktreeGitEnv: vi.fn(() => ({})),
  };

  it('stamps the committed task.json with phase=done', () => {
    const slug = basename(ctx.specPath);
    commitArtifactsToWorktree(
      { taskId: 't1', description: 'd', specPath: ctx.specPath, worktreePath: ctx.worktreePath },
      deps,
    );

    const committed = JSON.parse(readFileSync(
      join(ctx.worktreePath, '.teamai', slug, 'task.json'), 'utf-8'));
    expect(committed.phase).toBe('done');
    expect(mockWarn).not.toHaveBeenCalled();
  });

  it('warns (does not throw) when the committed task.json write fails', () => {
    mockWriteFileSync.mockImplementationOnce(() => { throw new Error('disk full'); });

    expect(() => commitArtifactsToWorktree(
      { taskId: 't1', description: 'd', specPath: ctx.specPath, worktreePath: ctx.worktreePath },
      deps,
    )).not.toThrow();

    expect(mockWarn).toHaveBeenCalledWith(
      'artifacts',
      expect.stringContaining('Failed to stamp committed task.json phase=done'),
      expect.anything(),
    );
  });
});
