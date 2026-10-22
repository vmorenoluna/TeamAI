import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@/lib/logger', () => ({ error: vi.fn(), warn: vi.fn(), log: vi.fn(), info: vi.fn() }));

import { processManager } from '@/lib/process-manager';
import { error as logError } from '@/lib/logger';
import { runInBackground, getBackgroundResult, isBackgroundPending } from '@/lib/background-actions';
import { getBackgroundActionResult } from '@/app/actions/background';

const flush = () => new Promise<void>(resolve => setImmediate(resolve));

describe('background-actions', () => {
  let events: Record<string, unknown>[];
  const listener = (e: Record<string, unknown>) => events.push(e);

  beforeEach(() => {
    events = [];
    processManager.on('action-result', listener);
    vi.mocked(logError).mockClear();
  });
  afterEach(() => {
    processManager.off('action-result', listener);
    vi.useRealTimers();
  });

  it('returns the given operation id synchronously and calls work synchronously', () => {
    const work = vi.fn(() => new Promise<void>(() => {}));
    const id = runInBackground({ operationId: 'op-given', action: 'run', taskId: 't1', projectRoot: '/p', notify: 'always' }, work);
    expect(id).toBe('op-given');
    expect(work).toHaveBeenCalledTimes(1);
    expect(getBackgroundResult('op-given')).toEqual({ status: 'pending' });
  });

  it('generates an id when none is given', () => {
    const id = runInBackground({ action: 'run', projectRoot: '/p', notify: 'always' }, async () => {});
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('emits ok:true on resolve with notify always', async () => {
    const id = runInBackground({ action: 'approve', taskId: 't1', projectRoot: '/p', notify: 'always' }, async () => 'x');
    await flush();
    expect(events).toEqual([{ operationId: id, action: 'approve', taskId: 't1', projectRoot: '/p', ok: true }]);
    expect(getBackgroundResult(id)).toEqual({ status: 'ok' });
  });

  it('emits nothing on resolve with notify failure-only', async () => {
    const id = runInBackground({ action: 'approve', taskId: 't1', projectRoot: '/p', notify: 'failure-only' }, async () => {});
    await flush();
    expect(events).toEqual([]);
    expect(getBackgroundResult(id).status).toBe('ok');
  });

  it('emits ok:false and logs when work rejects, even with failure-only', async () => {
    const id = runInBackground({ action: 'approve', taskId: 't1', projectRoot: '/p', notify: 'failure-only' }, async () => {
      throw new Error('gh: HTTP 502');
    });
    await flush();
    expect(events).toEqual([{ operationId: id, action: 'approve', taskId: 't1', projectRoot: '/p', ok: false, error: 'gh: HTTP 502' }]);
    expect(getBackgroundResult(id)).toEqual({ status: 'failed', error: 'gh: HTTP 502' });
    expect(logError).toHaveBeenCalledWith('background-action', expect.stringContaining(id), expect.anything());
    const message = vi.mocked(logError).mock.calls[0][1];
    expect(message).toContain('approve');
    expect(message).toContain('t1');
  });

  it('stringifies non-Error rejections', async () => {
    runInBackground({ action: 'run', projectRoot: '/p', notify: 'always' }, () => Promise.reject('boom'));
    await flush();
    expect(events[0]).toMatchObject({ ok: false, error: 'boom' });
  });

  it('treats a synchronous throw as a rejection without throwing (AC6)', async () => {
    let id = '';
    expect(() => {
      id = runInBackground({ action: 'stop', projectRoot: '/p', notify: 'always' }, () => {
        throw new Error('sync bang');
      });
    }).not.toThrow();
    expect(id).not.toBe('');
    await flush();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ operationId: id, ok: false, error: 'sync bang' });
  });

  it('replaces an empty rejection message with "<action> failed" (AC6)', async () => {
    runInBackground({ action: 'stop', projectRoot: '/p', notify: 'always' }, () => Promise.reject(''));
    runInBackground({ action: 'stop', projectRoot: '/p', notify: 'always' }, () => Promise.reject(new Error('')));
    await flush();
    expect(events.map(e => e.error)).toEqual(['stop failed', 'stop failed']);
  });

  it('isBackgroundPending is true only while the same action/task is pending', async () => {
    let finish!: () => void;
    runInBackground({ action: 'stop', taskId: 'tp', projectRoot: '/p', notify: 'always' }, () => new Promise<void>(r => { finish = r; }));
    expect(isBackgroundPending('stop', 'tp')).toBe(true);
    expect(isBackgroundPending('stop', 'other')).toBe(false);
    expect(isBackgroundPending('approve', 'tp')).toBe(false);
    finish();
    await flush();
    expect(isBackgroundPending('stop', 'tp')).toBe(false);
  });

  it('reports unknown for an unrecognised id, also through the server action', async () => {
    expect(getBackgroundResult('nope')).toEqual({ status: 'unknown' });
    expect(await getBackgroundActionResult('nope')).toEqual({ status: 'unknown' });
    const id = runInBackground({ action: 'run', projectRoot: '/p', notify: 'always' }, async () => {});
    await flush();
    expect(await getBackgroundActionResult(id)).toEqual({ status: 'ok' });
  });

  it('evicts the oldest settled entries beyond 500 and keeps pending ones (AC6)', async () => {
    const pendingId = runInBackground({ action: 'run', projectRoot: '/p', notify: 'failure-only' }, () => new Promise<void>(() => {}));
    const ids: string[] = [];
    for (let i = 0; i < 501; i++) {
      ids.push(runInBackground({ action: 'run', projectRoot: '/p', notify: 'failure-only' }, async () => {}));
    }
    await flush();
    expect(getBackgroundResult(ids[0]).status).toBe('unknown');
    expect(getBackgroundResult(ids[1]).status).toBe('ok');
    expect(getBackgroundResult(ids[500]).status).toBe('ok');
    expect(getBackgroundResult(pendingId).status).toBe('pending');
  });

  it('evicts a settled entry 15 minutes after settling but not a pending one (AC6)', async () => {
    vi.useFakeTimers();
    const doneId = runInBackground({ action: 'run', projectRoot: '/p', notify: 'failure-only' }, async () => {});
    const pendingId = runInBackground({ action: 'run', projectRoot: '/p', notify: 'failure-only' }, () => new Promise<void>(() => {}));
    await vi.advanceTimersByTimeAsync(0);
    expect(getBackgroundResult(doneId).status).toBe('ok');
    await vi.advanceTimersByTimeAsync(14 * 60 * 1000);
    expect(getBackgroundResult(doneId).status).toBe('ok');
    await vi.advanceTimersByTimeAsync(61 * 1000);
    expect(getBackgroundResult(doneId).status).toBe('unknown');
    expect(getBackgroundResult(pendingId).status).toBe('pending');
  });
});
