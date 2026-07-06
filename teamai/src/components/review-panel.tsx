'use client';

import { useState } from 'react';
import { approveTask, rejectTask, markTaskDone, reviseSpec } from '@/app/actions/tasks';
import { useServerMutation } from '@/hooks/use-server-mutation';
import { formatActionError } from '@/lib/error-format';

interface SpecConcern {
  issue: string;
  reasoning: string;
  suggested_fix?: string;
}

interface QaReport {
  overall: 'PASS' | 'FAIL';
  criteria?: { criterion?: string; name?: string; status: 'PASS' | 'FAIL'; notes?: string }[];
  spec_concerns?: SpecConcern[];
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

type PendingAction = 'approve-local' | 'approve-pr' | 'reject' | 'mark-done' | 'revise-spec' | null;

export function ReviewPanel({ taskId, spec, qaReport, humanFeedback, diff, prUrl, phase }: Props) {
  const { run } = useServerMutation();
  const [pendingAction, setPendingAction] = useState<PendingAction>(null);
  const [error, setError] = useState<string | null>(null);
  const [showReject, setShowReject] = useState(false);
  const [feedback, setFeedback] = useState('');
  const isPrOpen = phase === 'pr-open' || !!prUrl;

  /**
   * Run a Server Action with full error + pending state management:
   * - Set the pending label while the action runs (button shows its spinner text)
   * - Clear any previous error at the start
   * - On throw (or returned error), set an error message visible in the banner —
   *   this is the regression fix: previously, thrown errors were swallowed by
   *   useServerMutation's empty catch and the button appeared to "do nothing"
   * - Always clear pendingAction via finally, even on failure
   * - Re-throw so useServerMutation skips router.refresh() on failure
   */
  async function runAction<T>(
    label: PendingAction,
    verb: string,
    fn: () => Promise<T>,
  ): Promise<void> {
    setPendingAction(label);
    setError(null);
    run(async () => {
      try {
        await fn();
      } catch (err) {
        setError(formatActionError(verb, err));
        throw err;
      } finally {
        setPendingAction(null);
      }
    });
  }

  async function handleApprove(strategy: 'local-merge' | 'pull-request') {
    await runAction(
      strategy === 'local-merge' ? 'approve-local' : 'approve-pr',
      strategy === 'local-merge' ? 'merge task' : 'create pull request',
      () => approveTask(taskId, strategy),
    );
  }

  async function handleReject() {
    if (!feedback.trim()) return;
    await runAction('reject', 'send task back', async () => {
      await rejectTask(taskId, feedback);
      setShowReject(false);
      setFeedback('');
    });
  }

  async function handleReviseSpec() {
    await runAction('revise-spec', 'revise spec', () => reviseSpec(taskId));
  }

  async function handleMarkDone() {
    await runAction('mark-done', 'mark task as done', () => markTaskDone(taskId));
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

            {/* Spec concerns banner — shown when QA detected spec-level issues */}
            {qaReport.spec_concerns && qaReport.spec_concerns.length > 0 && (
              <div className="rounded-md border border-purple-800/40 bg-purple-950/20 p-3">
                <div className="flex items-center gap-1.5 mb-2">
                  <span className="text-purple-400 text-xs">📋</span>
                  <span className="text-xs font-semibold text-purple-300">Spec Concerns — The specification needs revision</span>
                </div>
                <div className="space-y-2">
                  {qaReport.spec_concerns.map((sc, i) => (
                    <div key={i} className="text-xs text-purple-200/90">
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
        {/* Error banner — surfaces Server Action failures (regression fix:
            previously useServerMutation's empty catch swallowed the throw
            and the button looked like it did nothing) */}
        {error && (
          <div
            role="alert"
            className="rounded-md border border-red-800/40 bg-red-950/30 p-3 flex items-start gap-3"
          >
            <span className="text-red-400 text-sm font-bold shrink-0 mt-0.5">✗</span>
            <div className="flex-1 min-w-0 text-xs">
              <p className="font-semibold text-red-300">Action failed</p>
              <p className="text-red-200/90 mt-0.5 break-words">{error}</p>
            </div>
            <button
              type="button"
              onClick={() => setError(null)}
              title="Dismiss"
              className="shrink-0 text-red-400 hover:text-red-300 text-base leading-none px-1"
            >
              ×
            </button>
          </div>
        )}
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
              {qaReport?.spec_concerns && qaReport.spec_concerns.length > 0 && (
              <button
                onClick={handleReviseSpec}
                disabled={pendingAction !== null}
                className="flex-1 px-4 py-2 text-sm font-medium bg-purple-700/60 text-purple-200 hover:bg-purple-600/70 disabled:opacity-50 rounded-md transition-colors"
              >
                {pendingAction === 'revise-spec' ? 'Revising Spec…' : 'Revise Spec'}
              </button>
              )}
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
