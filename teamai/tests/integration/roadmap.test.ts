/**
 * Integration tests for the roadmap actions.
 *
 * Tests exercise the full filesystem pipeline: creating real roadmap JSON files,
 * changelog files, task.json files, and verifying that each action function
 * reads, normalizes, and mutates them correctly.
 *
 * Functions that spawn processManager sessions (startRoadmapGeneration,
 * startChangelogGeneration) are tested with processManager mocked since they
 * cannot spawn real Claude subprocesses in a test environment.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, writeFileSync, existsSync, rmSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';

// ── Mocks ───────────────────────────────────────────────────────────────────

const mockGetActiveProjectPath = vi.fn();

vi.mock('@/app/actions/projects', () => ({
  getActiveProjectPath: (...args: unknown[]) => mockGetActiveProjectPath(...args),
}));

// Mock processManager for tests that touch startRoadmapGeneration
const mockCreateSession = vi.fn();
const mockSendMessage = vi.fn();
const mockGetSession = vi.fn();

// Mock next/cache so revalidatePath is a no-op (no Next.js context in tests)
vi.mock('next/cache', () => ({
  revalidatePath: vi.fn(),
}));

vi.mock('@/lib/process-manager', () => ({
  processManager: {
    createSession: (...args: unknown[]) => mockCreateSession(...args),
    sendMessage: (...args: unknown[]) => mockSendMessage(...args),
    getSession: (...args: unknown[]) => mockGetSession(...args),
    on: vi.fn(),
    off: vi.fn(),
    emit: vi.fn(),
    killSession: vi.fn(),
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

// ── Test Fixture Helpers ────────────────────────────────────────────────────

let projectDir: string;

/** Create a temp project directory with .teamai/roadmap/ subdirectory */
function initProject() {
  projectDir = join(tmpdir(), `teamai-roadmap-integ-${randomUUID().slice(0, 8)}`);
  mkdirSync(join(projectDir, '.teamai', 'roadmap'), { recursive: true });
  mockGetActiveProjectPath.mockResolvedValue(projectDir);
  return projectDir;
}

/** Clean up the temp project directory */
function cleanupProject() {
  if (projectDir && existsSync(projectDir)) {
    try { rmSync(projectDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
}

/** Write a roadmap JSON file with a given structure */
function writeRoadmapFile(
  filename: string,
  data: object,
) {
  const dir = join(projectDir, '.teamai', 'roadmap');
  writeFileSync(join(dir, filename), JSON.stringify(data, null, 2));
}

/** Build a full RoadmapReport fixture with named phases */
function fullRoadmapReport(overrides: Partial<{
  nowItems: number;
  nextItems: number;
  laterItems: number;
  iceboxItems: number;
  competitors: string[];
}> = {}) {
  const {
    nowItems = 2,
    nextItems = 1,
    laterItems = 0,
    iceboxItems = 0,
    competitors,
  } = overrides;

  const makeItem = (i: number, prio: string, cat: string) => ({
    title: `Item ${i}`,
    priority: prio,
    complexity: 3,
    category: cat,
    description: `Description ${i}`,
    affected_files: ['src/main.ts'],
    source: 'ideation',
    linkedTaskId: undefined as string | undefined,
  });

  return {
    generated_at: '2025-01-15T00:00:00Z',
    executive_summary: 'Test roadmap summary',
    competitor_analysis_run: true,
    ...(competitors ? { competitors } : {}),
    phases: {
      now: Array.from({ length: nowItems }, (_, i) => makeItem(i, 'P0', 'Security')),
      next: Array.from({ length: nextItems }, (_, i) => makeItem(nowItems + i, 'P1', 'New Feature')),
      later: Array.from({ length: laterItems }, (_, i) => makeItem(nowItems + nextItems + i, 'P2', 'DX')),
      icebox: Array.from({ length: iceboxItems }, (_, i) => makeItem(nowItems + nextItems + laterItems + i, 'P3', 'Infrastructure')),
    },
  };
}

/** Build a flat-items RoadmapReport fixture */
function flatItemsReport(items: number, usePhaseField = false) {
  const base = Array.from({ length: items }, (_, i) => ({
    title: `Flat Item ${i}`,
    priority: i === 0 ? 'P0' : 'P1',
    complexity: Math.min((i % 5) + 1, 5) as 1 | 2 | 3 | 4 | 5,
    category: 'New Feature' as const,
    description: `Flat description ${i}`,
    affected_files: ['src/lib/util.ts'],
    source: 'competitor-analysis' as const,
    ...(usePhaseField ? { phase: i < 2 ? 'now' : 'next' } : {}),
  }));

  return {
    generated_at: '2025-02-01T00:00:00Z',
    executive_summary: 'Flat items summary',
    competitor_analysis_run: false,
    items: base,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('Roadmap Integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    initProject();
  });

  afterEach(() => {
    cleanupProject();
    vi.resetModules();
  });

  // ── getRoadmapReports ──────────────────────────────────────────────

  describe('getRoadmapReports', () => {
    it('returns empty array when roadmap directory has no JSON files', async () => {
      const { getRoadmapReports } = await import('@/app/actions/roadmap');
      const reports = await getRoadmapReports();
      expect(reports).toEqual([]);
    });

    it('lists roadmap JSON files sorted by date descending', async () => {
      writeRoadmapFile('roadmap-2025-01-10.json', {});
      writeRoadmapFile('roadmap-2025-01-15.json', {});
      writeRoadmapFile('roadmap-2025-01-12.json', {});

      const { getRoadmapReports } = await import('@/app/actions/roadmap');
      const reports = await getRoadmapReports();

      expect(reports).toHaveLength(3);
      expect(reports[0].date).toBe('2025-01-15');
      expect(reports[1].date).toBe('2025-01-12');
      expect(reports[2].date).toBe('2025-01-10');
    });

    it('ignores non-roadmap JSON files', async () => {
      writeRoadmapFile('roadmap-2025-01-10.json', {});
      writeRoadmapFile('not-a-roadmap.json', {});

      const { getRoadmapReports } = await import('@/app/actions/roadmap');
      const reports = await getRoadmapReports();

      expect(reports).toHaveLength(1);
    });

    it('returns empty array when roadmap directory does not exist', async () => {
      // Remove the directory that initProject created
      rmSync(projectDir, { recursive: true, force: true });
      mkdirSync(projectDir, { recursive: true }); // recreate root but no .teamai/roadmap

      const { getRoadmapReports } = await import('@/app/actions/roadmap');
      const reports = await getRoadmapReports();

      expect(reports).toEqual([]);
    });
  });

  // ── getRoadmapReport (normalization) ───────────────────────────────

  describe('getRoadmapReport', () => {
    it('reads and returns a full report with phases unchanged', async () => {
      writeRoadmapFile('roadmap-2025-01-15.json', fullRoadmapReport({ nowItems: 2, nextItems: 1, competitors: ['Acme Corp'] }));

      const { getRoadmapReport } = await import('@/app/actions/roadmap');
      const report = await getRoadmapReport('roadmap-2025-01-15.json');

      expect(report.executive_summary).toBe('Test roadmap summary');
      expect(report.competitor_analysis_run).toBe(true);
      expect(report.competitors).toEqual(['Acme Corp']);
      expect(report.phases.now).toHaveLength(2);
      expect(report.phases.next).toHaveLength(1);
      expect(report.phases.later).toHaveLength(0);
      expect(report.phases.icebox).toHaveLength(0);
    });

    it('normalizes flat items with phase field into phases', async () => {
      writeRoadmapFile('roadmap-2025-02-01.json', flatItemsReport(4, true));

      const { getRoadmapReport } = await import('@/app/actions/roadmap');
      const report = await getRoadmapReport('roadmap-2025-02-01.json');

      expect(report.phases.now).toHaveLength(2);
      expect(report.phases.next).toHaveLength(2);
      expect(report.phases.later).toHaveLength(0);
      expect(report.phases.icebox).toHaveLength(0);
    });

    it('normalizes flat items without phase field by partitioning by priority', async () => {
      writeRoadmapFile('roadmap-2025-02-01.json', flatItemsReport(3, false));

      const { getRoadmapReport } = await import('@/app/actions/roadmap');
      const report = await getRoadmapReport('roadmap-2025-02-01.json');

      // Item 0: P0, complexity 1 → now
      // Item 1: P1, complexity 2 → now (P1 + complexity <= 2)
      // Item 2: P1, complexity 3 → next (P1 + complexity > 2)
      expect(report.phases.now).toHaveLength(2);
      expect(report.phases.next).toHaveLength(1);
    });

    it('throws on malformed JSON', async () => {
      const dir = join(projectDir, '.teamai', 'roadmap');
      writeFileSync(join(dir, 'roadmap-2025-01-15.json'), 'not-valid-json{{{');

      const { getRoadmapReport } = await import('@/app/actions/roadmap');
      await expect(getRoadmapReport('roadmap-2025-01-15.json')).rejects.toThrow(/malformed/i);
    });

    it('throws on invalid filename (path traversal attempt)', async () => {
      const { getRoadmapReport } = await import('@/app/actions/roadmap');
      await expect(getRoadmapReport('../../etc/passwd')).rejects.toThrow(/invalid/i);
      await expect(getRoadmapReport('roadmap-bad-date.json')).rejects.toThrow(/invalid/i);
    });

    it('fills missing generated_at and executive_summary with defaults', async () => {
      writeRoadmapFile('roadmap-2025-01-15.json', {
        competitor_analysis_run: true,
        phases: { now: [], next: [], later: [], icebox: [] },
      });

      const { getRoadmapReport } = await import('@/app/actions/roadmap');
      const report = await getRoadmapReport('roadmap-2025-01-15.json');

      expect(report.generated_at).toBe('');
      expect(report.executive_summary).toBe('');
    });
  });

  // ── convertToTask ──────────────────────────────────────────────────

  describe('convertToTask', () => {
    it('creates a task from a roadmap item and writes linkedTaskId back to the file', async () => {
      writeRoadmapFile('roadmap-2025-01-15.json', fullRoadmapReport({ nowItems: 1 }));

      const { convertToTask } = await import('@/app/actions/roadmap');
      const result = await convertToTask('roadmap-2025-01-15.json', 0, 'now');

      expect(result.taskId).toBeDefined();
      expect(typeof result.taskId).toBe('string');

      // Verify linkedTaskId was written back to the file
      const dir = join(projectDir, '.teamai', 'roadmap');
      const updated = JSON.parse(readFileSync(join(dir, 'roadmap-2025-01-15.json'), 'utf-8'));
      expect(updated.phases.now[0].linkedTaskId).toBe(result.taskId);

      // Verify a task was actually created
      const taskDir = join(projectDir, '.teamai');
      expect(existsSync(taskDir)).toBe(true);
    });

    it('returns existing taskId when item already has linkedTaskId', async () => {
      const existingId = 'already-linked-123';
      const report = fullRoadmapReport({ nowItems: 1 });
      report.phases.now[0].linkedTaskId = existingId;
      writeRoadmapFile('roadmap-2025-01-15.json', report);

      const { convertToTask } = await import('@/app/actions/roadmap');
      const result = await convertToTask('roadmap-2025-01-15.json', 0, 'now');

      expect(result.taskId).toBe(existingId);
    });

    it('throws on invalid item index', async () => {
      writeRoadmapFile('roadmap-2025-01-15.json', fullRoadmapReport({ nowItems: 1 }));

      const { convertToTask } = await import('@/app/actions/roadmap');
      await expect(convertToTask('roadmap-2025-01-15.json', 99, 'now')).rejects.toThrow(/not found/i);
    });

    it('throws on invalid phase key', async () => {
      writeRoadmapFile('roadmap-2025-01-15.json', fullRoadmapReport());

      const { convertToTask } = await import('@/app/actions/roadmap');
      await expect(convertToTask('roadmap-2025-01-15.json', 0, 'invalid-phase')).rejects.toThrow(/invalid phase/i);
    });
  });

  // ── convertMultipleToTasks ─────────────────────────────────────────

  describe('convertMultipleToTasks', () => {
    it('converts multiple roadmap items to tasks in one call', async () => {
      writeRoadmapFile('roadmap-2025-01-15.json', fullRoadmapReport({ nowItems: 2, nextItems: 2 }));

      const { convertMultipleToTasks } = await import('@/app/actions/roadmap');
      const result = await convertMultipleToTasks('roadmap-2025-01-15.json', [
        { itemIndex: 0, phaseKey: 'now' },
        { itemIndex: 1, phaseKey: 'now' },
        { itemIndex: 0, phaseKey: 'next' },
      ]);

      expect(result.converted).toBe(3);
      expect(result.skipped).toBe(0);
      expect(result.taskIds).toHaveLength(3);

      // Verify the file was updated with linkedTaskIds
      const dir = join(projectDir, '.teamai', 'roadmap');
      const updated = JSON.parse(readFileSync(join(dir, 'roadmap-2025-01-15.json'), 'utf-8'));
      expect(updated.phases.now[0].linkedTaskId).toBe(result.taskIds[0]);
      expect(updated.phases.now[1].linkedTaskId).toBe(result.taskIds[1]);
      expect(updated.phases.next[0].linkedTaskId).toBe(result.taskIds[2]);
    });

    it('skips already-converted items and returns them in taskIds', async () => {
      const report = fullRoadmapReport({ nowItems: 2 });
      report.phases.now[0].linkedTaskId = 'existing-id';
      writeRoadmapFile('roadmap-2025-01-15.json', report);

      const { convertMultipleToTasks } = await import('@/app/actions/roadmap');
      const result = await convertMultipleToTasks('roadmap-2025-01-15.json', [
        { itemIndex: 0, phaseKey: 'now' }, // already linked
        { itemIndex: 1, phaseKey: 'now' }, // new
      ]);

      expect(result.converted).toBe(1);
      expect(result.skipped).toBe(1);
      expect(result.taskIds[0]).toBe('existing-id');
      expect(result.taskIds[1]).toBeDefined();
    });

    it('is a no-op when the items array is empty', async () => {
      writeRoadmapFile('roadmap-2025-01-15.json', fullRoadmapReport());

      const { convertMultipleToTasks } = await import('@/app/actions/roadmap');
      const result = await convertMultipleToTasks('roadmap-2025-01-15.json', []);

      expect(result.converted).toBe(0);
      expect(result.skipped).toBe(0);
      expect(result.taskIds).toEqual([]);
    });

    it('skips invalid phase keys gracefully', async () => {
      writeRoadmapFile('roadmap-2025-01-15.json', fullRoadmapReport({ nowItems: 1 }));

      const { convertMultipleToTasks } = await import('@/app/actions/roadmap');
      const result = await convertMultipleToTasks('roadmap-2025-01-15.json', [
        { itemIndex: 0, phaseKey: 'now' },
        { itemIndex: 0, phaseKey: 'bogus' }, // invalid — silently skipped
      ]);

      expect(result.converted).toBe(1);
      expect(result.skipped).toBe(0);
    });
  });

  // ── clearLinkedTaskId ──────────────────────────────────────────────

  describe('clearLinkedTaskId', () => {
    it('clears the linkedTaskId from a roadmap item', async () => {
      const report = fullRoadmapReport({ nowItems: 1 });
      report.phases.now[0].linkedTaskId = 'to-clear';
      writeRoadmapFile('roadmap-2025-01-15.json', report);

      const { clearLinkedTaskId } = await import('@/app/actions/roadmap');
      await clearLinkedTaskId('roadmap-2025-01-15.json', 0, 'now');

      const dir = join(projectDir, '.teamai', 'roadmap');
      const updated = JSON.parse(readFileSync(join(dir, 'roadmap-2025-01-15.json'), 'utf-8'));
      expect(updated.phases.now[0].linkedTaskId).toBeUndefined();
    });

    it('is a no-op when the item has no linkedTaskId', async () => {
      writeRoadmapFile('roadmap-2025-01-15.json', fullRoadmapReport({ nowItems: 1 }));

      const { clearLinkedTaskId } = await import('@/app/actions/roadmap');
      await clearLinkedTaskId('roadmap-2025-01-15.json', 0, 'now');

      // Should not throw; file should be unchanged
      const dir = join(projectDir, '.teamai', 'roadmap');
      const updated = JSON.parse(readFileSync(join(dir, 'roadmap-2025-01-15.json'), 'utf-8'));
      expect(updated.phases.now[0].linkedTaskId).toBeUndefined();
    });

    it('throws on invalid phase key', async () => {
      writeRoadmapFile('roadmap-2025-01-15.json', fullRoadmapReport());

      const { clearLinkedTaskId } = await import('@/app/actions/roadmap');
      await expect(clearLinkedTaskId('roadmap-2025-01-15.json', 0, 'bad-phase')).rejects.toThrow(/invalid phase/i);
    });
  });

  // ── deleteRoadmapItem ──────────────────────────────────────────────

  describe('deleteRoadmapItem', () => {
    it('removes an item from the specified phase', async () => {
      writeRoadmapFile('roadmap-2025-01-15.json', fullRoadmapReport({ nowItems: 3 }));

      const { deleteRoadmapItem } = await import('@/app/actions/roadmap');
      await deleteRoadmapItem('roadmap-2025-01-15.json', 1, 'now');

      const dir = join(projectDir, '.teamai', 'roadmap');
      const updated = JSON.parse(readFileSync(join(dir, 'roadmap-2025-01-15.json'), 'utf-8'));
      expect(updated.phases.now).toHaveLength(2);
      // The second item (index 1) was removed, so index 0 should remain and index 1 should be the former index 2
      expect(updated.phases.now[0].title).toContain('Item 0');
      expect(updated.phases.now[1].title).toContain('Item 2');
    });

    it('throws when item index is out of bounds', async () => {
      writeRoadmapFile('roadmap-2025-01-15.json', fullRoadmapReport({ nowItems: 1 }));

      const { deleteRoadmapItem } = await import('@/app/actions/roadmap');
      await expect(deleteRoadmapItem('roadmap-2025-01-15.json', 99, 'now')).rejects.toThrow(/not found/i);
    });

    it('throws on invalid filename', async () => {
      const { deleteRoadmapItem } = await import('@/app/actions/roadmap');
      await expect(deleteRoadmapItem('hack.json', 0, 'now')).rejects.toThrow(/invalid/i);
    });
  });

  // ── getLinkedTaskStatuses ──────────────────────────────────────────

  describe('getLinkedTaskStatuses', () => {
    it('returns phase and title for existing tasks', async () => {
      // Create real tasks via TaskStore
      const { TaskStore } = await import('@/lib/task-store');
      const store = new TaskStore(projectDir);
      store.create('task-1', 'Linked Task A', 'Description A');
      store.create('task-2', 'Linked Task B', 'Description B');
      store.updatePhase('task-1', 'implement');

      const { getLinkedTaskStatuses } = await import('@/app/actions/roadmap');
      const result = await getLinkedTaskStatuses(['task-1', 'task-2']);

      expect(result['task-1']).toEqual({ phase: 'implement', title: 'Linked Task A' });
      expect(result['task-2']).toEqual({ phase: 'backlog', title: 'Linked Task B' });
    });

    it('returns null for missing task IDs', async () => {
      const { getLinkedTaskStatuses } = await import('@/app/actions/roadmap');
      const result = await getLinkedTaskStatuses(['nonexistent-task']);

      expect(result['nonexistent-task']).toBeNull();
    });

    it('handles empty input array', async () => {
      const { getLinkedTaskStatuses } = await import('@/app/actions/roadmap');
      const result = await getLinkedTaskStatuses([]);

      expect(result).toEqual({});
    });
  });

  // ── getChangelogReports ────────────────────────────────────────────

  describe('getChangelogReports', () => {
    it('returns empty array when no changelog files exist', async () => {
      const { getChangelogReports } = await import('@/app/actions/roadmap');
      const reports = await getChangelogReports();
      expect(reports).toEqual([]);
    });

    it('lists changelog .md files sorted by date descending', async () => {
      const dir = join(projectDir, '.teamai', 'roadmap');
      writeFileSync(join(dir, 'changelog-2025-01-20.md'), '# Changelog 20');
      writeFileSync(join(dir, 'changelog-2025-01-15.md'), '# Changelog 15');

      const { getChangelogReports } = await import('@/app/actions/roadmap');
      const reports = await getChangelogReports();

      expect(reports).toHaveLength(2);
      expect(reports[0].date).toBe('2025-01-20');
      expect(reports[1].date).toBe('2025-01-15');
    });

    it('ignores non-changelog .md files', async () => {
      const dir = join(projectDir, '.teamai', 'roadmap');
      writeFileSync(join(dir, 'changelog-2025-01-20.md'), '# Changelog');
      writeFileSync(join(dir, 'readme.md'), '# Readme');

      const { getChangelogReports } = await import('@/app/actions/roadmap');
      const reports = await getChangelogReports();

      expect(reports).toHaveLength(1);
    });
  });

  // ── getLatestChangelog ─────────────────────────────────────────────

  describe('getLatestChangelog', () => {
    it('reads the content of a changelog file', async () => {
      const dir = join(projectDir, '.teamai', 'roadmap');
      writeFileSync(join(dir, 'changelog-2025-01-20.md'), '# Changelog\n\n- Fixed bug A\n- Added feature B');

      const { getLatestChangelog } = await import('@/app/actions/roadmap');
      const content = await getLatestChangelog('changelog-2025-01-20.md');

      expect(content).toContain('Fixed bug A');
      expect(content).toContain('Added feature B');
    });

    it('throws on invalid filename (path traversal attempt)', async () => {
      const { getLatestChangelog } = await import('@/app/actions/roadmap');
      await expect(getLatestChangelog('../../etc/passwd')).rejects.toThrow(/invalid/i);
    });

    it('throws on non-md extension', async () => {
      const { getLatestChangelog } = await import('@/app/actions/roadmap');
      await expect(getLatestChangelog('changelog-2025-01-20.json')).rejects.toThrow(/invalid/i);
    });
  });

  // ── getActiveRoadmapSession ────────────────────────────────────────

  describe('getActiveRoadmapSession', () => {
    it('returns null when no session exists for the project', async () => {
      mockGetSession.mockReturnValue(undefined);

      const { getActiveRoadmapSession } = await import('@/app/actions/roadmap');
      const session = await getActiveRoadmapSession('roadmap');

      expect(session).toBeNull();
    });

    it('returns null when sessions map is empty (not started via startRoadmapGeneration)', async () => {
      const { getActiveRoadmapSession } = await import('@/app/actions/roadmap');
      const session = await getActiveRoadmapSession('roadmap');

      // sessions map is module-scoped and not populated via startRoadmapGeneration
      expect(session).toBeNull();
    });
  });

  describe('startRoadmapGeneration (with mocked processManager)', () => {
    it('creates a session and sends the /roadmap command', async () => {
      mockCreateSession.mockResolvedValue('sess-1');

      const { startRoadmapGeneration } = await import('@/app/actions/roadmap');
      const sessionId = await startRoadmapGeneration(true); // skipCompetitors=true

      expect(mockCreateSession).toHaveBeenCalledWith(
        expect.objectContaining({ projectRoot: projectDir, permissionMode: 'bypassPermissions' }),
      );
      expect(sessionId).toBe('sess-1');
      expect(mockSendMessage).toHaveBeenCalledWith('sess-1', expect.stringContaining('/roadmap'));
    });

    it('passes skip-competitors flag when requested', async () => {
      mockCreateSession.mockResolvedValue('sess-2');

      const { startRoadmapGeneration } = await import('@/app/actions/roadmap');
      await startRoadmapGeneration(true);

      expect(mockSendMessage).toHaveBeenCalledWith('sess-2', expect.stringContaining('--skip-competitors'));
    });

    it('does not pass skip-competitors flag by default', async () => {
      mockCreateSession.mockResolvedValue('sess-3');

      const { startRoadmapGeneration } = await import('@/app/actions/roadmap');
      await startRoadmapGeneration(false);

      const message = mockSendMessage.mock.calls[0][1];
      expect(message).not.toContain('--skip-competitors');
    });
  });

  describe('startChangelogGeneration (with mocked processManager)', () => {
    it('creates a session and sends the /changelog command', async () => {
      mockCreateSession.mockResolvedValue('sess-changelog');

      const { startChangelogGeneration } = await import('@/app/actions/roadmap');
      const sessionId = await startChangelogGeneration();

      expect(mockCreateSession).toHaveBeenCalledWith(
        expect.objectContaining({ projectRoot: projectDir, permissionMode: 'bypassPermissions' }),
      );
      expect(sessionId).toBe('sess-changelog');
      expect(mockSendMessage).toHaveBeenCalledWith('sess-changelog', '/changelog');
    });
  });
});
