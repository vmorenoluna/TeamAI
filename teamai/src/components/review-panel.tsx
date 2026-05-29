'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { approveTask, rejectTask, markTaskDone } from '@/app/actions/tasks';

interface QaReport {
  overall: 'PASS' | 'FAIL';
  criteria?: { criterion?: string; name?: string; status: 'PASS' | 'FAIL'; notes?: string }[];
}

interface Props {
  taskId: string;
  spec: string | null;
  qaReport: QaReport | null;
  humanFeedback?: string | null;
  diff: string | null;
  prUrl?: string | null;
  phase: string;
}

function DiffLine({ line }: { line: string }) {
  if (line.startsWith('+') && !line.startsWith('+++')) {
    return <div className="bg-green-950 text-green-300">{line}</div>;
  }
  if (line.startsWith('-') && !line.startsWith('---')) {
    return <div className="bg-red-950 text-red-300">{line}</div>;
  }
  if (line.startsWith('@@')) {
    return <div className="text-blue-400">{line}</div>;
  }
  return <div className="text-slate-400">{line}</div>;
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="border border-[#1e293b] rounded-lg overflow-hidden">
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center justify-between px-4 py-3 bg-[#1a1f2e] text-sm font-medium text-slate-200 hover:bg-[#1e293b] transition-colors"
      >
        {title}
        <span className="text-slate-400">{open ? '▲' : '▼'}</span>
      </button>
      {open && <div className="p-4 bg-[#11131b]">{children}</div>}
    </div>
  );
}

type PendingAction = 'approve-local' | 'approve-pr' | 'reject' | 'mark-done' | null;

export function ReviewPanel({ taskId, spec, qaReport, humanFeedback, diff, prUrl, phase }: Props) {
  const router = useRouter();
  const [pendingAction, setPendingAction] = useState<PendingAction>(null);
  const [showReject, setShowReject] = useState(false);
  const [feedback, setFeedback] = useState('');
  const isPrOpen = phase === 'pr-open' || !!prUrl;

  async function handleApprove(strategy: 'local-merge' | 'pull-request') {
    setPendingAction(strategy === 'local-merge' ? 'approve-local' : 'approve-pr');
    try {
      await approveTask(taskId, strategy);
      router.refresh();
    } finally {
      setPendingAction(null);
    }
  }

  async function handleReject() {
    if (!feedback.trim()) return;
    setPendingAction('reject');
    try {
      await rejectTask(taskId, feedback);
      setShowReject(false);
      setFeedback('');
      router.refresh();
    } finally {
      setPendingAction(null);
    }
  }

  async function handleMarkDone() {
    setPendingAction('mark-done');
    try {
      await markTaskDone(taskId);
      router.refresh();
    } finally {
      setPendingAction(null);
    }
  }

  return (
    <div className="space-y-4">
      {/* QA Report */}
      {qaReport && (
        <Section title={`QA Report — ${qaReport.overall === 'PASS' ? '✓ PASS' : '✗ FAIL'}`}>
          <div className="space-y-3">
            <div className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-bold ${
              qaReport.overall === 'PASS'
                ? 'bg-green-900/40 text-green-300'
                : 'bg-red-900/40 text-red-300'
            }`}>
              {qaReport.overall}
            </div>

            {/* Human feedback banner */}
            {humanFeedback && (
              <div className="rounded-md border border-amber-800/40 bg-amber-950/20 p-3">
                <div className="flex items-center gap-1.5 mb-1.5">
                  <span className="text-amber-400 text-xs">👤</span>
                  <span className="text-xs font-semibold text-amber-300">Human Reviewer Feedback</span>
                </div>
                <p className="text-xs text-amber-200/90 whitespace-pre-wrap leading-relaxed">
                  {humanFeedback}
                </p>
              </div>
            )}

            {qaReport.criteria?.map((c, i) => (
              <div key={i} className="flex items-start gap-2 text-sm">
                <span className={`shrink-0 font-semibold ${
                  c.status === 'PASS' ? 'text-green-400' : 'text-red-400'
                }`}>
                  {c.status === 'PASS' ? '✓' : '✗'}
                </span>
                <div>
                  <span className="text-slate-300">{c.criterion || c.name}</span>
                  {c.notes && <p className="text-slate-400 text-xs mt-0.5">{c.notes}</p>}
                </div>
              </div>
            ))}
          </div>
        </Section>
      )}

      {/* Spec */}
      {spec && (
        <Section title="Spec">
          <pre className="text-xs text-slate-300 whitespace-pre-wrap font-mono overflow-auto max-h-64">
            {spec}
          </pre>
        </Section>
      )}

      {/* Diff */}
      {diff && (
        <Section title="Git Diff">
          <pre className="text-xs font-mono overflow-auto max-h-96 bg-black rounded p-2">
            {diff.split('\n').map((line, i) => (
              <DiffLine key={i} line={line} />
            ))}
          </pre>
        </Section>
      )}

      {/* Action buttons */}
      <div className="flex flex-col gap-3 pt-2">
        {/* PR open banner */}
        {isPrOpen && prUrl && (
          <a
            href={prUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-2 px-3 py-2 rounded-lg border border-teal-800/50 bg-teal-950/30 text-teal-400 hover:bg-teal-900/40 hover:text-teal-300 transition-colors text-sm"
          >
            <span className="text-base">🔗</span>
            <span className="font-medium">View Pull Request</span>
            <svg className="w-3.5 h-3.5 opacity-70" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
            </svg>
          </a>
        )}

        <div className="flex gap-3">
          {!isPrOpen && (
            <>
              <button
                onClick={() => handleApprove('local-merge')}
                disabled={pendingAction !== null}
                className="flex-1 px-4 py-2 text-sm font-medium bg-green-600 hover:bg-green-700 disabled:opacity-50 text-white rounded-md transition-colors"
              >
                {pendingAction === 'approve-local' ? 'Merging…' : 'Merge Locally'}
              </button>
              <button
                onClick={() => handleApprove('pull-request')}
                disabled={pendingAction !== null}
                className="flex-1 px-4 py-2 text-sm font-medium bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white rounded-md transition-colors"
              >
                {pendingAction === 'approve-pr' ? 'Creating PR…' : 'Open Pull Request'}
              </button>
            </>
          )}

          {isPrOpen && (
            <button
              onClick={handleMarkDone}
              disabled={pendingAction !== null}
              className="flex-1 px-4 py-2 text-sm font-medium bg-green-700/60 text-green-200 hover:bg-green-600/70 disabled:opacity-50 rounded-md transition-colors"
            >
              {pendingAction === 'mark-done' ? 'Marking done…' : 'Mark as Done'}
            </button>
          )}

          <button
            onClick={() => setShowReject(r => !r)}
            disabled={pendingAction !== null}
            className="flex-1 px-4 py-2 text-sm font-medium bg-[#1a1f2e] hover:bg-[#1e293b] text-slate-200 rounded-md transition-colors"
          >
            Request Changes
          </button>
        </div>

        {showReject && (
          <div className="space-y-2">
            <textarea
              value={feedback}
              onChange={e => setFeedback(e.target.value)}
              rows={4}
              placeholder="Describe what needs to change..."
              className="w-full px-3 py-2 text-sm border border-[#334155] rounded-lg bg-[#11131b] text-white focus:outline-none focus:ring-2 focus:ring-[#2563eb] resize-none placeholder-slate-500"
            />
            <div className="flex gap-2 justify-end">
              <button
                onClick={() => setShowReject(false)}
                className="px-3 py-1.5 text-sm text-slate-400 hover:text-white transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleReject}
                disabled={pendingAction !== null || !feedback.trim()}
                className="px-4 py-1.5 text-sm font-medium bg-orange-600 hover:bg-orange-700 disabled:opacity-50 text-white rounded-md transition-colors"
              >
                {pendingAction === 'reject' ? 'Sending…' : 'Send Back'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
