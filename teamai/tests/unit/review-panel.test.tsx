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

    it('requires a target before sending feedback (no default)', async () => {
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
        fireEvent.click(screen.getByText('Request Changes'));
      });

      // The four target options render
      for (const label of ['Analyst', 'Planner', 'Engineer', 'QA Reviewer']) {
        expect(screen.getByText(label)).toBeInTheDocument();
      }

      // Submit is disabled until a target is chosen
      expect(screen.getByText('Send Back')).toBeDisabled();

      // Typing feedback alone is still not enough
      await act(async () => {
        fireEvent.change(screen.getByPlaceholderText('Describe what needs to change...'), {
          target: { value: 'Some feedback' },
        });
      });
      expect(screen.getByText('Send Back')).toBeDisabled();

      // Choosing a target enables submit
      await act(async () => {
        fireEvent.click(screen.getByText('Engineer'));
      });
      expect(screen.getByText('Send to Engineer')).toBeEnabled();
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

      // Select a target (no default)
      await act(async () => {
        fireEvent.click(screen.getByText('Engineer'));
      });

      // Type feedback
      const textarea = screen.getByPlaceholderText('Describe what needs to change...');
      await act(async () => {
        fireEvent.change(textarea, { target: { value: 'The PR needs more tests' } });
      });

      // Click "Send to Engineer"
      await act(async () => {
        fireEvent.click(screen.getByText('Send to Engineer'));
      });

      expect(mockRejectTask).toHaveBeenCalledWith('task-1', 'The PR needs more tests', 'coder', undefined);
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

      // Select a target (no default)
      await act(async () => {
        fireEvent.click(screen.getByText('Engineer'));
      });

      // Type feedback
      const textarea = screen.getByPlaceholderText('Describe what needs to change...');
      await act(async () => {
        fireEvent.change(textarea, { target: { value: 'Fix the button color' } });
      });

      // Click "Send to Engineer"
      await act(async () => {
        fireEvent.click(screen.getByText('Send to Engineer'));
      });

      expect(mockRejectTask).toHaveBeenCalledWith('task-2', 'Fix the button color', 'coder', undefined);
      expect(mockRouterRefresh).toHaveBeenCalled();
    });

    it('shows a subtask checklist for the Engineer target and passes the selection', async () => {
      render(
        <ReviewPanel
          taskId="task-2"
          spec={null}
          qaReport={QA_REPORT_PASS}
          diff={null}
          prUrl={null}
          phase="awaiting-review"
          subtasks={[
            { id: 1, title: 'Auth module', files: ['src/auth.ts'] },
            { id: 2, title: 'UI module', files: ['src/ui.ts'] },
            { id: 3, title: 'API module', files: ['src/api.ts'] },
          ]}
        />,
      );

      await act(async () => {
        fireEvent.click(screen.getByText('Request Changes'));
      });

      // Checklist is hidden until the Engineer target is chosen.
      expect(screen.queryByText(/Affected subtasks/)).not.toBeInTheDocument();

      await act(async () => {
        fireEvent.click(screen.getByText('Engineer'));
      });

      // Checklist renders one checkbox per subtask.
      expect(screen.getByText(/Affected subtasks/)).toBeInTheDocument();
      const checkboxes = screen.getAllByRole('checkbox');
      expect(checkboxes).toHaveLength(3);

      // Select subtasks #1 and #3.
      await act(async () => {
        fireEvent.click(checkboxes[0]);
        fireEvent.click(checkboxes[2]);
      });

      await act(async () => {
        fireEvent.change(screen.getByPlaceholderText('Describe what needs to change...'), {
          target: { value: 'Rework these modules' },
        });
      });
      await act(async () => {
        fireEvent.click(screen.getByText('Send to Engineer'));
      });

      expect(mockRejectTask).toHaveBeenCalledWith('task-2', 'Rework these modules', 'coder', [1, 3]);
      expect(mockRouterRefresh).toHaveBeenCalled();
    });

    it('shows a subtask checklist for the Planner target with preserve-list helper text and passes the selection', async () => {
      render(
        <ReviewPanel
          taskId="task-2"
          spec={null}
          qaReport={QA_REPORT_PASS}
          diff={null}
          prUrl={null}
          phase="awaiting-review"
          subtasks={[
            { id: 1, title: 'Auth module', files: ['src/auth.ts'] },
            { id: 2, title: 'UI module', files: ['src/ui.ts'] },
            { id: 3, title: 'API module', files: ['src/api.ts'] },
          ]}
        />,
      );

      await act(async () => {
        fireEvent.click(screen.getByText('Request Changes'));
      });

      // Checklist is hidden until the Planner target is chosen.
      expect(screen.queryByText(/Affected subtasks/)).not.toBeInTheDocument();

      await act(async () => {
        fireEvent.click(screen.getByText('Planner'));
      });

      // Checklist renders with the planner-specific helper text.
      expect(screen.getByText(/scopes which subtasks may be re-planned; others are left unchanged/)).toBeInTheDocument();
      const checkboxes = screen.getAllByRole('checkbox');
      expect(checkboxes).toHaveLength(3);

      // Select subtask #2 only.
      await act(async () => {
        fireEvent.click(checkboxes[1]);
      });

      await act(async () => {
        fireEvent.change(screen.getByPlaceholderText('Describe what needs to change...'), {
          target: { value: 'Re-plan only the migration subtask' },
        });
      });
      await act(async () => {
        fireEvent.click(screen.getByText('Send to Planner'));
      });

      expect(mockRejectTask).toHaveBeenCalledWith('task-2', 'Re-plan only the migration subtask', 'planner', [2]);
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
    it('shows spec concerns without expanding the QA Report section', () => {
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

      // Banner + concern details are visible immediately (no section expansion).
      expect(screen.getByText('Spec Concerns — The specification needs revision')).toBeInTheDocument();
      expect(screen.getByText('Wrong API response shape assumed')).toBeInTheDocument();
      expect(screen.getByText('Spec says API returns { data: [...] } but it actually returns { results: [...] }.')).toBeInTheDocument();
      expect(screen.getByText('Suggested: Update spec to use { results: [...] }.')).toBeInTheDocument();
    });

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

  // ── Request Changes → Analyst pre-fill ─────────────────────────────

  describe('Request Changes analyst pre-fill', () => {
    it('pre-fills the textarea with spec_concerns when selecting Analyst', async () => {
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

      await act(async () => {
        fireEvent.click(screen.getByText('Request Changes'));
      });
      await act(async () => {
        fireEvent.click(screen.getByText('Analyst'));
      });

      const textarea = screen.getByPlaceholderText('Describe what needs to change...');
      expect(textarea).toHaveValue(
        '- Wrong API response shape assumed\n' +
        '  Reasoning: Spec says API returns { data: [...] } but it actually returns { results: [...] }.\n' +
        '  Suggested fix: Update spec to use { results: [...] }.\n\n' +
        '- Missing edge case\n' +
        '  Reasoning: Spec does not cover the rate-limiting scenario.',
      );
    });

    it('does not pre-fill when selecting a non-analyst target', async () => {
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

      await act(async () => {
        fireEvent.click(screen.getByText('Request Changes'));
      });
      await act(async () => {
        fireEvent.click(screen.getByText('Engineer'));
      });

      const textarea = screen.getByPlaceholderText('Describe what needs to change...');
      expect(textarea).toHaveValue('');
    });
  });

  // ── spec_revision badge ──────────────────────────────────────────────

  describe('spec_revision badge', () => {
    it('shows Spec v{N} badge when QA report has spec_revision', async () => {
      const reportWithRevision = {
        ...QA_REPORT_WITH_SPEC_CONCERNS,
        spec_revision: 3,
      };
      render(
        <ReviewPanel
          taskId="task-rev-badge"
          spec={null}
          qaReport={reportWithRevision}
          diff={null}
          prUrl={null}
          phase="awaiting-review"
        />,
      );

      await act(async () => {
        fireEvent.click(screen.getByText(/QA Report/));
      });

      expect(screen.getByText('Spec v3')).toBeInTheDocument();
    });

    it('does NOT show Spec v{N} badge when spec_revision is absent', async () => {
      render(
        <ReviewPanel
          taskId="task-rev-badge2"
          spec={null}
          qaReport={QA_REPORT_WITH_SPEC_CONCERNS}
          diff={null}
          prUrl={null}
          phase="awaiting-review"
        />,
      );

      await act(async () => {
        fireEvent.click(screen.getByText(/QA Report/));
      });

      expect(screen.queryByText(/Spec v\d/)).not.toBeInTheDocument();
    });
  });

  // ── Spec revision limit warning + Open spec button ───────────────────

  describe('spec revision limit warning', () => {
    it('shows amber warning when specRevision >= 4 with spec_concerns', async () => {
      render(
        <ReviewPanel
          taskId="task-limit"
          spec={null}
          qaReport={QA_REPORT_WITH_SPEC_CONCERNS}
          diff={null}
          prUrl={null}
          phase="awaiting-review"
          specRevision={4}
        />,
      );

      await act(async () => {
        fireEvent.click(screen.getByText(/QA Report/));
      });

      expect(screen.getByText(/Max auto-revisions reached/)).toBeInTheDocument();
      expect(screen.getByText(/The pipeline is paused so you can safely edit the spec/)).toBeInTheDocument();
    });

    it('does NOT show amber warning when specRevision < 4', async () => {
      render(
        <ReviewPanel
          taskId="task-limit2"
          spec={null}
          qaReport={QA_REPORT_WITH_SPEC_CONCERNS}
          diff={null}
          prUrl={null}
          phase="awaiting-review"
          specRevision={3}
        />,
      );

      await act(async () => {
        fireEvent.click(screen.getByText(/QA Report/));
      });

      expect(screen.queryByText(/Max auto-revisions reached/)).not.toBeInTheDocument();
    });

    it('shows "Open spec location" button when specPath is provided in the warning', async () => {
      const mockShowItem = vi.fn();
      (window as any).electronAPI = { showItemInFolder: mockShowItem };

      render(
        <ReviewPanel
          taskId="task-open"
          spec={null}
          qaReport={QA_REPORT_WITH_SPEC_CONCERNS}
          diff={null}
          prUrl={null}
          phase="awaiting-review"
          specRevision={4}
          specPath="/test/project/.teamai/some-task/spec.md"
        />,
      );

      await act(async () => {
        fireEvent.click(screen.getByText(/QA Report/));
      });

      const openBtn = screen.getByText('📂 Open spec location');
      expect(openBtn).toBeInTheDocument();

      await act(async () => {
        fireEvent.click(openBtn);
      });

      expect(mockShowItem).toHaveBeenCalledWith('/test/project/.teamai/some-task/spec.md');

      delete (window as any).electronAPI;
    });

    it('does NOT show "Open spec location" button when specPath is not provided', async () => {
      render(
        <ReviewPanel
          taskId="task-no-open"
          spec={null}
          qaReport={QA_REPORT_WITH_SPEC_CONCERNS}
          diff={null}
          prUrl={null}
          phase="awaiting-review"
          specRevision={4}
        />,
      );

      await act(async () => {
        fireEvent.click(screen.getByText(/QA Report/));
      });

      expect(screen.queryByText('📂 Open spec location')).not.toBeInTheDocument();
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
        fireEvent.click(screen.getByText('Engineer'));
      });
      await act(async () => {
        fireEvent.change(screen.getByPlaceholderText('Describe what needs to change...'), {
          target: { value: 'Please add a test for X' },
        });
      });

      await act(async () => {
        fireEvent.click(screen.getByText('Send to Engineer'));
      });

      expect(mockRejectTask).toHaveBeenCalledWith('task-r1', 'Please add a test for X', 'coder', undefined);
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
