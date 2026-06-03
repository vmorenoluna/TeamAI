'use client';

import { useCallback, useEffect, useState } from 'react';
import { getAnalytics } from '@/app/actions/analytics';
import type { AnalyticsData } from '@/app/actions/analytics';

export function AnalyticsDashboard() {
  const [data, setData] = useState<AnalyticsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadAnalytics = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await getAnalytics();
      setData(result);
    } catch {
      setError('Failed to load analytics. Check that a project is selected.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initial load
    loadAnalytics();
  }, [loadAnalytics]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="flex flex-col items-center gap-3">
          <div className="w-8 h-8 border-2 border-[#2563eb] border-t-transparent rounded-full animate-spin" />
          <span className="text-sm text-slate-400">Computing analytics…</span>
        </div>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-center">
          <p className="text-slate-400 mb-3">{error ?? 'No data available'}</p>
          <button
            onClick={loadAnalytics}
            className="px-4 py-2 text-sm bg-[#2563eb] text-white rounded-lg hover:bg-[#1d4ed8] transition-colors"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  const maxPhaseCount = Math.max(1, ...Object.values(data.phaseDistribution));
  const maxTiming = Math.max(1, ...data.phaseTimings.map(p => p.avgHours));

  return (
    <div className="space-y-6">
      {/* Summary cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <SummaryCard
          label="Total Tasks"
          value={data.totalTasks}
          sub={`Across ${Object.keys(data.phaseDistribution).length} phases`}
          color="blue"
        />
        <SummaryCard
          label="QA Pass Rate"
          value={data.qaStats ? `${data.qaStats.passRate}%` : '—'}
          sub={data.qaStats ? `${data.qaStats.passCount}/${data.qaStats.totalQaRuns} runs` : 'No QA data yet'}
          color={data.qaStats && data.qaStats.passRate >= 80 ? 'green' : data.qaStats ? 'amber' : 'slate'}
        />
        <SummaryCard
          label="Bottleneck"
          value={data.bottleneck ? data.bottleneck.phase : '—'}
          sub={data.bottleneck ? `${data.bottleneck.avgHours}h avg (${data.bottleneck.count} samples)` : 'No data yet'}
          color={data.bottleneck && data.bottleneck.avgHours > 2 ? 'red' : 'amber'}
        />
        <SummaryCard
          label="Ideation-Driven"
          value={data.sourceBreakdown.ideation}
          sub={`${data.sourceBreakdown.competitorAnalysis} competitor-driven`}
          color="purple"
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Phase distribution */}
        <div className="bg-[#1a1f2e] rounded-xl border border-[#1e293b] p-5">
          <h3 className="text-sm font-semibold text-slate-200 mb-4">Phase Distribution</h3>
          <div className="space-y-2.5">
            {Object.entries(data.phaseDistribution)
              .sort(([, a], [, b]) => b - a)
              .map(([phase, count]) => {
                const pct = Math.round((count / maxPhaseCount) * 100);
                return (
                  <div key={phase} className="flex items-center gap-3">
                    <span className="w-20 text-xs text-slate-400 capitalize shrink-0">{phase}</span>
                    <div className="flex-1 h-5 bg-[#0f1320] rounded-full overflow-hidden">
                      <div
                        className="h-full rounded-full bg-gradient-to-r from-[#2563eb] to-[#3b82f6] transition-all duration-500"
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                    <span className="w-8 text-xs text-slate-300 text-right font-mono">{count}</span>
                  </div>
                );
              })}
          </div>
        </div>

        {/* Phase timings */}
        <div className="bg-[#1a1f2e] rounded-xl border border-[#1e293b] p-5">
          <h3 className="text-sm font-semibold text-slate-200 mb-4">Phase Timing (hours)</h3>
          {data.phaseTimings.length === 0 ? (
            <p className="text-xs text-slate-400 py-4 text-center">Not enough event data to compute timings.</p>
          ) : (
            <div className="space-y-2.5">
              {data.phaseTimings.map(p => {
                const pct = Math.round((p.avgHours / maxTiming) * 100);
                return (
                  <div key={p.phase} className="flex items-center gap-3">
                    <span className="w-20 text-xs text-slate-400 capitalize shrink-0">{p.phase}</span>
                    <div className="flex-1 h-5 bg-[#0f1320] rounded-full overflow-hidden relative">
                      <div
                        className={`h-full rounded-full transition-all duration-500 ${
                          p === data.bottleneck
                            ? 'bg-gradient-to-r from-red-600 to-red-400'
                            : 'bg-gradient-to-r from-emerald-600 to-emerald-400'
                        }`}
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                    <span className="w-20 text-xs text-slate-300 text-right font-mono shrink-0">
                      {p.avgHours}h <span className="text-slate-500">({p.minHours}–{p.maxHours})</span>
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* QA Stats */}
      {data.qaStats && (
        <div className="bg-[#1a1f2e] rounded-xl border border-[#1e293b] p-5">
          <h3 className="text-sm font-semibold text-slate-200 mb-4">QA Criteria Breakdown</h3>
          {data.qaStats.criteriaBreakdown.length === 0 ? (
            <p className="text-xs text-slate-400">No criterion-level data available.</p>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
              {data.qaStats.criteriaBreakdown.map(c => (
                <div
                  key={c.name}
                  className="flex items-center justify-between p-3 rounded-lg bg-[#0f1320] border border-[#1e293b]"
                >
                  <span className="text-xs text-slate-300 truncate max-w-[180px]">{c.name}</span>
                  <div className="flex items-center gap-2">
                    <div className="w-16 h-2 bg-[#1a1f2e] rounded-full overflow-hidden">
                      <div
                        className={`h-full rounded-full ${
                          c.passRate >= 80 ? 'bg-emerald-500' : c.passRate >= 50 ? 'bg-amber-500' : 'bg-red-500'
                        }`}
                        style={{ width: `${c.passRate}%` }}
                      />
                    </div>
                    <span className="text-xs text-slate-400 font-mono w-12 text-right">
                      {c.passRate}%
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Weekly trends */}
      {data.weeklyTrends.length > 1 && (
        <div className="bg-[#1a1f2e] rounded-xl border border-[#1e293b] p-5">
          <h3 className="text-sm font-semibold text-slate-200 mb-4">Weekly Trends (last 12 weeks)</h3>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-[#1e293b]">
                  <th className="text-left py-2 px-3 text-slate-400 font-medium">Week</th>
                  <th className="text-right py-2 px-3 text-slate-400 font-medium">Created</th>
                  <th className="text-right py-2 px-3 text-slate-400 font-medium">Completed</th>
                  <th className="text-right py-2 px-3 text-slate-400 font-medium">Velocity</th>
                </tr>
              </thead>
              <tbody>
                {data.weeklyTrends.map(w => {
                  const velocity = w.completed > 0 && w.created > 0
                    ? Math.round((w.completed / w.created) * 100)
                    : 0;
                  return (
                    <tr key={w.week} className="border-b border-[#1e293b]/50 hover:bg-[#1e2333] transition-colors">
                      <td className="py-2 px-3 text-slate-300 font-mono">{w.week}</td>
                      <td className="py-2 px-3 text-right text-slate-300">{w.created}</td>
                      <td className="py-2 px-3 text-right text-slate-300">{w.completed}</td>
                      <td className="py-2 px-3 text-right">
                        <span className={`font-mono ${velocity >= 70 ? 'text-emerald-400' : velocity >= 40 ? 'text-amber-400' : 'text-red-400'}`}>
                          {velocity}%
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Refresh button */}
      <div className="flex justify-end">
        <button
          onClick={loadAnalytics}
          className="px-4 py-2 text-xs bg-[#1e2333] text-slate-400 rounded-lg border border-[#1e293b] hover:bg-[#252d3d] hover:text-slate-300 transition-colors"
        >
          Refresh Analytics
        </button>
      </div>
    </div>
  );
}

function SummaryCard({
  label,
  value,
  sub,
  color,
}: {
  label: string;
  value: string | number;
  sub: string;
  color: 'blue' | 'green' | 'amber' | 'red' | 'purple' | 'slate';
}) {
  const borderColorMap = {
    blue: 'border-l-[#2563eb]',
    green: 'border-l-emerald-500',
    amber: 'border-l-amber-500',
    red: 'border-l-red-500',
    purple: 'border-l-purple-500',
    slate: 'border-l-slate-500',
  };
  const textColorMap = {
    blue: 'text-[#60a5fa]',
    green: 'text-emerald-400',
    amber: 'text-amber-400',
    red: 'text-red-400',
    purple: 'text-purple-400',
    slate: 'text-slate-400',
  };

  return (
    <div className={`bg-[#1a1f2e] rounded-xl border border-[#1e293b] border-l-2 p-4 ${borderColorMap[color]}`}>
      <div className="text-xs text-slate-400 mb-1">{label}</div>
      <div className={`text-2xl font-bold ${textColorMap[color]}`}>
        {value}
      </div>
      <div className="text-[11px] text-slate-500 mt-1">{sub}</div>
    </div>
  );
}
