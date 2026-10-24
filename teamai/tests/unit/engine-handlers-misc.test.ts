import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  setAutoModeState: vi.fn(),
  getSession: vi.fn(),
  getTerminalSessions: vi.fn(),
}));

vi.mock('@/lib/auto-mode', () => ({ setAutoModeState: mocks.setAutoModeState }));
vi.mock('@/lib/process-manager', () => ({
  processManager: {
    getSession: mocks.getSession,
    getTerminalSessions: mocks.getTerminalSessions,
    emit: vi.fn(),
  },
  containerSessionOpts: vi.fn(() => ({})),
}));

import { autoModeHandlers } from '@/engine/handlers/auto-mode';
import { sessionsHandlers } from '@/engine/handlers/sessions';
import { terminalsHandlers } from '@/engine/handlers/terminals';

describe('engine misc handlers', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('autoMode.toggle calls setAutoModeState', async () => {
    await autoModeHandlers['autoMode.toggle']({ projectPath: '/p', enabled: true, maxParallel: 3 });
    expect(mocks.setAutoModeState).toHaveBeenCalledWith('/p', true, 3);
  });

  it('autoMode.markReviewed rejects an empty taskId', async () => {
    await expect(autoModeHandlers['autoMode.markReviewed']({ projectPath: '/p', taskId: ' ' })).rejects.toThrow('Invalid taskId');
  });

  it('sessions.get returns null for an unknown id', async () => {
    mocks.getSession.mockReturnValue(undefined);
    expect(await sessionsHandlers['sessions.get']({ sessionId: 'nope' })).toBeNull();
  });

  it('sessions.get returns only the status of a known session', async () => {
    mocks.getSession.mockReturnValue({ status: 'running', process: {} });
    expect(await sessionsHandlers['sessions.get']({ sessionId: 's1' })).toEqual({ status: 'running' });
  });

  it('terminals.list filters by project and maps fields', async () => {
    mocks.getTerminalSessions.mockReturnValue([
      { id: 'a', role: 'coder', model: 'm', projectPath: '/p' },
      { id: 'b', role: 'qa', projectPath: '/other' },
      { id: 'c', role: 'planner', projectPath: '/p' },
    ]);
    expect(await terminalsHandlers['terminals.list']({ projectPath: '/p' })).toEqual([
      { sessionId: 'a', role: 'coder', model: 'm' },
      { sessionId: 'c', role: 'planner', model: 'unknown' },
    ]);
  });
});
