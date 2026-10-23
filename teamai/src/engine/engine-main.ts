/**
 * Engine process entry: owns the orchestrator, auto mode and ProcessManager.
 * Serves call/notify requests from the API server over IPC, forwards engine
 * events back, and runs the boot sequence (recovery, auto-resume, sweeps).
 */
import { processManager } from '../lib/process-manager';
import { appEvents } from '../lib/app-events';
import { containerManager, checkDockerAvailable } from '../lib/container-manager';
import { startupCleanup, autoResumeInterruptedTasks, sweepStalledTasks } from '../lib/recovery';
import { restoreAutoModeStates } from '../lib/auto-mode';
import { startRoleRefinementWatcher } from '../lib/role-refinement-watcher';
import { error as logError } from '../lib/logger';
import { projectStore } from '../lib/project-store';
import { sweepAbandonedWorktreeRemnants } from '../lib/orchestrator/worktree-ops';
import { ChildRegistry } from './child-registry';
import { engineHandlers } from './handlers';
import { ENGINE_METHOD_NOT_FOUND, serializeError } from './protocol';
import type { ApiToEngineMessage, EngineToApiMessage } from './protocol';

const SWEEP_INTERVAL_MS = 5 * 60_000; // 5 minutes

type Send = (message: EngineToApiMessage) => void;

function defaultSend(message: EngineToApiMessage): void {
  if (process.send && process.connected) {
    try {
      process.send(message);
    } catch (err) {
      logError('engine', 'Failed to send message to API process', err);
    }
  }
}

/** Runs one request; never throws. Returns the result message for calls. */
export async function dispatchMessage(
  message: ApiToEngineMessage,
  send: Send,
  handlers: Record<string, (params: unknown) => Promise<unknown>> = engineHandlers,
  onShutdown: () => void = shutdownEngine,
): Promise<void> {
  if (!message || typeof message !== 'object') return;
  if (message.type === 'shutdown') {
    onShutdown();
    return;
  }
  if (message.type !== 'call' && message.type !== 'notify') return;

  const handler = Object.prototype.hasOwnProperty.call(handlers, message.method)
    ? handlers[message.method]
    : undefined;
  const isCall = message.type === 'call';
  if (!handler) {
    if (isCall) {
      send({
        type: 'result',
        id: message.id,
        ok: false,
        error: { name: ENGINE_METHOD_NOT_FOUND, message: `Unknown engine method: ${message.method}` },
      });
    } else {
      logError('engine', `Unknown engine notify method: ${message.method}`);
    }
    return;
  }

  try {
    const value = await handler(message.args?.[0]);
    if (isCall) send({ type: 'result', id: message.id, ok: true, value });
  } catch (err) {
    if (isCall) send({ type: 'result', id: message.id, ok: false, error: serializeError(err) });
    else logError('engine', `Notify handler ${message.method} failed`, err);
  }
}

function shutdownEngine(): void {
  new ChildRegistry().clear();
  process.exit(0);
}

/** Forward engine events to the API process as { type: 'event', name, args: [payload] }. */
export function installEventForwarding(send: Send): void {
  const forward = (name: string, payload: unknown) => send({ type: 'event', name, args: [payload] });
  const relay = (source: NodeJS.EventEmitter, from: string, to: string = from) =>
    source.on(from, (payload: unknown) => forward(to, payload));

  for (const name of [
    'phase-change', 'action-result', 'refinement-update', 'subtask-progress',
    'container-docker-missing', 'container-validation-failed', 'terminal-data',
  ]) {
    relay(processManager, name);
  }
  for (const name of ['container-state', 'container-log', 'container-validation']) {
    relay(containerManager, name);
  }
  relay(appEvents, 'task-updated');

  // Agent output carries only the session id; attach task/project so the API
  // process can filter per project without owning the session map.
  const agent = (to: string) => (data: { sessionId: string; event: unknown }) => {
    const session = processManager.getSession(data.sessionId);
    if (!session) return;
    forward(to, {
      sessionId: data.sessionId,
      taskId: session.taskId,
      projectRoot: session.projectRoot,
      event: data.event,
    });
  };
  processManager.on('event', agent('agent-event'));
  processManager.on('error', agent('agent-error'));
}

export interface EngineBootSteps {
  checkDockerAvailable: () => Promise<unknown>;
  syncDefaults: () => void;
  recoveryScan: () => { interruptedTasks: number };
  sendReady: () => void;
  autoResume: () => Promise<void>;
  sweepWorktrees: () => void;
  restoreAutoMode: () => void;
  startRoleRefinementWatcher: () => void;
  startSweepInterval: () => void;
  listenContainerState: () => void;
}

/** Runs the steps in order; a step that throws is logged and the rest still run. */
export async function runEngineBoot(steps: EngineBootSteps): Promise<void> {
  const run = async (label: string, fn: () => unknown) => {
    try {
      await fn();
    } catch (err) {
      logError('engine-boot', `Boot step failed: ${label}`, err);
    }
  };
  let interrupted = 0;
  await run('checkDockerAvailable', steps.checkDockerAvailable);
  await run('syncDefaults', steps.syncDefaults);
  await run('recoveryScan', () => { interrupted = steps.recoveryScan().interruptedTasks; });
  await run('ready', steps.sendReady);
  if (interrupted > 0) void run('autoResume', steps.autoResume); // not awaited: must not delay later steps
  await run('sweepWorktrees', steps.sweepWorktrees);
  await run('restoreAutoMode', steps.restoreAutoMode);
  await run('startRoleRefinementWatcher', steps.startRoleRefinementWatcher);
  await run('startSweepInterval', steps.startSweepInterval);
  await run('listenContainerState', steps.listenContainerState);
}

export function createDefaultBootSteps(send: Send): EngineBootSteps {
  return {
    // Warm the Docker availability cache so the first sync readContainerConfig() sees the real value
    checkDockerAvailable,
    // Commands are the pipeline's orchestration contract and must match the
    // shipped defaults before any session runs (auto-resume below can spawn
    // sessions immediately).
    syncDefaults: () => {
      try {
        const syncReport = projectStore.syncAllProjectsDefaults();
        if (syncReport.projects.length > 0) {
          console.log(`[defaults] Auto-synced default commands for ${syncReport.projects.length} project(s):`);
          for (const p of syncReport.projects) {
            console.log(`  • ${p.projectName}: ${p.updatedFiles.length} file(s) — ${p.updatedFiles.slice(0, 3).join(', ')}${p.updatedFiles.length > 3 ? ', …' : ''}`);
          }
        } else {
          console.log('[defaults] All projects already up to date');
        }
      } catch (err) {
        logError('defaults', 'Failed to auto-sync default commands at startup', err);
      }
    },
    recoveryScan: () => {
      const staleSessions = processManager.getStaleSessions();
      const report = startupCleanup(staleSessions.length);

      const parts: string[] = [];
      if (report.restoredWorktrees > 0) {
        parts.push(`${report.restoredWorktrees} worktree(s) restored from container-patched state`);
      }
      if (report.interruptedTasks.length > 0) {
        parts.push(`${report.interruptedTasks.length} interrupted task(s)`);
      }
      if (report.staleSessions > 0) {
        parts.push(`${report.staleSessions} stale session(s)`);
      }
      if (report.orphanedWorktrees.length > 0) {
        parts.push(`${report.orphanedWorktrees.length} orphaned worktree(s)`);
      }
      if (report.autoClearedRateLimits > 0) {
        parts.push(`${report.autoClearedRateLimits} expired rate limit(s) auto-cleared`);
      }
      if (report.artifactInconsistencies.length > 0) {
        parts.push(`${report.artifactInconsistencies.length} artifact inconsistency(s)`);
      }

      if (parts.length > 0) {
        console.log(`[recovery] ${parts.join(', ')} detected:`);
        for (const t of report.interruptedTasks) {
          console.log(`  • interrupted: ${t.title} (${t.phase}) in ${t.projectName}`);
        }
        for (const s of staleSessions) {
          console.log(`  • stale session: ${s.id.substring(0, 8)}… task=${s.taskId} role=${s.role}`);
          processManager.removeStaleSession(s.id);
        }
        for (const w of report.orphanedWorktrees) {
          console.log(`  • orphaned worktree: ${w.path}`);
        }
        for (const a of report.artifactInconsistencies) {
          console.log(`  • artifact inconsistency: ${a.title} (${a.phase}) in ${a.projectName} — ${a.issue}`);
        }
      } else {
        console.log('[recovery] clean — no stale state detected');
      }
      return { interruptedTasks: report.interruptedTasks.length };
    },
    sendReady: () => send({ type: 'ready' }),
    autoResume: () =>
      autoResumeInterruptedTasks().then(count => {
        console.log(`[auto-resume] Queued ${count} interrupted task(s) for resumption`);
      }).catch(err => {
        logError('auto-resume', 'Failed to auto-resume interrupted tasks', err);
      }),
    // A subtask worktree path held open by a scanner or orphaned process is
    // never waited on: the run takes a fresh path and leaves the old directory
    // behind. By startup the lock has usually gone, so delete the leftovers.
    sweepWorktrees: () => {
      try {
        for (const project of projectStore.getAll()) {
          sweepAbandonedWorktreeRemnants(project.path).then(removed => {
            if (removed.length > 0) {
              console.log(`[worktree-sweep] Removed ${removed.length} abandoned worktree remnant(s) in ${project.path}`);
            }
          }).catch(err => {
            logError('worktree-sweep', 'Failed to sweep abandoned worktree remnants', err);
          });
        }
      } catch (err) {
        logError('worktree-sweep', 'Failed to sweep abandoned worktree remnants', err);
      }
    },
    // Auto-mode state is persisted to .teamai/auto-mode.json so it survives restarts.
    restoreAutoMode: () => {
      try {
        const restored = restoreAutoModeStates();
        if (restored > 0) {
          console.log(`[auto-mode] Restored auto mode for ${restored} project(s) from disk`);
        }
      } catch (err) {
        logError('auto-mode', 'Failed to restore auto-mode states from disk', err);
      }
    },
    startRoleRefinementWatcher: () => {
      try {
        startRoleRefinementWatcher();
        console.log('[role-refinement] Watcher started (auto-analysis on recurrence)');
      } catch (err) {
        logError('role-refinement', 'Failed to start role-refinement watcher', err);
      }
    },
    startSweepInterval: () => {
      // Every 5 minutes, scan all projects for tasks stuck in active phases and re-queue them.
      // sweepStalledTasks() is the SOLE owner of session stall-kills — do not add
      // another inline kill loop here. It reads each project's configured per-project
      // idle/tool-stall thresholds and passes the 'stalled' reason to killSession,
      // which gates the stall-recovery retry classification in implement.ts.
      setInterval(() => {
        sweepStalledTasks().then(count => {
          if (count > 0) {
            console.log(`[sweep] Re-queued ${count} stalled task(s)`);
          }
        }).catch(err => {
          logError('sweep', 'Periodic stall-detection sweep failed', err);
        });
      }, SWEEP_INTERVAL_MS);
    },
    listenContainerState: () => {
      containerManager.on('container-state', (data: { projectRoot: string; state: string }) => {
        if (data.state === 'running') {
          console.log(`[auto-resume] Container for ${data.projectRoot} became available — checking for interrupted tasks`);
          autoResumeInterruptedTasks().then(count => {
            if (count > 0) {
              console.log(`[auto-resume] Queued ${count} interrupted task(s) after container became available`);
            }
          }).catch(err => {
            logError('auto-resume', 'Failed to auto-resume after container became available', err);
          });
        }
      });
    },
  };
}

export function startEngineMain(): void {
  process.env.TEAMAI_PROCESS_ROLE = 'engine';
  const send = defaultSend;

  // Global error handlers so unhandled rejections don't crash the engine
  process.on('unhandledRejection', (reason: unknown) => {
    logError('engine', 'Unhandled rejection', reason instanceof Error ? reason : String(reason));
  });
  process.on('uncaughtException', (err: Error) => {
    logError('engine', 'Uncaught exception', err);
    // Don't exit — log and continue
  });

  // The API process went away: nothing left to serve.
  process.on('disconnect', () => process.exit(0));
  process.on('message', (message: ApiToEngineMessage) => {
    void dispatchMessage(message, send);
  });

  installEventForwarding(send);
  void runEngineBoot(createDefaultBootSteps(send));
}

if (process.send) startEngineMain();
