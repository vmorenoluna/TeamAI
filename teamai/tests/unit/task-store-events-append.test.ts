// @vitest-environment node

/**
 * Tests updatePhase's events.jsonl append guard:
 * task.json is the source of truth for phase, so a failed events.jsonl
 * append must not throw (which would surface as a phase-transition failure)
 * but must warn, since the audit trail is then incomplete.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

// ── Hoisted mocks ──

const { mockAppendFileSync, mockWarn } = vi.hoisted(() => ({
  mockAppendFileSync: vi.fn(),
  mockWarn: vi.fn(),
}));

vi.mock('../../src/lib/logger', () => ({
  log: vi.fn(),
  warn: mockWarn,
  error: vi.fn(),
  info: vi.fn(),
}));

// Override only appendFileSync with a controllable mock that defaults to the
// real implementation, so TaskStore setup (writeFileSync) still works.
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  const realAppend = actual.appendFileSync;
  (mockAppendFileSync as unknown as { mockImplementation: (f: (...a: unknown[]) => void) => void })
    .mockImplementation((...args: unknown[]) => realAppend(...(args as Parameters<typeof realAppend>)));
  return { ...actual, appendFileSync: mockAppendFileSync };
});

import { TaskStore } from '../../src/lib/task-store';
import { createTestProject } from '../utils/test-project';

describe('updatePhase — events.jsonl append guard', () => {
  let store: TaskStore;
  let clean: () => void;

  beforeEach(() => {
    vi.clearAllMocks();
    const { root, clean: c } = createTestProject();
    store = new TaskStore(root);
    clean = c;
  });

  afterEach(() => {
    clean();
  });

  it('warns (does not throw) when the events.jsonl append fails, keeping the phase on task.json', () => {
    const task = store.create('task-1', 'Event append', 'desc');
    const dir = store.getDirById(task.id);

    // The next appendFileSync (the events.jsonl append) throws.
    mockAppendFileSync.mockImplementationOnce(() => { throw new Error('disk full'); });

    expect(() => store.updatePhase(task.id, 'implement')).not.toThrow();

    // task.json still records the new phase — the phase transition succeeded.
    const onDisk = JSON.parse(readFileSync(join(dir, 'task.json'), 'utf-8'));
    expect(onDisk.phase).toBe('implement');

    // The failure was surfaced, not swallowed.
    expect(mockWarn).toHaveBeenCalledWith(
      'task-store',
      expect.stringContaining('Failed to append phase event'),
      expect.anything(),
    );
  });
});
