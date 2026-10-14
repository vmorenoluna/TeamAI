import { describe, it, expect, vi, beforeEach } from 'vitest';

const NAMES = ['claude', 'git', 'gh', 'docker', 'devcontainer'] as const;

const status = (name: string, customPath = false) => ({
  name,
  label: name,
  found: true,
  customPath,
});

const mocks = vi.hoisted(() => ({
  checkTool: vi.fn(),
  checkAllTools: vi.fn(),
  setToolPath: vi.fn(),
  clearToolPath: vi.fn(),
}));

vi.mock('@/lib/tool-checker', () => mocks);

import { checkTools, updateToolPath, resetToolPath } from '@/app/actions/tools';

describe('tools actions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.checkTool.mockImplementation(async (name: string) => status(name, name === 'gh'));
    mocks.checkAllTools.mockImplementation(async () => NAMES.map(n => status(n)));
  });

  it('updateToolPath resolves to a ToolStatus, not a promise', async () => {
    const result = await updateToolPath('gh', '/x/gh');
    expect(mocks.setToolPath).toHaveBeenCalledWith('gh', '/x/gh');
    expect(result).toMatchObject({ name: 'gh', customPath: true });
    expect(typeof (result as unknown as { then?: unknown }).then).toBe('undefined');
  });

  it('resetToolPath clears the path and resolves to a ToolStatus', async () => {
    mocks.checkTool.mockImplementation(async (name: string) => status(name));
    const result = await resetToolPath('git');
    expect(mocks.clearToolPath).toHaveBeenCalledWith('git');
    expect(result).toMatchObject({ name: 'git', customPath: false });
  });

  it('checkTools resolves to an array of 5 ToolStatus', async () => {
    const result = await checkTools();
    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(5);
  });

  it('propagates a checkTool rejection', async () => {
    mocks.checkTool.mockRejectedValue(new Error('boom'));
    await expect(updateToolPath('gh', '/x/gh')).rejects.toThrow('boom');
  });
});
