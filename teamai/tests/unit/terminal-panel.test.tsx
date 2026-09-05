// @vitest-environment happy-dom

/**
 * Unit tests for TerminalPanel's paste wiring.
 *
 * Regression coverage for the bug where Ctrl+V/Cmd+V did nothing in an
 * interactive terminal session: xterm.js core registers no 'paste' event
 * listener on its own (pasting is left entirely to the consumer), so the
 * keystroke was swallowed by xterm's default keydown handling before the
 * browser ever fired a native paste. TerminalPanel must opt xterm out of
 * handling that combo (attachCustomKeyEventHandler) and forward the
 * resulting browser 'paste' event into the PTY via terminal.paste().
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, waitFor } from '@testing-library/react';

// ── Hoisted mocks ───────────────────────────────────────────────────────────

const { mockTerminalPaste, mockTerminalOpen, mockAttachCustomKeyEventHandler } = vi.hoisted(() => ({
  mockTerminalPaste: vi.fn(),
  mockTerminalOpen: vi.fn((container: HTMLElement) => {
    // Mimic real xterm.js: open() mounts a hidden <textarea> that receives
    // keyboard focus and DOM paste events.
    const textarea = document.createElement('textarea');
    container.appendChild(textarea);
  }),
  mockAttachCustomKeyEventHandler: vi.fn(),
}));

const mockTerminalInstance = {
  open: mockTerminalOpen,
  dispose: vi.fn(),
  loadAddon: vi.fn(),
  onData: vi.fn(),
  paste: mockTerminalPaste,
  attachCustomKeyEventHandler: mockAttachCustomKeyEventHandler,
  cols: 80,
  rows: 24,
};

vi.mock('@xterm/xterm', () => ({
  Terminal: vi.fn(() => mockTerminalInstance),
}));

vi.mock('@xterm/addon-fit', () => ({
  FitAddon: vi.fn(() => ({ fit: vi.fn() })),
}));

vi.mock('@/app/actions/terminals', () => ({
  closeTerminalSession: vi.fn(),
}));

class MockResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal('ResizeObserver', MockResizeObserver);

class MockWebSocket {
  readyState = 0;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  constructor(public url: string) {}
  close() {}
}
vi.stubGlobal('WebSocket', MockWebSocket);

// ── Imports (after mocks) ────────────────────────────────────────────────────

import { TerminalPanel } from '@/components/terminal-panel';

describe('TerminalPanel paste handling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('opts xterm out of handling Ctrl+V/Cmd+V so the browser can paste natively', async () => {
    render(<TerminalPanel sessionId="s1" role="coder.md" model="claude" onClose={() => {}} />);

    await waitFor(() => expect(mockAttachCustomKeyEventHandler).toHaveBeenCalledTimes(1));

    const handler = mockAttachCustomKeyEventHandler.mock.calls[0][0];

    expect(handler({ type: 'keydown', ctrlKey: true, metaKey: false, key: 'v' })).toBe(false);
    expect(handler({ type: 'keydown', ctrlKey: false, metaKey: true, key: 'V' })).toBe(false);
    // Any other key (or the paste combo's own keyup) must still be handled by xterm.
    expect(handler({ type: 'keydown', ctrlKey: true, metaKey: false, key: 'a' })).toBe(true);
    expect(handler({ type: 'keyup', ctrlKey: true, metaKey: false, key: 'v' })).toBe(true);
  });

  it('forwards a native paste event on the hidden textarea into the PTY via terminal.paste()', async () => {
    const { container } = render(
      <TerminalPanel sessionId="s1" role="coder.md" model="claude" onClose={() => {}} />
    );

    await waitFor(() => expect(mockTerminalOpen).toHaveBeenCalledTimes(1));

    const textarea = container.querySelector('textarea')!;
    const pasteEvent = new Event('paste', { bubbles: true, cancelable: true }) as ClipboardEvent & {
      clipboardData: DataTransfer;
    };
    Object.defineProperty(pasteEvent, 'clipboardData', {
      value: { getData: () => 'pasted text' },
    });
    textarea.dispatchEvent(pasteEvent);

    expect(mockTerminalPaste).toHaveBeenCalledWith('pasted text');
  });

  it('does nothing when the clipboard payload is empty', async () => {
    const { container } = render(
      <TerminalPanel sessionId="s1" role="coder.md" model="claude" onClose={() => {}} />
    );

    await waitFor(() => expect(mockTerminalOpen).toHaveBeenCalledTimes(1));

    const textarea = container.querySelector('textarea')!;
    const pasteEvent = new Event('paste', { bubbles: true, cancelable: true }) as ClipboardEvent & {
      clipboardData: DataTransfer;
    };
    Object.defineProperty(pasteEvent, 'clipboardData', {
      value: { getData: () => '' },
    });
    textarea.dispatchEvent(pasteEvent);

    expect(mockTerminalPaste).not.toHaveBeenCalled();
  });
});
