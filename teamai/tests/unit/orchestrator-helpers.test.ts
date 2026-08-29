// @vitest-environment node

/**
 * Tests for pure orchestrator helpers extracted from the Orchestrator class:
 *   - logToOutput: timestamped output.log appends, warn (not throw) on failure
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, readFileSync, writeFileSync, existsSync } from 'fs';
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

import { logToOutput, updateSessionMap, startPhaseFromArtifacts, ensureSpecV1Snapshot } from '../../src/lib/orchestrator/helpers';

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

describe('updateSessionMap', () => {
  it('writes the session → role mapping and merges with existing entries', () => {
    updateSessionMap(specPath, 'coder', 'session-a');
    updateSessionMap(specPath, 'qa-reviewer', 'session-b');

    const map = JSON.parse(readFileSync(join(specPath, 'session_map.json'), 'utf-8'));
    expect(map).toEqual({ coder: 'session-a', 'qa-reviewer': 'session-b' });
    expect(mockWarn).not.toHaveBeenCalled();
  });

  it('warns (does not throw) when the write fails', () => {
    const missing = join(specPath, 'nonexistent-subdir');
    expect(() => updateSessionMap(missing, 'coder', 'session-a')).not.toThrow();
    expect(mockWarn).toHaveBeenCalledWith(
      'orchestrator',
      'Failed to persist session_map.json',
      expect.anything(),
    );
  });
});

describe('startPhaseFromArtifacts', () => {
  it('returns implement when a plan exists, regardless of spec', () => {
    expect(startPhaseFromArtifacts(true, true)).toBe('implement');
    expect(startPhaseFromArtifacts(true, false)).toBe('implement');
  });

  it('returns plan when only a spec exists', () => {
    expect(startPhaseFromArtifacts(false, true)).toBe('plan');
  });

  it('returns spec when neither artifact exists', () => {
    expect(startPhaseFromArtifacts(false, false)).toBe('spec');
  });
});

describe('ensureSpecV1Snapshot', () => {
  it('snapshots spec.md as spec_v1.md when v1 is missing', () => {
    writeFileSync(join(specPath, 'spec.md'), '# pre-seeded spec\n\nWritten outside the pipeline.');

    ensureSpecV1Snapshot(specPath);

    expect(existsSync(join(specPath, 'spec_v1.md'))).toBe(true);
    expect(readFileSync(join(specPath, 'spec_v1.md'), 'utf-8')).toBe('# pre-seeded spec\n\nWritten outside the pipeline.');
    expect(mockWarn).not.toHaveBeenCalled();
  });

  it('is a no-op when spec_v1.md already exists — never overwrites it', () => {
    writeFileSync(join(specPath, 'spec.md'), '# revised content');
    writeFileSync(join(specPath, 'spec_v1.md'), '# the true original');

    ensureSpecV1Snapshot(specPath);

    // v1 must stay exactly what it already was — this function only fills a
    // gap, it never treats a later spec.md as a replacement for v1.
    expect(readFileSync(join(specPath, 'spec_v1.md'), 'utf-8')).toBe('# the true original');
  });

  it('does nothing when spec.md does not exist', () => {
    ensureSpecV1Snapshot(specPath);
    expect(existsSync(join(specPath, 'spec_v1.md'))).toBe(false);
    expect(mockWarn).not.toHaveBeenCalled();
  });

});
