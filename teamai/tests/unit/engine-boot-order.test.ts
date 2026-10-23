import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/logger', () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn() }));
vi.mock('../../src/lib/logger', () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn() }));

import { runEngineBoot, dispatchMessage, type EngineBootSteps } from '../../src/engine/engine-main';

function makeSteps(order: string[], overrides: Partial<Record<keyof EngineBootSteps, () => unknown>> = {}, interrupted = 1): EngineBootSteps {
  const step = (name: keyof EngineBootSteps, value?: unknown) => () => {
    order.push(name);
    if (overrides[name]) return overrides[name]!();
    return value;
  };
  return {
    checkDockerAvailable: step('checkDockerAvailable', Promise.resolve()) as EngineBootSteps['checkDockerAvailable'],
    syncDefaults: step('syncDefaults') as EngineBootSteps['syncDefaults'],
    recoveryScan: (() => { step('recoveryScan')(); return { interruptedTasks: interrupted }; }) as EngineBootSteps['recoveryScan'],
    sendReady: step('sendReady') as EngineBootSteps['sendReady'],
    autoResume: step('autoResume', Promise.resolve()) as EngineBootSteps['autoResume'],
    sweepWorktrees: step('sweepWorktrees') as EngineBootSteps['sweepWorktrees'],
    restoreAutoMode: step('restoreAutoMode') as EngineBootSteps['restoreAutoMode'],
    startRoleRefinementWatcher: step('startRoleRefinementWatcher') as EngineBootSteps['startRoleRefinementWatcher'],
    startSweepInterval: step('startSweepInterval') as EngineBootSteps['startSweepInterval'],
    listenContainerState: step('listenContainerState') as EngineBootSteps['listenContainerState'],
  };
}

const FULL_ORDER = [
  'checkDockerAvailable', 'syncDefaults', 'recoveryScan', 'sendReady', 'autoResume',
  'sweepWorktrees', 'restoreAutoMode', 'startRoleRefinementWatcher', 'startSweepInterval', 'listenContainerState',
];

describe('runEngineBoot (AC20)', () => {
  it('runs steps in order with ready sent before autoResume', async () => {
    const order: string[] = [];
    await runEngineBoot(makeSteps(order));
    expect(order).toEqual(FULL_ORDER);
  });

  it('skips autoResume when no interrupted tasks were found', async () => {
    const order: string[] = [];
    await runEngineBoot(makeSteps(order, {}, 0));
    expect(order).toEqual(FULL_ORDER.filter(s => s !== 'autoResume'));
  });

  it('continues after a throwing step', async () => {
    const order: string[] = [];
    await runEngineBoot(makeSteps(order, {
      syncDefaults: () => { throw new Error('boom'); },
      checkDockerAvailable: () => Promise.reject(new Error('no docker')),
    }));
    expect(order).toEqual(FULL_ORDER);
  });
});

describe('dispatchMessage', () => {
  it('returns EngineMethodNotFound for unknown call methods', async () => {
    const send = vi.fn();
    await dispatchMessage({ type: 'call', id: 7, method: 'nope.nothing', args: [] }, send, {});
    expect(send).toHaveBeenCalledWith({
      type: 'result', id: 7, ok: false,
      error: expect.objectContaining({ name: 'EngineMethodNotFound' }),
    });
  });

  it('serializes handler errors preserving name, message and code', async () => {
    const send = vi.fn();
    const err = Object.assign(new Error('Task abc not found'), { name: 'TaskNotFoundError', code: 'TASK_NOT_FOUND' });
    await dispatchMessage({ type: 'call', id: 1, method: 'x', args: [{}] }, send, { x: async () => { throw err; } });
    expect(send).toHaveBeenCalledWith({
      type: 'result', id: 1, ok: false,
      error: { name: 'TaskNotFoundError', message: 'Task abc not found', code: 'TASK_NOT_FOUND' },
    });
  });

  it('returns ok values and sends nothing for notify', async () => {
    const send = vi.fn();
    await dispatchMessage({ type: 'call', id: 2, method: 'x', args: [{ a: 1 }] }, send, { x: async (p) => p });
    expect(send).toHaveBeenCalledWith({ type: 'result', id: 2, ok: true, value: { a: 1 } });
    send.mockClear();
    await dispatchMessage({ type: 'notify', method: 'x', args: [{}] }, send, { x: async () => 1 });
    expect(send).not.toHaveBeenCalled();
  });

  it('invokes the shutdown hook', async () => {
    const onShutdown = vi.fn();
    await dispatchMessage({ type: 'shutdown' }, vi.fn(), {}, onShutdown);
    expect(onShutdown).toHaveBeenCalled();
  });
});
