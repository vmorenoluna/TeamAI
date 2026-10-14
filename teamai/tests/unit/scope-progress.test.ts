// @vitest-environment node

import { describe, it, expect } from 'vitest';
import { assessScopeProgress, buildScopeRoundRecord, scopeBudgetExhausted } from '../../src/lib/orchestrator/scope-progress';
import type { ScopeRoundRecord } from '../../src/lib/orchestrator/types';

const rec = (round: number, failed: string[], passed: string[] = [], approved: string[] = []): ScopeRoundRecord =>
  ({ round, failed, passed, approved });

describe('assessScopeProgress', () => {
  it('first round is never progress', () => {
    const r = assessScopeProgress([], rec(1, ['3:a.ts']));
    expect(r.progress).toBe(false);
    expect(r.reason).toBe('no earlier round to compare');
  });

  it('identical failure set is not progress', () => {
    expect(assessScopeProgress([rec(1, ['3:a.ts'])], rec(2, ['3:a.ts'])).progress).toBe(false);
  });

  it('a new unlisted file is not progress', () => {
    const r = assessScopeProgress([rec(1, ['3:a.ts', '3:b.ts'])], rec(2, ['3:b.ts', '3:c.ts']));
    expect(r.progress).toBe(false);
    expect(r.reason).toContain('new failure');
  });

  it('a rejected file that is gone with nothing new is progress', () => {
    expect(assessScopeProgress([rec(1, ['3:a.ts', '3:b.ts'])], rec(2, ['3:b.ts'], ['3:a.ts'])).progress).toBe(true);
  });

  it('an approved file that stops being touched is not progress', () => {
    const history = [rec(1, ['3:a.ts', '3:b.ts'], [], ['3:a.ts'])];
    expect(assessScopeProgress(history, rec(2, ['3:b.ts'])).progress).toBe(false);
  });

  it('a resolved rejected file reappearing is a regression', () => {
    const history = [rec(1, ['3:a.ts', '3:b.ts']), rec(2, ['3:b.ts'], ['3:a.ts'])];
    const r = assessScopeProgress(history, rec(3, ['3:a.ts', '3:b.ts']));
    expect(r.progress).toBe(false);
    expect(r.reason.startsWith('regression')).toBe(true);
  });
});

describe('buildScopeRoundRecord', () => {
  it('numbers the round from scopeReplanCount and keys files by subtask', () => {
    const r = buildScopeRoundRecord({ subtaskId: 3, scopeReplanCount: 2, unlistedFiles: ['b.ts', 'a.ts', 'a.ts'], history: [] });
    expect(r).toEqual({ round: 3, failed: ['3:a.ts', '3:b.ts'], passed: [], approved: [] });
  });

  it('passes earlier-rejected files that are gone, but not approved ones', () => {
    const history = [rec(1, ['3:a.ts', '3:b.ts', '3:c.ts'], [], ['3:c.ts'])];
    const r = buildScopeRoundRecord({ subtaskId: 3, scopeReplanCount: 1, unlistedFiles: ['b.ts'], history });
    expect(r.failed).toEqual(['3:b.ts']);
    expect(r.passed).toEqual(['3:a.ts']);
  });
});

describe('scopeBudgetExhausted', () => {
  it('reports stall, rounds or null', () => {
    expect(scopeBudgetExhausted({ stall: 2, rounds: 1, maxStall: 2, maxRounds: 6 })).toBe('stall');
    expect(scopeBudgetExhausted({ stall: 0, rounds: 6, maxStall: 2, maxRounds: 6 })).toBe('rounds');
    expect(scopeBudgetExhausted({ stall: 1, rounds: 5, maxStall: 2, maxRounds: 6 })).toBe(null);
  });
});
