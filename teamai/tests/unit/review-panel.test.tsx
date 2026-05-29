// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
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

vi.mock('@/app/actions/tasks', () => ({
  approveTask: (...args: unknown[]) => mockApproveTask(...args),
  rejectTask: (...args: unknown[]) => mockRejectTask(...args),
  markTaskDone: (...args: unknown[]) => mockMarkTaskDone(...args),
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
});
