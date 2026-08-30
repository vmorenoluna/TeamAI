// @vitest-environment node

/**
 * Unit tests for the ticket-history trailer machinery:
 *   - buildTrailerBlock (shared commit/PR-body trailer lines)
 *   - buildTicketMessageForPipeline (loads artifacts from specPath, builds
 *     the full commit message; null when recordHistoryInGit is off)
 *
 * squashWithMessage is exercised by the integration suites
 * (create-pr-conflict, mark-task-done) against real git repos.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';

import {
  buildTrailerBlock,
  buildTicketMessageForPipeline,
} from '../../src/lib/orchestrator/artifact-commit';

// ── Helpers ──

function setupTaskDir(files: Record<string, string> = {}): string {
  const dir = join(tmpdir(), `teamai-ticket-msg-${randomUUID().slice(0, 8)}`);
  mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, name), content, 'utf-8');
  }
  return dir;
}

const PASS_REPORT = JSON.stringify({
  overall: 'PASS',
  criteria: [
    { criterion: 'a', status: 'PASS' },
    { criterion: 'b', status: 'PASS' },
    { criterion: 'c', status: 'PASS' },
  ],
});

const DEFFERED_REPORT = JSON.stringify({
  overall: 'PASS',
  criteria: [
    { criterion: 'a', status: 'PASS' },
    { criterion: 'b', status: 'DEFFERED' },
    { criterion: 'c', status: 'FAIL' },
  ],
});

// ── buildTrailerBlock ──

describe('buildTrailerBlock', () => {
  it('emits Task, Task-ID, QA and Reviewed-by lines', () => {
    const lines = buildTrailerBlock('my-slug', 'task-1', JSON.parse(PASS_REPORT), null);
    expect(lines).toEqual([
      'Task: my-slug',
      'Task-ID: task-1',
      'QA: PASS (3/3 criteria)',
      'Reviewed-by: TeamAI QA agent',
    ]);
  });

  it('reads overall from the report, never recomputed from criteria', () => {
    // overall FAIL with mixed criteria — trailer must say FAIL.
    const report = JSON.parse(JSON.stringify({
      overall: 'FAIL',
      criteria: [
        { status: 'PASS' }, { status: 'PASS' }, { status: 'FAIL' },
      ],
    }));
    const lines = buildTrailerBlock('s', 't', report, null);
    expect(lines[2]).toBe('QA: FAIL (2/3 criteria)');
  });

  it('excludes non-PASS/FAIL statuses from the denominator and reports them as deferred', () => {
    const lines = buildTrailerBlock('s', 't', JSON.parse(DEFFERED_REPORT), null);
    expect(lines[2]).toBe('QA: PASS (1/2 criteria, 1 deferred)');
  });

  it('is case-insensitive on criterion status', () => {
    const report = JSON.parse(JSON.stringify({
      overall: 'PASS',
      criteria: [{ status: 'pass' }, { status: 'Fail' }],
    }));
    const lines = buildTrailerBlock('s', 't', report, null);
    expect(lines[2]).toBe('QA: PASS (1/2 criteria)');
  });

  it('emits QA: ? when the report is missing or has no overall', () => {
    expect(buildTrailerBlock('s', 't', null, null)[2]).toBe('QA: ?');
    expect(buildTrailerBlock('s', 't', {}, null)[2]).toBe('QA: ?');
  });

  it('appends retried N times from qa-review re-entries in events', () => {
    const events = [
      { phase: 'spec' }, { phase: 'plan' }, { phase: 'implement' },
      { phase: 'qa-review' }, { phase: 'implement' }, { phase: 'qa-review' },
      { phase: 'implement' }, { phase: 'qa-review' },
    ];
    const lines = buildTrailerBlock('s', 't', JSON.parse(PASS_REPORT), events);
    expect(lines[2]).toBe('QA: PASS (3/3 criteria, retried 2 times)');
  });

  it('does not append retried for a single qa-review entry', () => {
    const events = [{ phase: 'spec' }, { phase: 'qa-review' }];
    const lines = buildTrailerBlock('s', 't', JSON.parse(PASS_REPORT), events);
    expect(lines[2]).toBe('QA: PASS (3/3 criteria)');
  });

  it('builds the Phases chain with (xN) repeat markers', () => {
    const events = [
      { phase: 'spec' }, { phase: 'plan' }, { phase: 'implement' },
      { phase: 'qa-review' }, { phase: 'implement' }, { phase: 'qa-review' },
      { phase: 'merge' },
    ];
    const lines = buildTrailerBlock('s', 't', JSON.parse(PASS_REPORT), events);
    expect(lines[3]).toBe('Phases: spec>plan>implement(x2)>qa-review(x2)>merge');
  });

  it('omits the Phases line when includePhasesTrailer is false', () => {
    const events = [{ phase: 'spec' }, { phase: 'qa-review' }];
    const lines = buildTrailerBlock('s', 't', JSON.parse(PASS_REPORT), events, { includePhasesTrailer: false });
    expect(lines).toEqual([
      'Task: s',
      'Task-ID: t',
      'QA: PASS (3/3 criteria)',
      'Reviewed-by: TeamAI QA agent',
    ]);
  });
});

// ── buildTicketMessageForPipeline ──

describe('buildTicketMessageForPipeline', () => {
  let dir: string;

  beforeEach(() => { dir = setupTaskDir(); });
  afterEach(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ } });

  const pipeline = (specPath: string) => ({
    taskId: 'task-1',
    title: 'Add password reset flow',
    description: 'Full task description here.',
    specPath,
    worktreePath: '/unused',
  });

  it('returns null when recordHistoryInGit is off', () => {
    expect(buildTicketMessageForPipeline(pipeline(dir), { recordHistoryInGit: false })).toBeNull();
  });

  it('builds subject + description body + trailers by default', () => {
    const result = buildTicketMessageForPipeline(pipeline(dir));
    expect(result).not.toBeNull();
    expect(result!.message).toBe(
      'feat: Add password reset flow\n' +
      '\n' +
      'Full task description here.\n' +
      '\n' +
      'Task: ' + dir.split(/[\\/]/).pop() + '\n' +
      'Task-ID: task-1\n' +
      'QA: ?\n' +
      'Reviewed-by: TeamAI QA agent\n',
    );
    expect(result!.trailerLines).toEqual([
      'Task: ' + dir.split(/[\\/]/).pop(),
      'Task-ID: task-1',
      'QA: ?',
      'Reviewed-by: TeamAI QA agent',
    ]);
  });

  it('prefers implementation_summary.md over the description as the body', () => {
    writeFileSync(join(dir, 'implementation_summary.md'), 'Added password reset via signed tokens.\n', 'utf-8');
    const result = buildTicketMessageForPipeline(pipeline(dir))!;
    expect(result.message).toContain('\nAdded password reset via signed tokens.\n');
    expect(result.message).not.toContain('Full task description here.');
  });

  it('reads the QA trailer from qa_report.json in specPath', () => {
    writeFileSync(join(dir, 'qa_report.json'), PASS_REPORT, 'utf-8');
    const result = buildTicketMessageForPipeline(pipeline(dir))!;
    expect(result.trailerLines).toContain('QA: PASS (3/3 criteria)');
  });

  it('derives the retry count from events.jsonl in specPath', () => {
    writeFileSync(join(dir, 'qa_report.json'), PASS_REPORT, 'utf-8');
    writeFileSync(join(dir, 'events.jsonl'), [
      JSON.stringify({ phase: 'spec' }),
      JSON.stringify({ phase: 'qa-review' }),
      JSON.stringify({ phase: 'implement' }),
      JSON.stringify({ phase: 'qa-review' }),
      '',
    ].join('\n'), 'utf-8');
    const result = buildTicketMessageForPipeline(pipeline(dir))!;
    expect(result.trailerLines).toContain('QA: PASS (3/3 criteria, retried 1 times)');
    expect(result.trailerLines).toContain('Phases: spec>qa-review(x2)>implement');
  });

  it('uses the taskType option in the subject', () => {
    const result = buildTicketMessageForPipeline(pipeline(dir), { taskType: 'fix' })!;
    expect(result.message.startsWith('fix: Add password reset flow\n')).toBe(true);
  });

  it('omits the Phases line when includePhasesTrailer is false', () => {
    writeFileSync(join(dir, 'events.jsonl'), JSON.stringify({ phase: 'spec' }) + '\n', 'utf-8');
    const result = buildTicketMessageForPipeline(pipeline(dir), { includePhasesTrailer: false })!;
    expect(result.trailerLines.some(l => l.startsWith('Phases:'))).toBe(false);
  });

  it('truncates the subject to 72 chars', () => {
    const long = buildTicketMessageForPipeline({
      taskId: 't', title: 'x'.repeat(120), description: 'd', specPath: dir,
    })!;
    const subject = long.message.split('\n')[0];
    expect(subject.startsWith('feat: ')).toBe(true);
    expect(subject.length).toBeLessThanOrEqual('feat: '.length + 72);
  });
});
