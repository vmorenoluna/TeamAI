import { getActiveTaskIds } from '@/lib/orchestrator';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Handler = (params: any) => Promise<unknown>;

async function getActiveTaskIdsHandler(_params: { projectPath: string }): Promise<string[]> {
  return getActiveTaskIds();
}

export const orchestratorHandlers: Record<string, Handler> = {
  'orchestrator.getActiveTaskIds': getActiveTaskIdsHandler,
};
