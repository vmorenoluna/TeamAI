// @vitest-environment happy-dom

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

import { UpdateBanner } from '@/components/update-banner';

// ── Mock electronAPI ────────────────────────────────────────────────────────

type ReadyCallback = () => void;
type ProgressCallback = (percent: number) => void;

let readyListeners: ReadyCallback[] = [];
let progressListeners: ProgressCallback[] = [];

function mockElectronAPI(overrides: Partial<Window['electronAPI']> = {}) {
  window.electronAPI = {
    getUpdateStatus: vi.fn(() =>
      Promise.resolve({ updateDownloaded: false })
    ),
    onUpdateReady: vi.fn((cb: ReadyCallback) => {
      readyListeners.push(cb);
    }),
    removeUpdateReadyListener: vi.fn(() => {
      readyListeners = [];
    }),
    onDownloadProgress: vi.fn((cb: ProgressCallback) => {
      progressListeners.push(cb);
    }),
    removeDownloadProgressListener: vi.fn(() => {
      progressListeners = [];
    }),
    installUpdate: vi.fn(),
    ...overrides,
  };
}

function fireUpdateReady() {
  act(() => {
    readyListeners.forEach((cb) => cb());
  });
}

function fireDownloadProgress(pct: number) {
  act(() => {
    progressListeners.forEach((cb) => cb(pct));
  });
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('UpdateBanner', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    readyListeners = [];
    progressListeners = [];
    mockElectronAPI();
  });

  afterEach(() => {
    delete (window as Partial<Window>).electronAPI;
  });

  // ── Hidden state ──────────────────────────────────────────────────────

  describe('when no update activity', () => {
    it('renders nothing (null)', () => {
      const { container } = render(<UpdateBanner />);
      expect(container.innerHTML).toBe('');
    });
  });

  // ── Downloading state ─────────────────────────────────────────────────

  describe('when download-progress fires', () => {
    it('shows the downloading message with percentage', () => {
      render(<UpdateBanner />);
      fireDownloadProgress(42);

      expect(screen.getByText(/Downloading update/)).toBeInTheDocument();
      expect(screen.getByText(/42%/)).toBeInTheDocument();
    });

    it('does NOT show the Install button while downloading', () => {
      render(<UpdateBanner />);
      fireDownloadProgress(10);

      expect(
        screen.queryByRole('button', { name: /Install & Restart/i })
      ).not.toBeInTheDocument();
    });

    it('shows progress bar at the given percentage', () => {
      render(<UpdateBanner />);
      fireDownloadProgress(75);

      // The inner bar has style width set
      const bar = document.querySelector('.bg-emerald-400');
      expect(bar).toBeTruthy();
      expect((bar as HTMLElement).style.width).toBe('75%');
    });

    it('updates percentage when multiple progress events arrive', () => {
      render(<UpdateBanner />);
      fireDownloadProgress(10);

      expect(screen.getByText(/10%/)).toBeInTheDocument();

      fireDownloadProgress(90);
      expect(screen.getByText(/90%/)).toBeInTheDocument();
    });
  });

  // ── Ready state ───────────────────────────────────────────────────────

  describe('when update-ready fires', () => {
    it('shows the ready message', () => {
      render(<UpdateBanner />);
      fireUpdateReady();

      expect(screen.getByText(/Update ready/)).toBeInTheDocument();
    });

    it('shows the Install & Restart button', () => {
      render(<UpdateBanner />);
      fireUpdateReady();

      const btn = screen.getByRole('button', { name: /Install & Restart/ });
      expect(btn).toBeInTheDocument();
    });

    it('does NOT show the progress bar', () => {
      render(<UpdateBanner />);
      fireUpdateReady();

      const bar = document.querySelector('.bg-emerald-400');
      expect(bar).toBeFalsy();
    });
  });

  // ── Install button click ──────────────────────────────────────────────

  describe('when Install & Restart is clicked', () => {
    it('calls installUpdate on electronAPI', () => {
      render(<UpdateBanner />);
      fireUpdateReady();

      fireEvent.click(screen.getByRole('button', { name: /Install & Restart/ }));
      expect(window.electronAPI?.installUpdate).toHaveBeenCalledTimes(1);
    });
  });

  // ── Transition: download → ready ──────────────────────────────────────

  describe('transition from downloading to ready', () => {
    it('switches from download message to ready message', () => {
      render(<UpdateBanner />);
      fireDownloadProgress(50);

      expect(screen.getByText(/Downloading/)).toBeInTheDocument();

      fireUpdateReady();

      expect(screen.getByText(/Update ready/)).toBeInTheDocument();
      expect(screen.queryByText(/Downloading/)).not.toBeInTheDocument();
    });

    it('clears progress bar and shows Install button', () => {
      render(<UpdateBanner />);
      fireDownloadProgress(50);

      fireUpdateReady();

      expect(
        screen.getByRole('button', { name: /Install & Restart/ })
      ).toBeInTheDocument();
      expect(document.querySelector('.bg-emerald-400')).toBeFalsy();
    });
  });

  // ── Persistence: getUpdateStatus returns already-downloaded ───────────

  describe('when getUpdateStatus reports update already downloaded', () => {
    it('shows the ready banner immediately on mount', async () => {
      // Override mock to return updateDownloaded: true
      mockElectronAPI({
        getUpdateStatus: vi.fn(() => Promise.resolve({ updateDownloaded: true })),
      });

      render(<UpdateBanner />);

      // Wait for the promise to resolve and re-render
      await act(async () => {
        await Promise.resolve();
        await new Promise((r) => setTimeout(r, 0));
      });

      expect(screen.getByText(/Update ready/)).toBeInTheDocument();
      expect(
        screen.getByRole('button', { name: /Install & Restart/ })
      ).toBeInTheDocument();
    });
  });
});
