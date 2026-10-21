// @vitest-environment node

/** analyzeFailedTask must resolve { success: false, error } (never reject, never
 *  success) when its TaskStore read rejects. */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockGetByIdAsync, mockUpdate, mockAnalyzeFailure } = vi.hoisted(() => ({
  mockGetByIdAsync: vi.fn(),
  mockUpdate: vi.fn(),
  mockAnalyzeFailure: vi.fn(),
}));

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/app/actions/projects', () => ({ getActiveProjectPath: vi.fn(async () => '/proj') }));
vi.mock('@/app/actions/tasks', () => ({ retryTask: vi.fn() }));
vi.mock('@/lib/logger', () => ({ log: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn() }));
vi.mock('@/lib/task-store', () => ({
  TaskStore: class {
    getByIdAsync = mockGetByIdAsync;
    update = mockUpdate;
  },
}));
vi.mock('@/lib/role-refinement', () => ({
  getRoleRefinementConfig: vi.fn(() => ({ mode: 'manual' })),
  setRoleRefinementConfig: vi.fn(),
  analyzeFailure: mockAnalyzeFailure,
  listSuggestions: vi.fn(),
  getSuggestion: vi.fn(),
  suggestionsForTask: vi.fn(),
  applyRefinement: vi.fn(),
  dismissRefinement: vi.fn(),
  revertRefinement: vi.fn(),
  makeRoleRefinementAnalyzeDeps: vi.fn(() => ({})),
}));

import { analyzeFailedTask } from '@/app/actions/role-refinement';

describe('analyzeFailedTask TaskStore read failures', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAnalyzeFailure.mockResolvedValue(undefined);
  });

  it('resolves { success: false, error } when the read rejects', async () => {
    mockGetByIdAsync.mockRejectedValue(new Error('EIO: read failed'));
    await expect(analyzeFailedTask('t1')).resolves.toEqual({ success: false, error: 'EIO: read failed' });
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(mockAnalyzeFailure).not.toHaveBeenCalled();
  });

  it('succeeds and starts the analysis when the task is failed', async () => {
    mockGetByIdAsync.mockResolvedValue({ id: 't1', phase: 'failed' });
    await expect(analyzeFailedTask('t1')).resolves.toEqual({ success: true, operationId: expect.any(String) });
    expect(mockUpdate).toHaveBeenCalledWith('t1', { refinementStatus: 'analyzing' });
  });
});
