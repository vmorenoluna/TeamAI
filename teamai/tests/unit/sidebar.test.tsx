// @vitest-environment happy-dom

/** Unit tests for the Sidebar — the Role Refinement pending-count badge on the
 *  Settings nav item (Phase 2). */

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

const mockPathname = vi.hoisted(() => vi.fn(() => '/'));

vi.mock('next/navigation', () => ({
  usePathname: () => mockPathname(),
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));

import { Sidebar } from '@/components/sidebar';

describe('Sidebar refinement badge', () => {
  it('shows the pending count bubble on Settings when there are suggestions', () => {
    render(<Sidebar projects={[]} activeProjectPath={null} refinementPendingCount={3} />);
    const badge = screen.getByTestId('sidebar-refinement-badge');
    expect(badge).toBeInTheDocument();
    expect(badge.textContent).toBe('3');
  });

  it('renders no badge when the count is zero or omitted', () => {
    const { rerender } = render(<Sidebar projects={[]} activeProjectPath={null} refinementPendingCount={0} />);
    expect(screen.queryByTestId('sidebar-refinement-badge')).not.toBeInTheDocument();

    rerender(<Sidebar projects={[]} activeProjectPath={null} />);
    expect(screen.queryByTestId('sidebar-refinement-badge')).not.toBeInTheDocument();
  });

  it('still renders the Settings link when no badge is shown', () => {
    render(<Sidebar projects={[]} activeProjectPath={null} />);
    expect(screen.getByText('Settings')).toBeInTheDocument();
  });
});
