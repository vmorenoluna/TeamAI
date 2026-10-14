import { describe, it, expect } from 'vitest';
import { additionalIssueKey, assessQaProgress, buildQaRoundRecord, qaBudgetExhausted } from '../../src/lib/orchestrator/qa-progress';
import type { QaRoundRecord } from '../../src/lib/orchestrator/types';

function rec(round: number, p: Partial<QaRoundRecord> = {}): QaRoundRecord {
  return { round, failedCriteria: [], passedCriteria: [], failedIssues: [], ...p };
}

describe('assessQaProgress', () => {
  it('AC1: resolving a previously failed criterion is progress', () => {
    const history = [rec(1, { failedCriteria: ['AC1', 'AC2'], passedCriteria: ['AC3'] })];
    const current = rec(2, { failedCriteria: ['AC2'], passedCriteria: ['AC1', 'AC3'] });
    const res = assessQaProgress(history, current);
    expect(res.progress).toBe(true);
    expect(res.reason).toBe('resolved: AC1');
  });

  it('AC2: a criterion absent from the current report is not resolved', () => {
    const res = assessQaProgress([rec(1, { failedCriteria: ['AC1'] })], rec(2, { failedCriteria: ['AC2'] }));
    expect(res.progress).toBe(false);
    expect(res.reason).toBe('nothing that failed last round is resolved');
  });

  it('AC3: a regression blocks progress and names the criterion', () => {
    const history = [
      rec(1, { failedCriteria: ['AC1'], passedCriteria: ['AC2'] }),
      rec(2, { failedCriteria: ['AC2', 'AC3'], passedCriteria: ['AC1'] }),
    ];
    const res = assessQaProgress(history, rec(3, { failedCriteria: ['AC2'], passedCriteria: ['AC1', 'AC3'] }));
    expect(res.progress).toBe(false);
    expect(res.reason).toBe('regression: AC2');
  });

  it('AC4: a repeated failure set blocks progress and names the round', () => {
    const history = [rec(1, { failedIssues: ['issue:x'] }), rec(2, { failedIssues: ['issue:y'] })];
    const res = assessQaProgress(history, rec(3, { failedIssues: ['issue:x'] }));
    expect(res.progress).toBe(false);
    expect(res.reason).toBe('failure set repeats round 1');
  });

  it('AC5: new issues never count as progress, resolutions do', () => {
    const history = [rec(1, { failedCriteria: ['AC1'] })];
    expect(assessQaProgress(history, rec(2, { failedCriteria: ['AC1'], failedIssues: ['issue:new'] })).progress).toBe(false);

    const withIssue = [rec(1, { failedCriteria: ['AC1'], failedIssues: ['issue:old'] })];
    const res = assessQaProgress(withIssue, rec(2, { passedCriteria: ['AC1'] }));
    expect(res.progress).toBe(true);
  });

  it('AC5: a criterion resolved while a new issue appears is still progress', () => {
    const history = [rec(1, { failedCriteria: ['AC1', 'AC2'] })];
    const res = assessQaProgress(history, rec(2, { failedCriteria: ['AC2'], passedCriteria: ['AC1'], failedIssues: ['issue:new'] }));
    expect(res.progress).toBe(true);
  });

  it('AC6: empty history is never progress', () => {
    const res = assessQaProgress([], rec(1, { failedCriteria: ['AC1'] }));
    expect(res.progress).toBe(false);
    expect(res.reason).toBeTruthy();
  });
});

describe('buildQaRoundRecord', () => {
  it('normalises ids, statuses and text fallbacks; sorts and dedupes', () => {
    const record = buildQaRoundRecord({
      overall: 'FAIL',
      criteria: [
        { id: ' ac2 ', status: ' fail ' },
        { id: 'AC1', status: 'PASS' },
        { id: 'AC1', status: 'PASS' },
        { criterion: '  Does   The Thing ', status: 'FAIL' },
        { name: 'Named', status: 'pass' },
        { id: 'AC4', status: 'N/A' },
        { status: 'FAIL' },
      ],
      additional_issues: [
        { file: 'A\\B.ts', description: 'Broke' },
        { file: 'A\\B.ts', description: 'Broke' },
        {},
      ],
    }, 4);
    expect(record.round).toBe(4);
    expect(record.failedCriteria).toEqual(['AC2', 'text:does the thing']);
    expect(record.passedCriteria).toEqual(['AC1', 'text:named']);
    expect(record.failedIssues).toEqual(['issue:a/b.ts::broke']);
  });

  it('counts a key with both PASS and FAIL as FAIL only', () => {
    const record = buildQaRoundRecord({ criteria: [{ id: 'AC1', status: 'PASS' }, { id: 'AC1', status: 'FAIL' }] }, 1);
    expect(record.failedCriteria).toEqual(['AC1']);
    expect(record.passedCriteria).toEqual([]);
  });

  it('falls back to issues when additional_issues is absent', () => {
    const record = buildQaRoundRecord({ issues: [{ message: 'Oops', file: 'f.ts' }] }, 1);
    expect(record.failedIssues).toEqual(['issue:f.ts::oops']);
  });

  it('dedupes same-file issues whose descriptions differ only in whitespace and case', () => {
    const record = buildQaRoundRecord({
      additional_issues: [
        { file: 'src/x.ts', description: 'Dup  test\nblock' },
        { file: 'src/x.ts', description: 'dup test block' },
      ],
    }, 1);
    expect(record.failedIssues).toEqual(['issue:src/x.ts::dup test block']);
  });
});

describe('additionalIssueKey', () => {
  it('maps descriptions differing only in spaces to the same key', () => {
    expect(additionalIssueKey({ file: 'src/x.ts', description: 'Broke  here' })).toBe('src/x.ts::broke here');
    expect(additionalIssueKey({ file: 'src/x.ts', description: 'Broke here' })).toBe('src/x.ts::broke here');
  });

  it('collapses tabs, newlines and CRLF runs into a single space', () => {
    expect(additionalIssueKey({ file: 'src/x.ts', description: 'Broke\n\there\r\n  now' })).toBe('src/x.ts::broke here now');
  });

  it('does not treat a literal backslash followed by s as whitespace', () => {
    const key = additionalIssueKey({ file: 'src/x.ts', description: 'a\\sb' });
    expect(key).toBe('src/x.ts::a\\sb');
    expect(key).not.toBe(additionalIssueKey({ file: 'src/x.ts', description: 'a b' }));
  });

  it('normalises the file path without collapsing its internal whitespace', () => {
    expect(additionalIssueKey({ file: '  A\\Dir  Name\\b.ts ', description: 'x' })).toBe('a/dir  name/b.ts::x');
  });
});

describe('qaBudgetExhausted', () => {
  it('returns stall when the stall counter reaches maxQaAttempts', () => {
    expect(qaBudgetExhausted({ qaStallCount: 3, qaRoundCount: 99, maxQaAttempts: 3, maxQaRounds: 9 })).toBe('stall');
  });
  it('returns rounds when the round cap is reached, defaulting to 3x maxQaAttempts', () => {
    expect(qaBudgetExhausted({ qaStallCount: 0, qaRoundCount: 4, maxQaAttempts: 3, maxQaRounds: 4 })).toBe('rounds');
    expect(qaBudgetExhausted({ qaRoundCount: 9, maxQaAttempts: 3 })).toBe('rounds');
    expect(qaBudgetExhausted({ qaRoundCount: 8, maxQaAttempts: 3 })).toBeNull();
  });
  it('returns null when neither budget is spent and treats missing counters as 0', () => {
    expect(qaBudgetExhausted({ qaStallCount: 2, qaRoundCount: 5, maxQaAttempts: 3, maxQaRounds: 9 })).toBeNull();
    expect(qaBudgetExhausted({ maxQaAttempts: 3 })).toBeNull();
  });
});
