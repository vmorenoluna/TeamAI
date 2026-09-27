// @vitest-environment node

/**
 * Unit tests for the ticket-history trailer machinery:
 *   - buildTrailerBlock (shared commit/PR-body trailer lines)
 *   - buildTicketMessageForPipeline (loads artifacts from specPath, builds
 *     the full commit message; null when recordHistoryInGit is off)
 *   - squashWithMessage (collapses a feature branch to a single
 *     trailer-bearing commit) — also exercised at the phase-runner level by
 *     the integration suites (create-pr-conflict, mark-task-done).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { execFileSync } from 'child_process';

import {
  buildTrailerBlock,
  buildTicketMessageForPipeline,
  readImplementationSummary,
  readSpecSummary,
  squashWithMessage,
  hasCommitsBeyondBase,
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

  describe('readImplementationSummary', () => {
    it('returns the trimmed file content when present', () => {
      writeFileSync(join(dir, 'implementation_summary.md'), '  Added password reset.  \n', 'utf-8');
      expect(readImplementationSummary(dir)).toBe('Added password reset.');
    });

    it('returns null when the file is missing', () => {
      expect(readImplementationSummary(dir)).toBeNull();
    });

    it('returns null when the file is empty/whitespace-only', () => {
      writeFileSync(join(dir, 'implementation_summary.md'), '   \n', 'utf-8');
      expect(readImplementationSummary(dir)).toBeNull();
    });
  });

  describe('readSpecSummary', () => {
    it('returns the trimmed file content when present', () => {
      writeFileSync(join(dir, 'spec_summary.md'), '  Chose signed tokens over sessions.  \n', 'utf-8');
      expect(readSpecSummary(dir)).toBe('Chose signed tokens over sessions.');
    });

    it('returns null when the file is missing', () => {
      expect(readSpecSummary(dir)).toBeNull();
    });

    it('returns null when the file is empty/whitespace-only', () => {
      writeFileSync(join(dir, 'spec_summary.md'), '   \n', 'utf-8');
      expect(readSpecSummary(dir)).toBeNull();
    });

    it('does not read spec.md itself, even when spec_summary.md is absent', () => {
      // Guards against a regression that falls back to the raw, unbounded
      // spec — the whole point of this file is to stay small by construction.
      writeFileSync(join(dir, 'spec.md'), '# Full Spec\n\nLots of unbounded content here.', 'utf-8');
      expect(readSpecSummary(dir)).toBeNull();
    });
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

// ── squashWithMessage ──
//
// Regression coverage for a real production failure (task
// guard-standalone-melody-endpoint-chord-s): a coder session edited a file
// and ended its turn without ever running `git add`/`git commit`. squashing
// via `git reset --soft <merge-base>` only restages the tree of the commit
// it resets to — it never touches the working directory — so that
// never-staged edit was left behind as a permanently uncommitted diff, and
// the branch that got pushed for the PR contained none of it. The fix adds a
// last-resort `git status --porcelain` check (mirroring the same auto-commit
// pattern already used elsewhere in this codebase, e.g. integrateGroup's
// pre-cherry-pick safety net) immediately before the reset, so a dirty
// worktree can never reach it.

describe('squashWithMessage', () => {
  let originDir: string;
  let worktreePath: string;
  let specPath: string;
  const noopDeps = {
    restoreWorktreeGitFileToHostPaths: () => {},
    worktreeGitEnv: () => ({}),
  };

  function git(args: string[], cwd: string): string {
    return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: 'pipe' });
  }

  beforeEach(() => {
    originDir = join(tmpdir(), `teamai-squash-origin-${randomUUID().slice(0, 8)}`);
    worktreePath = join(tmpdir(), `teamai-squash-work-${randomUUID().slice(0, 8)}`);
    specPath = join(tmpdir(), `teamai-squash-spec-${randomUUID().slice(0, 8)}`);
    mkdirSync(specPath, { recursive: true });

    mkdirSync(originDir, { recursive: true });
    git(['init', '--bare', '-b', 'master'], originDir);

    git(['clone', originDir, worktreePath], tmpdir());
    git(['config', 'user.email', 'test@teamai.dev'], worktreePath);
    git(['config', 'user.name', 'TeamAI Test'], worktreePath);
    writeFileSync(join(worktreePath, 'base.txt'), 'base\n');
    git(['add', '.'], worktreePath);
    git(['commit', '-m', 'initial commit'], worktreePath);
    git(['push', 'origin', 'master'], worktreePath);

    git(['checkout', '-b', 'feat/test'], worktreePath);
  });

  afterEach(() => {
    try { rmSync(originDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    try { rmSync(worktreePath, { recursive: true, force: true }); } catch { /* best-effort */ }
    try { rmSync(specPath, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  it('does not silently drop an uncommitted edit when squashing', () => {
    // A committed change on the feature branch.
    writeFileSync(join(worktreePath, 'feature.txt'), 'feature work\n');
    git(['add', '.'], worktreePath);
    git(['commit', '-m', 'feature work'], worktreePath);

    // An edit left behind uncommitted — the coder session that produced it
    // never ran git add/commit before ending.
    writeFileSync(join(worktreePath, 'feature.txt'), 'feature work + the actual fix\n');

    const result = squashWithMessage(worktreePath, 'feat: test squash\n\nTask-ID: t\n', 'master', specPath, noopDeps);

    expect(result).toBe(true);
    // Nothing left uncommitted afterward.
    expect(git(['status', '--porcelain'], worktreePath).trim()).toBe('');
    // Exactly one commit ahead of the base — the squash collapsed both the
    // committed change and the auto-committed edit into one.
    const log = git(['log', '--oneline', 'master..HEAD'], worktreePath).trim().split('\n');
    expect(log.length).toBe(1);
    // The edit itself survived into the squashed commit's tree.
    const committedContent = readFileSync(join(worktreePath, 'feature.txt'), 'utf-8');
    expect(committedContent).toBe('feature work + the actual fix\n');
  });

  it('returns false and leaves history untouched when there is nothing beyond the base', () => {
    const result = squashWithMessage(worktreePath, 'feat: test squash\n', 'master', specPath, noopDeps);
    expect(result).toBe(false);
  });
});

// ── hasCommitsBeyondBase ──
//
// Regression coverage for a real production failure: a pure verification
// ticket (empty src/ diff by design) reaching create-pr/merge with nothing
// committed beyond the base branch — squashWithMessage already detects this
// internally (see above) but its caller in phase-runners.ts ignored the
// return value and barrelled ahead into `gh pr create`, which GitHub
// rejects with "No commits between <base> and <branch>". Callers now check
// this independently, before attempting to squash/push/PR/merge at all.

describe('hasCommitsBeyondBase', () => {
  let originDir: string;
  let worktreePath: string;
  const noopDeps = {
    restoreWorktreeGitFileToHostPaths: () => {},
    worktreeGitEnv: () => ({}),
  };

  function git(args: string[], cwd: string): string {
    return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: 'pipe' });
  }

  beforeEach(() => {
    originDir = join(tmpdir(), `teamai-hcb-origin-${randomUUID().slice(0, 8)}`);
    worktreePath = join(tmpdir(), `teamai-hcb-work-${randomUUID().slice(0, 8)}`);

    mkdirSync(originDir, { recursive: true });
    git(['init', '--bare', '-b', 'master'], originDir);

    git(['clone', originDir, worktreePath], tmpdir());
    git(['config', 'user.email', 'test@teamai.dev'], worktreePath);
    git(['config', 'user.name', 'TeamAI Test'], worktreePath);
    writeFileSync(join(worktreePath, 'base.txt'), 'base\n');
    git(['add', '.'], worktreePath);
    git(['commit', '-m', 'initial commit'], worktreePath);
    git(['push', 'origin', 'master'], worktreePath);

    git(['checkout', '-b', 'feat/test'], worktreePath);
  });

  afterEach(() => {
    try { rmSync(originDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    try { rmSync(worktreePath, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  it('returns false when the branch is identical to the base (pure verification ticket)', () => {
    // No commits beyond master at all — exactly what a task whose own
    // acceptance criteria mandate an empty src/ diff leaves behind.
    expect(hasCommitsBeyondBase(worktreePath, 'master', noopDeps)).toBe(false);
  });

  it('returns true when the branch has a real commit beyond the base', () => {
    writeFileSync(join(worktreePath, 'feature.txt'), 'feature work\n');
    git(['add', '.'], worktreePath);
    git(['commit', '-m', 'feature work'], worktreePath);
    expect(hasCommitsBeyondBase(worktreePath, 'master', noopDeps)).toBe(true);
  });

  it('fails open (returns true) when the worktree does not exist', () => {
    expect(hasCommitsBeyondBase(join(tmpdir(), 'does-not-exist'), 'master', noopDeps)).toBe(true);
  });

  it('fails open (returns true) when merge-base/rev-parse cannot be resolved (e.g. an unrelated base branch)', () => {
    expect(hasCommitsBeyondBase(worktreePath, 'no-such-branch', noopDeps)).toBe(true);
  });
});
