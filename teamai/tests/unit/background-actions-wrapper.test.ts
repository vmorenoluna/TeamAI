import { describe, it, expect, vi, beforeEach } from 'vitest';

const engineCall = vi.fn();
vi.mock('@/engine/engine-client', () => ({ engineCall: (...a: unknown[]) => engineCall(...a) }));

import { getBackgroundActionResult } from '@/app/actions/background';
import { EngineUnavailableError, EngineTimeoutError } from '@/engine/protocol';

describe('getBackgroundActionResult', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('queries the engine registry', async () => {
    engineCall.mockResolvedValue({ status: 'failed', error: 'boom' });
    await expect(getBackgroundActionResult('op1')).resolves.toEqual({ status: 'failed', error: 'boom' });
    expect(engineCall).toHaveBeenCalledWith('background.getResult', [{ operationId: 'op1' }]);
  });

  it('degrades to unknown on EngineUnavailableError', async () => {
    engineCall.mockRejectedValue(new EngineUnavailableError('down'));
    await expect(getBackgroundActionResult('op1')).resolves.toEqual({ status: 'unknown' });
  });

  it('degrades to unknown on a plain Error named EngineUnavailableError', async () => {
    const err = new Error('down');
    err.name = 'EngineUnavailableError';
    engineCall.mockRejectedValue(err);
    await expect(getBackgroundActionResult('op1')).resolves.toEqual({ status: 'unknown' });
  });

  it('rethrows EngineTimeoutError and other errors', async () => {
    engineCall.mockRejectedValue(new EngineTimeoutError('slow'));
    await expect(getBackgroundActionResult('op1')).rejects.toBeInstanceOf(EngineTimeoutError);
    engineCall.mockRejectedValue(new Error('other'));
    await expect(getBackgroundActionResult('op1')).rejects.toThrow('other');
  });
});
