'use server';

import { getBackgroundResult, type BackgroundResult } from '@/lib/background-actions';

/** Lets the UI recover an `action-result` it missed (socket gap, reconnect). */
export async function getBackgroundActionResult(operationId: string): Promise<BackgroundResult> {
  return getBackgroundResult(operationId);
}
