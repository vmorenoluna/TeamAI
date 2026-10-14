/**
 * Scope-arbitration progress assessment — pure helpers (no I/O) that decide whether a
 * scope re-plan round moved a subtask forward, and whether the stall / round budgets are spent.
 */
import { assessProgress, budgetExhausted, type RoundRecord } from './progress-budget';
import type { ScopeRoundRecord } from './types';

/** Key for a file a subtask touched outside its assigned `files`. */
export function scopeFileKey(subtaskId: number, filePath: string): string {
  return `${subtaskId}:${filePath.trim().replace(/\\/g, '/')}`;
}

function sortedUnique(values: Iterable<string>): string[] {
  return [...new Set(values)].sort();
}

/**
 * Round record for the subtask's current pass. `approved` stays empty until the planner's
 * verdict is applied. `history` is this subtask's earlier rounds only.
 */
export function buildScopeRoundRecord(opts: {
  subtaskId: number;
  scopeReplanCount: number;
  unlistedFiles: string[];
  history: ScopeRoundRecord[];
}): ScopeRoundRecord {
  const failed = sortedUnique(opts.unlistedFiles.map(f => scopeFileKey(opts.subtaskId, f)));
  const failedNow = new Set(failed);
  const approved = new Set(opts.history.flatMap(r => r.approved));
  const rejectedEarlier = opts.history.flatMap(r => r.failed).filter(k => !approved.has(k));
  const passed = sortedUnique(rejectedEarlier.filter(k => !failedNow.has(k)));
  return { round: opts.scopeReplanCount + 1, failed, passed, approved: [] };
}

function toRoundRecord(record: ScopeRoundRecord): RoundRecord {
  const approved = new Set(record.approved);
  return {
    round: record.round,
    failed: record.failed,
    passed: record.passed.filter(k => !approved.has(k)),
  };
}

export function assessScopeProgress(
  history: ScopeRoundRecord[],
  current: ScopeRoundRecord,
): { progress: boolean; reason: string } {
  // An approved file that stops being touched is not progress: only a rejected file
  // that is explicitly gone counts, and a brand-new unlisted file is never progress.
  const everApproved = new Set(history.flatMap(r => r.approved));
  return assessProgress(history.map(toRoundRecord), toRoundRecord(current), {
    newFailures: 'block',
    requiresExplicitPass: key => everApproved.has(key),
  });
}

export function scopeBudgetExhausted(state: {
  stall: number;
  rounds: number;
  maxStall: number;
  maxRounds: number;
}): 'stall' | 'rounds' | null {
  return budgetExhausted(state);
}
