/**
 * Generic progress-aware retry budget — pure helpers (no I/O).
 *
 * A "round" is one attempt at a unit of work (a QA review, a scope re-plan, ...)
 * that either fails on some keys or passes on others. Two budgets bound the loop:
 * a stall counter (consecutive no-progress rounds, reset on progress) and a
 * never-resetting hard cap on total rounds. Domain adapters (e.g. qa-progress.ts)
 * map their own records onto RoundRecord.
 */

export interface RoundRecord {
  round: number;
  /** Keys that failed this round (sorted, deduped). */
  failed: string[];
  /** Keys that passed this round (sorted, deduped). */
  passed: string[];
}

function sortedUnique(values: Iterable<string>): string[] {
  return [...new Set(values)].sort();
}

function sameSet(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

export function assessProgress(
  history: RoundRecord[],
  current: RoundRecord,
  opts: {
    newFailures?: 'allow' | 'block';
    /** Keys for which "no longer failing" is not enough: they must be in current.passed to count as resolved. */
    requiresExplicitPass?: (key: string) => boolean;
  } = {},
): { progress: boolean; reason: string } {
  if (history.length === 0) return { progress: false, reason: 'no earlier round to compare' };
  const prev = history[history.length - 1];

  const everPassed = new Set(history.flatMap(r => r.passed));
  const regressed = current.failed.filter(k => everPassed.has(k));
  if (regressed.length > 0) return { progress: false, reason: `regression: ${regressed.join(', ')}` };

  const currentSet = sortedUnique(current.failed);
  const repeated = history.find(r => sameSet(sortedUnique(r.failed), currentSet));
  if (repeated) return { progress: false, reason: `failure set repeats round ${repeated.round}` };

  if (opts.newFailures === 'block') {
    const everFailed = new Set(history.flatMap(r => r.failed));
    const added = current.failed.filter(k => !everFailed.has(k));
    if (added.length > 0) return { progress: false, reason: `new failure: ${added.join(', ')}` };
  }

  const currentFailed = new Set(current.failed);
  const currentPassed = new Set(current.passed);
  const resolved = prev.failed.filter(k => !currentFailed.has(k) && (!opts.requiresExplicitPass?.(k) || currentPassed.has(k)));
  if (resolved.length === 0) return { progress: false, reason: 'nothing that failed last round is resolved' };

  return { progress: true, reason: `resolved: ${resolved.join(', ')}` };
}

export function budgetExhausted(
  state: { stall: number; rounds: number; maxStall: number; maxRounds: number },
): 'stall' | 'rounds' | null {
  if (state.stall >= state.maxStall) return 'stall';
  if (state.rounds >= state.maxRounds) return 'rounds';
  return null;
}

/** Hard cap on rounds: never below maxStall; defaults to factor * maxStall when unset/invalid. */
export function resolveRoundsCap(
  rawRounds: unknown,
  maxStall: number,
  factor = 3,
): { value: number; clamped: boolean } {
  if (typeof rawRounds === 'number' && Number.isInteger(rawRounds) && rawRounds > 0) {
    const value = Math.max(rawRounds, maxStall);
    return { value, clamped: value !== rawRounds };
  }
  return { value: factor * maxStall, clamped: false };
}
