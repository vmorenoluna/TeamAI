// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { execFile } from 'child_process';
import {
  HistoryScanner,
  extractSpecification,
} from '../../src/lib/history-scanner';

vi.mock('child_process', () => ({ execFile: vi.fn() }));
vi.mock('../../src/lib/tool-checker', () => ({ getToolPath: vi.fn(() => 'gh') }));
vi.mock('../../src/lib/logger', () => ({
  warn: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
}));

const mockedExecFile = vi.mocked(execFile);

/**
 * history-scanner.ts calls the async (callback-based) execFile, not
 * execFileSync — see history-scanner.ts for why. This adapts a synchronous
 * "(file, args) -> stdout" fixture selector into the callback shape
 * promisify(execFile) expects, so the tests below can keep expressing
 * fixtures the simple way.
 */
function execFileImpl(handler: (file: string, args: readonly string[]) => string) {
  return (...callArgs: unknown[]) => {
    const file = callArgs[0] as string;
    const args = (callArgs[1] as readonly string[]) ?? [];
    const callback = callArgs[callArgs.length - 1] as (
      err: unknown,
      result: { stdout: string; stderr: string },
    ) => void;
    callback(null, { stdout: handler(file, args), stderr: '' });
  };
}

const COMMIT_LOG_FIXTURE = [
  // hash, date, subject, body — two tasks, one with a QA retry
  'a1b2c3d2026-08-28 10:00:00 +0200feat: add password reset flowImplemented password reset with email tokens.\n\nTask: add-password-reset-flow\nTask-ID: t-111\nQA: PASS (3/3 criteria)\nPhases: spec>plan>implement>qa-review\nReviewed-by: TeamAI QA agent',
  'e4f5a6b2026-08-29 09:30:00 +0200refactor: simplify billing webhookExtracted the webhook parser into its own module.\n\nTask: simplify-billing-webhook\nTask-ID: t-222\nQA: PASS (2/3 criteria, 1 deferred, retried 2 times)\nPhases: spec>plan>implement>qa-review(x3)>merge\nReviewed-by: TeamAI QA agent',
  '', // trailing record after final 
].join('');

const PR_LIST_FIXTURE = JSON.stringify([
  {
    url: 'https://github.com/acme/repo/pull/42',
    mergedAt: '2026-08-29T08:00:00Z',
    title: 'feat: add password reset flow',
    body: '## Summary\n\nImplemented password reset.\n\n---\n\n## Specification\n\nUsers can reset passwords via email tokens.\n\n---\n\nTask: add-password-reset-flow\nTask-ID: t-111\nQA: PASS (3/3 criteria)\nReviewed-by: TeamAI QA agent',
  },
]);

function makeScanner(recordHistoryInGit = true): HistoryScanner {
  return new HistoryScanner({ projectRoot: '/tmp/project', recordHistoryInGit });
}

describe('history-scanner', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('toggle gating', () => {
    it('returns empty results and never shells out when recordHistoryInGit is off', async () => {
      const scanner = makeScanner(false);
      expect(scanner.isEnabled).toBe(false);
      expect((await scanner.scanCommitTrailers()).size).toBe(0);
      expect((await scanner.scanMergedPrBodies()).size).toBe(0);
      expect(await scanner.rescan()).toEqual([]);
      expect(mockedExecFile).not.toHaveBeenCalled();
    });
  });

  describe('scanCommitTrailers (Source A)', () => {
    it('parses trailer commits into DONE tickets', async () => {
      const scanner = makeScanner(true);
      mockedExecFile.mockImplementation(execFileImpl(() => COMMIT_LOG_FIXTURE) as never);

      const tickets = await scanner.scanCommitTrailers();
      expect(tickets.size).toBe(2);

      const t1 = tickets.get('add-password-reset-flow')!;
      expect(t1.title).toBe('add password reset flow');
      expect(t1.taskId).toBe('t-111');
      expect(t1.qaResult).toBe('PASS (3/3 criteria)');
      expect(t1.phaseChain).toBe('spec>plan>implement>qa-review');
      expect(t1.source).toBe('commit');
      expect(t1.prUrl).toBeUndefined();
      expect(t1.completedAt.getTime()).toBe(new Date('2026-08-28T10:00:00+02:00').getTime());
    });

    it('records the phase chain with retry counts', async () => {
      const scanner = makeScanner(true);
      mockedExecFile.mockImplementation(execFileImpl(() => COMMIT_LOG_FIXTURE) as never);

      const t2 = (await scanner.scanCommitTrailers()).get('simplify-billing-webhook')!;
      expect(t2.phaseChain).toBe('spec>plan>implement>qa-review(x3)>merge');
      expect(t2.qaResult).toContain('retried 2 times');
      expect(t2.qaResult).toContain('1 deferred');
    });

    it('skips records without a Task: trailer', async () => {
      const scanner = makeScanner(true);
      mockedExecFile.mockImplementation(execFileImpl(
        () => 'a1b2c3d2026-08-28 10:00:00 +0200chore: unrelated commitNo trailers here.',
      ) as never);
      expect((await scanner.scanCommitTrailers()).size).toBe(0);
    });
  });

  describe('scanMergedPrBodies (Source B)', () => {
    it('parses gh pr list JSON into DONE tickets with PR URLs', async () => {
      const scanner = makeScanner(true);
      mockedExecFile.mockImplementation(execFileImpl(() => PR_LIST_FIXTURE) as never);

      const tickets = await scanner.scanMergedPrBodies();
      expect(tickets.size).toBe(1);
      const t = tickets.get('add-password-reset-flow')!;
      expect(t.prUrl).toBe('https://github.com/acme/repo/pull/42');
      expect(t.source).toBe('pr-body');
      expect(t.taskId).toBe('t-111');
    });
  });

  describe('rescan (merge by slug)', () => {
    it('prefers Source A and enriches with Source B PR URL', async () => {
      const scanner = makeScanner(true);
      mockedExecFile.mockImplementation(execFileImpl(
        (file) => (file === 'git' ? COMMIT_LOG_FIXTURE : PR_LIST_FIXTURE),
      ) as never);

      const tickets = await scanner.rescan();
      expect(tickets).toHaveLength(2);

      const t1 = scanner.getBySlug('add-password-reset-flow')!;
      expect(t1.source).toBe('both');
      expect(t1.prUrl).toBe('https://github.com/acme/repo/pull/42');
      expect(t1.completedAt.getTime()).toBe(new Date('2026-08-28T10:00:00+02:00').getTime());

      // Newest first: the webhook refactor (08-29) before the reset flow (08-28)
      expect(tickets[0].slug).toBe('simplify-billing-webhook');
    });

    it('keeps local-merge tickets that have no PR', async () => {
      const scanner = makeScanner(true);
      mockedExecFile.mockImplementation(execFileImpl(
        (file) => (file === 'git' ? COMMIT_LOG_FIXTURE : '[]'),
      ) as never);

      const tickets = await scanner.rescan();
      expect(tickets).toHaveLength(2);
      expect(tickets.every(t => t.prUrl === undefined)).toBe(true);
    });
  });

  describe('appendOnCompletion', () => {
    it('synthesizes the fresh ticket and makes it the newest entry', async () => {
      const scanner = makeScanner(true);
      mockedExecFile.mockImplementation(execFileImpl(
        (file) => (file === 'git' ? COMMIT_LOG_FIXTURE : '[]'),
      ) as never);
      await scanner.rescan();

      const fresh = scanner.appendOnCompletion({
        slug: 'brand-new-task',
        taskId: 't-333',
        title: 'brand new task',
        taskType: 'feat',
        summary: 'Did the thing.',
        trailerLines: [
          'Task: brand-new-task',
          'Task-ID: t-333',
          'QA: PASS (4/4 criteria)',
          'Phases: spec>plan>implement>qa-review',
          'Reviewed-by: TeamAI QA agent',
        ],
        prUrl: 'https://github.com/acme/repo/pull/99',
      });

      expect(fresh.qaResult).toBe('PASS (4/4 criteria)');
      expect(fresh.prUrl).toBe('https://github.com/acme/repo/pull/99');

      const tickets = scanner.sorted();
      expect(tickets[0].slug).toBe('brand-new-task');
    });
  });

  describe('extractSpecification', () => {
    it('extracts the ## Specification section and stops at the trailer block', () => {
      const body = '## Summary\n\nDid things.\n\n---\n\n## Specification\n\nThe system shall do X.\n\n---\n\nTask: t\nQA: PASS';
      expect(extractSpecification(body)).toBe('The system shall do X.');
    });

    it('returns null when the section is absent', () => {
      expect(extractSpecification('No spec here.')).toBeNull();
    });
  });

  describe('getSpecContent', () => {
    it('fetches and caches the spec from the PR body', async () => {
      const scanner = makeScanner(true);
      mockedExecFile.mockImplementation(execFileImpl((file, args) => {
        if (file === 'git') return COMMIT_LOG_FIXTURE;
        const argsStr = args.join(' ');
        if (argsStr.includes('--search')) return PR_LIST_FIXTURE;
        return JSON.stringify({ body: '## Specification\n\nFull spec text.' });
      }) as never);
      await scanner.rescan();
      const callsAfterRescan = mockedExecFile.mock.calls.length;

      const spec = await scanner.getSpecContent('add-password-reset-flow');
      expect(spec).toBe('Full spec text.');

      // Second call is served from cache — no additional shell-out.
      await scanner.getSpecContent('add-password-reset-flow');
      expect(mockedExecFile).toHaveBeenCalledTimes(callsAfterRescan + 1);
    });

    it('falls back to the summary for local-merge tickets without a PR', async () => {
      const scanner = makeScanner(true);
      mockedExecFile.mockImplementation(execFileImpl(
        (file) => (file === 'git' ? COMMIT_LOG_FIXTURE : '[]'),
      ) as never);
      await scanner.rescan();
      const callsAfterRescan = mockedExecFile.mock.calls.length;

      const spec = await scanner.getSpecContent('simplify-billing-webhook');
      expect(spec).toBeTruthy();
      expect(mockedExecFile).toHaveBeenCalledTimes(callsAfterRescan); // no gh call for local-merge
    });
  });
});
