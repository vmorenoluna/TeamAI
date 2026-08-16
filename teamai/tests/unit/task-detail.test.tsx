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

  describe('spec concerns display', () => {
    it('renders spec_concerns banner even when overall is PASS', () => {
      const report = {
        overall: 'PASS' as const,
        criteria: [
          { name: 'Feature works', status: 'PASS' as const, notes: 'All good' },
        ],
        spec_concerns: [
          {
            issue: 'Threshold is unverifiable',
            reasoning: 'No committed artifact produces the required evidence.',
            suggested_fix: 'Specify the producing script and artifact.',
          },
        ],
      };

      render(<QAReportView qaReport={report} />);

      expect(screen.getByText('Spec Concerns — The specification needs revision')).toBeInTheDocument();
      expect(screen.getByText('Threshold is unverifiable')).toBeInTheDocument();
      expect(screen.getByText('No committed artifact produces the required evidence.')).toBeInTheDocument();
      expect(screen.getByText(/Specify the producing script/)).toBeInTheDocument();

      // The PASS badge still renders alongside the concerns banner.
      expect(screen.getByText('PASS')).toBeInTheDocument();
    });

    it('does NOT render spec_concerns banner when none are present', () => {
      render(<QAReportView qaReport={QA_REPORT_PASS} />);
      expect(screen.queryByText('Spec Concerns — The specification needs revision')).not.toBeInTheDocument();
    });
  });

  describe('additional issues display', () => {
    it('renders additional_issues banner with description, file, and fix', () => {
      const report = {
        overall: 'FAIL' as const,
        criteria: [
          { name: 'Feature works', status: 'PASS' as const, notes: 'All good' },
        ],
        additional_issues: [
          {
            description: 'Coder changed domain logic outside QA fix scope',
            file: 'src/main/scala/Engine.scala',
            fix_needed: 'Revert the formula change and follow the spec',
          },
        ],
      };

      render(<QAReportView qaReport={report} />);

      expect(screen.getByText('Additional Issues — Hard blockers')).toBeInTheDocument();
      expect(screen.getByText('Coder changed domain logic outside QA fix scope')).toBeInTheDocument();
      expect(screen.getByText('src/main/scala/Engine.scala')).toBeInTheDocument();
      expect(screen.getByText(/Revert the formula change/)).toBeInTheDocument();
    });

    it('falls back to message when description is missing', () => {
      const report = {
        overall: 'FAIL' as const,
        additional_issues: [
          { message: 'Regression in unrelated module' },
        ],
      };

      render(<QAReportView qaReport={report} />);
      expect(screen.getByText('Regression in unrelated module')).toBeInTheDocument();
    });

    it('does NOT render additional_issues banner when none are present', () => {
      render(<QAReportView qaReport={QA_REPORT_PASS} />);
      expect(screen.queryByText('Additional Issues — Hard blockers')).not.toBeInTheDocument();
    });
  });
});
