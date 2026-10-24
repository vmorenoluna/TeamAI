import { EventEmitter } from 'events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { engineCall, engineNotify } = vi.hoisted(() => ({ engineCall: vi.fn(), engineNotify: vi.fn() }));
vi.mock('@/engine/engine-client', () => ({ engineCall, engineNotify }));
vi.mock('@/lib/logger', () => ({ error: vi.fn() }));

import { attachWsRelay, handleClientMessage, type RelayClient } from '@/engine/ws-relay';

function client(projectRoot?: string): RelayClient & { sent: string[] } {
  const sent: string[] = [];
  return { readyState: 1, projectRoot, send: (m: string) => { sent.push(m); }, sent };
}

describe('ws relay', () => {
  let events: EventEmitter;
  let a: ReturnType<typeof client>;
  let b: ReturnType<typeof client>;
  let detach: () => void;

  beforeEach(() => {
    engineCall.mockReset();
    engineNotify.mockReset();
    events = new EventEmitter();
    a = client('/proj/a');
    b = client('/proj/b');
    detach = attachWsRelay(events, () => [a, b]);
  });
  afterEach(() => detach());

  const cases: Array<[string, Record<string, unknown>, Record<string, unknown>]> = [
    ['phase-change', { taskId: 't', phase: 'spec', prUrl: 'u', platform: 'github' }, { type: 'phase-change', taskId: 't', phase: 'spec', prUrl: 'u', platform: 'github' }],
    ['action-result', { operationId: 'o', action: 'x', taskId: 't', ok: false, error: 'boom' }, { type: 'action-result', operationId: 'o', action: 'x', taskId: 't', ok: false, error: 'boom' }],
    ['refinement-update', { taskId: 't' }, { type: 'refinement-update', taskId: 't' }],
    ['task-updated', { taskId: 't' }, { type: 'task-updated', taskId: 't' }],
    ['subtask-progress', { taskId: 't', completed: 1, total: 3 }, { type: 'subtask-progress', taskId: 't', completed: 1, total: 3 }],
    ['container-state', { state: 'running' }, { type: 'container-state', projectRoot: '/proj/a', state: 'running' }],
    ['container-log', { message: 'hi' }, { type: 'container-log', projectRoot: '/proj/a', message: 'hi' }],
    ['container-validation', { step: { n: 1 } }, { type: 'container-validation', projectRoot: '/proj/a', step: { n: 1 } }],
    ['container-docker-missing', {}, { type: 'container-docker-missing', projectRoot: '/proj/a' }],
    ['container-validation-failed', { message: 'bad' }, { type: 'container-validation-failed', projectRoot: '/proj/a', message: 'bad' }],
    ['agent-event', { sessionId: 's', taskId: 't', event: { k: 1 } }, { sessionId: 's', taskId: 't', event: { k: 1 } }],
  ];

  it.each(cases)('%s reaches project A only with the expected shape', (name, payload, expected) => {
    events.emit(name, { projectRoot: '/proj/a', ...payload });
    expect(a.sent.map(m => JSON.parse(m))).toEqual([expected]);
    expect(b.sent).toEqual([]);
  });

  it('sends events without a projectRoot to every client', () => {
    events.emit('task-updated', { taskId: 't' });
    expect(a.sent).toHaveLength(1);
    expect(b.sent).toHaveLength(1);
  });

  it('streams terminal data to every client', () => {
    events.emit('terminal-data', { sessionId: 's', data: 'x' });
    expect(JSON.parse(a.sent[0])).toEqual({ type: 'terminal', sessionId: 's', data: 'x' });
    expect(b.sent).toHaveLength(1);
  });

  it('removes its listeners on detach', () => {
    detach();
    events.emit('task-updated', { taskId: 't' });
    expect(a.sent).toEqual([]);
    expect(events.eventNames()).toEqual([]);
  });

  describe('client terminal messages (AC18)', () => {
    it('forwards input and resize as notifications', async () => {
      await handleClientMessage(a, JSON.stringify({ type: 'terminal-input', sessionId: 's', data: 'ls\n' }));
      await handleClientMessage(a, JSON.stringify({ type: 'terminal-resize', sessionId: 's', cols: 80, rows: 24 }));
      expect(engineNotify).toHaveBeenCalledWith('terminals.write', [{ sessionId: 's', data: 'ls\n' }]);
      expect(engineNotify).toHaveBeenCalledWith('terminals.resize', [{ sessionId: 's', cols: 80, rows: 24 }]);
    });

    it('replies to attach only with non-empty string output', async () => {
      engineCall.mockResolvedValueOnce('buffered');
      await handleClientMessage(a, JSON.stringify({ type: 'terminal-attach', sessionId: 's' }));
      expect(engineCall).toHaveBeenCalledWith('terminals.getOutput', [{ sessionId: 's' }], { timeoutMs: 5000 });
      expect(JSON.parse(a.sent[0])).toEqual({ type: 'terminal', sessionId: 's', data: 'buffered' });

      for (const v of ['', undefined, null, 5]) {
        engineCall.mockResolvedValueOnce(v);
        await handleClientMessage(a, JSON.stringify({ type: 'terminal-attach', sessionId: 's' }));
      }
      expect(a.sent).toHaveLength(1);
    });

    it('logs and swallows engine errors and bad JSON', async () => {
      engineCall.mockRejectedValueOnce(new Error('timeout'));
      await expect(handleClientMessage(a, JSON.stringify({ type: 'terminal-attach', sessionId: 's' }))).resolves.toBeUndefined();
      await expect(handleClientMessage(a, 'not json')).resolves.toBeUndefined();
      expect(a.sent).toEqual([]);
    });
  });
});
