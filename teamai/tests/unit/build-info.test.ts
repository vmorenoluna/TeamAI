import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockExecSync = vi.fn();
const mockReadFileSync = vi.fn();

vi.mock('child_process', () => ({ execSync: (...args: unknown[]) => mockExecSync(...args) }));
vi.mock('fs', () => ({ readFileSync: (...args: unknown[]) => mockReadFileSync(...args) }));

import { getBuildInfo } from '@/lib/build-info';

describe('getBuildInfo', () => {
  beforeEach(() => {
    globalThis.__teamaiBuildInfo = undefined;
    mockExecSync.mockReset();
    mockReadFileSync.mockReset();
    mockReadFileSync.mockReturnValue(JSON.stringify({ version: '0.3.0' }));
  });

  it('returns version and 7-char sha', () => {
    mockExecSync.mockReturnValue('abcdef1234567890\n');
    expect(getBuildInfo()).toEqual({ version: '0.3.0', sha: 'abcdef1' });
  });

  it('falls back to "unknown" when git throws, without affecting version', () => {
    mockExecSync.mockImplementation(() => { throw new Error('git not found'); });
    expect(getBuildInfo()).toEqual({ version: '0.3.0', sha: 'unknown' });
  });

  it('falls back to "unknown" when git output is empty', () => {
    mockExecSync.mockReturnValue('  \n');
    expect(getBuildInfo().sha).toBe('unknown');
  });

  it('returns empty version when package.json is unreadable, without throwing', () => {
    mockReadFileSync.mockImplementation(() => { throw new Error('ENOENT'); });
    mockExecSync.mockReturnValue('abcdef1234567890');
    expect(getBuildInfo()).toEqual({ version: '', sha: 'abcdef1' });
  });

  it('computes once: repeated calls spawn git a single time', () => {
    mockExecSync.mockReturnValue('abcdef1234567890');
    getBuildInfo();
    getBuildInfo();
    getBuildInfo();
    expect(mockExecSync).toHaveBeenCalledTimes(1);
    expect(mockReadFileSync).toHaveBeenCalledTimes(1);
  });
});
