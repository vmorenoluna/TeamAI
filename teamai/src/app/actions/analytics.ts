'use server';

import { TaskStore } from '@/lib/task-store';
import { getActiveProjectPath } from './projects';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import type { QAReportData } from '@/lib/stream-types';

// ── Analytics data types ────────────────────────────────────────────────────

export interface PhaseTiming {
  phase: string;
  avgHours: number;
  minHours: number;
  maxHours: number;
  count: number;
}

export interface QAStats {
  totalQaRuns: number;
  passCount: number;
  failCount: number;
  passRate: number; // 0-100
  criteriaBreakdown: Array<{ name: string; passRate: number; total: number }>;
}

export interface SourceBreakdown {
  ideation: number;
  competitorAnalysis: number;
  unknown: number;
}

export interface WeeklyTrend {
  week: string; // ISO week start date
  created: number;
  completed: number;
}

export interface AnalyticsData {
  projectPath: string;
  totalTasks: number;
  phaseDistribution: Record<string, number>;
  phaseTimings: PhaseTiming[];
  qaStats: QAStats | null;
  sourceBreakdown: SourceBreakdown;
  weeklyTrends: WeeklyTrend[];
  bottleneck: PhaseTiming | null;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Parse ISO timestamp, return milliseconds since epoch, or null if invalid */
function parseTime(ts: string | undefined | null): number | null {
  if (!ts) return null;
  const t = Date.parse(ts);
  return Number.isNaN(t) ? null : t;
}

/** Get ISO week start (Monday) for a given date */
function getWeekStart(date: Date): string {
  const d = new Date(date);
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1); // Monday
  d.setDate(diff);
  d.setHours(0, 0, 0, 0);
  return d.toISOString().slice(0, 10);
}

// ── Analytics computation ───────────────────────────────────────────────────

export async function getAnalytics(): Promise<AnalyticsData> {
  const projectPath = await getActiveProjectPath();
  const taskStore = new TaskStore(projectPath);
  const tasks = taskStore.getAll();

  // Phase distribution
  const phaseDistribution: Record<string, number> = {};
  for (const t of tasks) {
    phaseDistribution[t.phase] = (phaseDistribution[t.phase] ?? 0) + 1;
  }

  // Phase timings from events.jsonl
  const phaseDurations = new Map<string, number[]>();
  for (const t of tasks) {
    const events = taskStore.getEvents(t.id);
    if (events.length < 2) continue; // need at least 2 events for a duration

    for (let i = 0; i < events.length - 1; i++) {
      const start = parseTime(events[i].timestamp);
      const end = parseTime(events[i + 1].timestamp);
      if (start === null || end === null) continue;
      const hours = (end - start) / 3600000;
      if (hours < 0) continue; // skip negative durations (clock skew)
      const phase = events[i].phase;
      if (!phaseDurations.has(phase)) phaseDurations.set(phase, []);
      phaseDurations.get(phase)!.push(hours);
    }
  }

  const phaseTimings: PhaseTiming[] = Array.from(phaseDurations.entries())
    .map(([phase, durations]) => {
      const sorted = [...durations].sort((a, b) => a - b);
      return {
        phase,
        avgHours: Math.round((durations.reduce((s, v) => s + v, 0) / durations.length) * 10) / 10,
        minHours: Math.round(sorted[0] * 10) / 10,
        maxHours: Math.round(sorted[sorted.length - 1] * 10) / 10,
        count: durations.length,
      };
    })
    .sort((a, b) => b.avgHours - a.avgHours);

  // QA stats — collect all qa_report.json files
  let totalQaRuns = 0;
  let passCount = 0;
  let failCount = 0;
  const criteriaMap = new Map<string, { pass: number; total: number }>();

  for (const t of tasks) {
    try {
      const dir = taskStore.getDirById(t.id);
      const qaPath = join(dir, 'qa_report.json');
      if (!existsSync(qaPath)) continue;
      const qa: QAReportData = JSON.parse(readFileSync(qaPath, 'utf-8'));
      totalQaRuns++;
      if (qa.overall === 'PASS') passCount++;
      else failCount++;

      if (qa.criteria) {
        for (const c of qa.criteria) {
          const entry = criteriaMap.get(c.name) ?? { pass: 0, total: 0 };
          entry.total++;
          if (c.status === 'PASS') entry.pass++;
          criteriaMap.set(c.name, entry);
        }
      }
    } catch {
      // skip malformed or inaccessible qa reports
    }
  }

  const qaStats: QAStats | null = totalQaRuns > 0
    ? {
        totalQaRuns,
        passCount,
        failCount,
        passRate: Math.round((passCount / totalQaRuns) * 100),
        criteriaBreakdown: Array.from(criteriaMap.entries())
          .map(([name, { pass, total: tot }]) => ({
            name,
            passRate: Math.round((pass / tot) * 100),
            total: tot,
          }))
          .sort((a, b) => a.passRate - b.passRate),
      }
    : null;

  // Source breakdown
  const sourceBreakdown: SourceBreakdown = { ideation: 0, competitorAnalysis: 0, unknown: 0 };
  for (const t of tasks) {
    if (t.source === 'ideation') sourceBreakdown.ideation++;
    else if (t.source === 'competitor-analysis') sourceBreakdown.competitorAnalysis++;
    else sourceBreakdown.unknown++;
  }

  // Weekly trends
  const weekMap = new Map<string, { created: number; completed: number }>();
  for (const t of tasks) {
    const createdWeek = getWeekStart(new Date(t.createdAt));
    const entry = weekMap.get(createdWeek) ?? { created: 0, completed: 0 };
    entry.created++;
    weekMap.set(createdWeek, entry);

    if (t.phase === 'done') {
      const completedWeek = getWeekStart(new Date(t.updatedAt));
      const compEntry = weekMap.get(completedWeek) ?? { created: 0, completed: 0 };
      compEntry.completed++;
      weekMap.set(completedWeek, compEntry);
    }
  }

  const weeklyTrends: WeeklyTrend[] = Array.from(weekMap.entries())
    .map(([week, data]) => ({ week, ...data }))
    .sort((a, b) => a.week.localeCompare(b.week))
    .slice(-12); // last 12 weeks

  // Bottleneck — phase with highest average duration (excluding done/failed/cancelled)
  const activeTimings = phaseTimings.filter(
    p => !['done', 'failed', 'cancelled', 'backlog'].includes(p.phase) && p.count > 0
  );
  const bottleneck = activeTimings.length > 0 ? activeTimings[0] : null;

  return {
    projectPath,
    totalTasks: tasks.length,
    phaseDistribution,
    phaseTimings,
    qaStats,
    sourceBreakdown,
    weeklyTrends,
    bottleneck,
  };
}
