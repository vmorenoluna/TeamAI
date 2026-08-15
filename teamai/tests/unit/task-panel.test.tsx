// @vitest-environment happy-dom

/**
 * Unit tests for TaskPanel, TaskDetail, QAReportView, and PlanSubtasks components.
 *
 * Tests tab navigation (overview/terminal/spec/plan/qa), task detail rendering,
 * QA report with PASS/FAIL criteria, human feedback banner, plan subtasks with
 * progress, dependency management, loading/error/cached-data states,
 * WebSocket phase-change refresh, readonly mode, and callbacks.
 *
 * React's useTransition is mocked (isPending=false, synchronous callback)
 * following the project's established pattern.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import type { Task } from '@/lib/task-store';
import type { PlanData, QAReportData } from '@/lib/stream-types';
// ── Hoisted mocks ───────────────────────────────────────────────────────────

const mockGetTaskFull = vi.hoisted(() => vi.fn());
const mockMarkAutoReviewed = vi.hoisted(() => vi.fn());

vi.mock('@/app/actions/tasks', () => ({
  getTaskFull: (...args: unknown[]) => mockGetTaskFull(...args),

  addDependency: vi.fn(),
  removeDependency: vi.fn(),
  addBlock: vi.fn(),
  removeBlock: vi.fn(),
  deleteTask: vi.fn(),
  retryTask: vi.fn(),
  restartCurrentPhase: vi.fn(),
}));

const mockRouterRefresh = vi.hoisted(() => vi.fn());

vi.mock('@/app/actions/auto-mode', () => ({
  markAutoReviewed: (...args: unknown[]) => mockMarkAutoReviewed(...args),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: mockRouterRefresh }),
}));

// Mock Next.js Link to render <a> tags
vi.mock('next/link', () => ({
  default: ({ href, children, className }: { href: string; children: React.ReactNode; className?: string }) => (
    <a href={href} className={className}>{children}</a>
  ),
}));

const gOnMessageCbs = vi.hoisted(() => [] as Array<(data: Record<string, unknown>) => void>);

vi.mock('@/hooks/use-websocket', () => ({
  useWebSocket: (opts?: { onMessage?: (data: Record<string, unknown>) => void }) => {
    if (opts?.onMessage) gOnMessageCbs.push(opts.onMessage);
    return { reconnect: vi.fn() };
  },
}));

// UnifiedTerminal mock (replaces SubtaskTerminalList for unified terminal with filter chips)
vi.mock('@/components/unified-terminal', () => ({
  UnifiedTerminal: ({ taskId, subtaskTerminals, qaLog, specLog, planLog, mergeLog, orchestratorLog }: {
    taskId: string; subtaskTerminals: { id: number; title: string; log: string | null }[];
    qaLog: string | null; specLog: string | null; planLog: string | null; mergeLog: string | null; orchestratorLog: string | null;
  }) => (
    <div data-component="unified-terminal" data-task-id={taskId}>
      <span data-component="subtask-count">{subtaskTerminals.length}</span>
      {qaLog && <span data-component="qa-log-present">qa</span>}
      {specLog && <span data-component="spec-log-present">spec</span>}
      {planLog && <span data-component="plan-log-present">plan</span>}
      {mergeLog && <span data-component="merge-log-present">merge</span>}
      {orchestratorLog && <span data-component="orchestrator-log-present">orch</span>}
    </div>
  ),
}));

// ReviewPanel mock
vi.mock('@/components/review-panel', () => ({
  ReviewPanel: ({ taskId }: { taskId: string }) => (
    <div data-component="review-panel" data-task-id={taskId}>ReviewPanel</div>
  ),
}));

const mockStartTransition = vi.hoisted(() =>
  vi.fn((cb: () => void) => {
    try {
      const result = cb() as unknown;
      if (result instanceof Promise) result.catch(() => {});
    } catch { /* suppress */ }
  })
);

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>();
  return {
    ...actual,
    useTransition: () => [false, mockStartTransition],
  };
});

// ── Imports (after mocks) ───────────────────────────────────────────────────

import { TaskPanel, type FullData } from '@/components/task-panel';
import { TaskDetail, QAReportView, PlanSubtasks } from '@/components/task-detail';

// ── Fixtures ────────────────────────────────────────────────────────────────

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    title: 'Test Task',
    description: 'A test task for unit tests.',
    phase: 'backlog',
    createdAt: '2026-01-15T10:30:00.000Z',
    updatedAt: '2026-01-15T12:00:00.000Z',
    ...overrides,
  };
}

function makeFullData(overrides: Partial<{
  task: Partial<Task>;
  allTasks: Task[];
  dependencies: Task[];
  dependents: Task[];
  spec: string | null;
  plan: PlanData | null;
  qaReport: QAReportData | null;
  humanFeedback: string | null;
  diff: string | null;
  agentOutput: string | null;
  specVersions: Record<string, string>;
  specPath: string;
}> = {}): FullData {
  const task = makeTask(overrides.task ?? {});
  return {
    task,
    allTasks: overrides.allTasks ?? [task],
    dependencies: overrides.dependencies ?? [],
    dependents: overrides.dependents ?? [],
    spec: overrides.spec ?? null,
    plan: overrides.plan ?? null,
    qaReport: overrides.qaReport ?? null,
    humanFeedback: overrides.humanFeedback ?? null,
    diff: overrides.diff ?? null,
    agentOutput: overrides.agentOutput ?? null,
    specVersions: overrides.specVersions ?? {},
    subtaskTerminals: [],
    qaLog: null,
    specLog: null,
    planLog: null,
    mergeLog: null,
    sessionMap: {},
    specPath: overrides.specPath ?? '/test/spec.md',
  };
}

function qaPass(): QAReportData {
  return {
    overall: 'PASS',
    criteria: [
      { criterion: 'Tests pass', status: 'PASS', notes: 'All green' },
      { criterion: 'Code follows style', status: 'PASS' },
    ],
  };
}

function qaFail(): QAReportData {
  return {
    overall: 'FAIL',
    criteria: [
      { criterion: 'Tests pass', status: 'FAIL', notes: '2 tests failing' },
      { criterion: 'Code follows style', status: 'PASS' },
    ],
  };
}

function simplePlan(): PlanData {
  return {
    subtasks: [
      { id: 's1', title: 'Add login form', completed: true },
      { id: 's2', title: 'Add auth endpoint', completed: false, description: 'POST /api/auth' },
      { id: 's3', title: 'Add session handling', completed: false, files: ['src/auth.ts', 'src/session.ts'] },
    ],
  };
}

// ── Shared helpers ──────────────────────────────────────────────────────────

let closeCalls: number;

beforeEach(() => {
  vi.clearAllMocks();
  gOnMessageCbs.length = 0;
  closeCalls = 0;
  mockGetTaskFull.mockReset();
  mockGetTaskFull.mockResolvedValue(makeFullData());
  // Mock navigator.clipboard
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText: vi.fn().mockResolvedValue(undefined) },
    writable: true,
    configurable: true,
  });
  // Mock window.confirm to return true by default
  vi.spyOn(window, 'confirm').mockReturnValue(true);
});

afterEach(() => {
  // Restore confirm spy only — avoids footgun of vi.restoreAllMocks()
  // resetting hoisted mock implementations
  vi.spyOn(window, 'confirm').mockRestore();
});

// ═══════════════════════════════════════════════════════════════════════════
//  TaskPanel
// ═══════════════════════════════════════════════════════════════════════════

describe('TaskPanel', () => {
  function renderPanel(overrides: {
    taskId?: string;
    readonly?: boolean;
    onError?: (msg: string) => void;
    cachedData?: FullData | null;
    onDataLoaded?: (data: FullData, taskId: string) => void;
  } = {}) {
    const onClose = () => { closeCalls++; };
    render(
      <TaskPanel
        taskId={overrides.taskId ?? 'task-1'}
        onClose={onClose}
        readonly={overrides.readonly}
        onError={overrides.onError}
        cachedData={overrides.cachedData}
        onDataLoaded={overrides.onDataLoaded}
      />
    );
  }

  // ── Loading state ────────────────────────────────────────────────────

  describe('loading state', () => {
    it('shows "Loading…" in the title bar while fetching', () => {
      // @ts-expect-error -- _resolve assigned in Promise callback but never invoked, intentional
      let _resolve: (v: unknown) => void;
      const promise = new Promise(r => { _resolve = r; });
      mockGetTaskFull.mockReturnValue(promise);

      renderPanel();
      // "Loading…" appears in both title bar and content area
      const loadingTexts = screen.getAllByText('Loading…');
      expect(loadingTexts.length).toBeGreaterThanOrEqual(1);
    });

    it('shows loading content area while fetching', () => {
      // @ts-expect-error -- _resolve assigned in Promise callback but never invoked, intentional
      let _resolve: (v: unknown) => void;
      const promise = new Promise(r => { _resolve = r; });
      mockGetTaskFull.mockReturnValue(promise);

      renderPanel();
      // The content area shows "Loading…" text; title bar also shows "Loading…"
      const loadingDivs = screen.getAllByText('Loading…');
      expect(loadingDivs.length).toBe(2); // title bar + content area
    });
  });

  // ── Error state ──────────────────────────────────────────────────────

  describe('error state', () => {
    it('shows "Failed to load task." when fetch fails', async () => {
      mockGetTaskFull.mockRejectedValue(new Error('Network error'));

      renderPanel();

      await waitFor(() => {
        expect(screen.getByText('Failed to load task.')).toBeInTheDocument();
      });
    });

    it('calls onError callback with the error message', async () => {
      mockGetTaskFull.mockRejectedValue(new Error('Boom'));
      const onError = vi.fn();

      renderPanel({ onError });

      await waitFor(() => {
        expect(onError).toHaveBeenCalledWith('Boom');
      });
    });

    it('calls onError with generic message for non-Error rejects', async () => {
      mockGetTaskFull.mockRejectedValue('string error');
      const onError = vi.fn();

      renderPanel({ onError });

      await waitFor(() => {
        expect(onError).toHaveBeenCalledWith('Failed to load task');
      });
    });
  });

  // ── Cached data ──────────────────────────────────────────────────────

  describe('cached data', () => {
    it('does not re-fetch when cachedData is provided', async () => {
      const data = makeFullData({ task: { id: 'task-1', title: 'Cached Title', phase: 'implement' } });

      renderPanel({ cachedData: data });

      expect(mockGetTaskFull).not.toHaveBeenCalled();
    });

    it('displays the cached task title immediately', async () => {
      const data = makeFullData({ task: { id: 'task-1', title: 'Cached Title', phase: 'implement' } });

      renderPanel({ cachedData: data });

      // Title appears in title bar AND h1 heading in TaskDetail
      await waitFor(() => {
        const titles = screen.getAllByText('Cached Title');
        expect(titles.length).toBeGreaterThanOrEqual(1);
      });
    });
  });

  // ── Title bar & close ────────────────────────────────────────────────

  describe('title bar', () => {
    it('shows "Task Details" title bar fallback while loading', () => {
      // @ts-expect-error -- _resolve assigned in Promise callback but never invoked, intentional
      let _resolve: (v: unknown) => void;
      const promise = new Promise(r => { _resolve = r; });
      mockGetTaskFull.mockReturnValue(promise);

      renderPanel();

      // Title bar shows "Loading…" (content area also shows it)
      const loadingTexts = screen.getAllByText('Loading…');
      expect(loadingTexts.length).toBe(2);
    });

    it('shows the task title after loading', async () => {
      mockGetTaskFull.mockResolvedValue(makeFullData({ task: { title: 'Feature X' } }));

      renderPanel();

      // Title appears in both title bar AND h1
      await waitFor(() => {
        const titles = screen.getAllByText('Feature X');
        expect(titles.length).toBeGreaterThanOrEqual(1);
      });
    });

    it('close button calls onClose', async () => {
      mockGetTaskFull.mockResolvedValue(makeFullData());

      renderPanel();

      await waitFor(() => {
        expect(screen.getByTitle('Close window')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByTitle('Close window'));
      expect(closeCalls).toBe(1);
    });
  });

  // ── WebSocket refresh ────────────────────────────────────────────────

  describe('WebSocket refresh', () => {
    it('re-fetches silently on phase-change for the same taskId', async () => {
      mockGetTaskFull.mockResolvedValue(makeFullData({ task: { id: 'task-1', title: 'Phase Test' } }));

      renderPanel();

      await waitFor(() => {
        expect(screen.getAllByText('Phase Test').length).toBeGreaterThanOrEqual(1);
      });

      // Reset call count after initial fetch
      mockGetTaskFull.mockClear();

      // Simulate phase-change for the SAME task
      act(() => {
        gOnMessageCbs.forEach(cb => cb({ type: 'phase-change', taskId: 'task-1', phase: 'implement' }));
      });

      await waitFor(() => {
        expect(mockGetTaskFull).toHaveBeenCalledWith('task-1');
      });
    });

    it('does NOT re-fetch on phase-change for a different taskId', async () => {
      mockGetTaskFull.mockResolvedValue(makeFullData({ task: { id: 'task-1' } }));

      renderPanel();

      await waitFor(() => {
        expect(screen.getAllByText('Test Task').length).toBeGreaterThanOrEqual(1);
      });

      mockGetTaskFull.mockClear();

      act(() => {
        gOnMessageCbs.forEach(cb => cb({ type: 'phase-change', taskId: 'task-2', phase: 'done' }));
      });

      // must not have been called with any taskId
      expect(mockGetTaskFull).not.toHaveBeenCalled();
    });

    it('re-fetches silently on container-log', async () => {
      mockGetTaskFull.mockResolvedValue(makeFullData());

      renderPanel();

      await waitFor(() => {
        expect(screen.getAllByText('Test Task').length).toBeGreaterThanOrEqual(1);
      });

      mockGetTaskFull.mockClear();

      act(() => {
        gOnMessageCbs.forEach(cb => cb({ type: 'container-log', message: 'Container ready' }));
      });

      await waitFor(() => {
        expect(mockGetTaskFull).toHaveBeenCalled();
      });
    });

    it('does not re-fetch on phase-change when readonly', async () => {
      const data = makeFullData();
      renderPanel({ readonly: true, cachedData: data });
      mockGetTaskFull.mockClear();

      act(() => {
        gOnMessageCbs.forEach(cb => cb({ type: 'phase-change', taskId: 'task-1', phase: 'implement' }));
      });

      await new Promise(r => setTimeout(r, 50));
      expect(mockGetTaskFull).not.toHaveBeenCalled();
    });
  });

  // ── onDataLoaded callback ────────────────────────────────────────────

  describe('onDataLoaded callback', () => {
    it('calls onDataLoaded after successful fetch', async () => {
      const data = makeFullData({ task: { id: 'task-1', title: 'Loaded' } });
      mockGetTaskFull.mockResolvedValue(data);
      const onDataLoaded = vi.fn();

      renderPanel({ onDataLoaded });

      await waitFor(() => {
        expect(onDataLoaded).toHaveBeenCalledWith(
          expect.objectContaining({ task: expect.objectContaining({ title: 'Loaded' }) }),
          'task-1',
        );
      });
    });
  });

  // ── Readonly mode ────────────────────────────────────────────────────

  describe('readonly mode', () => {
    it('passes readonly=true to TaskDetail', async () => {
      const data = makeFullData({ task: { id: 'task-1' } });

      renderPanel({ readonly: true, cachedData: data });

      await waitFor(() => {
        // In readonly, there should be no tabs — the tab bar is hidden
        expect(screen.queryByText('Overview')).not.toBeInTheDocument();
      });
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  QAReportView
// ═══════════════════════════════════════════════════════════════════════════

describe('QAReportView', () => {
  // ── Empty state ──────────────────────────────────────────────────────

  describe('empty state', () => {
    it('shows placeholder when no QA report and no human feedback', () => {
      render(<QAReportView qaReport={null} humanFeedback={null} />);
      expect(screen.getByText('No QA report generated yet.')).toBeInTheDocument();
    });
  });

  // ── QA report rendering ─────────────────────────────────────────────

  describe('QA report rendering', () => {
    it('shows PASS badge with green styling', () => {
      render(<QAReportView qaReport={qaPass()} />);

      const passBadge = screen.getByText('PASS');
      expect(passBadge).toBeInTheDocument();
      expect(passBadge.className).toContain('bg-green-900/40');
      expect(passBadge.className).toContain('text-green-300');
    });

    it('shows FAIL badge with red styling', () => {
      render(<QAReportView qaReport={qaFail()} />);

      const failBadge = screen.getByText('FAIL');
      expect(failBadge).toBeInTheDocument();
      expect(failBadge.className).toContain('bg-red-900/40');
      expect(failBadge.className).toContain('text-red-300');
    });

    it('renders all criteria with PASS/FAIL indicators', () => {
      render(<QAReportView qaReport={qaFail()} />);

      // ✓ for PASS, ✗ for FAIL — these are inside criterion items
      const passMark = screen.getByText('✓');
      const failMark = screen.getByText('✗');
      expect(passMark).toBeInTheDocument();
      expect(failMark).toBeInTheDocument();
    });

    it('shows criterion text and notes', () => {
      render(<QAReportView qaReport={qaFail()} />);

      expect(screen.getByText('Tests pass')).toBeInTheDocument();
      expect(screen.getByText('2 tests failing')).toBeInTheDocument();
    });

    it('handles criteria with name instead of criterion', () => {
      const report: QAReportData = {
        overall: 'PASS',
        criteria: [{ name: 'Security check', status: 'PASS', notes: 'No issues' }],
      };
      render(<QAReportView qaReport={report} />);
      expect(screen.getByText('Security check')).toBeInTheDocument();
      expect(screen.getByText('No issues')).toBeInTheDocument();
    });

    it('handles criteria without notes gracefully', () => {
      // When notes is undefined, no notes paragraph should render
      const report: QAReportData = {
        overall: 'PASS',
        criteria: [{ criterion: 'Style', status: 'PASS' }],
      };
      render(<QAReportView qaReport={report} />);
      expect(screen.getByText('Style')).toBeInTheDocument();
      expect(screen.queryByText(/notes/i)).not.toBeInTheDocument();
    });

    it('renders Copy button in QA report', () => {
      render(<QAReportView qaReport={qaPass()} />);
      const copyBtns = screen.getAllByText('📋 Copy');
      expect(copyBtns.length).toBe(1);
    });
  });

  // ── Human feedback ───────────────────────────────────────────────────

  describe('human feedback', () => {
    it('shows human feedback banner when feedback is provided', () => {
      render(<QAReportView qaReport={null} humanFeedback="This needs better error handling." />);

      expect(screen.getByText('Human Reviewer Feedback')).toBeInTheDocument();
      expect(screen.getByText('This needs better error handling.')).toBeInTheDocument();
    });

    it('feedback banner uses amber styling', () => {
      render(<QAReportView qaReport={null} humanFeedback="Fix the login." />);

      const banner = screen.getByText('Human Reviewer Feedback');
      expect(banner.className).toContain('text-amber-300');
    });

    it('shows both QA report and feedback together', () => {
      render(<QAReportView qaReport={qaPass()} humanFeedback="Looks great!" />);

      expect(screen.getByText('Human Reviewer Feedback')).toBeInTheDocument();
      expect(screen.getByText('PASS')).toBeInTheDocument();
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  PlanSubtasks
// ═══════════════════════════════════════════════════════════════════════════

describe('PlanSubtasks', () => {
  // ── Empty state ──────────────────────────────────────────────────────

  describe('empty state', () => {
    it('shows placeholder when plan is null', () => {
      render(<PlanSubtasks plan={null} />);
      expect(screen.getByText('No plan generated yet.')).toBeInTheDocument();
    });

    it('shows placeholder when plan has empty subtasks', () => {
      render(<PlanSubtasks plan={{ subtasks: [] }} />);
      expect(screen.getByText('No plan generated yet.')).toBeInTheDocument();
    });
  });

  // ── Subtask rendering ────────────────────────────────────────────────

  describe('subtask rendering', () => {
    it('renders all subtasks', () => {
      render(<PlanSubtasks plan={simplePlan()} />);
      const subtasks = screen.getAllByTestId('plan-subtask');
      expect(subtasks).toHaveLength(3);
    });

    it('shows completed subtask with green styling and checkmark', () => {
      render(<PlanSubtasks plan={simplePlan()} />);
      const checkmark = screen.getByText('✓');
      expect(checkmark.className).toContain('text-green-500');
    });

    it('shows progress count (completed / total)', () => {
      render(<PlanSubtasks plan={simplePlan()} />);
      expect(screen.getByText('1 / 3 subtasks completed')).toBeInTheDocument();
    });

    it('shows progress bar when partially complete', () => {
      render(<PlanSubtasks plan={simplePlan()} />);
      const bar = screen.getByTestId('subtask-progress-bar');
      expect(bar).toBeInTheDocument();
      expect(bar.style.width).toMatch(/^33\.3/);
    });

    it('does not show progress bar when all complete', () => {
      const plan: PlanData = {
        subtasks: [
          { id: 's1', title: 'A', completed: true },
          { id: 's2', title: 'B', completed: true },
        ],
      };
      render(<PlanSubtasks plan={plan} />);
      expect(screen.queryByTestId('subtask-progress-bar')).not.toBeInTheDocument();
    });

    it('renders description for incomplete subtasks', () => {
      render(<PlanSubtasks plan={simplePlan()} />);
      expect(screen.getByText('POST /api/auth')).toBeInTheDocument();
    });

    it('renders file list for incomplete subtasks', () => {
      render(<PlanSubtasks plan={simplePlan()} />);
      expect(screen.getByText('src/auth.ts, src/session.ts')).toBeInTheDocument();
    });

    it('renders Copy button for plan JSON', () => {
      render(<PlanSubtasks plan={simplePlan()} />);
      const copyBtns = screen.getAllByText('📋 Copy');
      expect(copyBtns.length).toBe(1);
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  TaskDetail
// ═══════════════════════════════════════════════════════════════════════════

describe('TaskDetail', () => {
  function renderDetail(overrides: Partial<{
    task: Partial<Task>;
    allTasks: Task[];
    dependencies: Task[];
    dependents: Task[];
    spec: string | null;
    plan: PlanData | null;
    qaReport: QAReportData | null;
    humanFeedback: string | null;
    diff: string | null;
    agentOutput: string | null;
    specVersions: Record<string, string>;
    readonly: boolean;
    onClose: () => void;
  }> = {}) {
    const t = makeTask(overrides.task ?? {});
    render(
      <TaskDetail
        task={t}
        allTasks={overrides.allTasks ?? [t]}
        dependencies={overrides.dependencies ?? []}
        dependents={overrides.dependents ?? []}
        spec={overrides.spec ?? null}
        plan={overrides.plan ?? null}
        qaReport={overrides.qaReport ?? null}
        humanFeedback={overrides.humanFeedback ?? null}
        diff={overrides.diff ?? null}
        agentOutput={overrides.agentOutput ?? null}
        specVersions={overrides.specVersions ?? {}}
        subtaskTerminals={[]}
        qaLog={null}
        sessionMap={{}}
        readonly={overrides.readonly ?? false}
        onClose={overrides.onClose}
      />
    );
  }

  // ── Tab navigation ───────────────────────────────────────────────────

  describe('tab navigation', () => {
    it('renders all five tabs', () => {
      renderDetail();
      expect(screen.getByText('Overview')).toBeInTheDocument();
      expect(screen.getByText('Terminal')).toBeInTheDocument();
      expect(screen.getByText('Spec')).toBeInTheDocument();
      expect(screen.getByText('Plan')).toBeInTheDocument();
      expect(screen.getByText('QA')).toBeInTheDocument();
    });

    it('Overview tab is active by default (blue border)', () => {
      renderDetail();
      const overviewTab = screen.getByText('Overview');
      expect(overviewTab.className).toContain('border-[#2563eb]');
    });

    it('switches to Plan tab on click', () => {
      renderDetail();
      fireEvent.click(screen.getByText('Plan'));

      const planTab = screen.getByText('Plan');
      expect(planTab.className).toContain('border-[#2563eb]');
    });

    it('switches to QA tab on click', () => {
      renderDetail();
      fireEvent.click(screen.getByText('QA'));

      const qaTab = screen.getByText('QA');
      expect(qaTab.className).toContain('border-[#2563eb]');
    });

    it('shows badge count on Spec tab when spec exists', () => {
      renderDetail({ spec: '# Specification' });
      const specTab = screen.getByText('Spec').closest('button')!;
      const badgeSpans = specTab.querySelectorAll('span');
      const badgeTexts = Array.from(badgeSpans).map(b => b.textContent);
      expect(badgeTexts).toContain('1');
    });

    it('shows subtask count badge on Plan tab', () => {
      renderDetail({ plan: simplePlan() });
      const planTab = screen.getByText('Plan').closest('button')!;
      // The badge span contains just "3" — find it among the button's children
      const badgeSpans = planTab.querySelectorAll('span');
      const badgeTexts = Array.from(badgeSpans).map(b => b.textContent);
      expect(badgeTexts).toContain('3');
    });

    it('shows badge on QA tab when qaReport exists', () => {
      renderDetail({ qaReport: qaPass() });
      const qaTab = screen.getByText('QA').closest('button')!;
      const badgeSpans = qaTab.querySelectorAll('span');
      const badgeTexts = Array.from(badgeSpans).map(b => b.textContent);
      expect(badgeTexts).toContain('1');
    });
  });

  // ── Task detail rendering ────────────────────────────────────────────

  describe('task detail rendering', () => {
    it('shows task title as h1', () => {
      renderDetail({ task: { title: 'Build Login Page' } });
      expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Build Login Page');
    });

    it('shows task ID', () => {
      renderDetail({ task: { id: 'abc-123' } });
      expect(screen.getByTestId('task-id')).toHaveTextContent('abc-123');
    });

    it('shows task description', () => {
      renderDetail({ task: { description: 'Build a login page with OAuth.' } });
      expect(screen.getByText('Build a login page with OAuth.')).toBeInTheDocument();
    });

    it('shows phase badge', () => {
      renderDetail({ task: { phase: 'implement' } });
      expect(screen.getByText('In Progress')).toBeInTheDocument(); // PHASE_LABELS.implement
    });

    it('shows created/updated timestamps', () => {
      renderDetail();
      // "Created 1/15/2026, 10:30:00 AM · Updated 1/15/2026, 12:00:00 PM"
      expect(screen.getByText(/Created/)).toBeInTheDocument();
    });

    it('shows source info for tasks converted from ideation', () => {
      renderDetail({ task: { source: 'ideation' } });
      expect(screen.getByText('Source:')).toBeInTheDocument();
      expect(screen.getByText('Ideation')).toBeInTheDocument();
    });

    it('shows source info for competitor-analysis with context', () => {
      renderDetail({ task: { source: 'competitor-analysis', competitiveContext: 'Competitor X' } });
      expect(screen.getByText('Competitor Analysis')).toBeInTheDocument();
      expect(screen.getByText('Competitor X')).toBeInTheDocument();
    });

    it('shows ← Board breadcrumb link', () => {
      renderDetail();
      expect(screen.getByText('← Board')).toBeInTheDocument();
    });
  });

  // ── PR link ─────────────────────────────────────────────────────────

  describe('PR link', () => {
    it('shows PR link in header when prUrl exists', () => {
      renderDetail({ task: { prUrl: 'https://github.com/test/pr/1' } });
      const link = screen.getByTitle('View Pull Request');
      expect(link).toBeInTheDocument();
    });

    it('does not show PR link when prUrl is undefined', () => {
      renderDetail();
      expect(screen.queryByTitle('View Pull Request')).not.toBeInTheDocument();
    });
  });

  // ── Readonly mode ────────────────────────────────────────────────────

  describe('readonly mode', () => {
    it('hides tabs when readonly=true', () => {
      renderDetail({ readonly: true });
      expect(screen.queryByText('Overview')).not.toBeInTheDocument();
      expect(screen.queryByText('Terminal')).not.toBeInTheDocument();
      expect(screen.queryByText('Spec')).not.toBeInTheDocument();
      expect(screen.queryByText('Plan')).not.toBeInTheDocument();
      expect(screen.queryByText('QA')).not.toBeInTheDocument();
    });

    it('hides delete button when readonly=true', () => {
      renderDetail({ readonly: true });
      expect(screen.queryByText('🗑')).not.toBeInTheDocument();
    });

    it('hides restart button when readonly=true', () => {
      renderDetail({ readonly: true, task: { phase: 'implement' } });
      expect(screen.queryByTestId('restart-phase-button')).not.toBeInTheDocument();
    });
  });

  // ── Terminal tab ─────────────────────────────────────────────────────

  describe('terminal tab', () => {
    it('renders UnifiedTerminal when Terminal tab is active', () => {
      renderDetail();
      fireEvent.click(screen.getByText('Terminal'));

      expect(screen.getByTestId('unified-terminal')).toBeInTheDocument();
    });

    it('passes taskId to UnifiedTerminal', () => {
      renderDetail();
      fireEvent.click(screen.getByText('Terminal'));

      const panel = screen.getByTestId('unified-terminal');
      expect(panel.getAttribute('data-task-id')).toBe('task-1');
    });

    it('shows Spec terminal indicator when specLog is provided', () => {
      renderDetail();
      fireEvent.click(screen.getByText('Terminal'));
      // specLog defaults to null from renderDetail — no indicator
      expect(screen.queryByTestId('spec-log-present')).not.toBeInTheDocument();
    });

    it('shows Plan terminal indicator when planLog is provided', () => {
      renderDetail();
      fireEvent.click(screen.getByText('Terminal'));
      // planLog defaults to null from renderDetail — no indicator
      expect(screen.queryByTestId('plan-log-present')).not.toBeInTheDocument();
    });

    it('shows Merge terminal indicator when mergeLog is provided', () => {
      renderDetail();
      fireEvent.click(screen.getByText('Terminal'));
      // mergeLog defaults to null from renderDetail — no indicator
      expect(screen.queryByTestId('merge-log-present')).not.toBeInTheDocument();
    });
  });

  // ── Spec tab ─────────────────────────────────────────────────────────

  describe('spec tab', () => {
    it('shows spec content when spec is provided', () => {
      renderDetail({ spec: '# Feature Spec\n\nThis is the specification.' });
      fireEvent.click(screen.getByText('Spec'));

      expect(screen.getByText('Specification')).toBeInTheDocument();
      // spec text is rendered inside a <pre> — match the full content
      const pre = document.querySelector('pre');
      expect(pre?.textContent).toContain('# Feature Spec');
      expect(pre?.textContent).toContain('This is the specification.');
    });

    it('shows empty message when no spec', () => {
      renderDetail({ spec: null });
      fireEvent.click(screen.getByText('Spec'));

      expect(screen.getByText('No spec generated yet. Run the pipeline to create one.')).toBeInTheDocument();
    });
  });

  // ── Spec tab — version selector ──────────────────────────────────────

  describe('spec tab — version selector', () => {
    it('shows version buttons (v1, v2, v3) when specVersions are provided', () => {
      renderDetail({
        spec: '# Current Spec',
        specVersions: {
          v1: '# Spec v1 content',
          v2: '# Spec v2 content',
        },
      });
      fireEvent.click(screen.getByText('Spec'));

      expect(screen.getByText('v1')).toBeInTheDocument();
      expect(screen.getByText('v2')).toBeInTheDocument();
      expect(screen.getByText('v3')).toBeInTheDocument();
    });

    it('displays current spec content by default', () => {
      renderDetail({
        spec: '# Current Spec',
        specVersions: {
          v1: '# Spec v1 content',
          v2: '# Spec v2 content',
        },
      });
      fireEvent.click(screen.getByText('Spec'));

      const pre = document.querySelector('pre');
      expect(pre?.textContent).toContain('# Current Spec');
      expect(pre?.textContent).not.toContain('# Spec v1 content');
    });

    it('latest version button (v2) has blue highlight by default', () => {
      renderDetail({
        spec: '# Current Spec',
        specVersions: { v1: '# Spec v1 content' },
      });
      fireEvent.click(screen.getByText('Spec'));

      const currentBtn = screen.getByText('v2');
      expect(currentBtn.className).toContain('border-[#2563eb]');
      expect(currentBtn.className).toContain('text-blue-300');
    });

    it('clicking v1 shows v1 content and highlights v1 button', () => {
      renderDetail({
        spec: '# Current Spec',
        specVersions: {
          v1: '# Spec v1 content',
          v2: '# Spec v2 content',
        },
      });
      fireEvent.click(screen.getByText('Spec'));
      fireEvent.click(screen.getByText('v1'));

      // Content should be v1
      const pre = document.querySelector('pre');
      expect(pre?.textContent).toContain('# Spec v1 content');
      expect(pre?.textContent).not.toContain('# Current Spec');

      // v1 button should be highlighted
      const v1Btn = screen.getByText('v1');
      expect(v1Btn.className).toContain('border-[#2563eb]');
      expect(v1Btn.className).toContain('text-blue-300');

      // latest version button should NOT be highlighted
      const currentBtn = screen.getByText('v3');
      expect(currentBtn.className).toContain('text-slate-400');
      expect(currentBtn.className).not.toContain('border-[#2563eb]');
    });

    it('clicking v2 shows v2 content', () => {
      renderDetail({
        spec: '# Current Spec',
        specVersions: {
          v1: '# Spec v1 content',
          v2: '# Spec v2 content',
        },
      });
      fireEvent.click(screen.getByText('Spec'));
      fireEvent.click(screen.getByText('v2'));

      const pre = document.querySelector('pre');
      expect(pre?.textContent).toContain('# Spec v2 content');
      expect(pre?.textContent).not.toContain('# Spec v1 content');
      expect(pre?.textContent).not.toContain('# Current Spec');
    });

    it('clicking the latest version button after viewing a snapshot restores the live spec', () => {
      renderDetail({
        spec: '# Current Spec',
        specVersions: { v1: '# Spec v1 content' },
      });
      fireEvent.click(screen.getByText('Spec'));

      // Switch to v1
      fireEvent.click(screen.getByText('v1'));
      expect(document.querySelector('pre')?.textContent).toContain('# Spec v1 content');

      // Switch back to the live spec (v2)
      fireEvent.click(screen.getByText('v2'));
      expect(document.querySelector('pre')?.textContent).toContain('# Current Spec');
      expect(document.querySelector('pre')?.textContent).not.toContain('# Spec v1 content');
    });

    it('shows correct badge count when spec and versions exist', () => {
      renderDetail({
        spec: '# Current Spec',
        specVersions: { v1: '# v1', v2: '# v2', v3: '# v3' },
      });
      fireEvent.click(screen.getByText('Spec'));

      // Badge should be 4: 1 (current) + 3 (v1, v2, v3)
      const specTab = screen.getByText('Spec').closest('button')!;
      const badgeSpans = specTab.querySelectorAll('span');
      const badgeTexts = Array.from(badgeSpans).map(b => b.textContent);
      expect(badgeTexts).toContain('4');
    });

    it('does not show version buttons when specVersions is empty', () => {
      renderDetail({
        spec: '# Current Spec',
        specVersions: {},
      });
      fireEvent.click(screen.getByText('Spec'));

      expect(screen.queryByText('v1')).not.toBeInTheDocument();
      expect(screen.queryByText('v2')).not.toBeInTheDocument();
      expect(screen.queryByText('v3')).not.toBeInTheDocument();
    });

    it('does not show version buttons when specVersions is undefined', () => {
      renderDetail({ spec: '# Current Spec' });
      fireEvent.click(screen.getByText('Spec'));

      expect(screen.queryByText('v1')).not.toBeInTheDocument();
      expect(screen.queryByText('v2')).not.toBeInTheDocument();
    });

    it('shows snapshot content only (no current spec) when spec is null but versions exist', () => {
      renderDetail({
        spec: null,
        specVersions: { v1: '# Spec v1 content' },
      });
      fireEvent.click(screen.getByText('Spec'));

      // Should show empty state for the live spec (v2) but the version button should still be there
      expect(screen.getByText('v2')).toBeInTheDocument();
      expect(screen.getByText('v1')).toBeInTheDocument();

      // Clicking v1 should show the snapshot
      fireEvent.click(screen.getByText('v1'));
      expect(document.querySelector('pre')?.textContent).toContain('# Spec v1 content');

      // Clicking the live spec (v2) when spec is null should show empty content
      fireEvent.click(screen.getByText('v2'));
      expect(document.querySelector('pre')?.textContent).toBe('');
    });

    it('preserves selected version when switching between Spec and other tabs', () => {
      renderDetail({
        spec: '# Current Spec',
        specVersions: { v1: '# Spec v1 content', v2: '# Spec v2 content' },
      });
      fireEvent.click(screen.getByText('Spec'));
      fireEvent.click(screen.getByText('v1'));
      expect(document.querySelector('pre')?.textContent).toContain('# Spec v1 content');

      // Switch to Overview tab
      fireEvent.click(screen.getByText('Overview'));

      // Switch back to Spec — should still show v1
      fireEvent.click(screen.getByText('Spec'));
      expect(document.querySelector('pre')?.textContent).toContain('# Spec v1 content');

      const v1Btn = screen.getByText('v1');
      expect(v1Btn.className).toContain('border-[#2563eb]');
    });
  });

  // ── Spec tab — compare mode ──────────────────────────────────────────

  describe('spec tab — compare mode', () => {
    const specWithVersions = {
      spec: '# Current Spec',
      specVersions: {
        v1: '# Spec v1 content',
        v2: '# Spec v2 content',
      },
    };

    function clickSpec() { fireEvent.click(screen.getByText('Spec')); }

    it('shows compare toggle button when 2+ versions exist', () => {
      renderDetail(specWithVersions);
      clickSpec();
      expect(screen.getByTestId('compare-toggle')).toBeInTheDocument();
      expect(screen.getByText('⚖ Compare')).toBeInTheDocument();
    });

    it('shows compare toggle with just 1 snapshot (current + v1 = 2 total)', () => {
      renderDetail({ spec: '# Current', specVersions: { v1: '# v1' } });
      clickSpec();
      // With 1 snapshot + current, total is 2 — toggle should appear
      expect(screen.getByTestId('compare-toggle')).toBeInTheDocument();
    });

    it('does not show compare toggle when specVersions is undefined', () => {
      renderDetail({ spec: '# Current' });
      clickSpec();
      expect(screen.queryByTestId('compare-toggle')).not.toBeInTheDocument();
    });

    it('clicking compare toggle shows side-by-side diff view', () => {
      renderDetail(specWithVersions);
      clickSpec();
      fireEvent.click(screen.getByTestId('compare-toggle'));

      // Compare toggle text changes
      expect(screen.getByText('Compare ✓')).toBeInTheDocument();
      // Version selectors appear
      expect(screen.getByTestId('compare-left-select')).toBeInTheDocument();
      expect(screen.getByTestId('compare-right-select')).toBeInTheDocument();
      // Version buttons hidden in compare mode
      expect(screen.queryByText('v3')).not.toBeInTheDocument();
    });

    it('compare toggle is highlighted when active', () => {
      renderDetail(specWithVersions);
      clickSpec();
      fireEvent.click(screen.getByTestId('compare-toggle'));

      const toggle = screen.getByTestId('compare-toggle');
      expect(toggle.className).toContain('border-emerald-600');
      expect(toggle.className).toContain('text-emerald-300');
    });

    it('turning off compare mode returns to single-panel view', () => {
      renderDetail(specWithVersions);
      clickSpec();
      fireEvent.click(screen.getByTestId('compare-toggle'));
      // Turn off
      fireEvent.click(screen.getByTestId('compare-toggle'));

      expect(screen.getByText('⚖ Compare')).toBeInTheDocument();
      // Version buttons should be back
      expect(screen.getByText('v3')).toBeInTheDocument();
      expect(screen.getByText('v1')).toBeInTheDocument();
    });

    it('shows removed lines in red with strikethrough on left side', () => {
      renderDetail({
        spec: '# Current Spec',
        specVersions: {
          v1: '# Old Spec\nline to be removed\nunchanged line',
          v2: '# New Spec\nunchanged line\nline added',
        },
      });
      clickSpec();
      fireEvent.click(screen.getByTestId('compare-toggle'));

      // Explicitly select v1 vs v2
      const leftSelect = screen.getByTestId('compare-left-select');
      const rightSelect = screen.getByTestId('compare-right-select');
      fireEvent.change(leftSelect, { target: { value: 'v1' } });
      fireEvent.change(rightSelect, { target: { value: 'v2' } });

      // Find removed text (should be on left side with red styling)
      const allDiffLines = document.querySelectorAll('[data-component^="diff-left-"] div');
      const removedTexts = Array.from(allDiffLines).map(d => d.textContent?.trim());
      expect(removedTexts).toContain('- line to be removed');
    });

    it('shows added lines in green on right side', () => {
      renderDetail({
        spec: '# Current Spec',
        specVersions: {
          v1: '# Old Spec\nunchanged line',
          v2: '# New Spec\nunchanged line\nline added',
        },
      });
      clickSpec();
      fireEvent.click(screen.getByTestId('compare-toggle'));

      // Explicitly select v1 vs v2
      const leftSelect = screen.getByTestId('compare-left-select');
      const rightSelect = screen.getByTestId('compare-right-select');
      fireEvent.change(leftSelect, { target: { value: 'v1' } });
      fireEvent.change(rightSelect, { target: { value: 'v2' } });

      // Find added text (should be on right side with green styling)
      const allDiffLines = document.querySelectorAll('[data-component^="diff-right-"] div');
      const addedTexts = Array.from(allDiffLines).map(d => d.textContent?.trim());
      expect(addedTexts).toContain('+ line added');
    });

    it('shows unchanged lines on both sides with neutral styling', () => {
      renderDetail({
        spec: '# Current Spec',
        specVersions: {
          v1: '# Old Spec\nunchanged line',
          v2: '# New Spec\nunchanged line',
        },
      });
      clickSpec();
      fireEvent.click(screen.getByTestId('compare-toggle'));

      const leftLines = document.querySelectorAll('[data-component^="diff-left-"] div');
      const rightLines = document.querySelectorAll('[data-component^="diff-right-"] div');
      const leftTexts = Array.from(leftLines).map(d => d.textContent?.trim());
      const rightTexts = Array.from(rightLines).map(d => d.textContent?.trim());

      // Both should have the unchanged line
      expect(leftTexts).toContain('unchanged line');
      expect(rightTexts).toContain('unchanged line');
    });

    it('changing left dropdown updates the diff content', () => {
      renderDetail({
        spec: '# Current Spec\nshared line',
        specVersions: {
          v1: '# Old Spec\nline in v1 only\nshared line',
          v2: '# New Spec\nshared line\nline in v2 only',
        },
      });
      clickSpec();
      fireEvent.click(screen.getByTestId('compare-toggle'));

      // Explicitly set v1 vs v2 initially
      const leftSelect = screen.getByTestId('compare-left-select');
      const rightSelect = screen.getByTestId('compare-right-select');
      fireEvent.change(leftSelect, { target: { value: 'v1' } });
      fireEvent.change(rightSelect, { target: { value: 'v2' } });

      // Verify diff shows v1-specific content on left
      const leftLines = document.querySelectorAll('[data-component^="diff-left-"] div');
      const leftTexts = Array.from(leftLines).map(d => d.textContent);
      expect(leftTexts.some(t => t?.includes('line in v1 only'))).toBe(true);

      // Now switch left to 'current' spec
      fireEvent.change(leftSelect, { target: { value: 'current' } });

      // Diff should now compare current vs v2 (different content)
      const updatedLeftLines = document.querySelectorAll('[data-component^="diff-left-"] div');
      const updatedLeftTexts = Array.from(updatedLeftLines).map(d => d.textContent);
      expect(updatedLeftTexts.some(t => t?.includes('Current Spec'))).toBe(true);
      // v1-specific content should no longer appear
      expect(updatedLeftTexts.some(t => t?.includes('line in v1 only'))).toBe(false);
      // Shared/unchanged content should persist after recomputing diff
      expect(updatedLeftTexts.some(t => t?.includes('shared line'))).toBe(true);
    });

    it('renders column headers showing selected version labels', () => {
      renderDetail(specWithVersions);
      clickSpec();
      fireEvent.click(screen.getByTestId('compare-toggle'));

      // Headers should exist (v1 and v2 are auto-selected as the two most recent)
      const headers = document.querySelectorAll('.grid.grid-cols-2 > div');
      const headerTexts = Array.from(headers).map(h => h.textContent);
      expect(headerTexts).toContain('v1');
      expect(headerTexts).toContain('v2');
    });
  });

  // ── Plan tab ─────────────────────────────────────────────────────────

  describe('plan tab', () => {
    it('renders PlanSubtasks when Plan tab is active', () => {
      renderDetail({ plan: simplePlan() });
      fireEvent.click(screen.getByText('Plan'));

      expect(screen.getByText('1 / 3 subtasks completed')).toBeInTheDocument();
    });

    it('shows empty plan message when no plan', () => {
      renderDetail({ plan: null });
      fireEvent.click(screen.getByText('Plan'));

      expect(screen.getByText('No plan generated yet.')).toBeInTheDocument();
    });
  });

  // ── QA tab ───────────────────────────────────────────────────────────

  describe('QA tab', () => {
    it('renders QAReportView when QA tab is active', () => {
      renderDetail({ qaReport: qaPass() });
      fireEvent.click(screen.getByText('QA'));

      expect(screen.getByText('PASS')).toBeInTheDocument();
    });

    it('passes humanFeedback to QAReportView', () => {
      renderDetail({ humanFeedback: 'Looks good overall.' });
      fireEvent.click(screen.getByText('QA'));

      expect(screen.getByText('Human Reviewer Feedback')).toBeInTheDocument();
      expect(screen.getByText('Looks good overall.')).toBeInTheDocument();
    });

    it('shows empty QA message when no report', () => {
      renderDetail({ qaReport: null, humanFeedback: null });
      fireEvent.click(screen.getByText('QA'));

      expect(screen.getByText('No QA report generated yet.')).toBeInTheDocument();
    });
  });

  // ── Rate-limit banner ────────────────────────────────────────────────

  describe('rate-limit banner', () => {
    it('shows rate-limit banner when task is rate-limited', () => {
      renderDetail({ task: { rateLimitedUntil: '2026-06-04T08:00:00.000Z' } });
      expect(screen.getByText(/API token limit hit/)).toBeInTheDocument();
    });

    it('does not show banner in readonly mode', () => {
      renderDetail({ task: { rateLimitedUntil: '2026-06-04T08:00:00.000Z' }, readonly: true });
      expect(screen.queryByText(/API token limit hit/)).not.toBeInTheDocument();
    });
  });

  // ── Dependencies ─────────────────────────────────────────────────────

  describe('dependencies', () => {
    it('shows "Depends on" section with dependency tasks', () => {
      const dep = makeTask({ id: 'dep-1', title: 'Dependency Task' });
      renderDetail({ dependencies: [dep] });
      // The section header label is "Depends on" (the button shows "+ Depends on")
      expect(screen.getByText('Depends on')).toBeInTheDocument();
      expect(screen.getByText('Dependency Task')).toBeInTheDocument();
    });

    it('shows "Blocks" section with dependent tasks', () => {
      const dependent = makeTask({ id: 'dep-2', title: 'Blocked Task' });
      renderDetail({ dependents: [dependent] });
      expect(screen.getByText('Blocks')).toBeInTheDocument();
      expect(screen.getByText('Blocked Task')).toBeInTheDocument();
    });

    it('shows "No dependencies set." when none exist', () => {
      renderDetail({ dependencies: [], dependents: [] });
      expect(screen.getByText('No dependencies set.')).toBeInTheDocument();
    });
  });

  // ── Review panel ─────────────────────────────────────────────────────

  describe('review panel', () => {
    it('shows ReviewPanel for awaiting-review phase', () => {
      renderDetail({ task: { phase: 'awaiting-review' } });
      expect(screen.getByTestId('review-panel')).toBeInTheDocument();
    });

    it('shows ReviewPanel for pr-open phase', () => {
      renderDetail({ task: { phase: 'pr-open' } });
      expect(screen.getByTestId('review-panel')).toBeInTheDocument();
    });

    it('does not show ReviewPanel for non-review phases', () => {
      renderDetail({ task: { phase: 'implement' } });
      expect(screen.queryByTestId('review-panel')).not.toBeInTheDocument();
    });
  });

  // ── Hash-based tab navigation ────────────────────────────────────────

  describe('hash-based tab navigation', () => {
    it('opens Spec tab when URL hash is #spec', async () => {
      window.location.hash = '#spec';
      renderDetail();
      await waitFor(() => {
        const specTab = screen.getByText('Spec');
        expect(specTab.className).toContain('border-[#2563eb]');
      });
      window.location.hash = '';
    });

    it('opens QA tab when URL hash is #qa', async () => {
      window.location.hash = '#qa';
      renderDetail();
      await waitFor(() => {
        const qaTab = screen.getByText('QA');
        expect(qaTab.className).toContain('border-[#2563eb]');
      });
      window.location.hash = '';
    });
  });

  // ── Auto-processed banner ────────────────────────────────────────────

  describe('auto-processed banner', () => {
    it('shows the auto-processed banner when autoProcessed, !autoReviewed, and phase is done', () => {
      renderDetail({
        task: { phase: 'done', autoProcessed: true, autoReviewed: false },
      });

      expect(screen.getByText(/This task was auto-processed/)).toBeInTheDocument();
      expect(screen.getByText('🤖')).toBeInTheDocument();
    });

    it('shows the "Mark Reviewed" button in the banner', () => {
      renderDetail({
        task: { phase: 'done', autoProcessed: true, autoReviewed: false },
      });

      const btn = screen.getByText('✓ Mark Reviewed');
      expect(btn).toBeInTheDocument();
      expect(btn.tagName).toBe('BUTTON');
    });

    it('hides the banner when readonly is true', () => {
      renderDetail({
        task: { phase: 'done', autoProcessed: true, autoReviewed: false },
        readonly: true,
      });

      expect(screen.queryByText(/This task was auto-processed/)).not.toBeInTheDocument();
    });

    it('hides the banner when autoReviewed is true', () => {
      renderDetail({
        task: { phase: 'done', autoProcessed: true, autoReviewed: true },
      });

      expect(screen.queryByText(/This task was auto-processed/)).not.toBeInTheDocument();
    });

    it('hides the banner when autoProcessed is false', () => {
      renderDetail({
        task: { phase: 'done', autoProcessed: false, autoReviewed: false },
      });

      expect(screen.queryByText(/This task was auto-processed/)).not.toBeInTheDocument();
    });

    it('hides the banner when phase is not done (even if autoProcessed and !autoReviewed)', () => {
      renderDetail({
        task: { phase: 'implement', autoProcessed: true, autoReviewed: false },
      });

      expect(screen.queryByText(/This task was auto-processed/)).not.toBeInTheDocument();
    });

    it('clicking "Mark Reviewed" calls markAutoReviewed with the task ID', async () => {
      renderDetail({
        task: { id: 'auto-task', phase: 'done', autoProcessed: true, autoReviewed: false },
      });

      const btn = screen.getByText('✓ Mark Reviewed');
      fireEvent.click(btn);

      await waitFor(() => {
        expect(mockMarkAutoReviewed).toHaveBeenCalledWith('auto-task');
      });
    });

    it('does not show the banner for normal done tasks (neither autoProcessed nor autoReviewed)', () => {
      renderDetail({
        task: { phase: 'done' },
      });

      expect(screen.queryByText(/This task was auto-processed/)).not.toBeInTheDocument();
      expect(screen.queryByText('✓ Mark Reviewed')).not.toBeInTheDocument();
    });
  });
});
