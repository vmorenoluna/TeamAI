import { getBackgroundResult } from '@/lib/background-actions';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Handler = (params: any) => Promise<unknown>;

export const backgroundHandlers: Record<string, Handler> = {
  'background.getResult': async (params: { operationId: string }) => getBackgroundResult(params.operationId),
};
