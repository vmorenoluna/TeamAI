// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { ReviewPanel } from '@/components/review-panel';

// ── Mocks ──────────────────────────────────────────────────────────────

const mockRouterRefresh = vi.fn();

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    refresh: mockRouterRefresh,
    push: vi.fn(),
    prefetch: vi.fn(),
  }),
}));

const mockApproveTask = vi.fn().mockResolvedValue(undefined);
const mockRejectTask = vi.fn().mockResolvedValue(undefined);
const mockMarkTaskDone = vi.fn().mockResolvedValue(undefined);
const mockReviseSpec = vi.fn().mockResolvedValue(undefined);

vi.mock('@/app/actions/tasks', () => ({
  approveTask: (...args: unknown[]) => mockApproveTask(...args),
  rejectTask: (...args: unknown[]) => mockRejectTask(...args),
  markTaskDone: (...args: unknown[]) => mockMarkTaskDone(...args),
  reviseSpec: (...args: unknown[]) => mockReviseSpec(...args),
}));

// ── Fixtures ───────────────────────────────────────────────────────────

const QA_REPORT_PASS = {
  overall: 'PASS' as const,
  criteria: [
    { name: 'Feature works', status: 'PASS' as const, notes: 'All good' },
  ],
};

const QA_REPORT_FAIL = {
  overall: 'FAIL' as const,
  criteria: [
    { name: 'Feature works', status: 'FAIL' as const, notes: 'Broken on mobile' },
  ],
};

const QA_REPORT_WITH_SPEC_CONCERNS = {
  overall: 'FAIL' as const,
  criteria: [
    { name: 'API integration', status: 'PASS' as const, notes: 'Code matches spec' },
  ],
  spec_concerns: [
    {
      issue: 'Wrong API response shape assumed',
      reasoning: 'Spec says API returns { data: [...] } but it actually returns { results: [...] }.',
      suggested_fix: 'Update spec to use { results: [...] }.',
    },
    {
      issue: 'Missing edge case',
      reasoning: 'Spec does not cover the rate-limiting scenario.',
    },
  ],
};

// ── Tests ──────────────────────────────────────────────────────────────

describe('ReviewPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── pr-open phase ───────────────────────────────────────────────────

  describe('pr-open phase', () => {
    it('renders "View Pull Request" link when prUrl is set', () => {
      render(
        <ReviewPanel
          taskId="task-1"
          spec={null}
          qaReport={null}
          diff={null}
          prUrl="https://github.com/owner/repo/pull/42"
          phase="pr-open"
        />,
      );

      const link = screen.getByText('View Pull Request');
      expect(link).toBeInTheDocument();
      expect(link.closest('a')).toHaveAttribute('href', 'https://github.com/owner/repo/pull/42');
      expect(link.closest('a')).toHaveAttribute('target', '_blank');
    });

    it('renders "Mark as Done" button', () => {
      render(
        <ReviewPanel
          taskId="task-1"
          spec={null}
          qaReport={null}
          diff={null}
          prUrl="https://github.com/owner/repo/pull/42"
          phase="pr-open"
        />,
      );

      expect(screen.getByText('Mark as Done')).toBeInTheDocument();
    });

    it('renders "Request Changes" button', () => {
      render(
        <ReviewPanel
          taskId="task-1"
          spec={null}
          qaReport={null}
          diff={null}
          prUrl="https://github.com/owner/repo/pull/42"
          phase="pr-open"
        />,
      );

      expect(screen.getByText('Request Changes')).toBeInTheDocument();
    });

    it('does NOT render "Merge Locally" or "Open Pull Request" buttons', () => {
      render(
        <ReviewPanel
          taskId="task-1"
          spec={null}
          qaReport={null}
          diff={null}
          prUrl="https://github.com/owner/repo/pull/42"
          phase="pr-open"
        />,
      );

      expect(screen.queryByText('Merge Locally')).not.toBeInTheDocument();
      expect(screen.queryByText('Open Pull Request')).not.toBeInTheDocument();
    });

    it('still shows "Request Changes" when prUrl is absent (phase is pr-open but no PR link)', () => {
      render(
        <ReviewPanel
          taskId="task-1"
          spec={null}
          qaReport={null}
          diff={null}
          prUrl={null}
          phase="pr-open"
        />,
      );

      expect(screen.getByText('Request Changes')).toBeInTheDocument();
      expect(screen.getByText('Mark as Done')).toBeInTheDocument();
      expect(screen.queryByText('View Pull Request')).not.toBeInTheDocument();
    });

    it('calls markTaskDone when "Mark as Done" is clicked', async () => {
      render(
        <ReviewPanel
          taskId="task-1"
          spec={null}
          qaReport={null}
          diff={null}
          prUrl="https://github.com/owner/repo/pull/42"
          phase="pr-open"
        />,
      );

      await act(async () => {
        fireEvent.click(screen.getByText('Mark as Done'));
      });

      expect(mockMarkTaskDone).toHaveBeenCalledWith('task-1');
      expect(mockRouterRefresh).toHaveBeenCalled();
    });

    it('opens feedback textarea when "Request Changes" is clicked, and closes on Cancel', async () => {
      render(
        <ReviewPanel
          taskId="task-1"
          spec={null}
          qaReport={null}
          diff={null}
          prUrl="https://github.com/owner/repo/pull/42"
          phase="pr-open"
        />,
      );

      // Feedback textarea should NOT be visible initially
      expect(screen.queryByPlaceholderText('Describe what needs to change...')).not.toBeInTheDocument();

      // Click "Request Changes"
      await act(async () => {
        fireEvent.click(screen.getByText('Request Changes'));
      });

      // Feedback textarea and Send Back/Cancel should appear
      expect(screen.getByPlaceholderText('Describe what needs to change...')).toBeInTheDocument();
      expect(screen.getByText('Send Back')).toBeInTheDocument();
      expect(screen.getByText('Cancel')).toBeInTheDocument();

      // Click "Cancel"
      await act(async () => {
        fireEvent.click(screen.getByText('Cancel'));
      });

      // Feedback UI should be gone
      expect(screen.queryByPlaceholderText('Describe what needs to change...')).not.toBeInTheDocument();
    });

    it('calls rejectTask when feedback is submitted from pr-open phase', async () => {
      render(
        <ReviewPanel
          taskId="task-1"
          spec={null}
          qaReport={null}
          diff={null}
          prUrl="https://github.com/owner/repo/pull/42"
          phase="pr-open"
        />,
      );

      // Click "Request Changes" to open feedback
      await act(async () => {
        fireEvent.click(screen.getByText('Request Changes'));
      });

      // Type feedback
      const textarea = screen.getByPlaceholderText('Describe what needs to change...');
      await act(async () => {
        fireEvent.change(textarea, { target: { value: 'The PR needs more tests' } });
      });

      // Click "Send Back"
      await act(async () => {
        fireEvent.click(screen.getByText('Send Back'));
      });

      expect(mockRejectTask).toHaveBeenCalledWith('task-1', 'The PR needs more tests');
      expect(mockRouterRefresh).toHaveBeenCalled();
    });
  });

  // ── awaiting-review phase ───────────────────────────────────────────

  describe('awaiting-review phase', () => {
    it('renders "Merge Locally", "Open Pull Request", and "Request Changes" buttons', () => {
      render(
        <ReviewPanel
          taskId="task-2"
          spec={null}
          qaReport={QA_REPORT_PASS}
          diff={null}
          prUrl={null}
          phase="awaiting-review"
        />,
      );

      expect(screen.getByText('Merge Locally')).toBeInTheDocument();
      expect(screen.getByText('Open Pull Request')).toBeInTheDocument();
      expect(screen.getByText('Request Changes')).toBeInTheDocument();
    });

    it('does NOT render "Mark as Done" button', () => {
      render(
        <ReviewPanel
          taskId="task-2"
          spec={null}
          qaReport={QA_REPORT_PASS}
          diff={null}
          prUrl={null}
          phase="awaiting-review"
        />,
      );

      expect(screen.queryByText('Mark as Done')).not.toBeInTheDocument();
    });

    it('shows pr-open UI when prUrl is set in awaiting-review (rejected from pr-open)', () => {
      render(
        <ReviewPanel
          taskId="task-2"
          spec={null}
          qaReport={QA_REPORT_PASS}
          diff={null}
          prUrl="https://github.com/owner/repo/pull/42"
          phase="awaiting-review"
        />,
      );

      // Shows the teal PR banner, not the subtle previous-PR link
      const link = screen.getByText('View Pull Request');
      expect(link).toBeInTheDocument();
      expect(link.closest('a')).toHaveAttribute('href', 'https://github.com/owner/repo/pull/42');
      expect(link.closest('a')).toHaveAttribute('target', '_blank');

      // Shows "Mark as Done" instead of approve buttons
      expect(screen.getByText('Mark as Done')).toBeInTheDocument();
      expect(screen.queryByText('Merge Locally')).not.toBeInTheDocument();
      expect(screen.queryByText('Open Pull Request')).not.toBeInTheDocument();
    });

    it('does NOT show PR link when prUrl is absent', () => {
      render(
        <ReviewPanel
          taskId="task-2"
          spec={null}
          qaReport={QA_REPORT_PASS}
          diff={null}
          prUrl={null}
          phase="awaiting-review"
        />,
      );

      expect(screen.queryByText('View Pull Request')).not.toBeInTheDocument();
    });

    it('calls approveTask with local-merge when "Merge Locally" is clicked', async () => {
      render(
        <ReviewPanel
          taskId="task-2"
          spec={null}
          qaReport={QA_REPORT_PASS}
          diff={null}
          prUrl={null}
          phase="awaiting-review"
        />,
      );

      await act(async () => {
        fireEvent.click(screen.getByText('Merge Locally'));
      });

      expect(mockApproveTask).toHaveBeenCalledWith('task-2', 'local-merge');
      expect(mockRouterRefresh).toHaveBeenCalled();
    });

    it('calls approveTask with pull-request when "Open Pull Request" is clicked', async () => {
      render(
        <ReviewPanel
          taskId="task-2"
          spec={null}
          qaReport={QA_REPORT_PASS}
          diff={null}
          prUrl={null}
          phase="awaiting-review"
        />,
      );

      await act(async () => {
        fireEvent.click(screen.getByText('Open Pull Request'));
      });

      expect(mockApproveTask).toHaveBeenCalledWith('task-2', 'pull-request');
      expect(mockRouterRefresh).toHaveBeenCalled();
    });

    it('calls rejectTask when feedback is submitted from awaiting-review phase', async () => {
      render(
        <ReviewPanel
          taskId="task-2"
          spec={null}
          qaReport={QA_REPORT_PASS}
          diff={null}
          prUrl={null}
          phase="awaiting-review"
        />,
      );

      // Click "Request Changes" to open feedback
      await act(async () => {
        fireEvent.click(screen.getByText('Request Changes'));
      });

      // Type feedback
      const textarea = screen.getByPlaceholderText('Describe what needs to change...');
      await act(async () => {
        fireEvent.change(textarea, { target: { value: 'Fix the button color' } });
      });

      // Click "Send Back"
      await act(async () => {
        fireEvent.click(screen.getByText('Send Back'));
      });

      expect(mockRejectTask).toHaveBeenCalledWith('task-2', 'Fix the button color');
      expect(mockRouterRefresh).toHaveBeenCalled();
    });
  });

  // ── QA report rendering ─────────────────────────────────────────────

  describe('QA report', () => {
    it('renders QA report section title with PASS indicator', () => {
      render(
        <ReviewPanel
          taskId="task-3"
          spec={null}
          qaReport={QA_REPORT_PASS}
          diff={null}
          prUrl={null}
          phase="awaiting-review"
        />,
      );

      // Section title is always rendered (the clickable toggle button)
      expect(screen.getByText(/QA Report — ✓ PASS/)).toBeInTheDocument();
    });

    it('renders QA report section title with FAIL indicator', () => {
      render(
        <ReviewPanel
          taskId="task-3"
          spec={null}
          qaReport={QA_REPORT_FAIL}
          diff={null}
          prUrl={null}
          phase="awaiting-review"
        />,
      );

      expect(screen.getByText(/QA Report — ✗ FAIL/)).toBeInTheDocument();
    });

    it('shows PASS badge and criteria inside the expanded QA section', async () => {
      render(
        <ReviewPanel
          taskId="task-3"
          spec={null}
          qaReport={QA_REPORT_PASS}
          diff={null}
          prUrl={null}
          phase="awaiting-review"
        />,
      );

      // Click to expand the section
      await act(async () => {
        fireEvent.click(screen.getByText(/QA Report — ✓ PASS/));
      });

      // Now the interior content is in the DOM
      expect(screen.getByText('PASS')).toBeInTheDocument();
      expect(screen.getByText('Feature works')).toBeInTheDocument();
      expect(screen.getByText('All good')).toBeInTheDocument();
    });

    it('renders amber human feedback banner when humanFeedback is passed', async () => {
      render(
        <ReviewPanel
          taskId="task-3"
          spec={null}
          qaReport={QA_REPORT_PASS}
          humanFeedback="Fix the header alignment on mobile"
          diff={null}
          prUrl={null}
          phase="awaiting-review"
        />,
      );

      // Click to expand the QA section
      await act(async () => {
        fireEvent.click(screen.getByText(/QA Report — ✓ PASS/));
      });

      // The amber banner should be visible
      expect(screen.getByText('Human Reviewer Feedback')).toBeInTheDocument();
      expect(screen.getByText('Fix the header alignment on mobile')).toBeInTheDocument();
    });

    it('does NOT render human feedback banner when humanFeedback is null', async () => {
      render(
        <ReviewPanel
          taskId="task-3"
          spec={null}
          qaReport={QA_REPORT_PASS}
          humanFeedback={null}
          diff={null}
          prUrl={null}
          phase="awaiting-review"
        />,
      );

      // Click to expand the QA section
      await act(async () => {
        fireEvent.click(screen.getByText(/QA Report — ✓ PASS/));
      });

      // The amber banner should NOT be visible
      expect(screen.queryByText('Human Reviewer Feedback')).not.toBeInTheDocument();
    });
  });

  // ── Disabled state ──────────────────────────────────────────────────

  describe('disabled state during transition', () => {
    it('disables action buttons and shows per-action loading text while pending', async () => {
      // Use a never-resolving promise to keep the action pending
      mockApproveTask.mockImplementation(() => new Promise(() => {}));

      render(
        <ReviewPanel
          taskId="task-4"
          spec={null}
          qaReport={QA_REPORT_PASS}
          diff={null}
          prUrl={null}
          phase="awaiting-review"
        />,
      );

      await act(async () => {
        fireEvent.click(screen.getByText('Merge Locally'));
      });

      // Button now shows per-action loading text and is disabled
      const mergeBtn = screen.getByText('Merging…');
      expect(mergeBtn).toBeDisabled();

      // Other buttons are also disabled but don't show loading text
      expect(screen.getByText('Open Pull Request')).toBeDisabled();
      expect(screen.getByText('Request Changes')).toBeDisabled();
    });
  });

  // ── Spec concerns rendering ─────────────────────────────────────────

  describe('spec concerns banner', () => {
    it('renders spec concerns banner with issue, reasoning, and suggested_fix', async () => {
      render(
        <ReviewPanel
          taskId="task-5"
          spec={null}
          qaReport={QA_REPORT_WITH_SPEC_CONCERNS}
          diff={null}
          prUrl={null}
          phase="awaiting-review"
        />,
      );

      // Expand the QA section to see inner content
      await act(async () => {
        fireEvent.click(screen.getByText(/QA Report — ✗ FAIL/));
      });

      // Banner header
      expect(screen.getByText('Spec Concerns — The specification needs revision')).toBeInTheDocument();

      // First concern: issue, reasoning, suggested_fix
      expect(screen.getByText('Wrong API response shape assumed')).toBeInTheDocument();
      expect(screen.getByText('Spec says API returns { data: [...] } but it actually returns { results: [...] }.')).toBeInTheDocument();
      expect(screen.getByText('Suggested: Update spec to use { results: [...] }.')).toBeInTheDocument();

      // Second concern: no suggested_fix
      expect(screen.getByText('Missing edge case')).toBeInTheDocument();
      expect(screen.getByText('Spec does not cover the rate-limiting scenario.')).toBeInTheDocument();
    });

    it('does NOT render spec concerns banner when spec_concerns is empty', async () => {
      render(
        <ReviewPanel
          taskId="task-5"
          spec={null}
          qaReport={{
            overall: 'PASS',
            criteria: [{ name: 'Works', status: 'PASS' }],
            spec_concerns: [],
          }}
          diff={null}
          prUrl={null}
          phase="awaiting-review"
        />,
      );

      await act(async () => {
        fireEvent.click(screen.getByText(/QA Report — ✓ PASS/));
      });

      expect(screen.queryByText('Spec Concerns — The specification needs revision')).not.toBeInTheDocument();
    });

    it('does NOT render spec concerns banner when spec_concerns is undefined', async () => {
      render(
        <ReviewPanel
          taskId="task-5"
          spec={null}
          qaReport={QA_REPORT_PASS}
          diff={null}
          prUrl={null}
          phase="awaiting-review"
        />,
      );

      await act(async () => {
        fireEvent.click(screen.getByText(/QA Report — ✓ PASS/));
      });

      expect(screen.queryByText('Spec Concerns — The specification needs revision')).not.toBeInTheDocument();
    });
  });

  // ── Revise Spec button visibility ───────────────────────────────────

  describe('Revise Spec button', () => {
    it('appears when spec_concerns exist and not in pr-open phase', () => {
      render(
        <ReviewPanel
          taskId="task-6"
          spec={null}
          qaReport={QA_REPORT_WITH_SPEC_CONCERNS}
          diff={null}
          prUrl={null}
          phase="awaiting-review"
        />,
      );

      expect(screen.getByText('Revise Spec')).toBeInTheDocument();
    });

    it('does NOT appear when spec_concerns is undefined', () => {
      render(
        <ReviewPanel
          taskId="task-6"
          spec={null}
          qaReport={QA_REPORT_PASS}
          diff={null}
          prUrl={null}
          phase="awaiting-review"
        />,
      );

      expect(screen.queryByText('Revise Spec')).not.toBeInTheDocument();
    });

    it('does NOT appear when spec_concerns is empty', () => {
      render(
        <ReviewPanel
          taskId="task-6"
          spec={null}
          qaReport={{
            overall: 'PASS',
            criteria: [],
            spec_concerns: [],
          }}
          diff={null}
          prUrl={null}
          phase="awaiting-review"
        />,
      );

      expect(screen.queryByText('Revise Spec')).not.toBeInTheDocument();
    });

    it('does NOT appear when in pr-open phase (even with spec_concerns)', () => {
      render(
        <ReviewPanel
          taskId="task-6"
          spec={null}
          qaReport={QA_REPORT_WITH_SPEC_CONCERNS}
          diff={null}
          prUrl="https://github.com/owner/repo/pull/42"
          phase="pr-open"
        />,
      );

      expect(screen.queryByText('Revise Spec')).not.toBeInTheDocument();
      // pr-open shows Mark as Done instead
      expect(screen.getByText('Mark as Done')).toBeInTheDocument();
    });

    it('renders alongside Merge Locally and Open Pull Request buttons', () => {
      render(
        <ReviewPanel
          taskId="task-6"
          spec={null}
          qaReport={QA_REPORT_WITH_SPEC_CONCERNS}
          diff={null}
          prUrl={null}
          phase="awaiting-review"
        />,
      );

      // All three buttons should be present
      expect(screen.getByText('Merge Locally')).toBeInTheDocument();
      expect(screen.getByText('Open Pull Request')).toBeInTheDocument();
      expect(screen.getByText('Request Changes')).toBeInTheDocument();
      expect(screen.getByText('Revise Spec')).toBeInTheDocument();
    });
  });

  // ── Revise Spec action ──────────────────────────────────────────────

  describe('Revise Spec click action', () => {
    it('calls reviseSpec with the taskId and shows loading state', async () => {
      // Use a never-resolving promise to keep the action pending
      mockReviseSpec.mockImplementation(() => new Promise(() => {}));

      render(
        <ReviewPanel
          taskId="task-7"
          spec={null}
          qaReport={QA_REPORT_WITH_SPEC_CONCERNS}
          diff={null}
          prUrl={null}
          phase="awaiting-review"
        />,
      );

      await act(async () => {
        fireEvent.click(screen.getByText('Revise Spec'));
      });

      expect(mockReviseSpec).toHaveBeenCalledWith('task-7');

      // Button shows loading text and is disabled
      const reviseBtn = screen.getByText('Revising Spec…');
      expect(reviseBtn).toBeDisabled();
    });

    it('refreshes router on successful completion', async () => {
      mockReviseSpec.mockResolvedValue(undefined);

      render(
        <ReviewPanel
          taskId="task-8"
          spec={null}
          qaReport={QA_REPORT_WITH_SPEC_CONCERNS}
          diff={null}
          prUrl={null}
          phase="awaiting-review"
        />,
      );

      await act(async () => {
        fireEvent.click(screen.getByText('Revise Spec'));
      });

      expect(mockRouterRefresh).toHaveBeenCalled();
    });

    it('disables other buttons while revise-spec is pending', async () => {
      mockReviseSpec.mockImplementation(() => new Promise(() => {}));

      render(
        <ReviewPanel
          taskId="task-9"
          spec={null}
          qaReport={QA_REPORT_WITH_SPEC_CONCERNS}
          diff={null}
          prUrl={null}
          phase="awaiting-review"
        />,
      );

      await act(async () => {
        fireEvent.click(screen.getByText('Revise Spec'));
      });

      // All other action buttons should be disabled
      expect(screen.getByText('Merge Locally')).toBeDisabled();
      expect(screen.getByText('Open Pull Request')).toBeDisabled();
      expect(screen.getByText('Request Changes')).toBeDisabled();
      expect(screen.getByText('Revising Spec…')).toBeDisabled();
    });
  });

  // ── Raw-throw path (regression) ──────────────────────────────────
  // All four RunAction-routed handlers (Approve local-merge / Approve
  // pull-request / Reject / ReviseSpec) plus handleMarkDone (also via
  // runAction) had the original silent-failure antipattern: bare
  // `await action(...)` calls let thrown errors vanish into
  // useServerMutation's empty catch, so the button click appeared to
  // "do nothing" on failure.
  //
  // The fix wraps every call in a single shared `runAction<T>(label,
  // fallbackMessage, fn)` helper that sets `error` state on rejection
  // and re-throws. The dismissable role='alert' banner appears above
  // the action buttons with `Action failed` header + the raw
  // `err.message` (or fallbackMessage if the rejection isn't an Error
  // with a message). These tests lock in that contract for each path.

  describe('raw-throw path (regression)', () => {
    function setupAwaitingReview(overrides: Partial<Parameters<typeof ReviewPanel>[0]> = {}) {
      return render(
        <ReviewPanel
          taskId="task-r1"
          spec={null}
          qaReport={QA_REPORT_PASS}
          diff={null}
          prUrl={null}
          phase="awaiting-review"
          {...overrides}
        />,
      );
    }

    async function assertErrorBannerWith(text: string) {
      await waitFor(() => {
        const banner = screen.getByRole('alert');
        // The banner always carries the "Action failed" header — assert both
        // header and surfaced message to lock in the helper's contract.
        expect(banner).toHaveTextContent('Action failed');
        expect(banner).toHaveTextContent(text);
      });
    }

    it('handleApprove (local-merge): role=alert surfaces when approveTask throws; pendingAction clears', async () => {
      mockApproveTask.mockRejectedValueOnce(new Error('merge raw throw: rebase conflict'));

      setupAwaitingReview();

      await act(async () => {
        fireEvent.click(screen.getByText('Merge Locally'));
      });

      expect(mockApproveTask).toHaveBeenCalledWith('task-r1', 'local-merge');
      await assertErrorBannerWith('merge raw throw: rebase conflict');
      // runAction's `finally` cleared pendingAction — button reverts from
      // "Merging…" loading text back to "Merge Locally".
      expect(screen.getByText('Merge Locally')).toBeInTheDocument();
      // Re-throw → useServerMutation skips router.refresh() on failure.
      expect(mockRouterRefresh).not.toHaveBeenCalled();
    });

    it('handleApprove (pull-request): role=alert surfaces when approveTask throws', async () => {
      mockApproveTask.mockRejectedValueOnce(new Error('pr raw throw: gh auth expired'));

      setupAwaitingReview();

      await act(async () => {
        fireEvent.click(screen.getByText('Open Pull Request'));
      });

      expect(mockApproveTask).toHaveBeenCalledWith('task-r1', 'pull-request');
      await assertErrorBannerWith('pr raw throw: gh auth expired');
      expect(screen.getByText('Open Pull Request')).toBeInTheDocument();
      expect(mockRouterRefresh).not.toHaveBeenCalled();
    });

    it('handleReviseSpec: role=alert surfaces when reviseSpec throws', async () => {
      mockReviseSpec.mockRejectedValueOnce(new Error('revise raw throw: spec snapshot conflict'));

      setupAwaitingReview({ qaReport: QA_REPORT_WITH_SPEC_CONCERNS });

      await act(async () => {
        fireEvent.click(screen.getByText('Revise Spec'));
      });

      expect(mockReviseSpec).toHaveBeenCalledWith('task-r1');
      await assertErrorBannerWith('revise raw throw: spec snapshot conflict');
      expect(screen.getByText('Revise Spec')).toBeInTheDocument();
      expect(mockRouterRefresh).not.toHaveBeenCalled();
    });

    it('handleMarkDone: role=alert surfaces when markTaskDone throws', async () => {
      mockMarkTaskDone.mockRejectedValueOnce(new Error('markDone raw throw: gh merge conflict'));

      render(
        <ReviewPanel
          taskId="task-r1"
          spec={null}
          qaReport={QA_REPORT_PASS}
          diff={null}
          prUrl="https://github.com/owner/repo/pull/42"
          phase="pr-open"
        />,
      );

      await act(async () => {
        fireEvent.click(screen.getByText('Mark as Done'));
      });

      expect(mockMarkTaskDone).toHaveBeenCalledWith('task-r1');
      await assertErrorBannerWith('markDone raw throw: gh merge conflict');
      expect(screen.getByText('Mark as Done')).toBeInTheDocument();
      expect(mockRouterRefresh).not.toHaveBeenCalled();
    });

    it('handleReject: role=alert surfaces when rejectTask throws', async () => {
      mockRejectTask.mockRejectedValueOnce(new Error('reject raw throw: comment api down'));

      render(
        <ReviewPanel
          taskId="task-r1"
          spec={null}
          qaReport={QA_REPORT_PASS}
          diff={null}
          prUrl="https://github.com/owner/repo/pull/42"
          phase="pr-open"
        />,
      );

      // Open the feedback UI and submit it (handler requires non-empty feedback).
      await act(async () => {
        fireEvent.click(screen.getByText('Request Changes'));
      });
      await act(async () => {
        fireEvent.change(screen.getByPlaceholderText('Describe what needs to change...'), {
          target: { value: 'Please add a test for X' },
        });
      });

      await act(async () => {
        fireEvent.click(screen.getByText('Send Back'));
      });

      expect(mockRejectTask).toHaveBeenCalledWith('task-r1', 'Please add a test for X');
      await assertErrorBannerWith('reject raw throw: comment api down');
      // runAction's re-throw preserves the feedback UI — textarea still
      // visible so the user can edit and retry.
      expect(screen.getByPlaceholderText('Describe what needs to change...')).toBeInTheDocument();
      expect(mockRouterRefresh).not.toHaveBeenCalled();
    });

    it('fallback message: when rejection is not an Error<string>, runAction uses fallbackMessage', async () => {
      // Promise.reject('plain string') — the rejection value isn't an Error,
      // so `err instanceof Error && err.message` is false → fallbackMessage
      // When the rejection is a non-Error string, formatActionError falls back
      // to 'Unknown error' — so the banner surfaces the full prefixed template
      // 'Failed to merge task: Unknown error' (the bare 'Failed to merge task'
      // fallbackMessage that predates the formatActionError refactor is gone).
      mockApproveTask.mockRejectedValueOnce('some non-Error string');

      setupAwaitingReview();

      await act(async () => {
        fireEvent.click(screen.getByText('Merge Locally'));
      });

      await waitFor(() => {
        const banner = screen.getByRole('alert');
        expect(banner).toHaveTextContent('Action failed');
        expect(banner).toHaveTextContent('Failed to merge task: Unknown error');
      });
      // The literal "some non-Error string" should NOT be in the banner.
      expect(screen.queryByText('some non-Error string')).not.toBeInTheDocument();
    });
  });
});
