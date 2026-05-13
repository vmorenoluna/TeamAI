/**
 * Integration tests for the analytics pipeline.
 *
 * Tests exercise the full end-to-end getAnalytics() computation with real
 * filesystem operations: creates real tasks, events.jsonl, qa_report.json
 * files in temp directories, then verifies all analytics outputs.
 *
 * KEY: Phase durations are associated with the SOURCE phase of each
 * transition (events[i].phase), NOT the destination (events[i+1].phase).
 * Example: backlog→spec(2h)→plan(3h) means backlog=2h, spec=3h.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, writeFileSync, existsSync, readFileSync, rmSync, appendFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';

// ── Mocks ───────────────────────────────────────────────────────────────────

const mockGetActiveProjectPath = vi.fn();

vi.mock('@/app/actions/projects', () => ({
  getActiveProjectPath: (...args: unknown[]) => mockGetActiveProjectPath(...args),
}));

// ── Helpers ──────────────────────────────────────────────────────────────────

let projectDir: string;

/** Create a temp project directory with .teamai/ subdirectory */
function initProjectDir() {
  projectDir = join(tmpdir(), `teamai-analytics-integ-${randomUUID().slice(0, 8)}`);
  mkdirSync(join(projectDir, '.teamai'), { recursive: true });
  mockGetActiveProjectPath.mockResolvedValue(projectDir);
  return projectDir;
}

/** Write a task.json with given fields */
function writeTask(
  id: string,
  overrides: Partial<{
    title: string;
    description: string;
    phase: string;
    source: string;
    createdAt: string;
    updatedAt: string;
  }> = {},
) {
  const dir = join(projectDir, '.teamai', id);
  mkdirSync(dir, { recursive: true });
  const task = {
    id,
    title: overrides.title ?? 'Integration test task',
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
function appendEvent(taskId: string, event: { phase: string; timestamp: string }) {
  const dir = join(projectDir, '.teamai', taskId);
  const path = join(dir, 'events.jsonl');
  appendFileSync(path, JSON.stringify(event) + '\n');
}

/** Write a qa_report.json to the task directory */
function writeQaReport(taskId: string, report: object) {
  const dir = join(projectDir, '.teamai', taskId);
  writeFileSync(join(dir, 'qa_report.json'), JSON.stringify(report));
}

/** Clean up temp project directory */
function cleanupProjectDir() {
  if (projectDir && existsSync(projectDir)) {
    try {
      rmSync(projectDir, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
}

/** Helper: ISO date string offset by given hours from a base */
function isoH(isoBase: string, hours: number): string {
  const d = new Date(isoBase);
  d.setHours(d.getHours() + hours);
  return d.toISOString();
}

/** Helper: ISO date string offset by given days (including fractional) from a base.
 *  Uses UTC milliseconds to correctly handle fractional days. */
function isoD(isoBase: string, days: number): string {
  const ms = new Date(isoBase).getTime() + days * 86400000;
  return new Date(ms).toISOString();
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('Analytics Pipeline Integration', () => {
  beforeEach(() => {
    initProjectDir();
  });

  afterEach(() => {
    cleanupProjectDir();
    vi.clearAllMocks();
    vi.resetModules();
  });

  // ── Empty / Edge Cases ─────────────────────────────────────────────

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
      expect(data.projectPath).toBe(projectDir);
    });

    it('handles project with tasks but no events or QA reports', async () => {
      writeTask('task-1', { phase: 'spec' });
      writeTask('task-2', { phase: 'plan', source: 'ideation' });

      const { getAnalytics } = await import('@/app/actions/analytics');
      const data = await getAnalytics();

      expect(data.totalTasks).toBe(2);
      expect(data.phaseDistribution).toEqual({ spec: 1, plan: 1 });
      expect(data.phaseTimings).toEqual([]); // no events → no timings
      expect(data.qaStats).toBeNull(); // no QA reports
      expect(data.sourceBreakdown).toEqual({ ideation: 1, competitorAnalysis: 0, unknown: 1 });
      expect(data.bottleneck).toBeNull();
    });
  });

  // ── Phase Distribution ─────────────────────────────────────────────

  describe('phase distribution', () => {
    it('counts tasks across various phases', async () => {
      writeTask('t1', { phase: 'backlog' });
      writeTask('t2', { phase: 'spec' });
      writeTask('t3', { phase: 'spec' });
      writeTask('t4', { phase: 'plan' });
      writeTask('t5', { phase: 'implement' });
      writeTask('t6', { phase: 'implement' });
      writeTask('t7', { phase: 'implement' });
      writeTask('t8', { phase: 'done' });

      const { getAnalytics } = await import('@/app/actions/analytics');
      const data = await getAnalytics();

      expect(data.totalTasks).toBe(8);
      expect(data.phaseDistribution).toEqual({
        backlog: 1,
        spec: 2,
        plan: 1,
        implement: 3,
        done: 1,
      });
    });
  });

  // ── Phase Timings ──────────────────────────────────────────────────

  describe('phase timings from events.jsonl', () => {
    it('computes durations between consecutive events (source phase owns the duration)', async () => {
      const t0 = '2025-01-01T00:00:00Z';
      writeTask('timing-task', { phase: 'plan', createdAt: t0, updatedAt: t0 });

      // backlog→spec(2h) → backlog=2h; spec→plan(3h) → spec=3h
      appendEvent('timing-task', { phase: 'backlog', timestamp: t0 });
      appendEvent('timing-task', { phase: 'spec', timestamp: isoH(t0, 2) });
      appendEvent('timing-task', { phase: 'plan', timestamp: isoH(t0, 5) });

      const { getAnalytics } = await import('@/app/actions/analytics');
      const data = await getAnalytics();

      expect(data.phaseTimings.length).toBe(2);

      // Sort is by avgHours descending: spec(3h) first, backlog(2h) second
      expect(data.phaseTimings[0].phase).toBe('spec');
      expect(data.phaseTimings[0].avgHours).toBe(3);
      expect(data.phaseTimings[0].minHours).toBe(3);
      expect(data.phaseTimings[0].maxHours).toBe(3);
      expect(data.phaseTimings[0].count).toBe(1);

      expect(data.phaseTimings[1].phase).toBe('backlog');
      expect(data.phaseTimings[1].avgHours).toBe(2);
      expect(data.phaseTimings[1].minHours).toBe(2);
      expect(data.phaseTimings[1].maxHours).toBe(2);
      expect(data.phaseTimings[1].count).toBe(1);
    });

    it('aggregates durations across multiple tasks for same phase', async () => {
      const t0 = '2025-02-01T00:00:00Z';
      writeTask('a', { phase: 'spec', createdAt: t0 });
      writeTask('b', { phase: 'spec', createdAt: t0 });

      // Task A: backlog→spec (1h) → backlog=1h
      appendEvent('a', { phase: 'backlog', timestamp: t0 });
      appendEvent('a', { phase: 'spec', timestamp: isoH(t0, 1) });

      // Task B: backlog→spec (3h) → backlog=3h
      appendEvent('b', { phase: 'backlog', timestamp: t0 });
      appendEvent('b', { phase: 'spec', timestamp: isoH(t0, 3) });

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
      writeTask('sort-task', { phase: 'done', createdAt: t0 });

      // backlog→spec(10h) → backlog=10h; spec→plan(1h) → spec=1h
      appendEvent('sort-task', { phase: 'backlog', timestamp: t0 });
      appendEvent('sort-task', { phase: 'spec', timestamp: isoH(t0, 10) });
      appendEvent('sort-task', { phase: 'plan', timestamp: isoH(t0, 11) });

      const { getAnalytics } = await import('@/app/actions/analytics');
      const data = await getAnalytics();

      expect(data.phaseTimings.length).toBe(2);
      expect(data.phaseTimings[0].phase).toBe('backlog'); // 10h
      expect(data.phaseTimings[1].phase).toBe('spec'); // 1h
    });
  });

  // ── QA Stats ───────────────────────────────────────────────────────

  describe('QA stats aggregation', () => {
    it('computes pass/fail rates from qa_report.json files', async () => {
      writeTask('pass-task', { phase: 'done' });
      writeTask('fail-task', { phase: 'qa-review' });

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

    it('breaks down criteria by name and passRate', async () => {
      writeTask('qa1', { phase: 'done' });
      writeTask('qa2', { phase: 'done' });

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
      expect(testsPassing!.passRate).toBe(50); // 1/2
      expect(testsPassing!.total).toBe(2);

      expect(codeStyle).toBeDefined();
      expect(codeStyle!.passRate).toBe(100); // 2/2
      expect(codeStyle!.total).toBe(2);

      // Sorted by passRate ascending: tests-passing (50) before code-style (100)
      expect(data.qaStats!.criteriaBreakdown[0].name).toBe('tests-passing');
    });
  });

  // ── Source Breakdown ───────────────────────────────────────────────

  describe('source breakdown', () => {
    it('categorizes tasks by source field', async () => {
      writeTask('src-1', { source: 'ideation' });
      writeTask('src-2', { source: 'ideation' });
      writeTask('src-3', { source: 'competitor-analysis' });
      writeTask('src-4', {}); // no source → unknown
      writeTask('src-5', { source: 'unknown-value' }); // unknown

      const { getAnalytics } = await import('@/app/actions/analytics');
      const data = await getAnalytics();

      expect(data.sourceBreakdown).toEqual({
        ideation: 2,
        competitorAnalysis: 1,
        unknown: 2,
      });
    });
  });

  // ── Weekly Trends ──────────────────────────────────────────────────

  describe('weekly trends', () => {
    it('groups created and completed tasks by week', async () => {
      // Week of 2025-01-06 (Monday)
      writeTask('w1', {
        phase: 'done',
        createdAt: '2025-01-07T00:00:00Z', // Tuesday
        updatedAt: '2025-01-08T00:00:00Z', // Wednesday → week of 2025-01-06
      });
      // Week of 2025-01-13 (next Monday)
      writeTask('w2', {
        phase: 'done',
        createdAt: '2025-01-15T00:00:00Z', // Wednesday → week of 2025-01-13
        updatedAt: '2025-01-16T00:00:00Z', // Thursday → week of 2025-01-13
      });
      // Also created in w2 week but not done
      writeTask('w3', {
        phase: 'spec',
        createdAt: '2025-01-14T00:00:00Z', // Tuesday → week of 2025-01-13
        updatedAt: '2025-01-14T00:00:00Z',
      });

      const { getAnalytics } = await import('@/app/actions/analytics');
      const data = await getAnalytics();

      // 3 total entries, since all dates land in 2 different weeks
      // w1 created in 2025-01-06, completed in 2025-01-06 (same week)
      // w2 created in 2025-01-13, completed in 2025-01-13 (same week)
      // w3 created in 2025-01-13 (not completed)
      expect(data.weeklyTrends.length).toBe(2);

      expect(data.weeklyTrends[0].week).toBe('2025-01-06');
      expect(data.weeklyTrends[0].created).toBe(1);
      expect(data.weeklyTrends[0].completed).toBe(1);

      expect(data.weeklyTrends[1].week).toBe('2025-01-13');
      expect(data.weeklyTrends[1].created).toBe(2);
      expect(data.weeklyTrends[1].completed).toBe(1);
    });

    it('sorts weeks chronologically and handles cross-week created/completed', async () => {
      // Task created in one week, completed in a different week
      writeTask('cross-week', {
        phase: 'done',
        createdAt: '2025-01-28T00:00:00Z', // Tuesday → week of 2025-01-27
        updatedAt: '2025-02-05T00:00:00Z', // Wednesday → week of 2025-02-03
      });
      // Task created and completed in earlier week
      writeTask('same-week', {
        phase: 'done',
        createdAt: '2025-01-13T00:00:00Z', // Monday → week of 2025-01-13
        updatedAt: '2025-01-15T00:00:00Z', // Wednesday → week of 2025-01-13
      });

      const { getAnalytics } = await import('@/app/actions/analytics');
      const data = await getAnalytics();

      // 3 weeks total:
      //   2025-01-13: created=1, completed=1 (same-week task)
      //   2025-01-27: created=1 (cross-week created here)
      //   2025-02-03: completed=1 (cross-week completed here)
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
      // Create tasks spread across 20 weeks
      for (let i = 0; i < 20; i++) {
        const d = new Date('2025-01-01T00:00:00Z');
        d.setDate(d.getDate() + i * 7); // one per week
        writeTask(`wk-${i}`, {
          phase: 'done',
          createdAt: d.toISOString(),
          updatedAt: d.toISOString(),
        });
      }

      const { getAnalytics } = await import('@/app/actions/analytics');
      const data = await getAnalytics();

      expect(data.weeklyTrends.length).toBeLessThanOrEqual(12);
      // Should be the most recent 12 weeks
    });
  });

  // ── Bottleneck Detection ───────────────────────────────────────────

  describe('bottleneck detection', () => {
    it('identifies the phase with highest avg duration (source phase)', async () => {
      const t0 = '2025-04-01T00:00:00Z';
      writeTask('bottleneck-task', { phase: 'done', createdAt: t0 });

      // backlog→spec(1h) → backlog=1h
      // spec→plan(1h) → spec=1h
      // plan→implement(8h) → plan=8h ← bottleneck
      // implement→done(0.5h) → implement=0.5h
      appendEvent('bottleneck-task', { phase: 'backlog', timestamp: t0 });
      appendEvent('bottleneck-task', { phase: 'spec', timestamp: isoH(t0, 1) });
      appendEvent('bottleneck-task', { phase: 'plan', timestamp: isoH(t0, 2) });
      appendEvent('bottleneck-task', { phase: 'implement', timestamp: isoH(t0, 10) });
      appendEvent('bottleneck-task', { phase: 'done', timestamp: isoH(t0, 10.5) });

      const { getAnalytics } = await import('@/app/actions/analytics');
      const data = await getAnalytics();

      expect(data.bottleneck).not.toBeNull();
      expect(data.bottleneck!.phase).toBe('plan');
      expect(data.bottleneck!.avgHours).toBe(8);
    });

    it('excludes done, failed, cancelled, and backlog from bottleneck', async () => {
      const t0 = '2025-05-01T00:00:00Z';
      writeTask('excl-task', { phase: 'done', createdAt: t0 });

      // backlog→spec(10h) → backlog=10h (excluded)
      // spec→done(1h) → spec=1h
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
      writeTask('only-excluded', { phase: 'done', createdAt: t0 });

      // Only backlog and done events (both excluded from bottleneck)
      appendEvent('only-excluded', { phase: 'backlog', timestamp: t0 });
      appendEvent('only-excluded', { phase: 'done', timestamp: isoH(t0, 1) });

      const { getAnalytics } = await import('@/app/actions/analytics');
      const data = await getAnalytics();

      // backlog and done are both excluded → no active phases
      expect(data.bottleneck).toBeNull();
    });
  });

  // ── End-to-End Multi-Task Scenario ─────────────────────────────────

  describe('end-to-end multi-task scenario', () => {
    it('computes full analytics for a realistic multi-task project', async () => {
      const base = '2025-03-03T00:00:00Z'; // Monday

      // Task 1: completed task (ideation) — went through full pipeline
      writeTask('feat-auth', {
        title: 'Auth feature',
        phase: 'done',
        source: 'ideation',
        createdAt: isoD(base, 0),
        updatedAt: isoD(base, 3),
      });
      appendEvent('feat-auth', { phase: 'backlog', timestamp: isoD(base, 0) });      // +0d
      appendEvent('feat-auth', { phase: 'spec', timestamp: isoD(base, 0.5) });       // +0.5d
      appendEvent('feat-auth', { phase: 'plan', timestamp: isoD(base, 2) });         // +2d
      appendEvent('feat-auth', { phase: 'implement', timestamp: isoD(base, 4) });    // +4d
      appendEvent('feat-auth', { phase: 'qa-review', timestamp: isoD(base, 6) });    // +6d
      appendEvent('feat-auth', { phase: 'merge', timestamp: isoD(base, 6.5) });      // +6.5d
      appendEvent('feat-auth', { phase: 'done', timestamp: isoD(base, 7) });          // +7d
      writeQaReport('feat-auth', {
        overall: 'PASS',
        criteria: [
          { name: 'code-style', status: 'PASS' },
          { name: 'tests-passing', status: 'PASS' },
          { name: 'security-review', status: 'PASS' },
        ],
      });

      // Task 2: completed task (competitor-analysis)
      writeTask('feat-analytics', {
        title: 'Analytics dashboard',
        phase: 'done',
        source: 'competitor-analysis',
        createdAt: isoD(base, 1),
        updatedAt: isoD(base, 4),
      });
      appendEvent('feat-analytics', { phase: 'backlog', timestamp: isoD(base, 1) });   // +1d
      appendEvent('feat-analytics', { phase: 'spec', timestamp: isoD(base, 2) });      // +2d
      appendEvent('feat-analytics', { phase: 'plan', timestamp: isoD(base, 3) });      // +3d
      appendEvent('feat-analytics', { phase: 'implement', timestamp: isoD(base, 5) }); // +5d
      appendEvent('feat-analytics', { phase: 'qa-review', timestamp: isoD(base, 7) }); // +7d
      appendEvent('feat-analytics', { phase: 'merge', timestamp: isoD(base, 7.5) });   // +7.5d
      appendEvent('feat-analytics', { phase: 'done', timestamp: isoD(base, 8) });       // +8d
      writeQaReport('feat-analytics', {
        overall: 'PASS',
        criteria: [
          { name: 'code-style', status: 'PASS' },
          { name: 'tests-passing', status: 'FAIL' },
        ],
      });

      // Task 3: currently in implement (ideation)
      writeTask('feat-cache', {
        title: 'Caching layer',
        phase: 'implement',
        source: 'ideation',
        createdAt: isoD(base, 2),
        updatedAt: isoD(base, 2),
      });
      appendEvent('feat-cache', { phase: 'backlog', timestamp: isoD(base, 2) });     // +2d
      appendEvent('feat-cache', { phase: 'spec', timestamp: isoD(base, 2.5) });      // +2.5d
      appendEvent('feat-cache', { phase: 'plan', timestamp: isoD(base, 3) });        // +3d
      appendEvent('feat-cache', { phase: 'implement', timestamp: isoD(base, 5) });   // +5d

      // Task 4: in planning (no source → unknown)
      writeTask('feat-export', {
        title: 'Export feature',
        phase: 'plan',
        createdAt: isoD(base, 3),
        updatedAt: isoD(base, 3),
      });
      appendEvent('feat-export', { phase: 'backlog', timestamp: isoD(base, 3) });    // +3d
      appendEvent('feat-export', { phase: 'spec', timestamp: isoD(base, 3.5) });     // +3.5d
      appendEvent('feat-export', { phase: 'plan', timestamp: isoD(base, 5) });       // +5d

      // Task 5: in backlog
      writeTask('feat-notifications', {
        title: 'Notifications',
        phase: 'backlog',
        source: 'ideation',
        createdAt: isoD(base, 4),
        updatedAt: isoD(base, 4),
      });

      // Task 6: failed task with QA
      writeTask('feat-broken', {
        title: 'Broken feature',
        phase: 'qa-review',
        source: 'ideation',
        createdAt: isoD(base, 0),
        updatedAt: isoD(base, 1),
      });
      appendEvent('feat-broken', { phase: 'backlog', timestamp: isoD(base, 0) });    // +0d
      appendEvent('feat-broken', { phase: 'spec', timestamp: isoD(base, 0.5) });     // +0.5d
      appendEvent('feat-broken', { phase: 'plan', timestamp: isoD(base, 1) });       // +1d
      appendEvent('feat-broken', { phase: 'implement', timestamp: isoD(base, 3) });  // +3d
      appendEvent('feat-broken', { phase: 'qa-review', timestamp: isoD(base, 5) });  // +5d
      writeQaReport('feat-broken', {
        overall: 'FAIL',
        criteria: [
          { name: 'code-style', status: 'FAIL' },
          { name: 'tests-passing', status: 'FAIL' },
          { name: 'security-review', status: 'FAIL' },
        ],
      });

      // ── Assertions ──────────────────────────────────────────────────
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
      expect(data.qaStats!.passRate).toBe(67); // round(2/3 * 100) = 67

      // Criteria breakdown: 3 criteria total
      expect(data.qaStats!.criteriaBreakdown.length).toBe(3);
      const securityReview = data.qaStats!.criteriaBreakdown.find(c => c.name === 'security-review');
      expect(securityReview).toBeDefined();
      expect(securityReview!.passRate).toBe(50); // 1/2
      expect(securityReview!.total).toBe(2);

      // Weekly trends
      expect(data.weeklyTrends.length).toBeGreaterThanOrEqual(1);
      const firstWeek = data.weeklyTrends[0];
      expect(firstWeek.week).toBe('2025-03-03');

      // Bottleneck — plan has highest avg duration among active phases
      // (backlog is excluded from bottleneck detection)
      // Phase durations (source phase of each transition):
      //   feat-auth:  backlog(12h), spec(36h), plan(48h), implement(48h), qa-review(12h), merge(12h)
      //   feat-analytics: backlog(24h), spec(24h), plan(48h), implement(48h), qa-review(12h), merge(12h)
      //   feat-cache: backlog(12h), spec(12h), plan(48h)
      //   feat-export: backlog(12h), spec(36h)
      //   feat-broken: backlog(12h), spec(12h), plan(48h), implement(48h)
      //
      // Averages (active phases only, excluding backlog/done/failed/cancelled):
      //   spec: (36+24+12+36+12)/5 = 24h
      //   plan: (48+48+48+48)/4 = 48h ← bottleneck
      //   implement: (48+48+48)/3 = 48h
      //   qa-review: (12+12)/2 = 12h
      //   merge: (12+12)/2 = 12h
      // plan wins tiebreak because it was inserted into phaseDurations first
      expect(data.bottleneck).not.toBeNull();
      expect(data.bottleneck!.phase).toBe('plan');
    });
  });

  // ── Project Path Propagation ───────────────────────────────────────

  describe('project path propagation', () => {
    it('sets projectPath from getActiveProjectPath', async () => {
      const { getAnalytics } = await import('@/app/actions/analytics');
      const data = await getAnalytics();

      expect(data.projectPath).toBe(projectDir);
      expect(mockGetActiveProjectPath).toHaveBeenCalledTimes(1);
    });
  });
});
