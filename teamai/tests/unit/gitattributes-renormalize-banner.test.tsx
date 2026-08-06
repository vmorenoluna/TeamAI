// @vitest-environment happy-dom

/**
 * Unit tests for GitattributesRenormalizeBanner component.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

import { GitattributesRenormalizeBanner, resetGitattributesRenormalizeBannerDismissed } from '@/components/gitattributes-renormalize-banner';

// ── Mock server action ─────────────────────────────────────────────────────

const mockDismiss = vi.fn();

vi.mock('@/app/actions/projects', () => ({
  dismissGitattributesRenormalizeSuggestion: (...args: any[]) => mockDismiss(...args),
}));

// ── Tests ───────────────────────────────────────────────────────────────────

describe('GitattributesRenormalizeBanner', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionStorage.clear();
    resetGitattributesRenormalizeBannerDismissed();
  });

  it('returns null when projectPath is empty', () => {
    render(<GitattributesRenormalizeBanner projectPath="" />);
    expect(screen.queryByText(/gitattributes/)).not.toBeInTheDocument();
  });

  it('renders banner with the renormalize command when projectPath is set', () => {
    render(<GitattributesRenormalizeBanner projectPath="/test/project" />);
    expect(screen.getByText(/New .gitattributes added/)).toBeInTheDocument();
    expect(screen.getByText(/git add --renormalize \./)).toBeInTheDocument();
  });

  it('has a dismiss X button', () => {
    render(<GitattributesRenormalizeBanner projectPath="/test/project" />);
    const dismissButton = screen.getByTitle('Dismiss');
    expect(dismissButton).toBeInTheDocument();
  });

  it('hides the banner and calls dismiss server action when X button is clicked', async () => {
    render(<GitattributesRenormalizeBanner projectPath="/test/project" />);

    const dismissButton = screen.getByTitle('Dismiss');
    fireEvent.click(dismissButton);

    expect(screen.queryByText(/gitattributes/)).not.toBeInTheDocument();
    // The server action should be called to delete the marker file from disk.
    await vi.waitFor(() => {
      expect(mockDismiss).toHaveBeenCalled();
    });
  });

  it('stays hidden across re-renders after dismissal (sessionStorage-based)', () => {
    const { rerender, unmount } = render(
      <GitattributesRenormalizeBanner projectPath="/test/project" />,
    );

    fireEvent.click(screen.getByTitle('Dismiss'));
    expect(screen.queryByText(/gitattributes/)).not.toBeInTheDocument();

    // Re-render with same path — stays hidden
    rerender(<GitattributesRenormalizeBanner projectPath="/test/project" />);
    expect(screen.queryByText(/gitattributes/)).not.toBeInTheDocument();

    // Unmount + remount — still hidden via sessionStorage
    unmount();
    render(<GitattributesRenormalizeBanner projectPath="/test/project" />);
    expect(screen.queryByText(/gitattributes/)).not.toBeInTheDocument();
  });
});
