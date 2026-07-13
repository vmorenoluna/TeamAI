/**
 * Rate-limit handling extracted from Orchestrator class.
 *
 * Contains:
 *  - RateLimitError  — thrown when an API or session limit is hit
 *  - waitForCompletion — Promise-based session completion with rate-limit detection
 *  - handleRateLimit  — setTimeout-based retry with stale-pipeline guards
 */
import { appendFileSync } from 'fs';
import path from 'path';
import { processManager } from '../process-manager';
import { SessionExitedError } from './errors';
import { log, error as logError } from '../logger';

import type { TaskStore } from '../task-store';
import type { TaskPipeline } from './types';
import type { PipelinePhase } from '@/constants/phases';
import { NO_RESUME_PHASES } from '@/constants/phases';

// ── Types ─────────────────────────────────────────────────────────────────

interface RateLimitInfo {
  status: string;
  resetsAt?: number;
}

// ── Error class ───────────────────────────────────────────────────────────

export class RateLimitError extends Error {
  constructor(public resetsAt: number) {
    super(`Rate limited until ${new Date(resetsAt * 1000).toISOString()}`);
  }
}

// ── Session completion watcher ────────────────────────────────────────────

export interface WaitForCompletionDeps {
  parseSessionLimitReset: (line: string) => number | null;
}

/**
 * Return a promise that resolves when the session emits a `result` event.
 * Detects rate-limit and session-limit signals and rejects with RateLimitError
 * so the caller can pause and retry after the limit window resets.
 */
export function waitForCompletion(
  sessionId: string,
  deps: WaitForCompletionDeps,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let rateLimitResetsAt: number | null = null;
    let sessionLimitResetsAt: number | null = null;

    const cleanup = () => {
      processManager.off('event', onEvent);
      processManager.off('exit', onExit);
      processManager.off('raw', onRaw);
    };

    const onRaw = ({ sessionId: sid, data }: { sessionId: string; data: string }) => {
      if (sid !== sessionId) return;
      if (/session.?limit/i.test(data)) {
        sessionLimitResetsAt =
          deps.parseSessionLimitReset(data) ?? Math.floor(Date.now() / 1000) + 3600;
      }
    };

    const onEvent = ({ sessionId: sid, event }: { sessionId: string; event: Record<string, unknown> }) => {
      if (sid !== sessionId) return;

      if (event.type === 'rate_limit_event' && event.rate_limit_info) {
        const info = event.rate_limit_info as RateLimitInfo;
        if (info.status !== 'allowed' && info.resetsAt) {
          rateLimitResetsAt = info.resetsAt as number;
        }
      }

      if (event.type === 'result') {
        cleanup();
        if (sessionLimitResetsAt) {
          reject(new RateLimitError(sessionLimitResetsAt));
        } else if (event.is_error && rateLimitResetsAt) {
          reject(new RateLimitError(rateLimitResetsAt));
        } else {
          resolve();
        }
      }
    };

    const onExit = ({ sessionId: sid, code }: { sessionId: string; code: number | null }) => {
      if (sid !== sessionId) return;
      cleanup();
      if (sessionLimitResetsAt) reject(new RateLimitError(sessionLimitResetsAt));
      else if (code === 0 || code === null) resolve();
      else if (rateLimitResetsAt) reject(new RateLimitError(rateLimitResetsAt));
      else reject(new SessionExitedError(code));
    };

    processManager.on('event', onEvent);
    processManager.on('exit', onExit);
    processManager.on('raw', onRaw);
  });
}

// ── Rate-limit handler ────────────────────────────────────────────────────

export interface HandleRateLimitDeps {
  taskStore: TaskStore;
  projectRoot: string;
  /** Active-task lock set — prevents concurrent runs of the same task. */
  activeTasks: Set<string>;
  /** In-memory pipeline map. */
  pipelines: Map<string, TaskPipeline>;
  executePhase: (pipeline: TaskPipeline) => Promise<void>;
  advancePhase: (pipeline: TaskPipeline, phase: PipelinePhase) => void;
  /** Recursive call for nested rate limits — passes through the orchestrator so spies intercept it. */
  handleRateLimit: (pipeline: TaskPipeline, resetsAt: number) => void;
}

/**
 * Pause a rate-limited task and schedule a retry via setTimeout.
 *
 * Stores rateLimitedUntil on the task record, broadcasts the pause via
 * processManager.emit, then resumes executePhase when the limit window
 * expires.  Guards against stale pipelines (task moved to backlog or
 * pipeline replaced during the wait).
 */
export function handleRateLimit(
  pipeline: TaskPipeline,
  resetsAt: number,
  deps: HandleRateLimitDeps,
): void {
  const resetsAtMs = resetsAt * 1000;
  const MAX_DELAY_MS = 2_147_483_647; // 32-bit signed int max
  const rawWaitMs = Math.max(resetsAtMs - Date.now(), 0);
  const waitMs = Math.min(rawWaitMs, MAX_DELAY_MS);
  const resetsAtISO = new Date(resetsAtMs).toISOString();

  deps.taskStore.update(pipeline.taskId, { rateLimitedUntil: resetsAtISO });

  // Re-acquire the lock that was released in runTask's finally block
  deps.activeTasks.add(pipeline.taskId);
  deps.pipelines.set(pipeline.taskId, pipeline);

  // Broadcast so the UI can show the countdown
  processManager.emit('phase-change', {
    taskId: pipeline.taskId,
    phase: pipeline.phase,
    projectRoot: deps.projectRoot,
    rateLimitedUntil: resetsAtISO,
  });

  const mins = Math.ceil(waitMs / 60000);
  log('rate-limit', `Task ${pipeline.taskId} paused for ~${mins}min. Resuming at ${resetsAtISO}`);

  // Track the timer so cancelPipeline can clear it
  if (pipeline.pendingTimer) clearTimeout(pipeline.pendingTimer);
  pipeline.pendingTimer = setTimeout(async () => {
    // Before resuming, check if the task was manually moved to a terminal phase
    const task = deps.taskStore.getById(pipeline.taskId);
    if (!task || NO_RESUME_PHASES.has(task.phase)) {
      log('rate-limit', `Task ${pipeline.taskId} is in terminal phase "${task?.phase}" — skipping resume`);
      deps.taskStore.update(pipeline.taskId, { rateLimitedUntil: undefined });
      deps.pipelines.delete(pipeline.taskId);
      deps.activeTasks.delete(pipeline.taskId);
      return;
    }

    // Verify the pipeline object hasn't been replaced (stale guard)
    const currentPipeline = deps.pipelines.get(pipeline.taskId);
    if (currentPipeline !== pipeline) {
      log('rate-limit', `Task ${pipeline.taskId} pipeline was replaced — skipping stale resume`);
      deps.taskStore.update(pipeline.taskId, { rateLimitedUntil: undefined });
      return;
    }

    log('rate-limit', `Resuming task ${pipeline.taskId}`);
    deps.taskStore.update(pipeline.taskId, { rateLimitedUntil: undefined });
    let wasRateLimited = false;
    try {
      await deps.executePhase(pipeline);
    } catch (e) {
      if (e instanceof RateLimitError) {
        wasRateLimited = true;
        deps.handleRateLimit(pipeline, e.resetsAt);
      } else {
        const errMsg = e instanceof Error ? `${e.message}\n${e.stack ?? ''}` : String(e);
        appendFileSync(path.join(pipeline.specPath, 'output.log'),
          `\n[ERROR] Task failed after rate-limit retry: ${errMsg}\n`);
        logError('orchestrator', `Task ${pipeline.taskId} failed after rate-limit retry`, e);
        deps.advancePhase(pipeline, 'failed');
      }
    } finally {
      if (!wasRateLimited) {
        deps.pipelines.delete(pipeline.taskId);
        deps.activeTasks.delete(pipeline.taskId);
      }
    }
  }, waitMs);
}
