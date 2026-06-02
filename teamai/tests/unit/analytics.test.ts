/**
 * Unit tests for getAnalytics() server action.
 *
 * Tests exercise the full analytics computation pipeline using the
 * createTestProject() helper for temp project directories. Covers:
 *   - Phase distribution
 *   - Phase timing from events.jsonl
 *   - QA stats aggregation from qa_report.json
 *   - Source breakdown
 *   - Weekly trends
 *   - Bottleneck detection
 *
 * KEY: Phase durations are associated with the SOURCE phase of each
 * transition (events[i].phase), NOT the destination (events[i+1].phase).
 * Example: backlog→spec(2h)→plan(3h) means backlog=2h, spec=3h.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, writeFileSync, appendFileSync } from 'fs';
import { join } from 'path';
import { createTestProject } from '../utils/test-project';

// ── Mocks ───────────────────────────────────────────────────────────────────

const mockGetActiveProjectPath = vi.fn();

vi.mock('@/app/actions/projects', () => ({
  getActiveProjectPath: (...args: unknown[]) => mockGetActiveProjectPath(...args),
}));

// ── Helpers ──────────────────────────────────────────────────────────────────

let root: string;
let clean: () => void;

/** Shortcut to the .teamai/ directory in the test project */
function teamaiDir() { return join(root, '.teamai'); }

/**
 * Write a task.json for a task created by TaskStore.create().
 * This mirrors what TaskStore.create writes — the task is stored
 * under .teamai/<slug>/task.json.
 */
function writeTask(
  slug: string,
  id: string,
  overrides: Partial<{
    title: string; description: string; phase: string;
    source: string; createdAt: string; updatedAt: string;
  }> = {},
) {
  const dir = join(teamaiDir(), slug);
  mkdirSync(dir, { recursive: true });
  const task = {
    id,
    title: overrides.title ?? slug,
    description: overrides.description ?? 'Description',
    phase: overrides.phase ?? 'backlog',
    source: overrides.source,
    createdAt: overrides.createdAt ?? new Date().toISOString(),
    updatedAt: overrides.updatedAt ?? new Date().toISOString(),
  };
  writeFileSync(join(dir, 'task.json'), JSON.stringify(task));
  return dir;
}

/** Append an event line to events.jsonl */
function appendEvent(slug: string, event: { phase: string; timestamp: string }) {
  const path = join(teamaiDir(), slug, 'events.jsonl');
  appendFileSync(path, JSON.stringify(event) + '\n');
}

/** Write a qa_report.json to the task's slug directory */
function writeQaReport(slug: string, report: object) {
  const dir = join(teamaiDir(), slug);
  writeFileSync(join(dir, 'qa_report.json'), JSON.stringify(report));
}

/** ISO date offset by N hours from a base */
function isoH(isoBase: string, hours: number): string {
  const d = new Date(isoBase);
  d.setHours(d.getHours() + hours);
  return d.toISOString();
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('getAnalytics', () => {
  beforeEach(() => {
    const project = createTestProject();
    root = project.root;
    clean = project.clean;
    mkdirSync(teamaiDir(), { recursive: true });
    mockGetActiveProjectPath.mockResolvedValue(root);
  });

  afterEach(() => {
    clean();
    vi.clearAllMocks();
    vi.resetModules();
  });

  // ── Empty / Edge Cases ───────────────────────────────────────────────

  describe('empty / edge cases', () => {
    it('returns zeros for an empty project', async () => {
      const { getAnalytics } = await import('@/app/actions/analytics');
      const data = await getAnalytics();

      expect(data.totalTasks).toBe(0);
      expect(data.phaseDistribution).toEqual({});
      expect(data.phaseTimings).toEqual([]);
      expect(data.qaStats).toBeNull();
      expect(data.sourceBreakdown).toEqual({ ideation: 0, competitorAnalysis: 0, unknown: 0 });
      expect(data.weeklyTrends).toEqual([]);
      expect(data.bottleneck).toBeNull();
      expect(data.projectPath).toBe(root);
    });

    it('handles project with tasks but no events or QA reports', async () => {
      writeTask('task-one', 'id-1', { phase: 'spec' });
      writeTask('task-two', 'id-2', { phase: 'plan', source: 'ideation' });

      const { getAnalytics } = await import('@/app/actions/analytics');
      const data = await getAnalytics();

      expect(data.totalTasks).toBe(2);
      expect(data.phaseDistribution).toEqual({ spec: 1, plan: 1 });
      expect(data.phaseTimings).toEqual([]);
      expect(data.qaStats).toBeNull();
      expect(data.sourceBreakdown).toEqual({ ideation: 1, competitorAnalysis: 0, unknown: 1 });
      expect(data.bottleneck).toBeNull();
    });

    it('handles project with only excluded phases (no active phases)', async () => {
      const t0 = '2025-06-01T00:00:00Z';
      writeTask('only-backlog-done', 'id-1', { phase: 'done', createdAt: t0 });
      appendEvent('only-backlog-done', { phase: 'backlog', timestamp: t0 });
      appendEvent('only-backlog-done', { phase: 'done', timestamp: isoH(t0, 1) });

      const { getAnalytics } = await import('@/app/actions/analytics');
      const data = await getAnalytics();

      expect(data.totalTasks).toBe(1);
      expect(data.bottleneck).toBeNull();
    });
  });

  // ── Phase Distribution ───────────────────────────────────────────────

  describe('phase distribution', () => {
    it('counts tasks across various phases', async () => {
      writeTask('t1', 'id-1', { phase: 'backlog' });
      writeTask('t2', 'id-2', { phase: 'spec' });
      writeTask('t3', 'id-3', { phase: 'spec' });
      writeTask('t4', 'id-4', { phase: 'plan' });
      writeTask('t5', 'id-5', { phase: 'implement' });
      writeTask('t6', 'id-6', { phase: 'implement' });
      writeTask('t7', 'id-7', { phase: 'implement' });
      writeTask('t8', 'id-8', { phase: 'done' });

      const { getAnalytics } = await import('@/app/actions/analytics');
      const data = await getAnalytics();

      expect(data.totalTasks).toBe(8);
      expect(data.phaseDistribution).toEqual({
        backlog: 1, spec: 2, plan: 1, implement: 3, done: 1,
      });
    });

    it('handles single-task project', async () => {
      writeTask('solo', 'id-solo', { phase: 'backlog' });

      const { getAnalytics } = await import('@/app/actions/analytics');
      const data = await getAnalytics();

      expect(data.totalTasks).toBe(1);
      expect(data.phaseDistribution).toEqual({ backlog: 1 });
    });
  });

  // ── Phase Timings from events.jsonl ──────────────────────────────────

  describe('phase timings from events.jsonl', () => {
    it('computes durations between consecutive events (source phase owns the duration)', async () => {
      const t0 = '2025-01-01T00:00:00Z';
      writeTask('timing-task', 'tid-1', { phase: 'plan', createdAt: t0, updatedAt: t0 });

      appendEvent('timing-task', { phase: 'backlog', timestamp: t0 });
      appendEvent('timing-task', { phase: 'spec', timestamp: isoH(t0, 2) });
      appendEvent('timing-task', { phase: 'plan', timestamp: isoH(t0, 5) });

      const { getAnalytics } = await import('@/app/actions/analytics');
      const data = await getAnalytics();

      expect(data.phaseTimings.length).toBe(2);

      // Sorted by avgHours descending: spec(3h) > backlog(2h)
      expect(data.phaseTimings[0].phase).toBe('spec');
      expect(data.phaseTimings[0].avgHours).toBe(3);
      expect(data.phaseTimings[0].minHours).toBe(3);
      expect(data.phaseTimings[0].maxHours).toBe(3);
      expect(data.phaseTimings[0].count).toBe(1);

      expect(data.phaseTimings[1].phase).toBe('backlog');
      expect(data.phaseTimings[1].avgHours).toBe(2);
      expect(data.phaseTimings[1].count).toBe(1);
    });

    it('aggregates durations across multiple tasks for same phase', async () => {
      const t0 = '2025-02-01T00:00:00Z';
      writeTask('task-a', 'a', { phase: 'spec', createdAt: t0 });
      writeTask('task-b', 'b', { phase: 'spec', createdAt: t0 });

      appendEvent('task-a', { phase: 'backlog', timestamp: t0 });
      appendEvent('task-a', { phase: 'spec', timestamp: isoH(t0, 1) });

      appendEvent('task-b', { phase: 'backlog', timestamp: t0 });
      appendEvent('task-b', { phase: 'spec', timestamp: isoH(t0, 3) });

      const { getAnalytics } = await import('@/app/actions/analytics');
      const data = await getAnalytics();

      expect(data.phaseTimings.length).toBe(1);
      expect(data.phaseTimings[0].phase).toBe('backlog');
      expect(data.phaseTimings[0].avgHours).toBe(2); // (1 + 3) / 2
      expect(data.phaseTimings[0].minHours).toBe(1);
      expect(data.phaseTimings[0].maxHours).toBe(3);
      expect(data.phaseTimings[0].count).toBe(2);
    });

    it('sorts phase timings by avgHours descending', async () => {
      const t0 = '2025-03-01T00:00:00Z';
      writeTask('sort-task', 'st', { phase: 'done', createdAt: t0 });

      appendEvent('sort-task', { phase: 'backlog', timestamp: t0 });
      appendEvent('sort-task', { phase: 'spec', timestamp: isoH(t0, 10) });
      appendEvent('sort-task', { phase: 'plan', timestamp: isoH(t0, 11) });

      const { getAnalytics } = await import('@/app/actions/analytics');
      const data = await getAnalytics();

      expect(data.phaseTimings.length).toBe(2);
      expect(data.phaseTimings[0].phase).toBe('backlog'); // 10h
      expect(data.phaseTimings[1].phase).toBe('spec');    // 1h
    });

    it('returns empty timings when events.jsonl has fewer than 2 events', async () => {
      writeTask('single-event', 'se', { phase: 'backlog' });
      appendEvent('single-event', { phase: 'backlog', timestamp: '2025-01-01T00:00:00Z' });

      const { getAnalytics } = await import('@/app/actions/analytics');
      const data = await getAnalytics();

      expect(data.phaseTimings).toEqual([]);
    });

    it('skips negative durations (clock skew)', async () => {
      const t0 = '2025-01-01T00:00:00Z';
      writeTask('skew-task', 'sk', { phase: 'done', createdAt: t0 });
      // second event is BEFORE the first — negative duration, should be skipped
      appendEvent('skew-task', { phase: 'backlog', timestamp: isoH(t0, 5) });
      appendEvent('skew-task', { phase: 'spec', timestamp: t0 });

      const { getAnalytics } = await import('@/app/actions/analytics');
      const data = await getAnalytics();

      // The negative duration is skipped, so only the spec→done segment counts
      // Actually, backlog→spec is -5h (skipped), so no valid durations
      expect(data.phaseTimings).toEqual([]);
    });

    it('skips tasks with malformed events.jsonl without crashing', async () => {
      writeTask('corrupt-events', 'ce', { phase: 'spec' });
      // Write a non-JSON line followed by valid events
      const eventsPath = join(teamaiDir(), 'corrupt-events', 'events.jsonl');
      writeFileSync(eventsPath, 'this is not json\n{"phase":"backlog","timestamp":"2025-01-01T00:00:00Z"}\n');

      const { getAnalytics } = await import('@/app/actions/analytics');
      const data = await getAnalytics();

      // Should not crash — malformed events.jsonl is caught and skipped.
      // The JSON parse throws on the non-JSON line; the try/catch in
      // getAnalytics wraps taskStore.getEvents(), so the task is skipped.
      expect(data.phaseTimings).toEqual([]);
    });
  });

  // ── QA Stats ─────────────────────────────────────────────────────────

  describe('QA stats aggregation', () => {
    it('computes pass/fail rates from qa_report.json files', async () => {
      writeTask('pass-task', 'p1', { phase: 'done' });
      writeTask('fail-task', 'f1', { phase: 'qa-review' });

      writeQaReport('pass-task', { overall: 'PASS', criteria: [] });
      writeQaReport('fail-task', { overall: 'FAIL', criteria: [] });

      const { getAnalytics } = await import('@/app/actions/analytics');
      const data = await getAnalytics();

      expect(data.qaStats).not.toBeNull();
      expect(data.qaStats!.totalQaRuns).toBe(2);
      expect(data.qaStats!.passCount).toBe(1);
      expect(data.qaStats!.failCount).toBe(1);
      expect(data.qaStats!.passRate).toBe(50);
    });

    it('returns null when no QA reports exist', async () => {
      writeTask('no-qa', 'nq', { phase: 'done' });

      const { getAnalytics } = await import('@/app/actions/analytics');
      const data = await getAnalytics();

      expect(data.qaStats).toBeNull();
    });

    it('breaks down criteria by name and passRate', async () => {
      writeTask('qa1', 'q1', { phase: 'done' });
      writeTask('qa2', 'q2', { phase: 'done' });

      writeQaReport('qa1', {
        overall: 'PASS',
        criteria: [
          { name: 'code-style', status: 'PASS' },
          { name: 'tests-passing', status: 'PASS' },
        ],
      });
      writeQaReport('qa2', {
        overall: 'FAIL',
        criteria: [
          { name: 'code-style', status: 'PASS' },
          { name: 'tests-passing', status: 'FAIL' },
        ],
      });

      const { getAnalytics } = await import('@/app/actions/analytics');
      const data = await getAnalytics();

      expect(data.qaStats!.criteriaBreakdown.length).toBe(2);

      const testsPassing = data.qaStats!.criteriaBreakdown.find(c => c.name === 'tests-passing');
      const codeStyle = data.qaStats!.criteriaBreakdown.find(c => c.name === 'code-style');

      expect(testsPassing).toBeDefined();
      expect(testsPassing!.passRate).toBe(50);
      expect(testsPassing!.total).toBe(2);

      expect(codeStyle).toBeDefined();
      expect(codeStyle!.passRate).toBe(100);
      expect(codeStyle!.total).toBe(2);

      // Sorted by passRate ascending: tests-passing (50) before code-style (100)
      expect(data.qaStats!.criteriaBreakdown[0].name).toBe('tests-passing');
    });

    it('handles criteria with field name "criterion" (alternate field)', async () => {
      writeTask('alt-field', 'af', { phase: 'done' });
      writeQaReport('alt-field', {
        overall: 'PASS',
        criteria: [
          { criterion: 'legacy-criteria', status: 'PASS' },
        ],
      });

      const { getAnalytics } = await import('@/app/actions/analytics');
      const data = await getAnalytics();

      expect(data.qaStats!.criteriaBreakdown.length).toBe(1);
      expect(data.qaStats!.criteriaBreakdown[0].name).toBe('legacy-criteria');
      expect(data.qaStats!.criteriaBreakdown[0].passRate).toBe(100);
    });

    it('handles 100% pass rate', async () => {
      writeTask('perfect', 'pf', { phase: 'done' });
      writeQaReport('perfect', {
        overall: 'PASS',
        criteria: [{ name: 'all-good', status: 'PASS' }],
      });

      const { getAnalytics } = await import('@/app/actions/analytics');
      const data = await getAnalytics();

      expect(data.qaStats!.passRate).toBe(100);
      expect(data.qaStats!.passCount).toBe(1);
      expect(data.qaStats!.failCount).toBe(0);
    });

    it('handles 0% pass rate', async () => {
      writeTask('all-fail', 'af2', { phase: 'qa-review' });
      writeQaReport('all-fail', {
        overall: 'FAIL',
        criteria: [{ name: 'broken', status: 'FAIL' }],
      });

      const { getAnalytics } = await import('@/app/actions/analytics');
      const data = await getAnalytics();

      expect(data.qaStats!.passRate).toBe(0);
      expect(data.qaStats!.passCount).toBe(0);
      expect(data.qaStats!.failCount).toBe(1);
    });

    it('skips malformed qa_report.json without crashing', async () => {
      writeTask('corrupt-qa', 'cq', { phase: 'done' });
      // Write invalid JSON
      writeFileSync(join(teamaiDir(), 'corrupt-qa', 'qa_report.json'), '{invalid json!!');

      const { getAnalytics } = await import('@/app/actions/analytics');
      const data = await getAnalytics();

      // Should not crash — malformed qa_report.json is caught and skipped
      expect(data.qaStats).toBeNull();
    });
  });

  // ── Source Breakdown ─────────────────────────────────────────────────

  describe('source breakdown', () => {
    it('categorizes tasks by source field', async () => {
      writeTask('s1', 'id-s1', { source: 'ideation' });
      writeTask('s2', 'id-s2', { source: 'ideation' });
      writeTask('s3', 'id-s3', { source: 'competitor-analysis' });
      writeTask('s4', 'id-s4', {}); // no source → unknown
      writeTask('s5', 'id-s5', { source: 'random-value' }); // unrecognized → unknown

      const { getAnalytics } = await import('@/app/actions/analytics');
      const data = await getAnalytics();

      expect(data.sourceBreakdown).toEqual({
        ideation: 2,
        competitorAnalysis: 1,
        unknown: 2,
      });
    });

    it('returns all unknown when no tasks have sources set', async () => {
      writeTask('no-source-1', 'ns1');
      writeTask('no-source-2', 'ns2');
      writeTask('no-source-3', 'ns3');

      const { getAnalytics } = await import('@/app/actions/analytics');
      const data = await getAnalytics();

      expect(data.sourceBreakdown).toEqual({
        ideation: 0,
        competitorAnalysis: 0,
        unknown: 3,
      });
    });
  });

  // ── Weekly Trends ────────────────────────────────────────────────────

  describe('weekly trends', () => {
    it('groups created and completed tasks by week', async () => {
      writeTask('w1', 'w1', {
        phase: 'done',
        createdAt: '2025-01-07T00:00:00Z',  // Tuesday → week of 2025-01-06
        updatedAt: '2025-01-08T00:00:00Z',  // Wednesday → week of 2025-01-06
      });
      writeTask('w2', 'w2', {
        phase: 'done',
        createdAt: '2025-01-15T00:00:00Z',  // Wednesday → week of 2025-01-13
        updatedAt: '2025-01-16T00:00:00Z',  // Thursday → week of 2025-01-13
      });
      writeTask('w3', 'w3', {
        phase: 'spec',                       // not done → no completed count
        createdAt: '2025-01-14T00:00:00Z',  // Tuesday → week of 2025-01-13
        updatedAt: '2025-01-14T00:00:00Z',
      });

      const { getAnalytics } = await import('@/app/actions/analytics');
      const data = await getAnalytics();

      expect(data.weeklyTrends.length).toBe(2);

      expect(data.weeklyTrends[0].week).toBe('2025-01-06');
      expect(data.weeklyTrends[0].created).toBe(1);
      expect(data.weeklyTrends[0].completed).toBe(1);

      expect(data.weeklyTrends[1].week).toBe('2025-01-13');
      expect(data.weeklyTrends[1].created).toBe(2);
      expect(data.weeklyTrends[1].completed).toBe(1);
    });

    it('handles cross-week created/completed (task created W1, done W3)', async () => {
      writeTask('cross', 'cross', {
        phase: 'done',
        createdAt: '2025-01-28T00:00:00Z',  // Tuesday → week of 2025-01-27
        updatedAt: '2025-02-05T00:00:00Z',  // Wednesday → week of 2025-02-03
      });
      writeTask('same', 'same', {
        phase: 'done',
        createdAt: '2025-01-13T00:00:00Z',  // Monday → week of 2025-01-13
        updatedAt: '2025-01-15T00:00:00Z',  // Wednesday → week of 2025-01-13
      });

      const { getAnalytics } = await import('@/app/actions/analytics');
      const data = await getAnalytics();

      expect(data.weeklyTrends.length).toBe(3);

      expect(data.weeklyTrends[0].week).toBe('2025-01-13');
      expect(data.weeklyTrends[0].created).toBe(1);
      expect(data.weeklyTrends[0].completed).toBe(1);

      expect(data.weeklyTrends[1].week).toBe('2025-01-27');
      expect(data.weeklyTrends[1].created).toBe(1);
      expect(data.weeklyTrends[1].completed).toBe(0);

      expect(data.weeklyTrends[2].week).toBe('2025-02-03');
      expect(data.weeklyTrends[2].created).toBe(0);
      expect(data.weeklyTrends[2].completed).toBe(1);
    });

    it('limits to last 12 weeks when more exist', async () => {
      for (let i = 0; i < 20; i++) {
        const d = new Date('2025-01-01T00:00:00Z');
        d.setDate(d.getDate() + i * 7);
        writeTask(`wk-${i}`, `wk-${i}`, {
          phase: 'done',
          createdAt: d.toISOString(),
          updatedAt: d.toISOString(),
        });
      }

      const { getAnalytics } = await import('@/app/actions/analytics');
      const data = await getAnalytics();

      expect(data.weeklyTrends.length).toBeLessThanOrEqual(12);
    });

    it('sorts weeks chronologically', async () => {
      // Create in reverse chronological order to verify sorting
      writeTask('recent', 'r', {
        phase: 'done',
        createdAt: '2025-06-01T00:00:00Z',
        updatedAt: '2025-06-01T00:00:00Z',
      });
      writeTask('old', 'o', {
        phase: 'done',
        createdAt: '2025-01-01T00:00:00Z',
        updatedAt: '2025-01-01T00:00:00Z',
      });

      const { getAnalytics } = await import('@/app/actions/analytics');
      const data = await getAnalytics();

      expect(data.weeklyTrends.length).toBe(2);
      expect(data.weeklyTrends[0].week).toBe('2024-12-30'); // 2025-01-01 is a Wednesday → week of 2024-12-30
      expect(data.weeklyTrends[1].week < data.weeklyTrends[0].week).toBe(false);
    });
  });

  // ── Bottleneck Detection ─────────────────────────────────────────────

  describe('bottleneck detection', () => {
    it('identifies the phase with highest average duration among active phases', async () => {
      const t0 = '2025-04-01T00:00:00Z';
      writeTask('bottleneck-task', 'bt', { phase: 'done', createdAt: t0 });

      appendEvent('bottleneck-task', { phase: 'backlog', timestamp: t0 });
      appendEvent('bottleneck-task', { phase: 'spec', timestamp: isoH(t0, 1) });
      appendEvent('bottleneck-task', { phase: 'plan', timestamp: isoH(t0, 2) });
      appendEvent('bottleneck-task', { phase: 'implement', timestamp: isoH(t0, 10) });
      appendEvent('bottleneck-task', { phase: 'done', timestamp: isoH(t0, 10.5) });

      const { getAnalytics } = await import('@/app/actions/analytics');
      const data = await getAnalytics();

      expect(data.bottleneck).not.toBeNull();
      // plan = 10 - 2 = 8h ← highest active phase
      expect(data.bottleneck!.phase).toBe('plan');
      expect(data.bottleneck!.avgHours).toBe(8);
    });

    it('excludes done, failed, cancelled, and backlog from bottleneck', async () => {
      const t0 = '2025-05-01T00:00:00Z';
      writeTask('excl-task', 'et', { phase: 'done', createdAt: t0 });

      appendEvent('excl-task', { phase: 'backlog', timestamp: t0 });
      appendEvent('excl-task', { phase: 'spec', timestamp: isoH(t0, 10) });
      appendEvent('excl-task', { phase: 'done', timestamp: isoH(t0, 11) });

      const { getAnalytics } = await import('@/app/actions/analytics');
      const data = await getAnalytics();

      // backlog excluded, spec=1h → bottleneck = spec
      expect(data.bottleneck).not.toBeNull();
      expect(data.bottleneck!.phase).toBe('spec');
      expect(data.bottleneck!.avgHours).toBe(1);
    });

    it('returns null when only excluded phases have timings', async () => {
      const t0 = '2025-06-01T00:00:00Z';
      writeTask('only-excl', 'oe', { phase: 'done', createdAt: t0 });

      appendEvent('only-excl', { phase: 'backlog', timestamp: t0 });
      appendEvent('only-excl', { phase: 'done', timestamp: isoH(t0, 1) });

      const { getAnalytics } = await import('@/app/actions/analytics');
      const data = await getAnalytics();

      expect(data.bottleneck).toBeNull();
    });

    it('returns null when no events exist', async () => {
      writeTask('no-events', 'ne', { phase: 'spec' });

      const { getAnalytics } = await import('@/app/actions/analytics');
      const data = await getAnalytics();

      expect(data.bottleneck).toBeNull();
    });

    it('uses the first returned phase from sorted phaseTimings (highest avg)', async () => {
      const t0 = '2025-07-01T00:00:00Z';
      writeTask('multi-phase', 'mp', { phase: 'done', createdAt: t0 });

      // qa-review=3h, spec=7h, implement=5h
      appendEvent('multi-phase', { phase: 'backlog', timestamp: t0 });
      appendEvent('multi-phase', { phase: 'spec', timestamp: isoH(t0, 7) });       // backlog=7h (excluded)
      appendEvent('multi-phase', { phase: 'implement', timestamp: isoH(t0, 12) }); // spec=5h
      appendEvent('multi-phase', { phase: 'qa-review', timestamp: isoH(t0, 15) }); // implement=3h
      appendEvent('multi-phase', { phase: 'done', timestamp: isoH(t0, 18) });      // qa-review=3h (done excluded)

      const { getAnalytics } = await import('@/app/actions/analytics');
      const data = await getAnalytics();

      // Active phases sorted by avgHours desc: spec(5h), implement(3h), qa-review(3h)
      // bottleck = spec (highest avg among active)
      expect(data.bottleneck!.phase).toBe('spec');
      expect(data.bottleneck!.avgHours).toBe(5);
    });
  });

  // ── End-to-End Multi-Task Scenario ───────────────────────────────────

  describe('end-to-end multi-task scenario', () => {
    it('computes full analytics for a realistic multi-task project', async () => {
      const base = '2025-03-03T00:00:00Z'; // Monday

      // Task 1: done (ideation source)
      writeTask('feat-auth', 'auth', {
        phase: 'done', source: 'ideation',
        createdAt: base, updatedAt: new Date(new Date(base).getTime() + 7 * 86400000).toISOString(),
      });
      appendEvent('feat-auth', { phase: 'backlog', timestamp: base });
      appendEvent('feat-auth', { phase: 'spec', timestamp: isoH(base, 12) });
      appendEvent('feat-auth', { phase: 'plan', timestamp: isoH(base, 48) });
      appendEvent('feat-auth', { phase: 'implement', timestamp: isoH(base, 96) });
      appendEvent('feat-auth', { phase: 'qa-review', timestamp: isoH(base, 144) });
      appendEvent('feat-auth', { phase: 'done', timestamp: isoH(base, 156) });
      writeQaReport('feat-auth', {
        overall: 'PASS',
        criteria: [
          { name: 'code-style', status: 'PASS' },
          { name: 'tests-passing', status: 'PASS' },
        ],
      });

      // Task 2: done (competitor-analysis source)
      writeTask('feat-analytics', 'analytics', {
        phase: 'done', source: 'competitor-analysis',
        createdAt: new Date(new Date(base).getTime() + 86400000).toISOString(),
        updatedAt: new Date(new Date(base).getTime() + 8 * 86400000).toISOString(),
      });
      appendEvent('feat-analytics', { phase: 'backlog', timestamp: isoH(base, 24) });
      appendEvent('feat-analytics', { phase: 'spec', timestamp: isoH(base, 48) });
      appendEvent('feat-analytics', { phase: 'plan', timestamp: isoH(base, 72) });
      appendEvent('feat-analytics', { phase: 'implement', timestamp: isoH(base, 120) });
      appendEvent('feat-analytics', { phase: 'qa-review', timestamp: isoH(base, 168) });
      appendEvent('feat-analytics', { phase: 'done', timestamp: isoH(base, 180) });
      writeQaReport('feat-analytics', {
        overall: 'PASS',
        criteria: [
          { name: 'code-style', status: 'PASS' },
          { name: 'tests-passing', status: 'FAIL' },
        ],
      });

      // Task 3: in implement (ideation)
      writeTask('feat-cache', 'cache', {
        phase: 'implement', source: 'ideation',
        createdAt: new Date(new Date(base).getTime() + 2 * 86400000).toISOString(),
        updatedAt: new Date(new Date(base).getTime() + 2 * 86400000).toISOString(),
      });
      appendEvent('feat-cache', { phase: 'backlog', timestamp: isoH(base, 48) });
      appendEvent('feat-cache', { phase: 'spec', timestamp: isoH(base, 60) });
      appendEvent('feat-cache', { phase: 'plan', timestamp: isoH(base, 72) });
      appendEvent('feat-cache', { phase: 'implement', timestamp: isoH(base, 120) });

      // Task 4: in planning (unknown source)
      writeTask('feat-export', 'export', {
        phase: 'plan',
        createdAt: new Date(new Date(base).getTime() + 3 * 86400000).toISOString(),
        updatedAt: new Date(new Date(base).getTime() + 3 * 86400000).toISOString(),
      });
      appendEvent('feat-export', { phase: 'backlog', timestamp: isoH(base, 72) });
      appendEvent('feat-export', { phase: 'spec', timestamp: isoH(base, 84) });
      appendEvent('feat-export', { phase: 'plan', timestamp: isoH(base, 120) });

      // Task 5: in backlog (ideation, no events)
      writeTask('feat-notifications', 'notif', {
        phase: 'backlog', source: 'ideation',
        createdAt: new Date(new Date(base).getTime() + 4 * 86400000).toISOString(),
        updatedAt: new Date(new Date(base).getTime() + 4 * 86400000).toISOString(),
      });

      // Task 6: failed, in qa-review (ideation)
      writeTask('feat-broken', 'broken', {
        phase: 'qa-review', source: 'ideation',
        createdAt: base, updatedAt: new Date(new Date(base).getTime() + 86400000).toISOString(),
      });
      appendEvent('feat-broken', { phase: 'backlog', timestamp: base });
      appendEvent('feat-broken', { phase: 'spec', timestamp: isoH(base, 12) });
      appendEvent('feat-broken', { phase: 'plan', timestamp: isoH(base, 24) });
      appendEvent('feat-broken', { phase: 'implement', timestamp: isoH(base, 72) });
      appendEvent('feat-broken', { phase: 'qa-review', timestamp: isoH(base, 120) });
      writeQaReport('feat-broken', {
        overall: 'FAIL',
        criteria: [
          { name: 'code-style', status: 'FAIL' },
          { name: 'tests-passing', status: 'FAIL' },
          { name: 'security-review', status: 'FAIL' },
        ],
      });

      const { getAnalytics } = await import('@/app/actions/analytics');
      const data = await getAnalytics();

      // Total tasks
      expect(data.totalTasks).toBe(6);

      // Phase distribution
      expect(data.phaseDistribution).toEqual({
        done: 2,
        implement: 1,
        plan: 1,
        backlog: 1,
        'qa-review': 1,
      });

      // Source breakdown
      expect(data.sourceBreakdown).toEqual({
        ideation: 4,
        competitorAnalysis: 1,
        unknown: 1,
      });

      // QA stats
      expect(data.qaStats).not.toBeNull();
      expect(data.qaStats!.totalQaRuns).toBe(3);
      expect(data.qaStats!.passCount).toBe(2);
      expect(data.qaStats!.failCount).toBe(1);
      expect(data.qaStats!.passRate).toBe(67);

      // Weekly trends
      expect(data.weeklyTrends.length).toBeGreaterThanOrEqual(1);

      // Bottleneck — plan has highest avg among active phases.
      // plan and implement both average 48h; plan wins because it was inserted
      // into phaseDurations before implement (stable sort preserves Map insertion order).
      expect(data.bottleneck).not.toBeNull();
      expect(data.bottleneck!.phase).toBe('plan');
    });
  });

  // ── Project Path Propagation ─────────────────────────────────────────

  describe('project path', () => {
    it('sets projectPath from getActiveProjectPath mock', async () => {
      const { getAnalytics } = await import('@/app/actions/analytics');
      const data = await getAnalytics();

      expect(data.projectPath).toBe(root);
      expect(mockGetActiveProjectPath).toHaveBeenCalledTimes(1);
    });
  });
});
