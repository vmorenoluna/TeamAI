/**
 * QA progress assessment — pure helpers (no I/O) that decide whether a QA
 * round moved the task forward, and whether the stall / round budgets are spent.
 */
import { assessProgress, budgetExhausted, type RoundRecord } from './progress-budget';
import type { QaIssue, QaReport, QaRoundRecord, TaskPipeline } from './types';

/** Normalised `file::description` key for an additional issue. */
export function additionalIssueKey(issue: QaIssue): string {
  const file = (issue.file || '').trim().replace(/\\/g, '/').toLowerCase();
  const description = (issue.description || issue.message || '').trim().replace(/\\s+/g, ' ').toLowerCase();
  return `${file}::${description}`;
}

function sortedUnique(values: Iterable<string>): string[] {
  return [...new Set(values)].sort();
}

function criterionKey(c: { id?: unknown; criterion?: unknown; name?: unknown }): string | null {
  if (typeof c.id === 'string' && c.id.trim()) return c.id.trim().toUpperCase();
  const text = [c.criterion, c.name].find(v => typeof v === 'string' && v.trim()) as string | undefined;
  if (!text) return null;
  return `text:${text.trim().replace(/\s+/g, ' ').toLowerCase()}`;
}

export function buildQaRoundRecord(report: QaReport, round: number): QaRoundRecord {
  const failed = new Set<string>();
  const passed = new Set<string>();
  for (const c of report.criteria || []) {
    const key = criterionKey(c);
    if (!key) continue;
    const status = typeof c.status === 'string' ? c.status.trim().toUpperCase() : '';
    if (status === 'FAIL') failed.add(key);
    else if (status === 'PASS') passed.add(key);
  }
  for (const key of failed) passed.delete(key);

  const failedIssues = (report.additional_issues || report.issues || [])
    .map(additionalIssueKey)
    .filter(key => key !== '::')
    .map(key => `issue:${key}`);

  return {
    round,
    failedCriteria: sortedUnique(failed),
    passedCriteria: sortedUnique(passed),
    failedIssues: sortedUnique(failedIssues),
  };
}

function toRoundRecord(record: QaRoundRecord): RoundRecord {
  return {
    round: record.round,
    failed: [...record.failedCriteria, ...record.failedIssues],
    passed: record.passedCriteria,
  };
}

export function assessQaProgress(
  history: QaRoundRecord[],
  current: QaRoundRecord,
): { progress: boolean; reason: string } {
  // A criterion missing from the current report is not resolved; only an explicit PASS is.
  // Issues have no pass list, so an issue that stops being reported is resolved.
  return assessProgress(history.map(toRoundRecord), toRoundRecord(current), {
    requiresExplicitPass: key => !key.startsWith('issue:'),
  });
}

export function qaBudgetExhausted(
  pipeline: Pick<TaskPipeline, 'qaStallCount' | 'qaRoundCount' | 'maxQaAttempts' | 'maxQaRounds'>,
): 'stall' | 'rounds' | null {
  return budgetExhausted({
    stall: pipeline.qaStallCount ?? 0,
    rounds: pipeline.qaRoundCount ?? 0,
    maxStall: pipeline.maxQaAttempts,
    maxRounds: pipeline.maxQaRounds ?? 3 * pipeline.maxQaAttempts,
  });
}
