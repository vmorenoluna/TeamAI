// @vitest-environment node

/**
 * Tests ProjectStore's crash-recovery backup restore: a failed restore must
 * warn (and leave the backup in place) instead of silently swallowing.
 */
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { mkdirSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';

const { mockWarn, mockWriteFileSync } = vi.hoisted(() => ({
  mockWarn: vi.fn(),
  mockWriteFileSync: vi.fn(),
}));

vi.mock('@/lib/logger', () => ({
  log: vi.fn(),
  warn: mockWarn,
  error: vi.fn(),
  info: vi.fn(),
}));

// Override only writeFileSync with a controllable mock that defaults to the
// real implementation, so backup-file setup still writes to disk.
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  const realWrite = actual.writeFileSync;
  (mockWriteFileSync as unknown as { mockImplementation: (f: (...a: unknown[]) => void) => void })
    .mockImplementation((...args: unknown[]) => realWrite(...(args as Parameters<typeof realWrite>)));
  return { ...actual, writeFileSync: mockWriteFileSync };
});

import { ProjectStore } from '@/lib/project-store';
import { writeFileSync } from 'fs';

// Isolate via TEAMAI_CONFIG_DIR (highest precedence in resolveConfigDir).
const TEST_DIR = join(tmpdir(), `teamai-project-store-backup-${randomUUID().slice(0, 8)}`);
process.env.TEAMAI_CONFIG_DIR = TEST_DIR;

const configDir = () => join(TEST_DIR, '.teamai');
const projectsFile = () => join(configDir(), 'projects.json');
const backupFile = () => `${projectsFile()}.backup`;

describe('ProjectStore — backup restore', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mkdirSync(configDir(), { recursive: true });
  });

  afterAll(() => {
    delete process.env.TEAMAI_CONFIG_DIR;
    try { rmSync(TEST_DIR, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  it('restores projects.json from the backup', () => {
    writeFileSync(backupFile(), JSON.stringify([{ name: 'p', path: '/p', addedAt: 'x' }]));

    new ProjectStore();

    expect(existsSync(projectsFile())).toBe(true);
    expect(mockWarn).not.toHaveBeenCalled();
  });

  it('warns (and leaves the backup) when the restore write fails', () => {
    writeFileSync(backupFile(), JSON.stringify([{ name: 'p', path: '/p', addedAt: 'x' }]));
    mockWriteFileSync.mockImplementationOnce(() => { throw new Error('disk full'); });

    new ProjectStore();

    expect(mockWarn).toHaveBeenCalledWith(
      'project-store',
      expect.stringContaining('Failed to restore projects.json from backup'),
      expect.anything(),
    );
    // The backup is left in place for manual recovery.
    expect(existsSync(backupFile())).toBe(true);
  });
});
