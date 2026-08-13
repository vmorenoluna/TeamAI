// @vitest-environment node

/**
 * Tests for pure orchestrator helpers extracted from the Orchestrator class:
 *   - logToOutput: timestamped output.log appends, warn (not throw) on failure
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// ── Hoisted mocks ──

const { mockWarn } = vi.hoisted(() => ({ mockWarn: vi.fn() }));

vi.mock('child_process', () => ({
  execFile: vi.fn(),
  execFileSync: vi.fn(),
}));

vi.mock('../../src/lib/logger', () => ({
  log: vi.fn(),
  warn: mockWarn,
  error: vi.fn(),
  info: vi.fn(),
}));

vi.mock('../../src/lib/process-manager', () => ({
  processManager: {
    on: vi.fn(),
    off: vi.fn(),
    emit: vi.fn(),
    createSession: vi.fn(),
    sendMessage: vi.fn(),
    killSession: vi.fn(),
    getSession: vi.fn(),
    getAllSessions: vi.fn(() => []),
    getStaleSessions: vi.fn(() => []),
    removeStaleSession: vi.fn(),
    getTerminalSessions: vi.fn(() => []),
    killTerminalSession: vi.fn(),
    writeToSession: vi.fn(),
    terminateSession: vi.fn(),
  },
  containerSessionOpts: (projectRoot: string) => ({ projectRoot, permissionMode: 'bypassPermissions' as const }),
}));

vi.mock('../../src/lib/container-manager', () => ({
  readContainerConfig: vi.fn(() => ({ enabled: false, explicit: false })),
  readContainerRemoteUser: vi.fn(() => 'node'),
  containerManager: {
    ensureContainer: vi.fn(),
    getRunningContainer: vi.fn(() => null),
  },
  hostToContainerPath: vi.fn((p: string) => p),
  dockerAvailable: vi.fn(() => true),
  _resetDockerAvailableCache: vi.fn(),
}));

// ── Imports after mocks ──

import { logToOutput } from '../../src/lib/orchestrator/helpers';

// ── Helpers ──

let specPath: string;

beforeEach(() => {
  specPath = join(tmpdir(), `teamai-helpers-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(specPath, { recursive: true });
  mockWarn.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
  try { rmSync(specPath, { recursive: true, force: true }); } catch { /* best-effort */ }
});

// ── Tests ──

describe('logToOutput', () => {
  it('appends a timestamped message to output.log', () => {
    logToOutput(specPath, 'hello world');
    const content = readFileSync(join(specPath, 'output.log'), 'utf-8');
    expect(content).toMatch(/^\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\] hello world$/);
    expect(mockWarn).not.toHaveBeenCalled();
  });

  it('preserves leading newlines before the timestamp', () => {
    logToOutput(specPath, '\n\nphase separator');
    const content = readFileSync(join(specPath, 'output.log'), 'utf-8');
    expect(content.startsWith('\n\n[')).toBe(true);
    expect(content).toMatch(/phase separator$/);
  });

  it('warns (does not throw) when the specPath directory does not exist', () => {
    const missing = join(specPath, 'nonexistent-subdir');
    expect(() => logToOutput(missing, 'boom')).not.toThrow();
    expect(mockWarn).toHaveBeenCalledWith(
      'orchestrator',
      `Failed to write to output log at ${join(missing, 'output.log')}`,
      expect.anything(),
    );
  });
});
