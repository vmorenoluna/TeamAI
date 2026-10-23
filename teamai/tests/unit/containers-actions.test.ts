import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

let projectPath = '';
const checkDockerAvailable = vi.fn();
const engineCall = vi.fn();

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/app/actions/projects', () => ({ getActiveProjectPath: async () => projectPath }));
vi.mock('@/engine/engine-client', () => ({ engineCall: (...args: unknown[]) => engineCall(...args) }));
vi.mock('@/lib/container-manager', () => ({
  checkDockerAvailable: (...args: unknown[]) => checkDockerAvailable(...args),
}));

import { revalidatePath } from 'next/cache';
import {
  getContainerConfig, saveContainerConfig, revalidateContainer, getValidationStatus,
  getContainerState, getValidationSteps, isDockerAvailable, resetDockerAvailability,
} from '@/app/actions/containers';

describe('container server actions (engine wrappers)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    if (projectPath) rmSync(projectPath, { recursive: true, force: true });
    projectPath = mkdtempSync(join(tmpdir(), 'containers-actions-'));
  });

  it('getContainerConfig without container.json reports enabled/available from a single local probe', async () => {
    checkDockerAvailable.mockResolvedValue(true);
    expect(await getContainerConfig()).toEqual({ enabled: true, dockerAvailable: true });
    expect(checkDockerAvailable).toHaveBeenCalledTimes(1);
    expect(engineCall).not.toHaveBeenCalled();
  });

  it('saveContainerConfig writes container.json locally, revalidates, and delegates bootstrap to the engine', async () => {
    const engineResult = { enabled: true, dockerAvailable: true, generated: true, projectType: 'node' };
    engineCall.mockResolvedValue(engineResult);
    expect(await saveContainerConfig({ enabled: true })).toEqual(engineResult);
    expect(JSON.parse(readFileSync(join(projectPath, '.teamai', 'container.json'), 'utf-8'))).toEqual({ enabled: true });
    expect(revalidatePath).toHaveBeenCalledWith('/settings');
    expect(engineCall).toHaveBeenCalledWith('containers.saveContainerConfig', [{ projectPath, enabled: true }]);
  });

  it('saveContainerConfig propagates an engine failure', async () => {
    engineCall.mockRejectedValue(new Error('engine down'));
    await expect(saveContainerConfig({ enabled: false })).rejects.toThrow('engine down');
  });

  it.each([
    ['revalidateContainer', () => revalidateContainer('op1'), 'containers.revalidateContainer', [{ projectPath: '', operationId: 'op1' }]],
    ['getValidationStatus', () => getValidationStatus(), 'containers.getValidationStatus', [{ projectPath: '' }]],
    ['getContainerState', () => getContainerState(), 'containers.getContainerState', [{ projectPath: '' }]],
    ['getValidationSteps', () => getValidationSteps(), 'containers.getValidationSteps', [{ projectPath: '' }]],
  ])('%s forwards to the engine with the active project path', async (_n, fn, method, args) => {
    engineCall.mockResolvedValue('result');
    expect(await fn()).toBe('result');
    expect(engineCall).toHaveBeenCalledWith(method, [{ ...args[0], projectPath }]);
  });

  it('isDockerAvailable and resetDockerAvailability forward to the engine', async () => {
    engineCall.mockResolvedValueOnce(true);
    expect(await isDockerAvailable()).toBe(true);
    expect(engineCall).toHaveBeenLastCalledWith('containers.isDockerAvailable', [{}]);
    engineCall.mockResolvedValueOnce(undefined);
    await resetDockerAvailability();
    expect(engineCall).toHaveBeenLastCalledWith('containers.resetDockerAvailability', [{}]);
    expect(checkDockerAvailable).not.toHaveBeenCalled();
  });
});
