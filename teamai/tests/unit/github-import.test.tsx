// @vitest-environment happy-dom

/**
 * Unit tests for GitHubImport component.
 *
 * Tests the full lifecycle: initial idle state, fetching state, issue display
 * after completion, issue selection (individual + all), import flow, empty
 * states (no issues / no MCP), error handling, and reconnection on mount.
 *
 * React's useTransition is mocked (isPending=false, synchronous callback) to
 * avoid the happy-dom limitation where disabled buttons don't fire onClick.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import type { SessionEvent } from '@/hooks/use-session-stream';
import type { StreamEvent } from '@/lib/stream-types';
import type { GitHubIssue } from '@/app/actions/github';

// ── Hoisted mocks ───────────────────────────────────────────────────────────

const mockStartIssueList = vi.fn();
const mockParseIssuesFromText = vi.fn();
const mockSaveIssuesToFile = vi.fn();
const mockImportIssues = vi.fn();
const mockGetActiveIssueSession = vi.fn();
const mockCancelGithubIssueListing = vi.fn().mockResolvedValue(undefined);

vi.mock('@/app/actions/github', () => ({
  startIssueList: (() => mockStartIssueList()) as typeof import('@/app/actions/github').startIssueList,
  parseIssuesFromText: ((text: string) => mockParseIssuesFromText(text)) as typeof import('@/app/actions/github').parseIssuesFromText,
  saveIssuesToFile: ((...args: unknown[]) => mockSaveIssuesToFile(...args)) as typeof import('@/app/actions/github').saveIssuesToFile,
  importIssues: ((...args: unknown[]) => mockImportIssues(...args)) as typeof import('@/app/actions/github').importIssues,
  getActiveIssueSession: (() => mockGetActiveIssueSession()) as typeof import('@/app/actions/github').getActiveIssueSession,
  cancelGithubIssueListing: (() => mockCancelGithubIssueListing()) as typeof import('@/app/actions/github').cancelGithubIssueListing,
}));

const mockUseSessionStream = vi.fn();

vi.mock('@/hooks/use-session-stream', () => ({
  useSessionStream: (() => mockUseSessionStream()) as typeof import('@/hooks/use-session-stream').useSessionStream,
}));

const mockExtractText = vi.fn();
const mockExtractProgressText = vi.hoisted(() => vi.fn().mockReturnValue(''));
const mockParseSessionLimitReset = vi.hoisted(() => vi.fn().mockReturnValue(null));
const mockFormatCountdown = vi.hoisted(() => vi.fn().mockReturnValue(''));

vi.mock('@/lib/stream-types', () => ({
  extractText: ((event: Record<string, unknown>) => mockExtractText(event)) as typeof import('@/lib/stream-types').extractText,
  extractProgressText: ((event: Record<string, unknown>) => mockExtractProgressText(event)) as typeof import('@/lib/stream-types').extractProgressText,
}));

vi.mock('@/lib/rate-limit', () => ({
  RATE_LIMIT_PATTERN: /(session.?limit|rate.?limit|too many requests|usage.?limit)/i,
  parseSessionLimitReset: ((...args: unknown[]) => mockParseSessionLimitReset(...args)) as typeof import('@/lib/rate-limit').parseSessionLimitReset,
  formatCountdown: ((...args: unknown[]) => mockFormatCountdown(...args)) as typeof import('@/lib/rate-limit').formatCountdown,
}));

const mockRouterRefresh = vi.fn();

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: mockRouterRefresh }),
}));

const mockStartTransition = vi.hoisted(() => vi.fn((cb: () => void) => cb()));

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>();
  return {
    ...actual,
    useTransition: () => [false, mockStartTransition],
  };
});

// ── Imports (after mocks) ───────────────────────────────────────────────────

import { GitHubImport } from '@/components/github-import';

// ── Helpers ─────────────────────────────────────────────────────────────────

function renderComponent() {
  render(<GitHubImport />);
}

function ev(event: StreamEvent): SessionEvent {
  return { sessionId: '', event };
}

function ghIssue(overrides: Partial<GitHubIssue> = {}): GitHubIssue {
  return {
    number: 1,
    title: 'Test issue',
    body: 'Issue body',
    state: 'open',
    labels: ['bug'],
    html_url: 'https://github.com/owner/repo/issues/1',
    created_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

/**
 * Set up mocks for a completed scan with the given issues.
 * Returns after rendering and clicking "List Open Issues".
 */
async function setupCompletedScan(issues: GitHubIssue[], sessionId = 'session-done') {
  mockStartIssueList.mockResolvedValue(sessionId);
  mockUseSessionStream.mockReturnValue([ev({ type: 'result' })]);
  mockParseIssuesFromText.mockReturnValue(issues);
  mockSaveIssuesToFile.mockResolvedValue(undefined);

  renderComponent();

  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'List Open Issues' }));
  });
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('GitHubImport', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseSessionStream.mockReturnValue([]);
    mockGetActiveIssueSession.mockResolvedValue(null);
    mockCancelGithubIssueListing.mockResolvedValue(undefined);
    mockParseIssuesFromText.mockReturnValue([]);
    // Default: extractText returns empty — prevents falsey `'' + undefined = 'undefined'`
    // from polluting streamText and hiding empty-state sections.
    mockExtractText.mockReturnValue('');
    mockExtractProgressText.mockReturnValue('');
    mockParseSessionLimitReset.mockReturnValue(null);
    mockFormatCountdown.mockReturnValue('');
  });

  // ── Initial / idle state ─────────────────────────────────────────────

  describe('initial state', () => {
    it('renders the List Open Issues button', () => {
      renderComponent();
      expect(screen.getByRole('button', { name: 'List Open Issues' })).toBeInTheDocument();
    });

    it('shows the idle empty state message', () => {
      renderComponent();
      expect(screen.getByText('Click "List Open Issues" to fetch GitHub issues.')).toBeInTheDocument();
    });

    it('does not show error, imported badge, or issue list', () => {
      renderComponent();
      expect(screen.queryByText(/imported/)).not.toBeInTheDocument();
      expect(screen.queryByText(/Failed/)).not.toBeInTheDocument();
      expect(screen.queryByText(/open issue/)).not.toBeInTheDocument();
    });

    it('does not show Select All or Import Selected buttons', () => {
      renderComponent();
      expect(screen.queryByRole('button', { name: /Select All|Deselect All|Import Selected/ })).not.toBeInTheDocument();
    });
  });

  // ── Fetching state ───────────────────────────────────────────────────

  describe('fetching state', () => {
    it('shows ✕ Stop button while listing is running', async () => {
      mockStartIssueList.mockReturnValue(new Promise(() => {}));

      renderComponent();

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'List Open Issues' }));
      });

      const button = screen.getByRole('button', { name: '✕ Stop' });
      expect(button).toBeInTheDocument();
    });

    it('shows streaming output when text is available', async () => {
      mockStartIssueList.mockResolvedValue('session-stream');
      mockExtractProgressText.mockReturnValue('Listing issues...');
      mockUseSessionStream.mockReturnValue([]);

      const { rerender } = render(<GitHubImport />);

      // Click triggers startIssueList which sets sessionId
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'List Open Issues' }));
      });

      // Update mock to return stream events, then force re-render
      mockUseSessionStream.mockReturnValue([
        ev({ type: 'assistant', message: { content: [{ type: 'text', text: 'Listing issues...' }] } }),
      ]);

      await act(async () => {
        rerender(<GitHubImport />);
      });

      await waitFor(() => {
        expect(screen.getByText('Listing issues...')).toBeInTheDocument();
      });
    });
  });

  // ── Complete state with issues ───────────────────────────────────────

  describe('complete state with issues', () => {
    const issues = [
      ghIssue({ number: 1, title: 'Bug fix', body: 'Something broken', labels: ['critical'] }),
      ghIssue({ number: 2, title: 'Feature request', body: 'Add X', labels: ['enhancement'] }),
    ];

    beforeEach(async () => {
      await setupCompletedScan(issues);
    });

    it('returns button to List Open Issues after scan completes', async () => {
      await waitFor(() => {
        const button = screen.getByRole('button', { name: 'List Open Issues' });
        expect(button).toBeInTheDocument();
        expect(button).not.toBeDisabled();
      });
    });

    it('renders issue cards with title, number, body, and labels', async () => {
      await waitFor(() => {
        expect(screen.getByText('Bug fix')).toBeInTheDocument();
        expect(screen.getByText('Feature request')).toBeInTheDocument();
        expect(screen.getByText('#1')).toBeInTheDocument();
        expect(screen.getByText('#2')).toBeInTheDocument();
        expect(screen.getByText('critical')).toBeInTheDocument();
        expect(screen.getByText('enhancement')).toBeInTheDocument();
      });
    });

    it('shows the issue count summary', async () => {
      await waitFor(() => {
        expect(screen.getByText('2 open issues found')).toBeInTheDocument();
      });
    });

    it('renders checkboxes for each issue', async () => {
      await waitFor(() => {
        const checkboxes = screen.getAllByRole('checkbox');
        expect(checkboxes.length).toBe(2);
      });
    });

    it('shows Select All and Import Selected buttons', async () => {
      await waitFor(() => {
        expect(screen.getByRole('button', { name: 'Select All' })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Import Selected (0)' })).toBeInTheDocument();
      });
    });

    it('Import Selected button is disabled when nothing is selected', async () => {
      await waitFor(() => {
        const importBtn = screen.getByRole('button', { name: 'Import Selected (0)' });
        expect(importBtn).toBeDisabled();
      });
    });

    it('calls parseIssuesFromText after session completes', async () => {
      await waitFor(() => {
        expect(mockParseIssuesFromText).toHaveBeenCalled();
      });
    });

    it('saves issues to file when issues are found', async () => {
      await waitFor(() => {
        expect(mockSaveIssuesToFile).toHaveBeenCalledWith('session-done', issues);
      });
    });
  });

  // ── Singular label ───────────────────────────────────────────────────

  describe('singular label for one issue', () => {
    it('shows singular form in the count summary', async () => {
      await setupCompletedScan([ghIssue({ number: 1, title: 'Only one' })]);

      await waitFor(() => {
        expect(screen.getByText('1 open issue found')).toBeInTheDocument();
      });
    });
  });

  // ── Issue selection ──────────────────────────────────────────────────

  describe('issue selection', () => {
    const issues = [
      ghIssue({ number: 1, title: 'Issue A' }),
      ghIssue({ number: 2, title: 'Issue B' }),
      ghIssue({ number: 3, title: 'Issue C' }),
    ];

    beforeEach(async () => {
      await setupCompletedScan(issues);

      await waitFor(() => {
        expect(screen.getByText('Issue A')).toBeInTheDocument();
      });
    });

    it('toggles individual issue selection on click', async () => {
      await act(async () => {
        fireEvent.click(screen.getByText('Issue A'));
      });

      expect(screen.getByRole('button', { name: 'Import Selected (1)' })).toBeInTheDocument();

      await act(async () => {
        fireEvent.click(screen.getByText('Issue A'));
      });

      expect(screen.getByRole('button', { name: 'Import Selected (0)' })).toBeInTheDocument();
    });

    it('selects all issues with Select All', async () => {
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Select All' }));
      });

      expect(screen.getByRole('button', { name: 'Deselect All' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Import Selected (3)' })).toBeInTheDocument();
    });

    it('deselects all issues with Deselect All', async () => {
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Select All' }));
      });

      expect(screen.getByRole('button', { name: 'Deselect All' })).toBeInTheDocument();

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Deselect All' }));
      });

      expect(screen.getByRole('button', { name: 'Select All' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Import Selected (0)' })).toBeInTheDocument();
    });
  });

  // ── Import flow ──────────────────────────────────────────────────────

  describe('import flow', () => {
    const issues = [
      ghIssue({ number: 1, title: 'Issue A' }),
      ghIssue({ number: 2, title: 'Issue B' }),
    ];

    beforeEach(async () => {
      await setupCompletedScan(issues);

      await waitFor(() => {
        expect(screen.getByText('Issue A')).toBeInTheDocument();
      });
    });

    it('imports selected issues and shows success count', async () => {
      mockImportIssues.mockResolvedValue({ taskIds: ['task-1', 'task-2'] });

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Select All' }));
      });

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Import Selected (2)' }));
      });

      await waitFor(() => {
        expect(mockImportIssues).toHaveBeenCalledTimes(1);
        expect(screen.getByText('2 issues imported')).toBeInTheDocument();
      });
    });

    it('shows singular form for one imported issue', async () => {
      mockImportIssues.mockResolvedValue({ taskIds: ['task-1'] });

      await act(async () => {
        fireEvent.click(screen.getByText('Issue A'));
      });

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Import Selected (1)' }));
      });

      await waitFor(() => {
        expect(screen.getByText('1 issue imported')).toBeInTheDocument();
      });
    });

    it('calls router.refresh after successful import', async () => {
      mockImportIssues.mockResolvedValue({ taskIds: ['task-1'] });

      await act(async () => {
        fireEvent.click(screen.getByText('Issue A'));
      });

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Import Selected (1)' }));
      });

      await waitFor(() => {
        expect(mockRouterRefresh).toHaveBeenCalled();
      });
    });

    it('shows error when import fails', async () => {
      mockImportIssues.mockRejectedValue(new Error('Import failed'));

      await act(async () => {
        fireEvent.click(screen.getByText('Issue A'));
      });

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Import Selected (1)' }));
      });

      await waitFor(() => {
        expect(screen.getByText('Import failed')).toBeInTheDocument();
      });
    });

    it('clears selection after successful import', async () => {
      mockImportIssues.mockResolvedValue({ taskIds: ['task-1', 'task-2'] });

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Select All' }));
      });

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Import Selected (2)' }));
      });

      await waitFor(() => {
        expect(screen.getByRole('button', { name: 'Import Selected (0)' })).toBeInTheDocument();
      });
    });
  });

  // ── Complete state with no issues ────────────────────────────────────

  describe('complete state with no issues', () => {
    // NOTE: When done=true and issues=[], both showNoMcp AND the "No open
    // issues found" empty state render simultaneously (showNoMcp gates on
    // done && issues.length === 0; the lower empty state gates on
    // done && issues.length === 0 && !streamText — both are true).
    // This is a known component behaviour, not a test bug.

    it('shows No open issues found when result arrives but no issues parsed', async () => {
      await setupCompletedScan([]);

      await waitFor(() => {
        expect(screen.getByText('No open issues found.')).toBeInTheDocument();
      });
    });

    it('shows MCP configuration help alongside the empty state', async () => {
      await setupCompletedScan([]);

      await waitFor(() => {
        // Both sections render when done && issues.length === 0.
        // "GitHub MCP server" also appears in the header, so
        // getAllByText verifies it appears twice (header + showNoMcp).
        expect(screen.getByText('No open issues found.')).toBeInTheDocument();
        expect(screen.getByText('No issues found. The GitHub MCP server may not be configured.')).toBeInTheDocument();
        expect(screen.getAllByText(/GitHub MCP server/).length).toBe(2);
      });
    });
  });

  // ── Error state ──────────────────────────────────────────────────────

  describe('error state', () => {
    it('displays error message when startIssueList rejects', async () => {
      mockStartIssueList.mockRejectedValue(new Error('Network error'));

      renderComponent();

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'List Open Issues' }));
      });

      await waitFor(() => {
        expect(screen.getByText('Network error')).toBeInTheDocument();
      });
    });

    it('re-enables the button after an error', async () => {
      mockStartIssueList.mockRejectedValue(new Error('err'));

      renderComponent();

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'List Open Issues' }));
      });

      await waitFor(() => {
        const button = screen.getByRole('button', { name: 'List Open Issues' });
        expect(button).toBeInTheDocument();
        expect(button).not.toBeDisabled();
      });
    });

    it('clears previous issues when starting a new listing', async () => {
      // First, complete a listing with issues
      await setupCompletedScan([ghIssue({ number: 1, title: 'Old issue' })]);

      await waitFor(() => {
        expect(screen.getByText('Old issue')).toBeInTheDocument();
      });

      // Start a new listing (pending — never resolves, issues cleared)
      mockStartIssueList.mockReturnValue(new Promise(() => {}));
      mockUseSessionStream.mockReturnValue([]);

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'List Open Issues' }));
      });

      expect(screen.queryByText('Old issue')).not.toBeInTheDocument();
    });
  });

  // ── Reconnection ─────────────────────────────────────────────────────

  describe('reconnection on mount', () => {
    it('checks for active session on mount', async () => {
      mockGetActiveIssueSession.mockResolvedValue(null);

      renderComponent();

      await waitFor(() => {
        expect(mockGetActiveIssueSession).toHaveBeenCalled();
      });
    });

    it('reconnects to existing running session without starting a new listing', async () => {
      mockGetActiveIssueSession.mockResolvedValue('reconnect-session');

      renderComponent();

      await waitFor(() => {
        expect(screen.getByRole('button', { name: '✕ Stop' })).toBeInTheDocument();
      });

      // The component should reuse the existing session, not start a new one
      expect(mockStartIssueList).not.toHaveBeenCalled();
    });

    it('does not reconnect when getActiveIssueSession throws', async () => {
      mockGetActiveIssueSession.mockRejectedValue(new Error('no project'));

      renderComponent();

      await waitFor(() => {
        expect(screen.getByRole('button', { name: 'List Open Issues' })).toBeInTheDocument();
      });
    });
  });

  // ── Rate-limit detection ────────────────────────────────────────────

  describe('rate-limit detection', () => {
    const AE = (text: string) =>
      ev({ type: 'assistant', message: { content: [{ type: 'text', text }] } });

    it('shows rate-limit banner when stream contains "session limit" text', () => {
      mockExtractText.mockReturnValue('session limit reached. Try again later.');
      mockUseSessionStream.mockReturnValue([AE('session limit reached. Try again later.')]);

      renderComponent();

      expect(screen.getByText(/session limit reached/)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Retry Now' })).toBeInTheDocument();
    });

    it('detects "rate limit" as rate-limit', () => {
      mockExtractText.mockReturnValue('Rate limit exceeded. Please wait.');
      mockUseSessionStream.mockReturnValue([AE('Rate limit exceeded. Please wait.')]);

      renderComponent();

      expect(screen.getByText(/Rate limit exceeded/)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Retry Now' })).toBeInTheDocument();
    });

    it('detects "too many requests" as rate-limit', () => {
      mockExtractText.mockReturnValue('Too many requests. Slow down.');
      mockUseSessionStream.mockReturnValue([AE('Too many requests. Slow down.')]);

      renderComponent();

      expect(screen.getByText(/Too many requests/)).toBeInTheDocument();
    });

    it('detects "usage limit" as rate-limit', () => {
      mockExtractText.mockReturnValue('Your usage limit has been exceeded.');
      mockUseSessionStream.mockReturnValue([AE('Your usage limit has been exceeded.')]);

      renderComponent();

      expect(screen.getByText(/usage limit/)).toBeInTheDocument();
    });

    it('shows the error text in the rate-limit banner', () => {
      mockExtractText.mockReturnValue(
        'Too many requests. Please wait before sending another message.'
      );
      mockUseSessionStream.mockReturnValue([AE('Too many requests. Please wait before sending another message.')]);

      renderComponent();

      expect(
        screen.getByText(
          'Too many requests. Please wait before sending another message.'
        )
      ).toBeInTheDocument();
    });

    it('sets running to false when rate-limited', () => {
      mockExtractText.mockReturnValue('session limit');
      mockUseSessionStream.mockReturnValue([AE('session limit')]);

      renderComponent();

      // Running is false → button shows "List Open Issues" not "✕ Stop"
      expect(screen.getByRole('button', { name: 'List Open Issues' })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: '✕ Stop' })).not.toBeInTheDocument();
    });

    it('Retry Now button clears rate-limit state and restarts', async () => {
      mockStartIssueList.mockResolvedValue('sess-retry-now');
      mockExtractText.mockReturnValue('session limit reached');
      mockUseSessionStream.mockReturnValue([AE('session limit reached')]);

      renderComponent();

      expect(screen.getByRole('button', { name: 'Retry Now' })).toBeInTheDocument();

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Retry Now' }));
      });

      // Should restart: List Open Issues → triggers startIssueList
      expect(mockStartIssueList).toHaveBeenCalledTimes(1);
    });

    it('hides streaming output when rate-limited', () => {
      mockExtractText.mockReturnValue('session limit reached');
      mockUseSessionStream.mockReturnValue([AE('session limit reached')]);

      renderComponent();

      // running=false after rate-limit → streaming output div is hidden
      // The idle empty state shows instead
      expect(
        screen.getByText('Click "List Open Issues" to fetch GitHub issues.')
      ).toBeInTheDocument();
    });

    it('shows ⏳ icon in the rate-limit banner', () => {
      mockExtractText.mockReturnValue('session limit');
      mockUseSessionStream.mockReturnValue([AE('session limit')]);

      renderComponent();

      expect(screen.getByText('⏳')).toBeInTheDocument();
    });
  });

  // ── Auto-resume ────────────────────────────────────────────────────

  describe('auto-resume', () => {
    const AE = (text: string) =>
      ev({ type: 'assistant', message: { content: [{ type: 'text', text }] } });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('timer triggers handleListIssues when countdown reaches 0', async () => {
      vi.useFakeTimers();
      const NOW_MS = 1719000000 * 1000;
      const RESET_SECS = 1719000005;
      vi.setSystemTime(NOW_MS);

      mockStartIssueList.mockResolvedValue('sess-auto-resume');
      mockExtractText.mockReturnValue('session limit resets 3:45 pm UTC');
      mockParseSessionLimitReset.mockReturnValue(RESET_SECS);
      mockFormatCountdown.mockReturnValue('0:05');
      mockUseSessionStream.mockReturnValue([AE('session limit resets 3:45 pm UTC')]);

      renderComponent();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      expect(screen.getByText('Cancel')).toBeInTheDocument();
      expect(mockStartIssueList).not.toHaveBeenCalled();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(6000);
      });

      // handleListIssues calls startIssueList
      expect(mockStartIssueList).toHaveBeenCalled();
    });

    it('shows auto-resume countdown and Cancel when reset time is parseable', () => {
      mockExtractText.mockReturnValue('session limit resets 3:45 pm UTC');
      mockParseSessionLimitReset.mockReturnValue(1719000000);
      mockFormatCountdown.mockReturnValue('2:30');
      mockUseSessionStream.mockReturnValue([AE('session limit resets 3:45 pm UTC')]);

      renderComponent();

      expect(screen.getByText('2:30')).toBeInTheDocument();
      expect(screen.getByText('Cancel')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Retry Now' })).toBeInTheDocument();
    });

    it('shows auto-resuming message when reset time is parseable', () => {
      mockExtractText.mockReturnValue('session limit resets 3:45 pm UTC');
      mockParseSessionLimitReset.mockReturnValue(1719000000);
      mockFormatCountdown.mockReturnValue('5:00');
      mockUseSessionStream.mockReturnValue([AE('session limit resets 3:45 pm UTC')]);

      renderComponent();

      expect(
        screen.getByText('Session limit hit — auto-resuming 5:00')
      ).toBeInTheDocument();
    });

    it('Cancel button clears auto-resume and rate-limit state', async () => {
      mockExtractText.mockReturnValue('session limit resets 3:45 pm UTC');
      mockParseSessionLimitReset.mockReturnValue(1719000000);
      mockFormatCountdown.mockReturnValue('1:00');
      mockUseSessionStream.mockReturnValue([AE('session limit resets 3:45 pm UTC')]);

      renderComponent();

      expect(screen.getByText('Cancel')).toBeInTheDocument();

      await act(async () => {
        fireEvent.click(screen.getByText('Cancel'));
      });

      expect(screen.queryByText('Cancel')).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Retry Now' })).not.toBeInTheDocument();
      expect(
        screen.getByText('Click "List Open Issues" to fetch GitHub issues.')
      ).toBeInTheDocument();
    });

    it('does not show Cancel or countdown when reset time is unparseable', () => {
      mockExtractText.mockReturnValue('Rate limit exceeded. Please wait.');
      mockParseSessionLimitReset.mockReturnValue(null);
      mockUseSessionStream.mockReturnValue([AE('Rate limit exceeded. Please wait.')]);

      renderComponent();

      expect(screen.queryByText('Cancel')).not.toBeInTheDocument();
      expect(screen.getByText('⏳')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Retry Now' })).toBeInTheDocument();
    });
  });
});
