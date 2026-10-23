// @vitest-environment node

/** Role-refinement mutating actions are thin engine wrappers; read helpers stay local. */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { engineCall, mockListSuggestions } = vi.hoisted(() => ({
  engineCall: vi.fn(),
  mockListSuggestions: vi.fn(),
}));

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/app/actions/projects', () => ({ getActiveProjectPath: vi.fn(async () => '/proj') }));
vi.mock('@/engine/engine-client', () => ({ engineCall }));
vi.mock('@/lib/role-refinement', () => ({
  getRoleRefinementConfig: vi.fn(() => ({ mode: 'manual' })),
  listSuggestions: mockListSuggestions,
  getSuggestion: vi.fn(),
  suggestionsForTask: vi.fn(),
}));

import { revalidatePath } from 'next/cache';
import {
  analyzeFailedTask, setRoleRefinementConfigAction, applyRefinementAction,
  applyAndRetryRefinementAction, dismissRefinementAction, revertRefinementAction,
  getRefinementSuggestions,
} from '@/app/actions/role-refinement';

describe('role-refinement action wrappers', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('analyzeFailedTask forwards to the engine and revalidates on success', async () => {
    engineCall.mockResolvedValue({ success: true, operationId: 'op' });
    await expect(analyzeFailedTask('t1', 'op')).resolves.toEqual({ success: true, operationId: 'op' });
    expect(engineCall).toHaveBeenCalledWith('roleRefinement.analyzeFailedTask', [{ projectPath: '/proj', taskId: 't1', operationId: 'op' }]);
    expect(revalidatePath).toHaveBeenCalledWith('/');
    expect(revalidatePath).toHaveBeenCalledWith('/task/t1');
  });

  it('analyzeFailedTask passes through an engine { success: false } without revalidating', async () => {
    engineCall.mockResolvedValue({ success: false, error: 'EIO: read failed' });
    await expect(analyzeFailedTask('t1')).resolves.toEqual({ success: false, error: 'EIO: read failed' });
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it('setRoleRefinementConfigAction forwards cfg and revalidates', async () => {
    engineCall.mockResolvedValue(undefined);
    const cfg = { mode: 'auto' } as never;
    await setRoleRefinementConfigAction(cfg);
    expect(engineCall).toHaveBeenCalledWith('roleRefinement.setRoleRefinementConfigAction', [{ projectPath: '/proj', cfg }]);
    expect(revalidatePath).toHaveBeenCalledWith('/settings');
  });

  it('applyRefinementAction revalidates the source task path from the engine result', async () => {
    engineCall.mockResolvedValue({ success: true, sourceTaskId: 't9' });
    await expect(applyRefinementAction('s1', { a: 'b' })).resolves.toEqual({ success: true });
    expect(engineCall).toHaveBeenCalledWith('roleRefinement.applyRefinementAction', [{ projectPath: '/proj', suggestionId: 's1', overrides: { a: 'b' } }]);
    expect(revalidatePath).toHaveBeenCalledWith('/task/t9');
  });

  it('applyRefinementAction returns the engine error without revalidating', async () => {
    engineCall.mockResolvedValue({ success: false, error: 'nope' });
    await expect(applyRefinementAction('s1')).resolves.toEqual({ success: false, error: 'nope' });
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it('applyAndRetryRefinementAction, dismiss and revert forward to the engine', async () => {
    engineCall.mockResolvedValue({ success: true });
    await expect(applyAndRetryRefinementAction('s1')).resolves.toEqual({ success: true });
    expect(engineCall).toHaveBeenLastCalledWith('roleRefinement.applyAndRetryRefinementAction', [{ projectPath: '/proj', suggestionId: 's1', overrides: undefined }]);
    await dismissRefinementAction('s1');
    expect(engineCall).toHaveBeenLastCalledWith('roleRefinement.dismissRefinementAction', [{ projectPath: '/proj', suggestionId: 's1' }]);
    await revertRefinementAction('s1');
    expect(engineCall).toHaveBeenLastCalledWith('roleRefinement.revertRefinementAction', [{ projectPath: '/proj', suggestionId: 's1' }]);
  });

  it('read helpers stay local and do not call the engine', async () => {
    mockListSuggestions.mockReturnValue([]);
    await expect(getRefinementSuggestions()).resolves.toEqual([]);
    expect(mockListSuggestions).toHaveBeenCalledWith('/proj');
    expect(engineCall).not.toHaveBeenCalled();
  });
});
