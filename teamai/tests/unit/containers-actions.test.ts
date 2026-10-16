import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

let projectPath = '';
const checkDockerAvailable = vi.fn();

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/app/actions/projects', () => ({ getActiveProjectPath: async () => projectPath }));
vi.mock('@/lib/container-manager', () => ({
  containerManager: { getState: vi.fn(), bootstrapContainer: vi.fn(async () => {}) },
  checkDockerAvailable: (...args: unknown[]) => checkDockerAvailable(...args),
}));

import { getContainerConfig, isDockerAvailable, resetDockerAvailability } from '@/app/actions/containers';

describe('container server actions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    if (projectPath) rmSync(projectPath, { recursive: true, force: true });
    projectPath = mkdtempSync(join(tmpdir(), 'containers-actions-'));
  });

  it('getContainerConfig without container.json reports enabled/available from a single probe', async () => {
    checkDockerAvailable.mockResolvedValue(true);
    const result = await getContainerConfig();
    expect(result).toEqual({ enabled: true, dockerAvailable: true });
    expect(checkDockerAvailable).toHaveBeenCalledTimes(1);
  });

  it('resetDockerAvailability forces a fresh probe that the next isDockerAvailable reflects', async () => {
    let docker = false;
    let cached: boolean | null = null;
    checkDockerAvailable.mockImplementation(async (opts?: { force?: boolean }) => {
      if (opts?.force || cached === null) cached = docker;
      return cached;
    });
    expect(await isDockerAvailable()).toBe(false);
    docker = true;
    expect(await isDockerAvailable()).toBe(false);
    await resetDockerAvailability();
    expect(checkDockerAvailable).toHaveBeenCalledWith({ force: true });
    expect(await isDockerAvailable()).toBe(true);
  });
});
