// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { QAReportView } from '@/components/task-detail';

// ── Fixtures ───────────────────────────────────────────────────────────

const QA_REPORT_PASS = {
  overall: 'PASS' as const,
  criteria: [
    { name: 'Feature works', status: 'PASS' as const, notes: 'All good' },
  ],
};

// ── Tests ──────────────────────────────────────────────────────────────

describe('QAReportView', () => {
  describe('human feedback display', () => {
    it('renders amber human feedback banner when humanFeedback is passed (with qaReport)', () => {
      render(
        <QAReportView
          qaReport={QA_REPORT_PASS}
          humanFeedback="Fix the header alignment on mobile"
        />,
      );

      // The amber banner should be visible
      expect(screen.getByText('Human Reviewer Feedback')).toBeInTheDocument();
      expect(screen.getByText('Fix the header alignment on mobile')).toBeInTheDocument();

      // QA report criteria should also still render
      expect(screen.getByText('PASS')).toBeInTheDocument();
      expect(screen.getByText('Feature works')).toBeInTheDocument();
    });

    it('renders amber human feedback banner when humanFeedback is passed (without qaReport)', () => {
      render(
        <QAReportView
          qaReport={null}
          humanFeedback="Fix the header alignment on mobile"
        />,
      );

      // The amber banner should be visible even without a qaReport
      expect(screen.getByText('Human Reviewer Feedback')).toBeInTheDocument();
      expect(screen.getByText('Fix the header alignment on mobile')).toBeInTheDocument();

      // No QA criteria should render
      expect(screen.queryByText('PASS')).not.toBeInTheDocument();
    });

    it('does NOT render human feedback banner when humanFeedback is null', () => {
      render(
        <QAReportView
          qaReport={QA_REPORT_PASS}
          humanFeedback={null}
        />,
      );

      // The amber banner should NOT be visible
      expect(screen.queryByText('Human Reviewer Feedback')).not.toBeInTheDocument();

      // QA report criteria should still render
      expect(screen.getByText('PASS')).toBeInTheDocument();
      expect(screen.getByText('Feature works')).toBeInTheDocument();
    });

    it('shows empty state when both qaReport and humanFeedback are null', () => {
      render(
        <QAReportView
          qaReport={null}
          humanFeedback={null}
        />,
      );

      expect(screen.getByText('No QA report generated yet.')).toBeInTheDocument();
      expect(screen.queryByText('Human Reviewer Feedback')).not.toBeInTheDocument();
    });
  });
});
