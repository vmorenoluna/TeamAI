/**
 * QA progress assessment — pure helpers (no I/O) that decide whether a QA
 * round moved the task forward, and whether the stall / round budgets are spent.
 */
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

function failureSet(record: QaRoundRecord): string[] {
  return sortedUnique([...record.failedCriteria, ...record.failedIssues]);
}

function sameSet(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

export function assessQaProgress(
  history: QaRoundRecord[],
  current: QaRoundRecord,
): { progress: boolean; reason: string } {
  if (history.length === 0) return { progress: false, reason: 'no earlier round to compare' };
  const prev = history[history.length - 1];

  const everPassed = new Set(history.flatMap(r => r.passedCriteria));
  const regressed = current.failedCriteria.filter(k => everPassed.has(k));
  if (regressed.length > 0) return { progress: false, reason: `regression: ${regressed.join(', ')}` };

  const currentSet = failureSet(current);
  const repeated = history.find(r => sameSet(failureSet(r), currentSet));
  if (repeated) return { progress: false, reason: `failure set repeats round ${repeated.round}` };

  const currentPassed = new Set(current.passedCriteria);
  const currentIssues = new Set(current.failedIssues);
  const resolved = [
    ...prev.failedCriteria.filter(k => currentPassed.has(k)),
    ...prev.failedIssues.filter(k => !currentIssues.has(k)),
  ];
  if (resolved.length === 0) return { progress: false, reason: 'nothing that failed last round is resolved' };

  return { progress: true, reason: `resolved: ${resolved.join(', ')}` };
}

export function qaBudgetExhausted(
  pipeline: Pick<TaskPipeline, 'qaStallCount' | 'qaRoundCount' | 'maxQaAttempts' | 'maxQaRounds'>,
): 'stall' | 'rounds' | null {
  if ((pipeline.qaStallCount ?? 0) >= pipeline.maxQaAttempts) return 'stall';
  if ((pipeline.qaRoundCount ?? 0) >= (pipeline.maxQaRounds ?? 3 * pipeline.maxQaAttempts)) return 'rounds';
  return null;
}
