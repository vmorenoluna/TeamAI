/**
 * The engine's method table: every handler record merged into one flat map,
 * keyed by the `<area>.<method>` names the API process calls.
 */
import { autoModeHandlers } from './auto-mode';
import { backgroundHandlers } from './background';
import { containersHandlers } from './containers';
import { orchestratorHandlers } from './orchestrator';
import { roleRefinementHandlers } from './role-refinement';
import { sessionsHandlers } from './sessions';
import { tasksHandlers } from './tasks';
import { terminalsHandlers } from './terminals';

/* eslint-disable @typescript-eslint/no-explicit-any */
export type EngineHandler = (params: any) => Promise<unknown>;

export const engineHandlers: Record<string, EngineHandler> = {
  ...tasksHandlers,
  ...orchestratorHandlers,
  ...backgroundHandlers,
  ...autoModeHandlers,
  ...terminalsHandlers,
  ...sessionsHandlers,
  ...containersHandlers,
  ...roleRefinementHandlers,
};
