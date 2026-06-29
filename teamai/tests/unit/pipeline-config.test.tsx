// @vitest-environment happy-dom

/**
 * Unit tests for PipelineConfigEditor component.
 *
 * Tests the config editor lifecycle: initial render with prop values, input
 * interactions (number + checkbox), save flow (success + Saved! timer +
 * error handling), and button states (Save / Saving… / Saved! / disabled).
 *
 * React's useTransition is mocked (isPending=false, synchronous callback) to
 * isolate the component's own state logic and to avoid happy-dom's limitation
 * where disabled buttons don't fire onClick.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import type { PipelineConfig } from '@/app/actions/pipeline';

// ── Hoisted mocks ───────────────────────────────────────────────────────────

const mockSavePipelineConfig = vi.hoisted(() => vi.fn());

vi.mock('@/app/actions/pipeline', () => ({
  savePipelineConfig: ((config: PipelineConfig) =>
    mockSavePipelineConfig(config)) as typeof import('@/app/actions/pipeline').savePipelineConfig,
}));

const mockStartTransition = vi.hoisted(() =>
  vi.fn((cb: () => void) => {
    // Call the callback synchronously (matching the real startTransition
    // behaviour in non-concurrent mode) and suppress any unhandled promise
    // rejections from async callbacks — the real startTransition handles
    // these internally.
    try {
      const result = cb() as unknown;
      if (result instanceof Promise) result.catch(() => {});
    } catch {
      /* suppress sync errors too */
    }
  })
);

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>();
  return {
    ...actual,
    useTransition: () => [false, mockStartTransition],
  };
});

// ── Imports (after mocks) ───────────────────────────────────────────────────

import { PipelineConfigEditor } from '@/components/pipeline-config';

// ── Helpers ─────────────────────────────────────────────────────────────────

const defaultConfig: PipelineConfig = {
  maxQaAttempts: 3,
  parallelSubtasks: true,
  autoModeMaxParallel: 1,
};

function renderComponent(config: PipelineConfig = defaultConfig) {
  render(<PipelineConfigEditor config={config} />);
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('PipelineConfigEditor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSavePipelineConfig.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ── Initial render ───────────────────────────────────────────────────

  describe('initial render', () => {
    it('renders the Max QA attempts label and input', () => {
      renderComponent();
      expect(screen.getByText('Max QA attempts')).toBeInTheDocument();
      const input = screen.getAllByRole('spinbutton')[0];
      expect(input).toBeInTheDocument();
      expect(input).toHaveValue(3);
    });

    it('renders the Parallel subtasks label and checkbox', () => {
      renderComponent();
      expect(screen.getByText('Parallel subtasks')).toBeInTheDocument();
      const checkbox = screen.getByRole('checkbox');
      expect(checkbox).toBeInTheDocument();
      expect(checkbox).toBeChecked();
    });

    it('renders the Save Pipeline Config button', () => {
      renderComponent();
      expect(
        screen.getByRole('button', { name: 'Save Pipeline Config' })
      ).toBeInTheDocument();
    });

    it('renders with custom config values from props', () => {
      renderComponent({ maxQaAttempts: 5, parallelSubtasks: false, autoModeMaxParallel: 1 });
      expect(screen.getAllByRole('spinbutton')[0]).toHaveValue(5);
      expect(screen.getByRole('checkbox')).not.toBeChecked();
    });

    it('does not show Saved! or Saving… initially', () => {
      renderComponent();
      expect(screen.queryByText('Saved!')).not.toBeInTheDocument();
      expect(screen.queryByText('Saving…')).not.toBeInTheDocument();
    });
  });

  // ── Input interactions ───────────────────────────────────────────────

  describe('input interactions', () => {
    it('updates maxQaAttempts when the number input changes', () => {
      renderComponent();
      const input = screen.getAllByRole('spinbutton')[0];
      fireEvent.change(input, { target: { value: '7' } });
      expect(input).toHaveValue(7);
    });

    it('toggles parallelSubtasks when the checkbox is clicked', () => {
      renderComponent({ maxQaAttempts: 3, parallelSubtasks: true, autoModeMaxParallel: 1 });
      const checkbox = screen.getByRole('checkbox');
      fireEvent.click(checkbox);
      expect(checkbox).not.toBeChecked();
      fireEvent.click(checkbox);
      expect(checkbox).toBeChecked();
    });

    it('defaults parallelSubtasks to unchecked when config says false', () => {
      renderComponent({ maxQaAttempts: 3, parallelSubtasks: false, autoModeMaxParallel: 1 });
      expect(screen.getByRole('checkbox')).not.toBeChecked();
    });
  });

  // ── Save flow ────────────────────────────────────────────────────────

  describe('save flow', () => {
    it('calls savePipelineConfig with current values on save click', async () => {
      renderComponent();

      // Change values to non-defaults
      fireEvent.change(screen.getAllByRole('spinbutton')[0], { target: { value: '4' } });
      fireEvent.click(screen.getByRole('checkbox'));

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Save Pipeline Config' }));
      });

      expect(mockSavePipelineConfig).toHaveBeenCalledWith({
        maxQaAttempts: 4,
        parallelSubtasks: false,
        autoModeMaxParallel: 1,
      });
    });

    it('shows Saved! after successful save', async () => {
      renderComponent();

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Save Pipeline Config' }));
      });

      expect(screen.getByText('Saved!')).toBeInTheDocument();
    });

    it('does not show Saved! when the transition callback is not invoked', () => {
      // When startTransition never calls the callback, savePipelineConfig is
      // never reached, so setSaved(true) never runs.
      mockStartTransition.mockImplementationOnce(() => {
        // Don't call the callback — simulates a pending transition.
      });

      renderComponent();

      act(() => {
        fireEvent.click(screen.getByRole('button', { name: 'Save Pipeline Config' }));
      });

      // Button stays at "Save Pipeline Config" — Saved! never appears.
      expect(screen.queryByText('Saved!')).not.toBeInTheDocument();
      expect(
        screen.getByRole('button', { name: 'Save Pipeline Config' })
      ).toBeInTheDocument();
    });

    it('reverts Saved! back to Save Pipeline Config after 2 seconds', async () => {
      vi.useFakeTimers();
      renderComponent();

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Save Pipeline Config' }));
      });

      expect(screen.getByText('Saved!')).toBeInTheDocument();

      // Advance past 2 seconds
      await act(async () => {
        vi.advanceTimersByTime(2100);
      });

      expect(screen.queryByText('Saved!')).not.toBeInTheDocument();
      expect(
        screen.getByRole('button', { name: 'Save Pipeline Config' })
      ).toBeInTheDocument();
    });

    it('does not revert Saved! before 2 seconds', async () => {
      vi.useFakeTimers();
      renderComponent();

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Save Pipeline Config' }));
      });

      expect(screen.getByText('Saved!')).toBeInTheDocument();

      // Advance only 1 second — Saved! should still be showing
      await act(async () => {
        vi.advanceTimersByTime(1000);
      });

      expect(screen.getByText('Saved!')).toBeInTheDocument();
    });

    it('uses savePipelineConfig with default config values when unchanged', async () => {
      renderComponent();

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Save Pipeline Config' }));
      });

      expect(mockSavePipelineConfig).toHaveBeenCalledWith(defaultConfig);
    });
  });

  // ── Error handling ───────────────────────────────────────────────────

  describe('error handling', () => {
    it('does not show Saved! when save fails', async () => {
      mockSavePipelineConfig.mockRejectedValue(new Error('Save failed'));

      renderComponent();

      // The component catches errors in startTransition — we need to see
      // if the error is swallowed or surfaced.
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Save Pipeline Config' }));
      });

      // The component's catch block is empty (no error state), so Saved!
      // should NOT appear since setSaved(true) is not reached on rejection.
      expect(screen.queryByText('Saved!')).not.toBeInTheDocument();
      // Button should return to its idle label since the catch ran and
      // the transition finished.
      expect(
        screen.getByRole('button', { name: 'Save Pipeline Config' })
      ).toBeInTheDocument();
    });

    it('allows retrying save after a failure', async () => {
      mockSavePipelineConfig.mockRejectedValueOnce(new Error('First fail'));
      mockSavePipelineConfig.mockResolvedValueOnce(undefined);

      renderComponent();

      // First save — fails
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Save Pipeline Config' }));
      });

      expect(screen.queryByText('Saved!')).not.toBeInTheDocument();

      // Second save — succeeds
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Save Pipeline Config' }));
      });

      await waitFor(() => {
        expect(screen.getByText('Saved!')).toBeInTheDocument();
      });

      expect(mockSavePipelineConfig).toHaveBeenCalledTimes(2);
    });
  });

  // ── Prop changes ─────────────────────────────────────────────────────

  describe('prop initialization', () => {
    it('initializes state from props on first render', () => {
      // Render with non-default values
      const { rerender } = render(
        <PipelineConfigEditor config={{ maxQaAttempts: 1, parallelSubtasks: false, autoModeMaxParallel: 1 }} />
      );

      expect(screen.getAllByRole('spinbutton')[0]).toHaveValue(1);
      expect(screen.getByRole('checkbox')).not.toBeChecked();

      // NOTE: The component uses useState(config.maxQaAttempts) without
      // a useEffect to re-sync, so prop changes after initial render don't
      // update the input values — this is the expected behaviour.
      rerender(
        <PipelineConfigEditor config={{ maxQaAttempts: 8, parallelSubtasks: true, autoModeMaxParallel: 1 }} />
      );

      // Values remain at the initial render values, not the new props.
      expect(screen.getAllByRole('spinbutton')[0]).toHaveValue(1);
      expect(screen.getByRole('checkbox')).not.toBeChecked();
    });
  });

  // ── Edge cases ───────────────────────────────────────────────────────

  describe('edge cases', () => {
    it('handles maxQaAttempts at the minimum boundary (1)', () => {
      renderComponent({ maxQaAttempts: 1, parallelSubtasks: true, autoModeMaxParallel: 1 });
      expect(screen.getAllByRole('spinbutton')[0]).toHaveValue(1);
    });

    it('handles maxQaAttempts at the maximum boundary (10)', () => {
      renderComponent({ maxQaAttempts: 10, parallelSubtasks: true, autoModeMaxParallel: 1 });
      expect(screen.getAllByRole('spinbutton')[0]).toHaveValue(10);
    });

    it('saves immediately after toggling parallelSubtasks', async () => {
      renderComponent({ maxQaAttempts: 2, parallelSubtasks: true, autoModeMaxParallel: 1 });

      fireEvent.click(screen.getByRole('checkbox'));

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Save Pipeline Config' }));
      });

      expect(mockSavePipelineConfig).toHaveBeenCalledWith({
        maxQaAttempts: 2,
        parallelSubtasks: false,
        autoModeMaxParallel: 1,
      });
    });

    it('multiple rapid saves all call savePipelineConfig', async () => {
      vi.useFakeTimers();
      renderComponent();

      // First save
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Save Pipeline Config' }));
      });
      expect(screen.getByText('Saved!')).toBeInTheDocument();

      // Advance past the 2s "Saved!" timeout so the button reverts
      await act(async () => {
        vi.advanceTimersByTime(2100);
      });

      // Second save
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Save Pipeline Config' }));
      });

      // Advance again
      await act(async () => {
        vi.advanceTimersByTime(2100);
      });

      // Third save
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Save Pipeline Config' }));
      });

      expect(mockSavePipelineConfig).toHaveBeenCalledTimes(3);
    });
  });
});
