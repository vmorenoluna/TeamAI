// @vitest-environment happy-dom

/**
 * Unit tests for RoleEditor component.
 *
 * Verifies the raw-throw regression contract for handleSave and handleReset:
 * when the underlying Server Action throws, the error message surfaces in a
 * dismissable role='alert' banner instead of vanishing silently into
 * useTransition's empty catch.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

// ── Hoisted mocks ───────────────────────────────────────────────────────────

const mockSaveRole = vi.fn();
const mockResetRole = vi.fn();

vi.mock('@/app/actions/roles', () => ({
  saveRole: ((...args: unknown[]) => mockSaveRole(...args)) as typeof import('@/app/actions/roles').saveRole,
  resetRole: ((...args: unknown[]) => mockResetRole(...args)) as typeof import('@/app/actions/roles').resetRole,
}));

const mockStartTransition = vi.fn();

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>();
  return {
    ...actual,
    useTransition: () => [false, mockStartTransition],
  };
});

// ── Imports (after mocks) ───────────────────────────────────────────────────

import { RoleEditor } from '@/components/role-editor';
import type { RoleDefinition } from '@/app/actions/roles';

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeRole(): RoleDefinition {
  return {
    name: 'analyst',
    filename: 'analyst.md',
    content: 'You are an analyst.',
  };
}

/** Open the role-editor so the textarea is rendered. */
async function openEditor() {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: /analyst/ }));
  });
}

/** Wait for the role='alert' banner to appear with the given text. */
async function assertErrorBanner(text: string | RegExp) {
  await waitFor(() => {
    const banner = screen.getByRole('alert');
    expect(banner).toHaveTextContent(text);
  });
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('RoleEditor — raw-throw path (regression)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSaveRole.mockResolvedValue(undefined);
    mockResetRole.mockResolvedValue('DEFAULT CONTENT');
    mockStartTransition.mockImplementation((cb: () => void | Promise<void>) => cb());
  });

  describe('handleSave', () => {
    it('surfaces role="alert" banner when saveRole throws', async () => {
      mockSaveRole.mockRejectedValueOnce(new Error('disk full'));

      render(<RoleEditor role={makeRole()} />);
      await openEditor();

      // Modify content so dirty=true (button enabled).
      const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
      fireEvent.change(textarea, { target: { value: 'some new content' } });

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Save' }));
      });

      await assertErrorBanner('Failed to save role: disk full');
    });

    it('preserves dirty content after save throws (so the user can retry)', async () => {
      mockSaveRole.mockRejectedValueOnce(new Error('write lock'));

      render(<RoleEditor role={makeRole()} />);
      await openEditor();

      const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
      const edited = 'attempted edit to be saved';
      fireEvent.change(textarea, { target: { value: edited } });

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Save' }));
      });

      await assertErrorBanner(/Failed to save role: write lock/);
      // User can still see and re-edit their content.
      expect(textarea.value).toBe(edited);
    });

    it('does not show "Saved!" indicator when saveRole throws', async () => {
      mockSaveRole.mockRejectedValueOnce(new Error('IO error'));

      render(<RoleEditor role={makeRole()} />);
      await openEditor();

      const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
      fireEvent.change(textarea, { target: { value: 'edit' } });

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Save' }));
      });

      await assertErrorBanner(/IO error/);
      expect(screen.queryByText('Saved!')).not.toBeInTheDocument();
    });
  });

  describe('handleReset', () => {
    it('surfaces role="alert" banner when resetRole throws', async () => {
      mockResetRole.mockRejectedValueOnce(new Error('default missing'));

      render(<RoleEditor role={makeRole()} />);
      await openEditor();

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Reset to default' }));
      });

      await assertErrorBanner('Failed to reset role: default missing');
    });

    it('preserves current (potentially dirty) content after reset throws', async () => {
      mockResetRole.mockRejectedValueOnce(new Error('reset failed'));

      render(<RoleEditor role={makeRole()} />);
      await openEditor();

      const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
      const edited = 'user edit before reset attempt';
      fireEvent.change(textarea, { target: { value: edited } });

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Reset to default' }));
      });

      await assertErrorBanner(/Failed to reset role: reset failed/);
      // Reset did NOT clobber the user's edit.
      expect(textarea.value).toBe(edited);
    });
  });

  describe('error lifecycle', () => {
    it('dismiss button (✕) clears the role="alert" banner', async () => {
      mockSaveRole.mockRejectedValueOnce(new Error('temporary'));

      render(<RoleEditor role={makeRole()} />);
      await openEditor();

      const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
      fireEvent.change(textarea, { target: { value: 'edit' } });

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Save' }));
      });

      await assertErrorBanner(/temporary/);

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Dismiss error' }));
      });

      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });

    it('a subsequent click clears any prior error before re-running the action', async () => {
      // First save throws, second save succeeds.
      mockSaveRole.mockRejectedValueOnce(new Error('first attempt fails'));
      mockSaveRole.mockResolvedValueOnce(undefined);

      render(<RoleEditor role={makeRole()} />);
      await openEditor();

      const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
      fireEvent.change(textarea, { target: { value: 'first edit' } });

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Save' }));
      });
      await assertErrorBanner(/first attempt fails/);

      // Now edit again and save successfully.
      fireEvent.change(textarea, { target: { value: 'second edit' } });
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Save' }));
      });

      // Banner cleared and "Saved!" indicator shown.
      await waitFor(() => {
        expect(screen.queryByRole('alert')).not.toBeInTheDocument();
        expect(screen.getByText('Saved!')).toBeInTheDocument();
      });
    });

    it('error message uses raw err.message fallback for non-Error rejects', async () => {
      // Some non-Error rejection shape — ensures `err instanceof Error` guard works.
      mockSaveRole.mockRejectedValueOnce('plain string reason');

      render(<RoleEditor role={makeRole()} />);
      await openEditor();

      const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
      fireEvent.change(textarea, { target: { value: 'edit' } });

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Save' }));
      });

      await assertErrorBanner('Failed to save role: Unknown error');
    });
  });
});
