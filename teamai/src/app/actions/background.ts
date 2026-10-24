'use server';

import type { BackgroundResult } from '@/lib/background-actions';
import { engineCall } from '@/engine/engine-client';

/** Lets the UI recover an `action-result` it missed (socket gap, reconnect).
 *  The registry lives in the engine process; when it is down the result is unknown. */
export async function getBackgroundActionResult(operationId: string): Promise<BackgroundResult> {
  try {
    return await engineCall<BackgroundResult>('background.getResult', [{ operationId }]);
  } catch (err) {
    if (err instanceof Error && err.name === 'EngineUnavailableError') return { status: 'unknown' };
    throw err;
  }
}
