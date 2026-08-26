/**
 * Role Refinement Assistant — Phases 2–3: recurrence watcher + auto-apply.
 *
 * A boot-time listener (independent of auto-mode) that turns the `failed`
 * phase-change event into an auto-triggered failure analysis when ALL gates
 * pass:
 *   - project mode is 'auto' (config read fresh on every event),
 *   - `detectRecurrence` reports a hit (persisted criterion / repeated task
 *     failure / cross-task cluster),
 *   - the `maxAutoAnalysesPerDay` spend cap is not exhausted,
 *   - no suggestion record already covers this failure `signature` (dedupe),
 *   - the retry-loop guard allows it (`refinementRetryCount` below the cap;
 *     a same-signature failure after an applied refinement escalates to the
 *     user instead of looping edit → retry → fail → edit).
 *
 * Analysis runs with `trigger: 'auto'` and lands in the same store as manual
 * analysis. Phase 3: when the analysis resolves to a `suggested` record,
 * `maybeAutoApplyAndRetry` auto-applies + retries — but only under compounded
 * opt-ins (auto mode + autoApply + the pipeline auto-runner) and the
 * `isAutoApplyEligible` policy. Everything is still backed up and revertable.
 */
import { processManager } from './process-manager';
import { TaskStore } from './task-store';
import {
  getRoleRefinementConfig,
  analyzeFailure,
  detectRecurrence,
  listSuggestions,
  countAutoAnalysesToday,
  makeRoleRefinementAnalyzeDeps,
  getSuggestion,
  applyRefinement,
  isAutoApplyEligible,
  REFINEMENT_RETRY_LOOP_CAP,
} from './role-refinement';
import { isAutoModeEnabled } from './auto-mode-state';
import { retryFailedTask } from './task-retry';
import { log as logInfo, warn as logWarn } from './logger';

/** §7 retry-loop guard — how many refinement-retries before auto-analysis escalates. */
export { REFINEMENT_RETRY_LOOP_CAP };

let started = false;
let cleanup: (() => void) | null = null;

/** Register the phase-change listener. Idempotent (safe under HMR / double boot). */
export function startRoleRefinementWatcher(): void {
  if (started) return;
  started = true;

  const onPhaseChange = (data: { taskId: string; phase: string; projectRoot: string }) => {
    if (data.phase !== 'failed') return;
    maybeAutoAnalyze(data.projectRoot, data.taskId).catch(err => {
      logWarn('role-refinement', `Watcher failed to evaluate task ${data.taskId}`, err);
    });
  };

  processManager.on('phase-change', onPhaseChange);
  cleanup = () => processManager.off('phase-change', onPhaseChange);
  logInfo('role-refinement', 'Watcher started — auto-analysis on recurrence enabled per-project');
}

/** Remove the listener (tests / shutdown). */
export function stopRoleRefinementWatcher(): void {
  if (cleanup) {
    cleanup();
    cleanup = null;
  }
  started = false;
}

/**
 * Evaluate a `failed` phase-change against every auto-trigger gate and, if all
 * pass, fire-and-forget an analysis. Exported for direct unit testing — the
 * phase-change listener is a thin wrapper around this.
 */
export async function maybeAutoAnalyze(projectRoot: string, taskId: string): Promise<void> {
  const config = getRoleRefinementConfig(projectRoot);
  if (config.mode !== 'auto') return;

  const taskStore = new TaskStore(projectRoot);
  const task = taskStore.getById(taskId);
  if (!task) return;

  // Retry-loop guard (§7): a task that has already been through Apply & Retry
  // and failed again is escalated to a human, never auto-analyzed in a loop.
  if ((task.refinementRetryCount ?? 0) >= REFINEMENT_RETRY_LOOP_CAP) {
    escalate(projectRoot, taskId,
      `task ${taskId} failed again after ${task.refinementRetryCount} refinement retries — human review needed`);
    return;
  }

  const { hit, cluster, signature } = detectRecurrence(projectRoot, taskId);
  if (!hit) return;

  // Daily spend cap.
  const autoToday = countAutoAnalysesToday(projectRoot);
  if (autoToday >= config.maxAutoAnalysesPerDay) {
    logInfo('role-refinement',
      `Skipping auto-analysis for task ${taskId} — daily cap (${config.maxAutoAnalysesPerDay}) reached`);
    return;
  }

  // Signature dedupe: the same root cause never spawns stacked analyses. An
  // `applied` record covering this signature is the retry-loop escalation case
  // (the refinement didn't fix it — surface it, don't re-analyze the same gap).
  const covering = listSuggestions(projectRoot).find(s => s.signature === signature);
  if (covering) {
    if (covering.status === 'applied') {
      escalate(projectRoot, taskId,
        `task ${taskId} failed with the same signature as applied refinement ${covering.id} — human review needed`);
    } else {
      logInfo('role-refinement',
        `Skipping auto-analysis for task ${taskId} — signature already covered by ${covering.id} (${covering.status})`);
    }
    return;
  }

  logInfo('role-refinement',
    `Auto-analyzing failure for task ${taskId} (trigger: auto, cluster: ${cluster.join(', ')})`);
  analyzeFailure(projectRoot, taskId, 'auto', makeRoleRefinementAnalyzeDeps(), signature, cluster)
    .then(id => maybeAutoApplyAndRetry(projectRoot, id))
    .catch(err => logWarn('role-refinement', `auto analyzeFailure ${taskId} failed`, err));
}

/**
 * Phase-3 auto-apply + auto-retry (§2.5, §2.6, §8). Runs after an auto
 * analysis completes with a `suggested` record. Fires only when ALL gates
 * pass:
 *   - config.mode === 'auto' AND config.autoApply is opted in,
 *   - the pipeline auto-runner (auto-mode) is also enabled (compounded
 *     opt-in — auto-retry only advances tasks when the runner is on),
 *   - `isAutoApplyEligible`: role-prompt gap, confidence high, every edit
 *     additive/append and within the size cap, retry-loop guard clear.
 * Applies with `appliedBy: 'auto'` (backed up + revertable like any apply),
 * bumps `refinementRetryCount`, and retries the failed task.
 */
export async function maybeAutoApplyAndRetry(projectRoot: string, suggestionId: string): Promise<void> {
  const config = getRoleRefinementConfig(projectRoot);
  if (config.mode !== 'auto' || !config.autoApply) {
    logInfo('role-refinement', `Skipping auto-apply for ${suggestionId} — autoApply is off`);
    return;
  }
  if (!isAutoModeEnabled(projectRoot)) {
    logInfo('role-refinement', `Skipping auto-apply for ${suggestionId} — pipeline auto-runner is off`);
    return;
  }

  const record = getSuggestion(projectRoot, suggestionId);
  const taskId = record?.sourceTaskIds?.[0];
  if (!record || !taskId) return;

  const taskStore = new TaskStore(projectRoot);
  const task = taskStore.getById(taskId);
  if (!task) return;

  const eligibility = isAutoApplyEligible(record, task);
  if (!eligibility.eligible) {
    logInfo('role-refinement', `Skipping auto-apply for ${suggestionId} — ${eligibility.reason}`);
    return;
  }

  logInfo('role-refinement', `Auto-applying refinement ${suggestionId} to task ${taskId}`);
  try {
    applyRefinement(projectRoot, suggestionId, undefined, 'auto');
  } catch (err) {
    logWarn('role-refinement', `Auto-apply failed for ${suggestionId}`, err);
    return;
  }

  // Bump the loop-guard counter BEFORE the retry so a re-entrant failure on
  // the same task sees the incremented value and escalates instead of looping.
  taskStore.update(taskId, { refinementRetryCount: (task.refinementRetryCount ?? 0) + 1 });
  retryFailedTask(projectRoot, taskId);
}

/** Stamp the retry-loop escalation on the task and surface it to the UI. */
function escalate(projectRoot: string, taskId: string, message: string): void {
  try {
    new TaskStore(projectRoot).update(taskId, { refinementEscalated: true });
  } catch { /* best-effort — the record is persisted regardless */ }
  logInfo('role-refinement', `[ESCALATE] ${message}`);
  try {
    processManager.emit('refinement-update', { taskId, projectRoot });
  } catch { /* best-effort */ }
}
