import { describe, it, expect } from 'vitest';
import { assessProgress, budgetExhausted, resolveRoundsCap, type RoundRecord } from '@/lib/orchestrator/progress-budget';

const rec = (round: number, failed: string[], passed: string[] = []): RoundRecord => ({ round, failed, passed });

describe('assessProgress', () => {
  it('is not progress without history', () => {
    expect(assessProgress([], rec(1, ['A']))).toEqual({ progress: false, reason: 'no earlier round to compare' });
  });

  it('flags a regression of a key that passed in any earlier round', () => {
    const history = [rec(1, ['A', 'B'], []), rec(2, ['B'], ['A'])];
    expect(assessProgress(history, rec(3, ['A'], ['B']))).toEqual({ progress: false, reason: 'regression: A' });
  });

  it('flags a failure set that repeats an earlier round', () => {
    const history = [rec(1, ['A', 'B']), rec(2, ['A', 'C'])];
    const result = assessProgress(history, rec(3, ['B', 'A']));
    expect(result.progress).toBe(false);
    expect(result.reason).toBe('failure set repeats round 1');
  });

  it('is not progress when nothing from last round is resolved', () => {
    const history = [rec(1, ['A'])];
    expect(assessProgress(history, rec(2, ['A', 'C']))).toEqual({
      progress: false,
      reason: 'nothing that failed last round is resolved',
    });
  });

  it('is progress when a key that failed last round no longer fails', () => {
    const history = [rec(1, ['A', 'B'])];
    expect(assessProgress(history, rec(2, ['B'], ['A']))).toEqual({ progress: true, reason: 'resolved: A' });
  });

  it('requires an explicit pass for keys selected by requiresExplicitPass', () => {
    const history = [rec(1, ['A'])];
    const opts = { requiresExplicitPass: () => true };
    expect(assessProgress(history, rec(2, []), opts).progress).toBe(false);
    expect(assessProgress(history, rec(2, [], ['A']), opts).progress).toBe(true);
  });

  it('allows brand-new failures by default alongside a resolution', () => {
    const history = [rec(1, ['A'])];
    expect(assessProgress(history, rec(2, ['N'])).progress).toBe(true);
    expect(assessProgress(history, rec(2, ['N']), { newFailures: 'allow' }).progress).toBe(true);
  });

  it('blocks brand-new failures when newFailures is "block"', () => {
    const history = [rec(1, ['A'])];
    expect(assessProgress(history, rec(2, ['N']), { newFailures: 'block' })).toEqual({
      progress: false,
      reason: 'new failure: N',
    });
  });

  it('does not treat a previously seen failure as new in block mode', () => {
    const history = [rec(1, ['A', 'B']), rec(2, ['B', 'C'])];
    expect(assessProgress(history, rec(3, ['C']), { newFailures: 'block' }).progress).toBe(true);
  });
});

describe('budgetExhausted', () => {
  it('returns null while both budgets have headroom', () => {
    expect(budgetExhausted({ stall: 1, rounds: 2, maxStall: 3, maxRounds: 9 })).toBeNull();
  });

  it('returns "stall" when the stall counter reaches maxStall', () => {
    expect(budgetExhausted({ stall: 3, rounds: 4, maxStall: 3, maxRounds: 9 })).toBe('stall');
  });

  it('returns "rounds" when only the hard cap is reached', () => {
    expect(budgetExhausted({ stall: 0, rounds: 9, maxStall: 3, maxRounds: 9 })).toBe('rounds');
  });

  it('checks stall before rounds when both are exhausted', () => {
    expect(budgetExhausted({ stall: 3, rounds: 9, maxStall: 3, maxRounds: 9 })).toBe('stall');
  });
});

describe('resolveRoundsCap', () => {
  it('keeps a valid value at or above maxStall', () => {
    expect(resolveRoundsCap(7, 3)).toEqual({ value: 7, clamped: false });
    expect(resolveRoundsCap(3, 3)).toEqual({ value: 3, clamped: false });
  });

  it('raises a value below maxStall and reports clamped', () => {
    expect(resolveRoundsCap(2, 5)).toEqual({ value: 5, clamped: true });
  });

  it.each([undefined, null, 0, -1, 2.5, '9', NaN])('defaults to 3*maxStall for %s', raw => {
    expect(resolveRoundsCap(raw, 4)).toEqual({ value: 12, clamped: false });
  });

  it('honours a custom factor', () => {
    expect(resolveRoundsCap(undefined, 4, 2)).toEqual({ value: 8, clamped: false });
  });
});
