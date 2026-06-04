// @vitest-environment happy-dom

/**
 * Unit tests for RoadmapView main component.
 *
 * Tests tab switching (roadmap/changelog), Generate Roadmap button,
 * skip-competitors checkbox, history select, streaming output,
 * no-project empty state, and changelog tab controls.
 *
 * React's useTransition is mocked (isPending=false, synchronous callback)
 * following the project's established pattern.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import type { SessionEvent } from '@/hooks/use-session-stream';

// ── Hoisted mocks ───────────────────────────────────────────────────────────

const mockStartRoadmapGeneration = vi.hoisted(() => vi.fn());
const mockStartChangelogGeneration = vi.hoisted(() => vi.fn());
const mockGetRoadmapReports = vi.hoisted(() => vi.fn());
const mockGetRoadmapReport = vi.hoisted(() => vi.fn());
const mockGetChangelogReports = vi.hoisted(() => vi.fn());
const mockGetLatestChangelog = vi.hoisted(() => vi.fn());
const mockGetActiveRoadmapSession = vi.hoisted(() => vi.fn().mockResolvedValue(null));
const mockConvertToTask = vi.hoisted(() => vi.fn());
const mockClearLinkedTaskId = vi.hoisted(() => vi.fn());

vi.mock('@/app/actions/roadmap', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/app/actions/roadmap')>();
  return {
    ...actual,
    startRoadmapGeneration: (...args: unknown[]) => mockStartRoadmapGeneration(...args),
    startChangelogGeneration: (...args: unknown[]) => mockStartChangelogGeneration(...args),
    getRoadmapReports: (...args: unknown[]) => mockGetRoadmapReports(...args),
    getRoadmapReport: (...args: unknown[]) => mockGetRoadmapReport(...args),
    getChangelogReports: (...args: unknown[]) => mockGetChangelogReports(...args),
    getLatestChangelog: (...args: unknown[]) => mockGetLatestChangelog(...args),
    getActiveRoadmapSession: (...args: unknown[]) => {
      mockGetActiveRoadmapSession(...args);
      return Promise.resolve(null);
    },
    convertToTask: (...args: unknown[]) => mockConvertToTask(...args),
    clearLinkedTaskId: (...args: unknown[]) => mockClearLinkedTaskId(...args),
  };
});

const mockUseSessionStream = vi.hoisted(() => vi.fn());

vi.mock('@/hooks/use-session-stream', () => ({
  useSessionStream: (() => mockUseSessionStream()) as typeof import('@/hooks/use-session-stream').useSessionStream,
}));

const mockExtractText = vi.hoisted(() => vi.fn());

vi.mock('@/lib/stream-types', () => ({
  extractText: ((event: Record<string, unknown>) => mockExtractText(event)) as typeof import('@/lib/stream-types').extractText,
}));

vi.mock('@/hooks/use-phase-sync', () => ({
  usePhaseSync: vi.fn(),
}));

vi.mock('@/components/task-panel', () => ({
  TaskPanel: ({ onClose }: { taskId: string; onClose: () => void }) => (
    <div data-testid="task-panel">
      <button data-testid="close-task-panel" onClick={onClose}>Close</button>
    </div>
  ),
}));

// Mock PhasedKanban (tested separately) so it doesn't add noise
vi.mock('@/components/roadmap-view', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/roadmap-view')>();
  return {
    ...actual,
    PhasedKanban: ({ report }: { report: { executive_summary: string } }) => (
      <div data-testid="phased-kanban">
        <span data-testid="exec-summary">{report.executive_summary}</span>
      </div>
    ),
  };
});

const mockSessionStorage = {
  store: {} as Record<string, string>,
  getItem(key: string) { return this.store[key] ?? null; },
  setItem(key: string, value: string) { this.store[key] = value; },
  removeItem(key: string) { delete this.store[key]; },
  clear() { this.store = {}; },
};

Object.defineProperty(window, 'sessionStorage', {
  value: mockSessionStorage,
  writable: true,
});

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

import { RoadmapView } from '@/components/roadmap-view';

// ── Helpers ─────────────────────────────────────────────────────────────────

function renderView(noProject = false) {
  act(() => {
    render(<RoadmapView noProject={noProject} />);
  });
}

function ev(type: string, text?: string): SessionEvent {
  return {
    sessionId: '',
    event: { type, ...(text ? { message: { content: [{ type: 'text', text }] } } : {}) },
  } as SessionEvent;
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('RoadmapView', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSessionStorage.clear();
    mockUseSessionStream.mockReturnValue([]);
    mockGetRoadmapReports.mockResolvedValue([]);
    mockGetChangelogReports.mockResolvedValue([]);
    mockGetActiveRoadmapSession.mockResolvedValue(null);
    mockExtractText.mockReturnValue('');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── No-project empty state ───────────────────────────────────────────

  describe('no-project empty state', () => {
    it('shows the empty state message when noProject is true', () => {
      renderView(true);
      expect(
        screen.getByText('Select or add a project from the sidebar to get started.')
      ).toBeInTheDocument();
    });

    it('still renders the Roadmap and Changelog tabs when noProject is true', () => {
      renderView(true);
      expect(screen.getByText('Roadmap')).toBeInTheDocument();
      expect(screen.getByText('Changelog')).toBeInTheDocument();
    });

    it('does not show Generate Roadmap button when noProject is true', () => {
      renderView(true);
      expect(screen.queryByText('Generate Roadmap')).not.toBeInTheDocument();
    });
  });

  // ── Tab switching ────────────────────────────────────────────────────

  describe('tab switching', () => {
    it('renders the Roadmap tab as active by default', () => {
      renderView(false);
      const roadmapTab = screen.getByText('Roadmap');
      expect(roadmapTab.className).toContain('border-[#2563eb]');
    });

    it('switches to Changelog tab on click', () => {
      renderView(false);
      fireEvent.click(screen.getByText('Changelog'));

      const changelogTab = screen.getByText('Changelog');
      expect(changelogTab.className).toContain('border-[#2563eb]');
    });

    it('shows Generate Changelog button on the changelog tab', () => {
      renderView(false);
      fireEvent.click(screen.getByText('Changelog'));

      expect(screen.getByText('Generate Changelog')).toBeInTheDocument();
    });

    it('shows Generate Roadmap button on the roadmap tab', () => {
      renderView(false);
      expect(screen.getByText('Generate Roadmap')).toBeInTheDocument();
    });

    it('persists tab selection in sessionStorage', () => {
      renderView(false);
      fireEvent.click(screen.getByText('Changelog'));

      expect(mockSessionStorage.getItem('roadmap-tab')).toBe('changelog');
    });
  });

  // ── Generate Roadmap ─────────────────────────────────────────────────

  describe('Generate Roadmap button', () => {
    it('calls startRoadmapGeneration with skipCompetitors=false by default', async () => {
      mockStartRoadmapGeneration.mockResolvedValue('sess-rm-1');
      renderView(false);

      await act(async () => {
        fireEvent.click(screen.getByText('Generate Roadmap'));
      });

      expect(mockStartRoadmapGeneration).toHaveBeenCalledWith(false);
    });

    it('calls startRoadmapGeneration with skipCompetitors=true when checkbox is checked', async () => {
      mockStartRoadmapGeneration.mockResolvedValue('sess-rm-2');
      renderView(false);

      // Check the "Skip competitor research" checkbox
      const checkbox = screen.getByLabelText('Skip competitor research');
      fireEvent.click(checkbox);

      await act(async () => {
        fireEvent.click(screen.getByText('Generate Roadmap'));
      });

      expect(mockStartRoadmapGeneration).toHaveBeenCalledWith(true);
    });

    it('shows "Generating…" when a roadmap generation is running', async () => {
      mockStartRoadmapGeneration.mockResolvedValue('sess-rm-3');
      mockUseSessionStream.mockReturnValue([]); // not done yet

      renderView(false);

      await act(async () => {
        fireEvent.click(screen.getByText('Generate Roadmap'));
      });

      // The button should show "Generating…" because rmRunning=true and rmDone=false
      expect(screen.getByText('Generating…')).toBeInTheDocument();
    });

    it('shows "Generate Roadmap" again when session completes', async () => {
      mockStartRoadmapGeneration.mockResolvedValue('sess-rm-4');
      // Return a 'result' event to signal completion
      mockUseSessionStream.mockReturnValue([ev('result')]);

      renderView(false);

      await act(async () => {
        fireEvent.click(screen.getByText('Generate Roadmap'));
      });

      await waitFor(() => {
        // After result event, rmDone=true → rmRunning cleared → button reverts
        expect(screen.getByText('Generate Roadmap')).toBeInTheDocument();
      });
    });
  });

  // ── Skip-competitors checkbox ────────────────────────────────────────

  describe('skip-competitors checkbox', () => {
    it('renders the skip-competitors checkbox', () => {
      renderView(false);
      expect(screen.getByLabelText('Skip competitor research')).toBeInTheDocument();
    });

    it('checkbox is unchecked by default', () => {
      renderView(false);
      const cb = screen.getByLabelText('Skip competitor research') as HTMLInputElement;
      expect(cb.checked).toBe(false);
    });

    it('checkbox can be toggled on and off', () => {
      renderView(false);
      const cb = screen.getByLabelText('Skip competitor research') as HTMLInputElement;

      fireEvent.click(cb);
      expect(cb.checked).toBe(true);

      fireEvent.click(cb);
      expect(cb.checked).toBe(false);
    });
  });

  // ── Streaming output ─────────────────────────────────────────────────

  describe('streaming output', () => {
    it('renders streaming text when roadmap is running and text is available', async () => {
      mockStartRoadmapGeneration.mockResolvedValue('sess-stream');
      mockUseSessionStream.mockReturnValue([ev('assistant', 'Analysing codebase…')]);
      mockExtractText.mockReturnValue('Analysing codebase…');

      renderView(false);

      await act(async () => {
        fireEvent.click(screen.getByText('Generate Roadmap'));
      });

      expect(screen.getByText('Analysing codebase…')).toBeInTheDocument();
    });

    it('does not show streaming block when no text is available', async () => {
      mockStartRoadmapGeneration.mockResolvedValue('sess-stream');
      mockUseSessionStream.mockReturnValue([ev('assistant', '')]);
      mockExtractText.mockReturnValue('');

      renderView(false);

      await act(async () => {
        fireEvent.click(screen.getByText('Generate Roadmap'));
      });

      // StreamingBlock only renders when rmLatestText is truthy
      const preElements = document.querySelectorAll('pre');
      expect(preElements.length).toBe(0);
    });

    it('shows streaming text on the changelog tab too', async () => {
      mockStartChangelogGeneration.mockResolvedValue('sess-cl');
      mockUseSessionStream.mockReturnValue([ev('assistant', 'Building changelog…')]);
      mockExtractText.mockReturnValue('Building changelog…');

      renderView(false);
      fireEvent.click(screen.getByText('Changelog'));

      await act(async () => {
        fireEvent.click(screen.getByText('Generate Changelog'));
      });

      expect(screen.getByText('Building changelog…')).toBeInTheDocument();
    });
  });

  // ── Empty state message ──────────────────────────────────────────────

  describe('empty state message', () => {
    it('shows empty roadmap message when no report and not running', () => {
      renderView(false);
      expect(
        screen.getByText("No roadmap generated yet. Click 'Generate Roadmap' to start.")
      ).toBeInTheDocument();
    });

    it('shows empty changelog message on changelog tab', () => {
      renderView(false);
      fireEvent.click(screen.getByText('Changelog'));

      expect(
        screen.getByText("No changelog generated yet. Click 'Generate Changelog' to start.")
      ).toBeInTheDocument();
    });
  });

  // ── Changelog tab ────────────────────────────────────────────────────

  describe('changelog tab', () => {
    it('renders the changelog content when markdown is loaded', async () => {
      mockGetChangelogReports.mockResolvedValue([
        { filename: 'changelog-2026-01-01.md', date: '2026-01-01' },
      ]);
      mockGetLatestChangelog.mockResolvedValue('# Changelog\n\n- Fixed bug A');

      renderView(false);

      // Markdown is loaded into state by the useEffect regardless of tab,
      // but DOM rendering requires the Changelog tab to be active.
      fireEvent.click(screen.getByText('Changelog'));

      await waitFor(() => {
        expect(screen.getByText(/Fixed bug A/)).toBeInTheDocument();
      });
    });

    it('shows Generating… on the changelog button while running', async () => {
      mockStartChangelogGeneration.mockResolvedValue('sess-cl-2');
      mockUseSessionStream.mockReturnValue([]);

      renderView(false);
      fireEvent.click(screen.getByText('Changelog'));

      await act(async () => {
        fireEvent.click(screen.getByText('Generate Changelog'));
      });

      expect(screen.getByText('Generating…')).toBeInTheDocument();
    });
  });

  // ── History dropdown ─────────────────────────────────────────────────

  describe('history dropdown', () => {
    it('shows history dropdown when reports are available', async () => {
      mockGetRoadmapReports.mockResolvedValue([
        { filename: 'roadmap-2026-01-15.json', date: '2026-01-15' },
        { filename: 'roadmap-2026-01-10.json', date: '2026-01-10' },
      ]);

      renderView(false);

      await waitFor(() => {
        expect(screen.getByText('History:')).toBeInTheDocument();
      });
    });

    it('does not show history dropdown when no reports exist', async () => {
      mockGetRoadmapReports.mockResolvedValue([]);

      renderView(false);

      await waitFor(() => {
        expect(screen.queryByText('History:')).not.toBeInTheDocument();
      });
    });
  });
});
