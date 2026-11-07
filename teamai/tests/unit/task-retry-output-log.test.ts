/**
 * Retrying a failed task clears output.log for a fresh terminal view, but the
 * failed run's log (which cap was hit, which phase threw) must survive in
 * output_before_retry.log — nothing else records it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';

vi.mock('@/lib/orchestrator', () => ({ getOrchestrator: vi.fn() }));
vi.mock('../../src/lib/orchestrator', () => ({ getOrchestrator: vi.fn() }));

import { preRestoreFailedTask } from '../../src/lib/task-retry';

let dir: string;
const store = () => ({ getDirById: () => dir, update: vi.fn() }) as never;

beforeEach(() => { dir = join(tmpdir(), 'retry-log-' + randomUUID()); mkdirSync(dir, { recursive: true }); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('preRestoreFailedTask output.log', () => {
  it('moves the failed run log aside and clears output.log', () => {
    writeFileSync(join(dir, 'output.log'), 'run 1: wakeup cap exceeded\n');
    preRestoreFailedTask(store(), 't');
    expect(existsSync(join(dir, 'output.log'))).toBe(false);
    expect(readFileSync(join(dir, 'output_before_retry.log'), 'utf-8')).toBe('run 1: wakeup cap exceeded\n');
  });

  it('keeps the history of earlier failed runs', () => {
    writeFileSync(join(dir, 'output.log'), 'run 1\n');
    preRestoreFailedTask(store(), 't');
    writeFileSync(join(dir, 'output.log'), 'run 2\n');
    preRestoreFailedTask(store(), 't');
    expect(readFileSync(join(dir, 'output_before_retry.log'), 'utf-8')).toBe('run 1\nrun 2\n');
  });
});
