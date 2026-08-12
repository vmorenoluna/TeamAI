// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { ContainerDockerMissingDialog } from '@/components/container-docker-missing-dialog';

// ── Mocks ──────────────────────────────────────────────────────────────

const mockSaveContainerConfig = vi.fn();
const mockResetDockerAvailability = vi.fn();

vi.mock('@/app/actions/containers', () => ({
  saveContainerConfig: (...args: unknown[]) => mockSaveContainerConfig(...args),
  resetDockerAvailability: (...args: unknown[]) => mockResetDockerAvailability(...args),
}));

// WebSocket mock — store the onmessage handler so tests can fire events
let wsOnMessage: ((e: MessageEvent) => void) | null = null;
const mockWsClose = vi.fn();
const mockWsAddEventListener = vi.fn((event: string, handler: unknown) => {
  if (event === 'message') wsOnMessage = handler as (e: MessageEvent) => void;
});
const mockWsRemoveEventListener = vi.fn();

class MockWebSocket {
  static CONNECTING = 0;
  readyState = 1; // OPEN
  addEventListener = mockWsAddEventListener;
  removeEventListener = mockWsRemoveEventListener;
  close = mockWsClose;
  send = vi.fn();
}

// @ts-expect-error — partial mock for happy-dom
global.WebSocket = MockWebSocket;

// ── Helpers ──────────────────────────────────────────────────────────────

function fireWsMessage(data: unknown) {
  if (wsOnMessage) {
    wsOnMessage(new MessageEvent('message', { data: JSON.stringify(data) }));
  }
}

// ── Tests ──────────────────────────────────────────────────────────────

describe('ContainerDockerMissingDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    wsOnMessage = null;
    mockSaveContainerConfig.mockResolvedValue({ enabled: false, dockerAvailable: true });
    mockResetDockerAvailability.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── Rendering ─────────────────────────────────────────────────────────

  describe('rendering', () => {
    it('renders nothing when projectPath is null', () => {
      const { container } = render(
        <ContainerDockerMissingDialog projectPath={null} />,
      );

      expect(container.innerHTML).toBe('');
    });

    it('renders nothing initially (visible is false)', () => {
      render(<ContainerDockerMissingDialog projectPath="/test/project" />);

      expect(screen.queryByText('Docker Not Running')).not.toBeInTheDocument();
    });

    it('shows dialog when container-docker-missing event fires for matching project', async () => {
      render(<ContainerDockerMissingDialog projectPath="/test/project" />);

      await act(async () => {
        fireWsMessage({ type: 'container-docker-missing', projectRoot: '/test/project' });
      });

      await waitFor(() => {
        expect(screen.getByText('Docker Not Running')).toBeInTheDocument();
      });
    });

    it('ignores container-docker-missing events for other projects', async () => {
      render(<ContainerDockerMissingDialog projectPath="/test/project" />);

      await act(async () => {
        fireWsMessage({ type: 'container-docker-missing', projectRoot: '/other/project' });
      });

      expect(screen.queryByText('Docker Not Running')).not.toBeInTheDocument();
    });

    it('ignores non-container-docker-missing WebSocket messages', async () => {
      render(<ContainerDockerMissingDialog projectPath="/test/project" />);

      await act(async () => {
        fireWsMessage({ type: 'phase-change', taskId: 'abc' });
      });

      expect(screen.queryByText('Docker Not Running')).not.toBeInTheDocument();
    });
  });

  // ── Buttons ────────────────────────────────────────────────────────────

  describe('buttons', () => {
    async function showDialog() {
      render(<ContainerDockerMissingDialog projectPath="/test/project" />);
      await act(async () => {
        fireWsMessage({ type: 'container-docker-missing', projectRoot: '/test/project' });
      });
      await waitFor(() => {
        expect(screen.getByText('Docker Not Running')).toBeInTheDocument();
      });
    }

    it('has a Disable Container Mode button', async () => {
      await showDialog();

      expect(screen.getByText('Disable Container Mode')).toBeInTheDocument();
    });

    it('has an I\'ve Started Docker button', async () => {
      await showDialog();

      expect(screen.getByText(/I.*ve Started Docker/)).toBeInTheDocument();
    });

    it('calls saveContainerConfig with enabled:false when Disable Container Mode is clicked', async () => {
      await showDialog();

      fireEvent.click(screen.getByText('Disable Container Mode'));

      await waitFor(() => {
        expect(mockSaveContainerConfig).toHaveBeenCalledWith({ enabled: false });
      });
    });

    it('closes dialog after successfully disabling container mode', async () => {
      await showDialog();

      fireEvent.click(screen.getByText('Disable Container Mode'));

      await waitFor(() => {
        expect(screen.queryByText('Docker Not Running')).not.toBeInTheDocument();
      });
    });

    it('calls resetDockerAvailability when I\'ve Started Docker is clicked', async () => {
      await showDialog();

      fireEvent.click(screen.getByText(/I.*ve Started Docker/));

      await waitFor(() => {
        expect(mockResetDockerAvailability).toHaveBeenCalled();
      });
    });

    it('closes dialog after clicking I\'ve Started Docker', async () => {
      await showDialog();

      fireEvent.click(screen.getByText(/I.*ve Started Docker/));

      await waitFor(() => {
        expect(screen.queryByText('Docker Not Running')).not.toBeInTheDocument();
      });
    });

    it('shows loading text on I\'ve Started Docker while checking', async () => {
      // Keep the promise pending so we can observe the loading state
      mockResetDockerAvailability.mockReturnValue(new Promise(() => {}));

      await showDialog();

      await act(async () => {
        fireEvent.click(screen.getByText(/I.*ve Started Docker/));
      });

      expect(screen.getByText(/Checking Docker/)).toBeInTheDocument();
    });

    it('keeps dialog open when Disable Container Mode fails', async () => {
      mockSaveContainerConfig.mockRejectedValue(new Error('save failed'));

      await showDialog();

      await act(async () => {
        fireEvent.click(screen.getByText('Disable Container Mode'));
      });

      // Dialog should still be visible
      expect(screen.getByText('Docker Not Running')).toBeInTheDocument();
    });

    it('disables both buttons while Disable Container Mode is in flight', async () => {
      mockSaveContainerConfig.mockReturnValue(new Promise(() => {}));

      await showDialog();

      await act(async () => {
        fireEvent.click(screen.getByText('Disable Container Mode'));
      });

      expect(screen.getByText('Disabling…')).toBeDisabled();
      expect(screen.getByRole('button', { name: /I.*ve Started Docker/ })).toBeDisabled();
    });

    it('disables both buttons while cache reset is in flight', async () => {
      mockResetDockerAvailability.mockReturnValue(new Promise(() => {}));

      await showDialog();

      await act(async () => {
        fireEvent.click(screen.getByText(/I.*ve Started Docker/));
      });

      expect(screen.getByText('Disable Container Mode')).toBeDisabled();
      expect(screen.getByRole('button', { name: /Checking Docker/ })).toBeDisabled();
    });
  });

  // ── Dismiss ────────────────────────────────────────────────────────────

  describe('dismiss', () => {
    async function showDialog() {
      render(<ContainerDockerMissingDialog projectPath="/test/project" />);
      await act(async () => {
        fireWsMessage({ type: 'container-docker-missing', projectRoot: '/test/project' });
      });
      await waitFor(() => {
        expect(screen.getByText('Docker Not Running')).toBeInTheDocument();
      });
    }

    it('closes dialog when backdrop is clicked', async () => {
      await showDialog();

      // The backdrop is the absolute-positioned div with bg-black/60
      const backdrop = document.querySelector('.bg-black\\/60');
      expect(backdrop).not.toBeNull();
      fireEvent.click(backdrop!);

      await waitFor(() => {
        expect(screen.queryByText('Docker Not Running')).not.toBeInTheDocument();
      });
    });
  });
});
