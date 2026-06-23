/**
 * Unit tests for ideation server actions.
 *
 * Tests cover startIdeationScan() (session creation, /ideation command)
 * and getIdeationReports() (directory listing, empty/missing directory).
 * Uses createTestProject() helper and mocked processManager.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';

// ── Hoisted mocks ───────────────────────────────────────────────────────────

const mockCreateSession = vi.fn();
const mockSendMessage = vi.fn();

vi.mock('@/lib/process-manager', () => ({
  processManager: {
    createSession: (...args: unknown[]) => mockCreateSession(...args),
    sendMessage: (...args: unknown[]) => mockSendMessage(...args),
  },
}));

const mockGetActiveProjectPath = vi.fn();

vi.mock('@/app/actions/projects', () => ({
  getActiveProjectPath: (...args: unknown[]) => mockGetActiveProjectPath(...args),
}));

// ── Imports (must be after mocks) ───────────────────────────────────────────

import { createTestProject } from '../utils/test-project';

// ── Helpers ─────────────────────────────────────────────────────────────────

let root: string;
let clean: () => void;

function resetGlobalSessions() {
  delete (globalThis as Record<string, unknown>).__ideationSessions;
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('ideation server actions', () => {
  beforeEach(() => {
    const project = createTestProject();
    root = project.root;
    clean = project.clean;
    mkdirSync(join(root, '.teamai'), { recursive: true });
    mockGetActiveProjectPath.mockResolvedValue(root);
    resetGlobalSessions();
  });

  afterEach(() => {
    clean();
    vi.clearAllMocks();
    vi.resetModules();
    resetGlobalSessions();
  });

  // ── startIdeationScan ────────────────────────────────────────────────

  describe('startIdeationScan', () => {
    it('creates a session and sends the /ideation command', async () => {
      mockCreateSession.mockResolvedValue('session-ideation');

      const { startIdeationScan } = await import('@/app/actions/ideation');
      const id = await startIdeationScan();

      expect(id).toBe('session-ideation');
      expect(mockCreateSession).toHaveBeenCalledTimes(1);
      expect(mockCreateSession).toHaveBeenCalledWith({
        taskId: `ideation::${root}`,
        role: 'general',
        cwd: root,
        model: undefined,
        projectRoot: root,
        permissionMode: 'bypassPermissions',
      });
      expect(mockSendMessage).toHaveBeenCalledWith('session-ideation', '/ideation');
    });

    it('stores the session in the global sessions map', async () => {
      mockCreateSession.mockResolvedValue('session-store');

      const { startIdeationScan } = await import('@/app/actions/ideation');
      await startIdeationScan();

      // The session should be stored in global.__ideationSessions
      const globalSessions: Map<string, string> | undefined =
        (globalThis as Record<string, unknown>).__ideationSessions as Map<string, string> | undefined;
      expect(globalSessions).toBeDefined();
      expect(globalSessions!.get(root)).toBe('session-store');
    });

    it('uses the correct project path from getActiveProjectPath', async () => {
      mockCreateSession.mockResolvedValue('session-path');

      const { startIdeationScan } = await import('@/app/actions/ideation');
      await startIdeationScan();

      // getActiveProjectPath is called twice: once in startIdeationScan and once in getProvidersConfig
      expect(mockGetActiveProjectPath).toHaveBeenCalledTimes(2);
      expect(mockCreateSession).toHaveBeenCalledWith(
        expect.objectContaining({ cwd: root, taskId: `ideation::${root}` }),
      );
    });

    it('propagates error when createSession fails', async () => {
      mockCreateSession.mockRejectedValue(new Error('process unavailable'));

      const { startIdeationScan } = await import('@/app/actions/ideation');
      await expect(startIdeationScan()).rejects.toThrow('process unavailable');
    });

    it('propagates error when getActiveProjectPath fails', async () => {
      mockGetActiveProjectPath.mockRejectedValue(new Error('no project selected'));

      const { startIdeationScan } = await import('@/app/actions/ideation');
      await expect(startIdeationScan()).rejects.toThrow('no project selected');
    });
  });

  // ── getIdeationReports ───────────────────────────────────────────────

  describe('getIdeationReports', () => {
    it('returns empty array when ideation directory does not exist', async () => {
      const { getIdeationReports } = await import('@/app/actions/ideation');
      const reports = await getIdeationReports();

      expect(reports).toEqual([]);
    });

    it('returns empty array when ideation directory exists but is empty', async () => {
      mkdirSync(join(root, '.teamai', 'ideation'), { recursive: true });

      const { getIdeationReports } = await import('@/app/actions/ideation');
      const reports = await getIdeationReports();

      expect(reports).toEqual([]);
    });

    it('lists ideation report files with extracted dates', async () => {
      const ideationDir = join(root, '.teamai', 'ideation');
      mkdirSync(ideationDir, { recursive: true });

      writeFileSync(join(ideationDir, 'ideation-2026-06-01.json'), '{}');
      writeFileSync(join(ideationDir, 'ideation-2026-05-15.json'), '{}');
      writeFileSync(join(ideationDir, 'ideation-2026-06-02.json'), '{}');

      const { getIdeationReports } = await import('@/app/actions/ideation');
      const reports = await getIdeationReports();

      expect(reports.length).toBe(3);
      // Sorted newest first (date descending)
      expect(reports[0]).toEqual({ filename: 'ideation-2026-06-02.json', date: '2026-06-02' });
      expect(reports[1]).toEqual({ filename: 'ideation-2026-06-01.json', date: '2026-06-01' });
      expect(reports[2]).toEqual({ filename: 'ideation-2026-05-15.json', date: '2026-05-15' });
    });

    it('filters out non-JSON files in the ideation directory', async () => {
      const ideationDir = join(root, '.teamai', 'ideation');
      mkdirSync(ideationDir, { recursive: true });

      writeFileSync(join(ideationDir, 'ideation-2026-06-01.json'), '{}');
      writeFileSync(join(ideationDir, 'README.md'), '# ideation reports');
      writeFileSync(join(ideationDir, '.gitkeep'), '');

      const { getIdeationReports } = await import('@/app/actions/ideation');
      const reports = await getIdeationReports();

      expect(reports.length).toBe(1);
      expect(reports[0].filename).toBe('ideation-2026-06-01.json');
    });

    it('handles files that do not match the ideation naming pattern', async () => {
      const ideationDir = join(root, '.teamai', 'ideation');
      mkdirSync(ideationDir, { recursive: true });

      // File ending in .json but with unexpected name
      writeFileSync(join(ideationDir, 'custom-report.json'), '{}');

      const { getIdeationReports } = await import('@/app/actions/ideation');
      const reports = await getIdeationReports();

      // Should be included (only filters by .json extension, not naming pattern)
      expect(reports.length).toBe(1);
      expect(reports[0].filename).toBe('custom-report.json');
      expect(reports[0].date).toBe('custom-report'); // replace('ideation-', '') no-op
    });

    it('uses the active project path to locate the ideation directory', async () => {
      const ideationDir = join(root, '.teamai', 'ideation');
      mkdirSync(ideationDir, { recursive: true });
      writeFileSync(join(ideationDir, 'ideation-2026-06-01.json'), '{}');

      const { getIdeationReports } = await import('@/app/actions/ideation');
      await getIdeationReports();

      expect(mockGetActiveProjectPath).toHaveBeenCalledTimes(1);
    });
  });

  // ── Session lifecycle integration ────────────────────────────────────

  describe('session lifecycle', () => {
    it('subsequent scans on the same project create separate sessions', async () => {
      mockCreateSession.mockResolvedValueOnce('session-1');
      mockCreateSession.mockResolvedValueOnce('session-2');

      const { startIdeationScan } = await import('@/app/actions/ideation');

      const id1 = await startIdeationScan();
      expect(id1).toBe('session-1');

      const id2 = await startIdeationScan();
      expect(id2).toBe('session-2');

      expect(mockCreateSession).toHaveBeenCalledTimes(2);
      expect(mockSendMessage).toHaveBeenCalledTimes(2);
    });
  });
});
