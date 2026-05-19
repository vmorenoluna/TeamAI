import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { TaskStore } from '@/lib/task-store';
import { mkdirSync, rmSync, existsSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';

// ── Mock setup ────────────────────────────────────────────────────────────
// vi.hoisted runs before vi.mock, so testDir is available when the mock factory executes

const { testDir } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { join } = require('path');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { randomUUID } = require('crypto');
  return {
    testDir: join(process.cwd(), '.teamai-test-analytics-' + randomUUID().slice(0, 8)),
  };
});

vi.mock('@/app/actions/projects', () => ({
  getActiveProjectPath: vi.fn().mockResolvedValue(testDir),
}));

// Import after mock
import { getAnalytics } from '@/app/actions/analytics';

// ── Helper types for qaReport ─────────────────────────────────────────────

interface QACriterion {
  name: string;
  status: 'PASS' | 'FAIL';
}

interface QAReportFixture {
  overall: 'PASS' | 'FAIL';
  criteria: QACriterion[];
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe('getAnalytics', () => {
  let store: TaskStore;

  beforeEach(() => {
    mkdirSync(testDir, { recursive: true });
    store = new TaskStore(testDir);
  });

  afterEach(() => {
    if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
  });

  // ── Helpers ─────────────────────────────────────────────────────────────

  /** Create a task, advance its phases, write events.jsonl, optionally a qa_report.
   *  Since TaskStore.update() excludes createdAt from its Partial, we write
   *  createdAt directly to task.json when needed. */
  function createTaskWithPhases(
    id: string,
    title: string,
    phases: string[],
    opts?: { source?: string; createdAt?: string; updatedAt?: string; qaReport?: QAReportFixture }
  ) {
    store.create(id, title, 'desc', opts?.source, undefined);

    if (opts?.createdAt) {
      const dir = store.getDirById(id);
      const taskPath = join(dir, 'task.json');
      const task = JSON.parse(readFileSync(taskPath, 'utf-8'));
      task.createdAt = opts.createdAt;
      writeFileSync(taskPath, JSON.stringify(task, null, 2));
    }

    for (const phase of phases) {
      store.updatePhase(id, phase);
    }

    if (opts?.updatedAt) {
      const dir = store.getDirById(id);
      const taskPath = join(dir, 'task.json');
      const task = JSON.parse(readFileSync(taskPath, 'utf-8'));
      task.updatedAt = opts.updatedAt;
      writeFileSync(taskPath, JSON.stringify(task, null, 2));
    }

    if (opts?.qaReport) {
      const dir = store.getDirById(id);
      writeFileSync(join(dir, 'qa_report.json'), JSON.stringify(opts.qaReport, null, 2));
    }
  }

  // ── Empty state ──────────────────────────────────────────────────────────

  it('returns empty analytics when no tasks exist', async () => {
    const data = await getAnalytics();
    expect(data.totalTasks).toBe(0);
    expect(data.phaseDistribution).toEqual({});
    expect(data.phaseTimings).toEqual([]);
    expect(data.qaStats).toBeNull();
    expect(data.sourceBreakdown).toEqual({ ideation: 0, competitorAnalysis: 0, unknown: 0 });
    expect(data.weeklyTrends).toEqual([]);
    expect(data.bottleneck).toBeNull();
    expect(data.projectPath).toBe(testDir);
  });

  // ── Phase distribution ──────────────────────────────────────────────────

  it('correctly computes phase distribution across tasks', async () => {
    createTaskWithPhases('t1', 'Task 1', ['spec', 'plan']);
    createTaskWithPhases('t2', 'Task 2', ['spec']); // still in spec
    createTaskWithPhases('t3', 'Task 3', ['spec', 'plan', 'implement', 'done']);

    const data = await getAnalytics();

    // t1 is in plan, t2 in spec, t3 in done
    expect(data.phaseDistribution).toEqual({
      plan: 1,
      spec: 1,
      done: 1,
    });
  });

  it('groups multiple tasks in the same phase', async () => {
    createTaskWithPhases('t1', 'Task 1', []); // in backlog
    createTaskWithPhases('t2', 'Task 2', []); // in backlog
    createTaskWithPhases('t3', 'Task 3', ['spec']); // in spec

    const data = await getAnalytics();
    expect(data.phaseDistribution).toEqual({
      backlog: 2,
      spec: 1,
    });
  });

  // ── Phase timings ───────────────────────────────────────────────────────

  it('computes phase timings from events.jsonl', async () => {
    createTaskWithPhases('t1', 'Task 1', ['spec', 'plan', 'implement']);

    const data = await getAnalytics();
    expect(data.phaseTimings.length).toBeGreaterThanOrEqual(1);

    // Find the spec phase timing
    const specTiming = data.phaseTimings.find(p => p.phase === 'spec');
    expect(specTiming).toBeDefined();
    expect(specTiming!.count).toBe(1);
    // avgHours should be a small number (test runs instantly)
    expect(specTiming!.avgHours).toBeGreaterThanOrEqual(0);
  });

  it('skips tasks with fewer than 2 events for timing computation', async () => {
    createTaskWithPhases('t1', 'Task 1', []); // only a single event at creation

    const data = await getAnalytics();
    expect(data.phaseTimings).toEqual([]);
  });

  it('handles negative durations gracefully (clock skew)', async () => {
    store.create('t1', 'Clock Skew Task', 'desc');
    store.updatePhase('t1', 'spec');

    // Manually overwrite events.jsonl with timestamps that would produce negative duration
    const dir = store.getDirById('t1');
    const eventsPath = join(dir, 'events.jsonl');
    writeFileSync(eventsPath,
      JSON.stringify({ phase: 'spec', timestamp: '2025-01-01T10:00:00Z' }) + '\n' +
      JSON.stringify({ phase: 'plan', timestamp: '2025-01-01T09:00:00Z' }) + '\n' // earlier!
    );

    const data = await getAnalytics();
    // All transitions are negative → no valid timings
    expect(data.phaseTimings.length).toBe(0);
  });

  it('handles multiple tasks contributing to same phase durations', async () => {
    createTaskWithPhases('t1', 'Task 1', ['spec', 'plan']);
    createTaskWithPhases('t2', 'Task 2', ['spec', 'plan', 'implement']);
    createTaskWithPhases('t3', 'Task 3', ['spec', 'plan']);

    const data = await getAnalytics();
    const specTiming = data.phaseTimings.find(p => p.phase === 'spec');
    expect(specTiming).toBeDefined();
    expect(specTiming!.count).toBe(3); // all 3 tasks have spec→next transition

    const planTiming = data.phaseTimings.find(p => p.phase === 'plan');
    expect(planTiming).toBeDefined();
    expect(planTiming!.count).toBe(1); // only t2 has plan→implement transition
  });

  it('sorts phase timings by avgHours descending', async () => {
    // Create a task with events that clearly have different durations
    store.create('t1', 'Task', 'desc');
    store.updatePhase('t1', 'spec');

    const dir = store.getDirById('t1');
    writeFileSync(join(dir, 'events.jsonl'),
      JSON.stringify({ phase: 'phase-a', timestamp: '2025-01-01T00:00:00Z' }) + '\n' +
      JSON.stringify({ phase: 'phase-b', timestamp: '2025-01-01T01:00:00Z' }) + '\n' + // 1 hour
      JSON.stringify({ phase: 'phase-c', timestamp: '2025-01-01T05:00:00Z' }) + '\n'   // 4 hours
    );

    const data = await getAnalytics();
    expect(data.phaseTimings.length).toBe(2);

    // phase-b comes first (4 hours > 1 hour)
    expect(data.phaseTimings[0].phase).toBe('phase-b');
    expect(data.phaseTimings[0].avgHours).toBeCloseTo(4, 0);

    expect(data.phaseTimings[1].phase).toBe('phase-a');
    expect(data.phaseTimings[1].avgHours).toBeCloseTo(1, 0);
  });

  it('handles malformed events.jsonl gracefully', async () => {
    store.create('t1', 'Malformed Events', 'desc');
    const dir = store.getDirById('t1');
    writeFileSync(join(dir, 'events.jsonl'), '{ invalid json }\n');

    // Should not throw — just skip the malformed task
    const data = await getAnalytics();
    expect(data.phaseTimings).toEqual([]);
  });

  // ── QA stats ─────────────────────────────────────────────────────────────

  it('returns null qaStats when no tasks have qa reports', async () => {
    createTaskWithPhases('t1', 'Task 1', ['spec', 'done']);

    const data = await getAnalytics();
    expect(data.qaStats).toBeNull();
  });

  it('computes QA pass stats from qa_report.json files', async () => {
    createTaskWithPhases('t1', 'Task 1', ['implement'], {
      qaReport: { overall: 'PASS', criteria: [] },
    });

    const data = await getAnalytics();
    expect(data.qaStats).not.toBeNull();
    expect(data.qaStats!.totalQaRuns).toBe(1);
    expect(data.qaStats!.passCount).toBe(1);
    expect(data.qaStats!.failCount).toBe(0);
    expect(data.qaStats!.passRate).toBe(100);
  });

  it('computes QA fail stats correctly', async () => {
    createTaskWithPhases('t1', 'Task 1', ['implement'], {
      qaReport: { overall: 'FAIL', criteria: [] },
    });

    const data = await getAnalytics();
    expect(data.qaStats).not.toBeNull();
    expect(data.qaStats!.passCount).toBe(0);
    expect(data.qaStats!.failCount).toBe(1);
    expect(data.qaStats!.passRate).toBe(0);
  });

  it('aggregates QA stats across multiple tasks', async () => {
    createTaskWithPhases('t1', 'Task 1', ['implement'], {
      qaReport: { overall: 'PASS', criteria: [] },
    });
    createTaskWithPhases('t2', 'Task 2', ['implement'], {
      qaReport: { overall: 'PASS', criteria: [] },
    });
    createTaskWithPhases('t3', 'Task 3', ['implement'], {
      qaReport: { overall: 'FAIL', criteria: [] },
    });

    const data = await getAnalytics();
    expect(data.qaStats!.totalQaRuns).toBe(3);
    expect(data.qaStats!.passCount).toBe(2);
    expect(data.qaStats!.failCount).toBe(1);
    expect(data.qaStats!.passRate).toBe(67); // 2/3 = 66.67, rounded
  });

  it('computes criteria breakdown from qa reports', async () => {
    createTaskWithPhases('t1', 'Task 1', ['implement'], {
      qaReport: {
        overall: 'PASS',
        criteria: [
          { name: 'typescript', status: 'PASS' },
          { name: 'tests', status: 'PASS' },
          { name: 'lint', status: 'FAIL' },
        ],
      },
    });
    createTaskWithPhases('t2', 'Task 2', ['implement'], {
      qaReport: {
        overall: 'FAIL',
        criteria: [
          { name: 'typescript', status: 'PASS' },
          { name: 'tests', status: 'FAIL' },
          { name: 'lint', status: 'FAIL' },
        ],
      },
    });

    const data = await getAnalytics();
    expect(data.qaStats!.criteriaBreakdown).toHaveLength(3);

    const tsCriterion = data.qaStats!.criteriaBreakdown.find(c => c.name === 'typescript');
    expect(tsCriterion).toBeDefined();
    expect(tsCriterion!.passRate).toBe(100);
    expect(tsCriterion!.total).toBe(2);

    const testsCriterion = data.qaStats!.criteriaBreakdown.find(c => c.name === 'tests');
    expect(testsCriterion).toBeDefined();
    expect(testsCriterion!.passRate).toBe(50);
    expect(testsCriterion!.total).toBe(2);

    const lintCriterion = data.qaStats!.criteriaBreakdown.find(c => c.name === 'lint');
    expect(lintCriterion).toBeDefined();
    expect(lintCriterion!.passRate).toBe(0);
    expect(lintCriterion!.total).toBe(2);
  });

  it('sorts criteria breakdown by pass rate ascending (worst first)', async () => {
    createTaskWithPhases('t1', 'Task', ['implement'], {
      qaReport: {
        overall: 'PASS',
        criteria: [
          { name: 'always-passes', status: 'PASS' },
          { name: 'always-fails', status: 'FAIL' },
        ],
      },
    });

    const data = await getAnalytics();
    expect(data.qaStats!.criteriaBreakdown[0].name).toBe('always-fails');
    expect(data.qaStats!.criteriaBreakdown[0].passRate).toBe(0);
    expect(data.qaStats!.criteriaBreakdown[1].name).toBe('always-passes');
    expect(data.qaStats!.criteriaBreakdown[1].passRate).toBe(100);
  });

  it('skips malformed qa reports gracefully', async () => {
    createTaskWithPhases('t1', 'Good Task', ['implement'], {
      qaReport: { overall: 'PASS', criteria: [] },
    });
    // Write malformed JSON to another task's qa_report
    createTaskWithPhases('t2', 'Bad Task', ['implement']);
    const dir = store.getDirById('t2');
    writeFileSync(join(dir, 'qa_report.json'), '{ invalid json }');

    const data = await getAnalytics();
    // Should still get stats from the good task
    expect(data.qaStats!.totalQaRuns).toBe(1);
    expect(data.qaStats!.passCount).toBe(1);
  });

  // ── Source breakdown ────────────────────────────────────────────────────

  it('breaks down tasks by source', async () => {
    createTaskWithPhases('t1', 'Ideation Task', [], { source: 'ideation' });
    createTaskWithPhases('t2', 'Ideation Task 2', [], { source: 'ideation' });
    createTaskWithPhases('t3', 'Competitor Task', [], { source: 'competitor-analysis' });

    const data = await getAnalytics();
    expect(data.sourceBreakdown).toEqual({
      ideation: 2,
      competitorAnalysis: 1,
      unknown: 0,
    });
  });

  it('counts tasks without source as unknown', async () => {
    createTaskWithPhases('t1', 'No Source', []);
    createTaskWithPhases('t2', 'Ideation', [], { source: 'ideation' });
    createTaskWithPhases('t3', 'No Source 2', []);

    const data = await getAnalytics();
    expect(data.sourceBreakdown.unknown).toBe(2);
    expect(data.sourceBreakdown.ideation).toBe(1);
    expect(data.sourceBreakdown.competitorAnalysis).toBe(0);
  });

  // ── Weekly trends ───────────────────────────────────────────────────────

  it('tracks created count per week', async () => {
    createTaskWithPhases('t1', 'Task 1', [], { createdAt: '2025-06-02T10:00:00Z' }); // Monday Jun 2
    createTaskWithPhases('t2', 'Task 2', [], { createdAt: '2025-06-03T10:00:00Z' }); // Same week
    createTaskWithPhases('t3', 'Task 3', [], { createdAt: '2025-06-09T10:00:00Z' }); // Next Monday (new week)

    const data = await getAnalytics();
    expect(data.weeklyTrends.length).toBe(2);

    const week1 = data.weeklyTrends.find(w => w.week === '2025-06-02');
    expect(week1).toBeDefined();
    expect(week1!.created).toBe(2);
    expect(week1!.completed).toBe(0);

    const week2 = data.weeklyTrends.find(w => w.week === '2025-06-09');
    expect(week2).toBeDefined();
    expect(week2!.created).toBe(1);
  });

  it('tracks completed count when tasks reach done phase', async () => {
    const created = '2025-06-02T10:00:00Z';
    const completed = '2025-06-03T15:00:00Z'; // same week

    createTaskWithPhases('t1', 'Done Task', ['spec', 'plan', 'implement', 'done'], {
      createdAt: created,
      updatedAt: completed,
    });

    const data = await getAnalytics();
    const week = data.weeklyTrends.find(w => w.week === '2025-06-02');
    expect(week).toBeDefined();
    expect(week!.created).toBe(1);
    expect(week!.completed).toBe(1);
  });

  it('handles completion in a different week from creation', async () => {
    createTaskWithPhases('t1', 'Cross Week', ['spec', 'plan', 'done'], {
      createdAt: '2025-06-02T10:00:00Z', // Week 23
      updatedAt: '2025-06-16T15:00:00Z', // Week 25
    });

    const data = await getAnalytics();
    const createWeek = data.weeklyTrends.find(w => w.week === '2025-06-02');
    const completeWeek = data.weeklyTrends.find(w => w.week === '2025-06-16');

    expect(createWeek).toBeDefined();
    expect(createWeek!.created).toBe(1);
    expect(createWeek!.completed).toBe(0);

    expect(completeWeek).toBeDefined();
    expect(completeWeek!.created).toBe(0);
    expect(completeWeek!.completed).toBe(1);
  });

  it('limits weekly trends to last 12 weeks', async () => {
    // Create tasks across 15 different weeks
    for (let i = 0; i < 15; i++) {
      const date = new Date('2025-01-06T10:00:00Z'); // First Monday of 2025
      date.setDate(date.getDate() + i * 7); // advance by weeks
      createTaskWithPhases(`t${i}`, `Task ${i}`, [], {
        createdAt: date.toISOString(),
      });
    }

    const data = await getAnalytics();
    // Should have exactly 12 (slice -12 from 15 entries)
    expect(data.weeklyTrends.length).toBe(12);
  });

  it('sorts weekly trends chronologically', async () => {
    createTaskWithPhases('t1', 'Early', [], { createdAt: '2025-06-02T10:00:00Z' });
    createTaskWithPhases('t2', 'Late', [], { createdAt: '2025-06-23T10:00:00Z' });
    createTaskWithPhases('t3', 'Middle', [], { createdAt: '2025-06-09T10:00:00Z' });

    const data = await getAnalytics();
    for (let i = 1; i < data.weeklyTrends.length; i++) {
      expect(data.weeklyTrends[i].week.localeCompare(data.weeklyTrends[i - 1].week)).toBeGreaterThanOrEqual(0);
    }
  });

  it('correctly aligns to Monday for week start dates', async () => {
    // Sunday June 1, 2025 should belong to week starting Monday May 26
    createTaskWithPhases('t1', 'Sunday Task', [], { createdAt: '2025-06-01T10:00:00Z' });

    const data = await getAnalytics();
    const week = data.weeklyTrends.find(w => w.week === '2025-05-26');
    expect(week).toBeDefined();
    expect(week!.created).toBe(1);
  });

  // ── Bottleneck ──────────────────────────────────────────────────────────

  it('identifies bottleneck as the phase with highest average duration', async () => {
    store.create('t1', 'Bottleneck Task', 'desc');

    const dir = store.getDirById('t1');
    writeFileSync(join(dir, 'events.jsonl'),
      JSON.stringify({ phase: 'spec', timestamp: '2025-01-01T00:00:00Z' }) + '\n' +
      JSON.stringify({ phase: 'plan', timestamp: '2025-01-01T00:30:00Z' }) + '\n' +    // 0.5 hours in spec
      JSON.stringify({ phase: 'implement', timestamp: '2025-01-01T04:30:00Z' }) + '\n' // 4 hours in plan
    );

    const data = await getAnalytics();
    expect(data.bottleneck).not.toBeNull();
    expect(data.bottleneck!.phase).toBe('plan');
    expect(data.bottleneck!.avgHours).toBeCloseTo(4, 0);
  });

  it('excludes done, failed, cancelled, and backlog phases from bottleneck', async () => {
    store.create('t1', 'Task', 'desc');

    const dir = store.getDirById('t1');
    writeFileSync(join(dir, 'events.jsonl'),
      JSON.stringify({ phase: 'backlog', timestamp: '2025-01-01T00:00:00Z' }) + '\n' +
      JSON.stringify({ phase: 'spec', timestamp: '2025-01-01T10:00:00Z' }) + '\n' +     // 10 hours backlog (excluded)
      JSON.stringify({ phase: 'done', timestamp: '2025-01-01T10:30:00Z' }) + '\n'        // 0.5 hours spec
    );

    const data = await getAnalytics();
    // Spec should be the bottleneck, not backlog
    expect(data.bottleneck).not.toBeNull();
    expect(data.bottleneck!.phase).toBe('spec');
    expect(data.bottleneck!.avgHours).toBeCloseTo(0.5, 1);
  });

  it('returns null bottleneck when no active phases have timings', async () => {
    createTaskWithPhases('t1', 'Task 1', []); // no events

    const data = await getAnalytics();
    expect(data.bottleneck).toBeNull();
  });

  it('returns null bottleneck when all tasks only reached backlog', async () => {
    createTaskWithPhases('t1', 'Task 1', []);

    const data = await getAnalytics();
    expect(data.bottleneck).toBeNull();
  });

  // ── Min/max hours in phase timings ──────────────────────────────────────

  it('computes min and max hours for phase timings', async () => {
    // Task 1: slow
    store.create('t1', 'Slow', 'desc');
    store.updatePhase('t1', 'spec');
    const dir1 = store.getDirById('t1');
    writeFileSync(join(dir1, 'events.jsonl'),
      JSON.stringify({ phase: 'spec', timestamp: '2025-01-01T00:00:00Z' }) + '\n' +
      JSON.stringify({ phase: 'plan', timestamp: '2025-01-01T05:00:00Z' }) + '\n' // 5 hours in spec
    );

    // Task 2: quick
    store.create('t2', 'Quick', 'desc');
    store.updatePhase('t2', 'spec');
    const dir2 = store.getDirById('t2');
    writeFileSync(join(dir2, 'events.jsonl'),
      JSON.stringify({ phase: 'spec', timestamp: '2025-01-01T00:00:00Z' }) + '\n' +
      JSON.stringify({ phase: 'plan', timestamp: '2025-01-01T01:00:00Z' }) + '\n' // 1 hour in spec
    );

    const data = await getAnalytics();
    const specTiming = data.phaseTimings.find(p => p.phase === 'spec');
    expect(specTiming).toBeDefined();
    expect(specTiming!.minHours).toBeCloseTo(1, 0);
    expect(specTiming!.maxHours).toBeCloseTo(5, 0);
    expect(specTiming!.avgHours).toBeCloseTo(3, 0);
    expect(specTiming!.count).toBe(2);
  });

  // ── Total tasks count ───────────────────────────────────────────────────

  it('reports correct total task count', async () => {
    createTaskWithPhases('t1', 'A', []);
    createTaskWithPhases('t2', 'B', []);
    createTaskWithPhases('t3', 'C', []);
    createTaskWithPhases('t4', 'D', []);
    createTaskWithPhases('t5', 'E', []);

    const data = await getAnalytics();
    expect(data.totalTasks).toBe(5);
  });

  // ── Events with missing timestamps ──────────────────────────────────────

  it('skips events with missing timestamps', async () => {
    store.create('t1', 'Bad Timestamps', 'desc');
    const dir = store.getDirById('t1');
    writeFileSync(join(dir, 'events.jsonl'),
      JSON.stringify({ phase: 'spec', timestamp: null }) + '\n' +
      JSON.stringify({ phase: 'plan', timestamp: '2025-01-01T01:00:00Z' }) + '\n'
    );

    const data = await getAnalytics();
    // null timestamp → parseTime returns null → skipped
    expect(data.phaseTimings).toEqual([]);
  });
});
