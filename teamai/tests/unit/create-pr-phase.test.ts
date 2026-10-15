// @vitest-environment node

/**
 * runCreatePRPhase awaits the async git-platform calls: an existing open PR
 * short-circuits PR creation, otherwise the created PR's URL is stored.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const gp = vi.hoisted(() => ({
  resolveBaseBranch: vi.fn(),
  detectGitPlatform: vi.fn(),
  checkExistingPRViaCLI: vi.fn(),
  createPRViaCLI: vi.fn(),
  buildPRBody: vi.fn(),
}));

vi.mock('../../src/lib/logger', () => ({ log: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn() }));
vi.mock('../../src/lib/git-platform', () => gp);
vi.mock('../../src/lib/process-manager', () => ({
  processManager: { on: vi.fn(), off: vi.fn(), emit: vi.fn() },
  containerSessionOpts: (projectRoot: string) => ({ projectRoot }),
}));
// `git rev-list --count` → '0' makes rebaseOntoLatestDefault skip the rebase.
vi.mock('child_process', async (orig) => ({
  ...(await orig<typeof import('child_process')>()),
  execFileSync: vi.fn(() => '0'),
}));
vi.mock('../../src/lib/orchestrator/artifact-commit', () => ({
  squashWithMessage: vi.fn(() => true),
  hasCommitsBeyondBase: vi.fn(() => true),
  readImplementationSummary: vi.fn(() => null),
  readSpecSummary: vi.fn(() => 'summary'),
}));
vi.mock('../../src/lib/orchestrator/plan-validation', async (orig) => ({
  ...(await orig<typeof import('../../src/lib/orchestrator/plan-validation')>()),
  planDeclaresRealFileChanges: vi.fn(() => false),
}));

import { runCreatePRPhase } from '../../src/lib/orchestrator/phase-runners';

const EXISTING = 'https://github.com/o/r/pull/3';
const CREATED = 'https://github.com/o/r/pull/4';

describe('runCreatePRPhase', () => {
  let root: string;
  let pipeline: Parameters<typeof runCreatePRPhase>[0];
  let deps: Parameters<typeof runCreatePRPhase>[1];
  let update: ReturnType<typeof vi.fn>;
  let advancePhase: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    root = mkdtempSync(join(tmpdir(), 'teamai-create-pr-'));
    writeFileSync(join(root, 'spec_summary.md'), 'summary');
    gp.resolveBaseBranch.mockResolvedValue('main');
    gp.detectGitPlatform.mockResolvedValue('github');
    gp.buildPRBody.mockReturnValue('body');
    update = vi.fn();
    advancePhase = vi.fn();
    pipeline = {
      taskId: '11111111-1111-4111-8111-111111111111', title: 'T', description: 'D', phase: 'create-pr',
      specPath: root, worktreePath: join(root, 'wt'), branch: 'feat/x', specRevision: 0,
    } as unknown as typeof pipeline;
    deps = {
      projectRoot: root,
      persistAndEmitPhase: vi.fn(),
      sessionOpts: vi.fn(),
      waitForCompletion: vi.fn(async () => undefined),
      advancePhase,
      taskStore: { update } as never,
      execGit: vi.fn(),
      execGitCapture: vi.fn(() => ''),
      gitPush: vi.fn(),
      extractPrUrl: vi.fn(() => null),
      buildTicketMessage: vi.fn(() => null),
      removeWorktree: vi.fn(),
    } as unknown as typeof deps;
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('reuses an existing open PR without creating another', async () => {
    gp.checkExistingPRViaCLI.mockResolvedValue(EXISTING);

    await runCreatePRPhase(pipeline, deps);

    expect(gp.createPRViaCLI).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledWith(pipeline.taskId, expect.objectContaining({ prUrl: EXISTING, platform: 'github' }));
    expect(advancePhase).toHaveBeenCalledWith(pipeline, 'pr-open', expect.objectContaining({ prUrl: EXISTING }));
  });

  it('awaits createPRViaCLI and stores its URL when no PR exists', async () => {
    gp.checkExistingPRViaCLI.mockResolvedValue(null);
    gp.createPRViaCLI.mockResolvedValue(CREATED);

    await runCreatePRPhase(pipeline, deps);

    expect(gp.createPRViaCLI).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith(pipeline.taskId, expect.objectContaining({ prUrl: CREATED }));
    expect(advancePhase).toHaveBeenCalledWith(pipeline, 'pr-open', expect.objectContaining({ prUrl: CREATED }));
  });
});
