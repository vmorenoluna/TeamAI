// @vitest-environment happy-dom

/**
 * Unit tests: alert-banner absence contract.
 *
 * The silent-failure audit + fix sweep established a uniform
 * `try/catch + role='alert'` pattern across 9 components. This file
 * locks in the COMPLEMENTARY contract: when no action has thrown, the
 * `role='alert'` banner is NOT rendered. Without this sanity check,
 * future regressions could accidentally render an alert by default
 * (e.g., initializing `error` with a non-null value, or forgetting to
 * gate the JSX on `&& error`).
 *
 * Pattern per component: render with mocks returning success, assert
 * `screen.queryByRole('alert')` returns null.
 */

// ── Hoisted mock functions ─────────────────────────────────────────────────

// pipeline-config
const mockSavePipelineConfig = vi.hoisted(() => vi.fn());
// provider-config
const mockSaveProvidersConfig = vi.hoisted(() => vi.fn());
const mockGetAvailableModels = vi.hoisted(() => vi.fn());
// directory-browser
const mockBrowseDirectory = vi.hoisted(() => vi.fn());
// role-editor
const mockSaveRole = vi.hoisted(() => vi.fn());
const mockResetRole = vi.hoisted(() => vi.fn());
// kanban-board / review-panel / task-detail actions
const mockCreateTask = vi.hoisted(() => vi.fn());
const mockMoveTask = vi.hoisted(() => vi.fn());
const mockBulkDeleteTasks = vi.hoisted(() => vi.fn());
const mockApproveTask = vi.hoisted(() => vi.fn());
const mockRejectTask = vi.hoisted(() => vi.fn());
const mockMarkTaskDone = vi.hoisted(() => vi.fn());
const mockAddDependency = vi.hoisted(() => vi.fn());
const mockRemoveDependency = vi.hoisted(() => vi.fn());
const mockAddBlock = vi.hoisted(() => vi.fn());
const mockRemoveBlock = vi.hoisted(() => vi.fn());
const mockDeleteTask = vi.hoisted(() => vi.fn());
const mockRetryTask = vi.hoisted(() => vi.fn());
const mockRestartCurrentPhase = vi.hoisted(() => vi.fn());
// task-detail auto-mode
const mockMarkAutoReviewed = vi.hoisted(() => vi.fn());
// insights-chat
const mockGetOrCreateInsightsSession = vi.hoisted(() => vi.fn());
const mockSendInsightsMessage = vi.hoisted(() => vi.fn());
const mockCancelInsightsSession = vi.hoisted(() => vi.fn());

// Mock startTransition so async callbacks resolve synchronously
// without depending on the React scheduler.
const mockStartTransition = vi.hoisted(() =>
  vi.fn((cb: () => void | Promise<void>) => {
    try {
      const result = cb() as unknown;
      if (result instanceof Promise) result.catch(() => { /* best-effort */ });
    } catch { /* suppress */ }
  })
);

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>();
  return { ...actual, useTransition: () => [false, mockStartTransition] };
});

// ── Module mocks ──────────────────────────────────────────────────────────

vi.mock('@/app/actions/pipeline', () => ({
  savePipelineConfig: (cfg: unknown) => mockSavePipelineConfig(cfg),
}));

vi.mock('@/app/actions/providers', () => ({
  saveProvidersConfig: (cfg: unknown) => mockSaveProvidersConfig(cfg),
  getAvailableModels: (provider: string, refresh: boolean) =>
    mockGetAvailableModels(provider, refresh),
}));

vi.mock('@/app/actions/projects', () => ({
  browseDirectory: (path: string | undefined) => mockBrowseDirectory(path),
}));

vi.mock('@/app/actions/role-refinement', () => ({
  analyzeFailedTask: vi.fn(async () => ({ success: true })),
  applyRefinementAction: vi.fn(async () => ({ success: true })),
  applyAndRetryRefinementAction: vi.fn(async () => ({ success: true })),
  dismissRefinementAction: vi.fn(async () => ({ success: true })),
  revertRefinementAction: vi.fn(async () => ({ success: true })),
}));

vi.mock('@/app/actions/roles', () => ({
  saveRole: (filename: string, content: string) => mockSaveRole(filename, content),
  resetRole: (filename: string) => mockResetRole(filename),
}));

vi.mock('@/app/actions/tasks', () => ({
  createTask: (formData: FormData) => mockCreateTask(formData),
  moveTask: (id: string, phase: string) => mockMoveTask(id, phase),
  bulkDeleteTasks: (ids: string[]) => mockBulkDeleteTasks(ids),
  approveTask: (id: string, strategy: 'local-merge' | 'pull-request') =>
    mockApproveTask(id, strategy),
  rejectTask: (id: string, feedback: string) => mockRejectTask(id, feedback),
  markTaskDone: (id: string) => mockMarkTaskDone(id),
  addDependency: (taskId: string, depId: string) => mockAddDependency(taskId, depId),
  removeDependency: (taskId: string, depId: string) => mockRemoveDependency(taskId, depId),
  addBlock: (taskId: string, blockedId: string) => mockAddBlock(taskId, blockedId),
  removeBlock: (taskId: string, blockedId: string) => mockRemoveBlock(taskId, blockedId),
  deleteTask: (id: string) => mockDeleteTask(id),
  retryTask: (id: string) => mockRetryTask(id),
  restartCurrentPhase: (id: string) => mockRestartCurrentPhase(id),
}));

vi.mock('@/app/actions/auto-mode', () => ({
  markAutoReviewed: (id: string) => mockMarkAutoReviewed(id),
}));

vi.mock('@/app/actions/insights', () => ({
  getOrCreateInsightsSession: () => mockGetOrCreateInsightsSession(),
  sendInsightsMessage: (id: string, msg: string) => mockSendInsightsMessage(id, msg),
  cancelInsightsSession: () => mockCancelInsightsSession(),
}));

vi.mock('@/hooks/use-server-mutation', () => ({
  useServerMutation: () => ({ run: vi.fn(), isPending: false }),
}));

vi.mock('@/hooks/use-phase-sync', () => ({
  usePhaseSync: () => {},
}));

vi.mock('@/hooks/use-session-stream', () => ({
  useSessionStream: () => [],
}));

vi.mock('@/hooks/use-rate-limit-auto-resume', () => ({
  useRateLimitAutoResume: () => ({
    rateLimited: false,
    rateLimitMessage: '',
    autoResumeAt: null,
    countdown: 0,
    resetRateLimit: vi.fn(),
    handleCancelAutoResume: vi.fn(),
  }),
}));

vi.mock('@/hooks/use-stream-progress', () => ({
  useStreamProgress: () => '',
}));

vi.mock('@/hooks/use-streaming-state', () => ({
  useStreamingState: () => ({ running: false, setRunning: vi.fn() }),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

vi.mock('next/link', () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));

// ── Imports (after mocks) ─────────────────────────────────────────────────

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

import { PipelineConfigEditor } from '@/components/pipeline-config';
import { ProviderConfigEditor } from '@/components/provider-config';
import { RoleEditor } from '@/components/role-editor';
import { DirectoryBrowser } from '@/components/directory-browser';
import { KanbanBoard } from '@/components/kanban-board';
import { InsightsChat } from '@/components/insights-chat';
import { ReviewPanel } from '@/components/review-panel';
import { TaskDetail } from '@/components/task-detail';
import type { Task } from '@/lib/task-store';

// ── Helpers ────────────────────────────────────────────────────────────────

function assertNoAlert() {
  expect(
    screen.queryByRole('alert'),
    'role="alert" must NOT be rendered when no action has thrown',
  ).toBeNull();
}

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 't-1',
    title: 'Sample task',
    description: '',
    phase: 'backlog',
    source: null,
    prUrl: null,
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
    ...overrides,
  } as Task;
}

const ALL_SUCCESS_OBJ = () => ({ success: true });

// ── Tests ──────────────────────────────────────────────────────────────────

describe('alert-banner absence contract', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // pipeline-config
    mockSavePipelineConfig.mockResolvedValue(undefined);
    // provider-config
    mockSaveProvidersConfig.mockResolvedValue(undefined);
    mockGetAvailableModels.mockResolvedValue({ models: [], error: undefined });
    // directory-browser
    mockBrowseDirectory.mockResolvedValue({ path: '/initial', parent: null, entries: [] });
    // role-editor
    mockSaveRole.mockResolvedValue(undefined);
    mockResetRole.mockResolvedValue('');
    // kanban-board / review-panel / task-detail
    mockCreateTask.mockResolvedValue(undefined);
    mockMoveTask.mockResolvedValue(undefined);
    mockBulkDeleteTasks.mockResolvedValue(undefined);
    mockApproveTask.mockResolvedValue(undefined);
    mockRejectTask.mockResolvedValue(undefined);
    mockMarkTaskDone.mockResolvedValue(undefined);
    mockAddDependency.mockResolvedValue(undefined);
    mockRemoveDependency.mockResolvedValue(undefined);
    mockAddBlock.mockResolvedValue(undefined);
    mockRemoveBlock.mockResolvedValue(undefined);
    mockDeleteTask.mockResolvedValue(undefined);
    mockRetryTask.mockResolvedValue(ALL_SUCCESS_OBJ());
    mockRestartCurrentPhase.mockResolvedValue(ALL_SUCCESS_OBJ());
    mockMarkAutoReviewed.mockResolvedValue(undefined);
    // insights-chat
    mockGetOrCreateInsightsSession.mockResolvedValue('session-1');
    mockSendInsightsMessage.mockResolvedValue(undefined);
    mockCancelInsightsSession.mockResolvedValue(undefined);
  });

  // ── pipeline-config ────────────────────────────────────────────────────

  it('pipeline-config: no role="alert" on initial render', () => {
    render(
      <PipelineConfigEditor
        config={{ maxQaAttempts: 3, parallelSubtasks: true, autoModeMaxParallel: 1, idleStallMinutes: 15, toolStallMinutes: 30, recordHistoryInGit: true, includePhasesTrailer: true }}
      />,
    );
    assertNoAlert();
  });

  // ── provider-config ───────────────────────────────────────────────────
  // Note: provider-config uses a sub-component (ModelRow) that maintains
  // its own `fetchError` state — not a `role='alert'` banner. The
  // tests cover the contract that the top-level error banner (from
  // handleSave) is absent until handleSave throws.

  it('provider-config: no role="alert" on initial render (handleSave not invoked)', () => {
    render(
      <ProviderConfigEditor
        config={{
          default: { model: 'sonnet', provider: 'anthropic' },
          roles: {},
        }}
      />,
    );
    assertNoAlert();
  });

  // ── role-editor ───────────────────────────────────────────────────────

  it('role-editor: no role="alert" on initial render with editor closed', () => {
    render(
      <RoleEditor role={{ name: 'analyst', filename: 'analyst.md', content: 'you are an analyst.' }} />,
    );
    assertNoAlert();
  });

  it('role-editor: no role="alert" after opening the editor (handleSave/handleReset not invoked)', async () => {
    render(
      <RoleEditor role={{ name: 'analyst', filename: 'analyst.md', content: 'you are an analyst.' }} />,
    );
    await act(async () => {
      // The only top-level button when closed is the collapse header → getByRole.
      // Avoid getByText(/analyst/) which matches both the role-name span AND
      // the filename span ("analyst.md" contains the substring "analyst").
      screen.getByRole('button').click();
    });
    assertNoAlert();
  });

  // ── directory-browser ────────────────────────────────────────────────

  it('directory-browser: no role="alert" on initial render (after mount fetch succeeds)', async () => {
    render(<DirectoryBrowser onSelect={() => {}} onClose={() => {}} />);
    // mount useEffect calls navigate(undefined) → browseDirectory resolves.
    await act(async () => { await new Promise(r => setTimeout(r, 0)); });
    assertNoAlert();
  });

  // ── kanban-board ─────────────────────────────────────────────────────

  it('kanban-board: no role="alert" on initial render (no tasks, no actions invoked)', () => {
    render(<KanbanBoard tasks={[]} projectPath="/test/project" />);
    assertNoAlert();
  });

  it('kanban-board: no role="alert" with tasks present (still no actions invoked)', () => {
    render(
      <KanbanBoard
        tasks={[makeTask({ id: 't-1', phase: 'backlog', title: 'Task 1' })]}
        projectPath="/test/project"
      />,
    );
    assertNoAlert();
  });

  // ── insights-chat ────────────────────────────────────────────────────

  it('insights-chat: no role="alert" on initial render (mount reconnect succeeds)', async () => {
    render(<InsightsChat />);
    // Mount useEffect calls reconnect('start chat session') → mocked to resolve.
    await act(async () => { await new Promise(r => setTimeout(r, 0)); });
    assertNoAlert();
  });

  // ── review-panel ─────────────────────────────────────────────────────

  it('review-panel: no role="alert" on initial render (no actions invoked yet)', () => {
    render(
      <ReviewPanel
        taskId="t-1"
        spec={null}
        qaReport={{ overall: 'PASS' }}
        humanFeedback={null}
        diff={null}
        prUrl={null}
        phase="awaiting-review"
      />,
    );
    assertNoAlert();
  });

  // ── task-detail ──────────────────────────────────────────────────────
  // Render with phase='backlog' so the inner ReviewPanel is NOT rendered
  // (it's conditional on awaiting-review/pr-open). The outer error
  // banner from TaskDetail's handlers stays absent until a handler throws.

  it('task-detail: no role="alert" on initial render (overview tab, no actions invoked)', () => {
    const task = makeTask({ phase: 'backlog' });
    render(
      <TaskDetail
        task={task}
        allTasks={[task]}
        dependencies={[]}
        dependents={[]}
        spec={null}
        plan={null}
        qaReport={null}
        humanFeedback={null}
        diff={null}
      />,
    );
    assertNoAlert();
  });

  it('task-detail: no role="alert" with plan + diff present (still no actions invoked)', () => {
    const task = makeTask({ phase: 'implement' });
    render(
      <TaskDetail
        task={task}
        allTasks={[task]}
        dependencies={[]}
        dependents={[]}
        spec="Spec body"
        plan={{ subtasks: [], _format: 'teamai/plan@v1' } as never}
        qaReport={null}
        humanFeedback={null}
        diff="+ added a line\n- removed a line"
      />,
    );
    assertNoAlert();
  });

  // In awaiting-review phase, TaskDetail mounts the nested <ReviewPanel>.
  // This locks in the absence contract for BOTH the outer task-detail
  // banner AND the nested review-panel banner — two role='alert' surfaces
  // reachable from one DOM tree.
  it('task-detail: no role="alert" in awaiting-review phase (nested ReviewPanel also clean)', () => {
    const task = makeTask({ phase: 'awaiting-review' });
    render(
      <TaskDetail
        task={task}
        allTasks={[task]}
        dependencies={[]}
        dependents={[]}
        spec={null}
        plan={null}
        qaReport={{ overall: 'PASS' }}
        humanFeedback={null}
        diff={null}
      />,
    );
    assertNoAlert();
  });
});
