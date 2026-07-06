// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { ProjectSelector } from '@/components/project-selector';
import type { Project } from '@/lib/project-store';

// ── Mocks ──────────────────────────────────────────────────────────────

const mockRouterRefresh = vi.fn();

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    refresh: mockRouterRefresh,
    push: vi.fn(),
    prefetch: vi.fn(),
  }),
}));

const mockAddProject = vi.fn();
const mockSetActiveProject = vi.fn();
const mockRemoveProject = vi.fn();

vi.mock('@/app/actions/projects', () => ({
  addProject: (...args: unknown[]) => mockAddProject(...args),
  setActiveProject: (...args: unknown[]) => mockSetActiveProject(...args),
  removeProject: (...args: unknown[]) => mockRemoveProject(...args),
}));

// Don't render the directory browser — we don't exercise it here.
vi.mock('@/components/directory-browser', () => ({
  DirectoryBrowser: () => null,
}));

// Mock useTransition so async callbacks resolve synchronously for the
// happy-dom environment. See auto-mode-button.test.tsx for rationale.
vi.mock('react', async () => {
  const actual = await vi.importActual<typeof import('react')>('react');
  return {
    ...actual,
    useTransition: () => {
      const [isPending, setIsPending] = actual.useState(false);
      function startTransition(cb: () => void) {
        setIsPending(true);
        try {
          const result = cb();
          if (result != null && typeof (result as Promise<unknown>).then === 'function') {
            (result as Promise<unknown>).finally(() => setIsPending(false));
          } else {
            setIsPending(false);
          }
        } catch {
          setIsPending(false);
        }
      }
      return [isPending, startTransition] as [boolean, (cb: () => void) => void];
    },
  };
});

// ── Fixtures ───────────────────────────────────────────────────────────

const projects: Project[] = [
  { name: 'existing', path: '/home/user/existing', addedAt: new Date().toISOString() },
];

// ── Helpers ────────────────────────────────────────────────────────────

function openAddDialog() {
  fireEvent.click(screen.getByTitle('Add project'));
}

function typePath(path: string) {
  fireEvent.change(screen.getByPlaceholderText('/home/user/my-project'), {
    target: { value: path },
  });
}

function submitForm() {
  // Submit button text is "Add Project" — accessible name is exact match,
  // doesn't collide with the + tab button (whose accessible name is "+").
  fireEvent.click(screen.getByRole('button', { name: 'Add Project' }));
}

// ── Tests ──────────────────────────────────────────────────────────────

describe('ProjectSelector — Add Project dialog', () => {
  // Restore console.error between tests so the spy doesn't leak into other
  // test files in the same Vitest worker. We capture the original at the
  // describe scope and assign vi.fn() instead of using vi.spyOn (avoiding
  // ReturnType<typeof vi.spyOn> variance noise under strict mode) and also
  // avoid vi.restoreAllMocks() because it would un-mock the vi.mock()
  // factory mocks like mockAddProject.
  const originalConsoleError = console.error;

  beforeEach(() => {
    vi.clearAllMocks();
    mockAddProject.mockResolvedValue({ ok: true });
    mockSetActiveProject.mockResolvedValue(undefined);
    mockRemoveProject.mockResolvedValue(undefined);
    // Silences the hook's console.error('action threw:') which fires for the
    // throw-test cases. We're testing the component, not the hook's logging.
    console.error = vi.fn();
  });

  afterEach(() => {
    console.error = originalConsoleError;
  });

  // ── Dialog open / close ─────────────────────────────────────────────

  describe('dialog open/close', () => {
    it('opens the dialog when the + button is clicked', () => {
      render(<ProjectSelector projects={projects} activeProjectPath={null} />);
      expect(screen.queryByRole('heading', { name: 'Add Project' })).not.toBeInTheDocument();

      openAddDialog();

      expect(screen.getByRole('heading', { name: 'Add Project' })).toBeInTheDocument();
    });

    it('closes the dialog when Cancel is clicked', () => {
      render(<ProjectSelector projects={projects} activeProjectPath={null} />);

      openAddDialog();
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

      expect(screen.queryByRole('heading', { name: 'Add Project' })).not.toBeInTheDocument();
    });

    it('does not render the dialog when collapsed=true', () => {
      render(<ProjectSelector projects={projects} activeProjectPath={null} collapsed={true} />);

      expect(screen.queryByTitle('Add project')).not.toBeInTheDocument();
    });
  });

  // ── Success path ─────────────────────────────────────────────────────

  describe('success path', () => {
    it('calls addProject with the path from FormData', async () => {
      render(<ProjectSelector projects={projects} activeProjectPath={null} />);

      openAddDialog();
      typePath('/home/user/new');
      submitForm();

      await waitFor(() => {
        expect(mockAddProject).toHaveBeenCalledTimes(1);
      });

      const formData = mockAddProject.mock.calls[0][0] as FormData;
      expect(formData).toBeInstanceOf(FormData);
      expect(formData.get('path')).toBe('/home/user/new');
    });

    it('closes the dialog and refreshes the router on success', async () => {
      render(<ProjectSelector projects={projects} activeProjectPath={null} />);

      openAddDialog();
      typePath('/home/user/new');
      submitForm();

      await waitFor(() => {
        expect(mockRouterRefresh).toHaveBeenCalledTimes(1);
      });
      expect(screen.queryByRole('heading', { name: 'Add Project' })).not.toBeInTheDocument();
    });
  });

  // ── Bug fix: thrown errors must surface to the dialog ───────────────

  describe('error handling', () => {
    it('shows the error message when addProject throws an Error (the original bug)', async () => {
      // This is THE regression test: before the fix, addProject throwing
      // made the button appear to do nothing — the throw was swallowed by
      // useServerMutation's empty catch and no UI feedback was shown.
      mockAddProject.mockRejectedValue(new Error('Server Action ID is invalid'));

      render(<ProjectSelector projects={projects} activeProjectPath={null} />);

      openAddDialog();
      typePath('/some/path');
      submitForm();

      await waitFor(() => {
        expect(screen.getByText('Server Action ID is invalid')).toBeInTheDocument();
      });
    });

    it('shows returned error message when addProject returns {error}', async () => {
      mockAddProject.mockResolvedValue({
        error: 'This project is already registered.',
      });

      render(<ProjectSelector projects={projects} activeProjectPath={null} />);

      openAddDialog();
      typePath('/home/user/existing');
      submitForm();

      await waitFor(() => {
        expect(screen.getByText('This project is already registered.')).toBeInTheDocument();
      });
    });

    it('falls back to a generic message when addProject throws a non-Error', async () => {
      // Defensive: any thrown value (string, object, undefined) should
      // produce a visible error message — never silent failure.
      mockAddProject.mockRejectedValue('plain string rejection');

      render(<ProjectSelector projects={projects} activeProjectPath={null} />);

      openAddDialog();
      typePath('/some/path');
      submitForm();

      await waitFor(() => {
        expect(screen.getByText('Failed to add project')).toBeInTheDocument();
      });
    });

    it('keeps the dialog open on error so the user can retry', async () => {
      mockAddProject.mockRejectedValue(new Error('Network error'));

      render(<ProjectSelector projects={projects} activeProjectPath={null} />);

      openAddDialog();
      typePath('/some/path');
      submitForm();

      await waitFor(() => {
        expect(screen.getByText('Network error')).toBeInTheDocument();
      });

      expect(screen.getByRole('heading', { name: 'Add Project' })).toBeInTheDocument();
    });

    it('does not call router.refresh() on failure', async () => {
      mockAddProject.mockRejectedValue(new Error('Network error'));

      render(<ProjectSelector projects={projects} activeProjectPath={null} />);

      openAddDialog();
      typePath('/some/path');
      submitForm();

      await waitFor(() => {
        expect(screen.getByText('Network error')).toBeInTheDocument();
      });

      expect(mockRouterRefresh).not.toHaveBeenCalled();
    });

    it('clears the previous error when the dialog is reopened after Cancel', async () => {
      mockAddProject.mockRejectedValueOnce(new Error('First error'));

      render(<ProjectSelector projects={projects} activeProjectPath={null} />);

      openAddDialog();
      typePath('/some/path');
      submitForm();

      await waitFor(() => {
        expect(screen.getByText('First error')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
      openAddDialog();

      expect(screen.queryByText('First error')).not.toBeInTheDocument();
    });
  });

  // ── Submit button states ────────────────────────────────────────────

  describe('submit button states', () => {
    it('shows "Adding…" text while addProject is pending', async () => {
      // Never-resolving promise keeps the action pending so we can observe
      // the in-flight state.
      mockAddProject.mockImplementation(() => new Promise(() => {}));

      render(<ProjectSelector projects={projects} activeProjectPath={null} />);

      openAddDialog();
      typePath('/some/path');
      submitForm();

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /Adding/i })).toBeInTheDocument();
      });
    });
  });
});
