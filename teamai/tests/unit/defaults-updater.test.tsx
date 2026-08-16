// @vitest-environment happy-dom

/**
 * Unit tests for the DefaultsUpdater informational auto-sync banner.
 *
 * The banner shows what was force-synced at startup (no click-to-sync action)
 * and can be dismissed. The store logic that produces the report is covered in
 * project-store.test.ts; these tests cover rendering + dismissal.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

import { DefaultsUpdater } from '@/components/defaults-updater';
import type { DefaultsSyncReport } from '@/lib/project-store';

// ── Mock server action ─────────────────────────────────────────────────────

const mockDismiss = vi.fn();

vi.mock('@/app/actions/projects', () => ({
  dismissDefaultsSyncReport: () => mockDismiss(),
}));

function makeReport(): DefaultsSyncReport {
  return {
    syncedAt: '2026-08-16T00:00:00.000Z',
    projects: [
      {
        projectName: 'alpha',
        projectPath: '/path/to/alpha',
        updatedFiles: [
          'commands/implement.md',
          'commands/qa-review.md',
          'commands/merge.md',
          'commands/spec.md',
        ],
      },
    ],
  };
}

describe('DefaultsUpdater', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDismiss.mockResolvedValue(undefined);
  });

  it('renders nothing when no report is provided', () => {
    const { container } = render(<DefaultsUpdater initialReport={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing when the report has no projects', () => {
    const { container } = render(
      <DefaultsUpdater initialReport={{ syncedAt: 'x', projects: [] }} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('renders the banner with the project name and synced-file summary', () => {
    render(<DefaultsUpdater initialReport={makeReport()} />);

    expect(screen.getByText('TeamAI defaults auto-synced')).toBeInTheDocument();
    expect(screen.getByText('alpha')).toBeInTheDocument();

    const listItem = screen.getByText('alpha').closest('li')!;
    expect(listItem).toHaveTextContent('4 files');
    expect(listItem).toHaveTextContent('commands/implement.md');
    // Long file lists truncate to the first 3 with a "+N more" suffix.
    expect(listItem).toHaveTextContent('+1 more');
  });

  it('dismissing hides the banner and calls the dismiss action', async () => {
    render(<DefaultsUpdater initialReport={makeReport()} />);

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));

    await waitFor(() => expect(mockDismiss).toHaveBeenCalledTimes(1));
    expect(screen.queryByText('TeamAI defaults auto-synced')).not.toBeInTheDocument();
  });
});
