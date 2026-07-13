'use client';

import { CopyButton } from './copy-button';
import type { QAReportData, QACriterion } from '@/lib/stream-types';

export function QAReportView({ qaReport, humanFeedback }: { qaReport: QAReportData | null; humanFeedback?: string | null }) {
  if (!qaReport && !humanFeedback) return <p className="text-sm text-slate-400">No QA report generated yet.</p>;
  const qaText = JSON.stringify(qaReport, null, 2);
  return (
    <div className="space-y-4">
      {humanFeedback && (
        <div className="rounded-lg border border-amber-800/40 bg-amber-950/20 p-4">
          <div className="flex items-center gap-2 mb-2">
            <span className="text-amber-400 text-sm">👤</span>
            <h3 className="text-sm font-semibold text-amber-300">Human Reviewer Feedback</h3>
          </div>
          <pre className="text-sm text-amber-200/90 whitespace-pre-wrap font-sans leading-relaxed">
            {humanFeedback}
          </pre>
        </div>
      )}
      {qaReport && (
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <div className={`inline-flex items-center px-2.5 py-1 rounded text-sm font-bold ${
              qaReport.overall === 'PASS'
                ? 'bg-green-900/40 text-green-300'
                : 'bg-red-900/40 text-red-300'
            }`}>
              {qaReport.overall}
            </div>
            <CopyButton text={qaText} label="QA report" />
          </div>
          {qaReport.criteria?.map((c: QACriterion, i: number) => (
            <div key={i} className="flex items-start gap-2 text-sm">
              <span className={`shrink-0 font-bold ${c.status === 'PASS' ? 'text-green-600' : 'text-red-600'}`}>
                {c.status === 'PASS' ? '✓' : '✗'}
              </span>
              <div>
                <p className="text-slate-300">{c.criterion || c.name}</p>
                {c.notes && <p className="text-xs text-slate-400 mt-0.5">{c.notes}</p>}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
