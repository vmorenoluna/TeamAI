'use client';

import { CopyButton } from './copy-button';
import type { QAReportData, QACriterion, QAIssue, SpecConcern } from '@/lib/stream-types';

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
                : qaReport.overall === 'FAIL'
                ? 'bg-red-900/40 text-red-300'
                // Neither PASS nor FAIL (e.g. "IN_PROGRESS") — the reviewer
                // never reached a verdict; amber signals "incomplete", not
                // "failed", so this isn't misread as a real FAIL.
                : 'bg-amber-900/40 text-amber-300'
            }`}>
              {qaReport.overall}
            </div>
            <CopyButton text={qaText} label="QA report" />
          </div>
          {qaReport.spec_concerns && qaReport.spec_concerns.length > 0 && (
            <div className="rounded-lg border border-purple-800/40 bg-purple-950/20 p-4">
              <div className="flex items-center gap-1.5 mb-2">
                <span className="text-purple-400 text-sm">📋</span>
                <h3 className="text-sm font-semibold text-purple-300">Spec Concerns — The specification needs revision</h3>
              </div>
              <div className="space-y-2">
                {qaReport.spec_concerns.map((sc: SpecConcern, i: number) => (
                  <div key={i} className="text-sm text-purple-200/90">
                    <p className="font-medium">{sc.issue}</p>
                    <p className="text-purple-300/70 mt-0.5">{sc.reasoning}</p>
                    {sc.suggested_fix && (
                      <p className="text-purple-300/50 mt-0.5 italic">Suggested: {sc.suggested_fix}</p>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
          {qaReport.additional_issues && qaReport.additional_issues.length > 0 && (
            <div className="rounded-lg border border-red-800/40 bg-red-950/20 p-4">
              <div className="flex items-center gap-1.5 mb-2">
                <span className="text-red-400 text-sm">⚠</span>
                <h3 className="text-sm font-semibold text-red-300">Additional Issues — Hard blockers</h3>
              </div>
              <div className="space-y-2">
                {qaReport.additional_issues.map((issue: QAIssue, i: number) => (
                  <div key={i} className="text-sm text-red-200/90">
                    <p className="font-medium">{issue.description || issue.message}</p>
                    {issue.file && (
                      <p className="text-red-300/70 mt-0.5 font-mono text-xs">{issue.file}</p>
                    )}
                    {issue.fix_needed && (
                      <p className="text-red-300/50 mt-0.5 italic">Fix: {issue.fix_needed}</p>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
          {qaReport.criteria?.map((c: QACriterion, i: number) => (
            <div key={i} className="flex items-start gap-2 text-sm">
              <span className={`shrink-0 font-bold ${
                c.status === 'PASS' ? 'text-green-600' : c.status === 'FAIL' ? 'text-red-600' : 'text-amber-500'
              }`}>
                {c.status === 'PASS' ? '✓' : c.status === 'FAIL' ? '✗' : '…'}
              </span>
              <div>
                <p className="text-slate-300">
                  {c.criterion || c.name}
                  {c.status !== 'PASS' && c.status !== 'FAIL' && (
                    <span className="ml-2 text-[10px] uppercase tracking-wider text-amber-500">{c.status}</span>
                  )}
                </p>
                {(c.notes || c.evidence) && <p className="text-xs text-slate-400 mt-0.5">{c.notes || c.evidence}</p>}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
