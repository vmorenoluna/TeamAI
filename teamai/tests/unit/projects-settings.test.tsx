// @vitest-environment happy-dom

/**
 * Unit tests for ProjectsSettings component.
 *
 * Verifies the raw-throw regression contract: when a Server Action throws
 * (rather than returning {success:false}), the error message surfaces in a
 * dismissable role='alert' banner so the user knows what happened.
 *
 * Complements the silent-failure pattern locked in across kanban-board,
 * task-card, task-detail, review-panel.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

// ── Hoisted mocks ───────────────────────────────────────────────────────────

const mockGetAllProjectsSyncStatus = vi.fn();
const mockSyncProjectDefaults = vi.fn();

vi.mock('@/app/actions/projects', () => ({
  getAllProjectsSyncStatus: (() => mockGetAllProjectsSyncStatus()) as typeof import('@/app/actions/projects').getAllProjectsSyncStatus,
  syncProjectDefaults: ((...args: unknown[]) => mockSyncProjectDefaults(...args)) as typeof import('@/app/actions/projects').syncProjectDefaults,
}));

// use-server-mutation: run() is the success-path wrapper that triggers
// router.refresh(); we capture it to confirm the failure path does NOT
// trigger refresh on raw throws.
const mockRouterRefresh = vi.fn();

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: mockRouterRefresh }),
}));

const mockRun = vi.fn();

vi.mock('@/hooks/use-server-mutation', () => ({
  useServerMutation: () => ({ run: mockRun }),
}));

// ── Imports (after mocks) ───────────────────────────────────────────────────

import { ProjectsSettings } from '@/components/projects-settings';
import type { ProjectSyncStatus } from '@/app/actions/projects';

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeStatuses(): ProjectSyncStatus[] {
  return [
    {
      projectName: 'alpha',
      projectPath: '/path/to/alpha',
      upToDate: true,
      outdatedFiles: [],
    },
  ];
}

/** Wait for the role='alert' banner to appear with the given text. */
async function assertErrorBanner(text: string | RegExp) {
  await waitFor(() => {
    const banner = screen.getByRole('alert');
    expect(banner).toHaveTextContent(text);
  });
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('ProjectsSettings — raw-throw path (regression)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetAllProjectsSyncStatus.mockResolvedValue(makeStatuses());
    mockSyncProjectDefaults.mockResolvedValue([]);
    mockRun.mockImplementation(async (cb: () => Promise<void>) => {
      await cb();
    });
  });

  it('surfaces role="alert" banner when mount getAllProjectsSyncStatus throws', async () => {
    mockGetAllProjectsSyncStatus.mockRejectedValueOnce(new Error('init failed: db offline'));

    render(<ProjectsSettings />);

    await assertErrorBanner(/init failed: db offline/);
  });

  it('displays loading state then error banner on mount throw', async () => {
    mockGetAllProjectsSyncStatus.mockRejectedValueOnce(new Error('Failed to refresh project status'));

    render(<ProjectsSettings />);

    // After error, the loading text is gone, and the role='alert' banner is up.
    await assertErrorBanner('Failed to refresh project status');
    expect(screen.queryByText(/Loading project status…/)).not.toBeInTheDocument();
  });

  it('surfaces role="alert" banner when handleRefresh click throws', async () => {
    // First call (mount) succeeds, second call (Refresh) throws.
    mockGetAllProjectsSyncStatus.mockResolvedValueOnce(makeStatuses());
    mockGetAllProjectsSyncStatus.mockRejectedValueOnce(
      new Error('refresh failed: timeout'),
    );

    render(<ProjectsSettings />);

    // Wait for the first successful load
    await waitFor(() => {
      expect(screen.getByText('alpha')).toBeInTheDocument();
    });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    });

    await assertErrorBanner('refresh failed: timeout');
  });

  it('renders Sync error inline via syncResults[…] — does NOT use role="alert"', async () => {
    // Mount succeeds, then syncProjectDefaults throws.
    mockGetAllProjectsSyncStatus.mockResolvedValueOnce([
      {
        projectName: 'beta',
        projectPath: '/path/to/beta',
        upToDate: false,
        outdatedFiles: ['spec.md', 'plan.md'],
      },
    ]);
    mockSyncProjectDefaults.mockRejectedValueOnce(new Error('sync threw: fs locked'));

    render(<ProjectsSettings />);

    await waitFor(() => {
      expect(screen.getByText('beta')).toBeInTheDocument();
    });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Sync' }));
    });

    await waitFor(() => {
      // Sync records error inline next to the project row.
      expect(screen.getByText(/\(Sync failed: sync threw: fs locked\)/)).toBeInTheDocument();
    });

    // BUT no role='alert' banner — sync errors are reported inline per row.
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('dismiss button (✕) clears the role="alert" banner', async () => {
    mockGetAllProjectsSyncStatus.mockRejectedValueOnce(new Error('some throw'));

    render(<ProjectsSettings />);

    await assertErrorBanner(/some throw/);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Dismiss error' }));
    });

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('dismiss button does not unmount the component (Refresh button still rendered)', async () => {
    mockGetAllProjectsSyncStatus.mockRejectedValueOnce(new Error('initial throw'));

    render(<ProjectsSettings />);

    await assertErrorBanner(/initial throw/);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Dismiss error' }));
    });

    // Component still renders the section header.
    expect(screen.getByText('Project Defaults')).toBeInTheDocument();
    // Refresh button still present.
    expect(screen.getByRole('button', { name: 'Refresh' })).toBeInTheDocument();
  });

  it('a subsequent successful Refresh clears a prior error banner', async () => {
    // First call (mount) throws; second call (Refresh) succeeds.
    mockGetAllProjectsSyncStatus.mockRejectedValueOnce(new Error('first load broken'));
    mockGetAllProjectsSyncStatus.mockResolvedValueOnce(makeStatuses());

    render(<ProjectsSettings />);

    await assertErrorBanner('first load broken');

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    });

    await waitFor(() => {
      // Refresh handler clears error before reloading.
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      expect(screen.getByText('alpha')).toBeInTheDocument();
    });
  });
});
