'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { approveTask, rejectTask } from '@/app/actions/tasks';

interface QaReport {
  overall: 'PASS' | 'FAIL';
  criteria?: { criterion?: string; name?: string; status: 'PASS' | 'FAIL'; notes?: string }[];
}

interface Props {
  taskId: string;
  spec: string | null;
  qaReport: QaReport | null;
  diff: string | null;
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

export function ReviewPanel({ taskId, spec, qaReport, diff }: Props) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [showReject, setShowReject] = useState(false);
  const [feedback, setFeedback] = useState('');

  function handleApprove(strategy: 'local-merge' | 'pull-request') {
    startTransition(async () => {
      await approveTask(taskId, strategy);
      router.refresh();
    });
  }

  function handleReject() {
    if (!feedback.trim()) return;
    startTransition(async () => {
      await rejectTask(taskId, feedback);
      setShowReject(false);
      setFeedback('');
      router.refresh();
    });
  }

  return (
    <div className="space-y-4">
      {/* QA Report */}
      {qaReport && (
        <Section title={`QA Report — ${qaReport.overall === 'PASS' ? '✓ PASS' : '✗ FAIL'}`}>
          <div className="space-y-2">
            <div className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-bold ${
              qaReport.overall === 'PASS'
                ? 'bg-green-900/40 text-green-300'
                : 'bg-red-900/40 text-red-300'
            }`}>
              {qaReport.overall}
            </div>
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
        <div className="flex gap-3">
          <button
            onClick={() => handleApprove('local-merge')}
            disabled={isPending}
            className="flex-1 px-4 py-2 text-sm font-medium bg-green-600 hover:bg-green-700 disabled:opacity-50 text-white rounded-md transition-colors"
          >
            Merge Locally
          </button>
          <button
            onClick={() => handleApprove('pull-request')}
            disabled={isPending}
            className="flex-1 px-4 py-2 text-sm font-medium bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white rounded-md transition-colors"
          >
            Open Pull Request
          </button>
          <button
            onClick={() => setShowReject(r => !r)}
            disabled={isPending}
            className="flex-1 px-4 py-2 text-sm font-medium bg-[#1a1f2e] hover:bg-[#1e293b] text-slate-200 rounded-md transition-colors"
          >
            Reject with Feedback
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
                disabled={isPending || !feedback.trim()}
                className="px-4 py-1.5 text-sm font-medium bg-orange-600 hover:bg-orange-700 disabled:opacity-50 text-white rounded-md transition-colors"
              >
                {isPending ? 'Sending…' : 'Send Back'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
