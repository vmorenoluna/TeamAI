'use client';

import { useState } from 'react';
import { rejectTask } from '@/app/actions/tasks';
import { useServerMutation } from '@/hooks/use-server-mutation';
import { formatActionError } from '@/lib/error-format';
import { FEEDBACK_TARGETS, FEEDBACK_TARGET_LABELS, type FeedbackTarget } from '@/lib/orchestrator/feedback-target';

interface SpecConcern {
  issue: string;
  reasoning: string;
  suggested_fix?: string;
}

/**
 * Send-feedback-to-agent control — the "Request Changes" flow shared by the
 * awaiting-review/pr-open ReviewPanel and the failed-task banner. Extracted
 * from review-panel.tsx so a `failed` task (e.g. one whose spec-revision
 * budget was exhausted without QA ever passing) can route feedback to the
 * analyst/planner/coder/qa-reviewer the same way an awaiting-review task can
 * — rejectTask (review-actions.ts) accepts `failed` as a source phase.
 */
interface Props {
  taskId: string;
  specConcerns?: SpecConcern[];
  subtasks?: { id: number; title: string; files?: string[] }[];
  /** Label for the toggle button — defaults to "Request Changes". */
  toggleLabel?: string;
  /** Disables the toggle button while a caller-owned action (e.g. approve,
   *  mark-done, retry) is pending, so a reject can't race a conflicting
   *  action on the same task. Combined with this panel's own pending state. */
  disabled?: boolean;
}

function specConcernsToText(concerns: SpecConcern[]): string {
  return concerns
    .map((sc) => {
      const lines = [`- ${sc.issue}`];
      if (sc.reasoning) lines.push(`  Reasoning: ${sc.reasoning}`);
      if (sc.suggested_fix) lines.push(`  Suggested fix: ${sc.suggested_fix}`);
      return lines.join('\n');
    })
    .join('\n\n');
}

export function RejectFeedbackPanel({ taskId, specConcerns, subtasks, toggleLabel = 'Request Changes', disabled = false }: Props) {
  const { run } = useServerMutation();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [show, setShow] = useState(false);
  const [feedback, setFeedback] = useState('');
  const [target, setTarget] = useState<FeedbackTarget | null>(null);
  const [selectedSubtasks, setSelectedSubtasks] = useState<number[]>([]);

  async function handleReject() {
    if (!feedback.trim() || !target) return;
    setPending(true);
    setError(null);
    run(async () => {
      try {
        await rejectTask(taskId, feedback, target, selectedSubtasks.length ? selectedSubtasks : undefined);
        setShow(false);
        setFeedback('');
        setTarget(null);
        setSelectedSubtasks([]);
      } catch (err) {
        setError(formatActionError('send task back', err));
        throw err;
      } finally {
        setPending(false);
      }
    });
  }

  function toggleSubtask(id: number) {
    setSelectedSubtasks(prev =>
      prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id],
    );
  }

  function selectTarget(t: FeedbackTarget) {
    setTarget(t);
    setSelectedSubtasks([]);
    if (t === 'analyst' && !feedback.trim() && specConcerns && specConcerns.length > 0) {
      setFeedback(specConcernsToText(specConcerns));
    }
  }

  return (
    <div className="space-y-2">
      {error && (
        <div role="alert" className="rounded-md border border-red-800/40 bg-red-950/30 p-3 flex items-start gap-3">
          <span className="text-red-400 text-sm font-bold shrink-0 mt-0.5">✗</span>
          <div className="flex-1 min-w-0 text-xs">
            <p className="font-semibold text-red-300">Action failed</p>
            <p className="text-red-200/90 mt-0.5 break-words">{error}</p>
          </div>
          <button type="button" onClick={() => setError(null)} title="Dismiss" className="shrink-0 text-red-400 hover:text-red-300 text-base leading-none px-1">×</button>
        </div>
      )}

      <button
        type="button"
        onClick={() => setShow(s => !s)}
        disabled={pending || disabled}
        data-component="reject-feedback-toggle"
        className="text-[11px] font-medium px-2.5 py-1 rounded-md bg-[#1a1f2e] hover:bg-[#1e293b] text-slate-200 disabled:opacity-50 transition-colors"
      >
        {toggleLabel}
      </button>

      {show && (
        <div className="space-y-2">
          <div className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-slate-400">Send to</span>
            <div className="flex flex-wrap gap-1.5">
              {FEEDBACK_TARGETS.map(t => (
                <button
                  key={t}
                  type="button"
                  onClick={() => selectTarget(t)}
                  className={`px-2.5 py-1 text-xs font-medium rounded-md border transition-colors ${
                    target === t
                      ? 'bg-blue-900/40 text-blue-300 border-blue-600'
                      : 'bg-[#1a1f2e] text-slate-300 border-[#334155] hover:bg-[#1e293b]'
                  }`}
                >
                  {FEEDBACK_TARGET_LABELS[t]}
                </button>
              ))}
            </div>
          </div>
          {(target === 'coder' || target === 'planner') && subtasks && subtasks.length > 0 && (
            <div className="flex flex-col gap-1.5">
              <span className="text-xs font-medium text-slate-400">
                Affected subtasks{' '}
                <span className="text-slate-500">
                  {target === 'planner'
                    ? '(optional — scopes which subtasks may be re-planned; others are left unchanged)'
                    : '(optional — scopes the rework)'}
                </span>
              </span>
              <div className="max-h-44 overflow-y-auto rounded-md border border-[#334155] bg-[#11131b] p-1.5 space-y-1">
                {subtasks.map(s => {
                  const checked = selectedSubtasks.includes(s.id);
                  return (
                    <label
                      key={s.id}
                      className={`flex items-start gap-2 px-2 py-1.5 rounded cursor-pointer text-xs ${
                        checked ? 'bg-blue-900/30' : 'hover:bg-[#1a1f2e]'
                      }`}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggleSubtask(s.id)}
                        className="mt-0.5 accent-blue-500"
                      />
                      <span className="text-slate-300 min-w-0">
                        <span className="font-medium">#{s.id}</span> {s.title}
                        {s.files && s.files.length > 0 && (
                          <span className="block text-slate-500 truncate">{s.files.join(', ')}</span>
                        )}
                      </span>
                    </label>
                  );
                })}
              </div>
            </div>
          )}
          <textarea
            value={feedback}
            onChange={e => setFeedback(e.target.value)}
            rows={4}
            placeholder="Describe what needs to change..."
            className="w-full px-3 py-2 text-sm border border-[#334155] rounded-lg bg-[#11131b] text-white focus:outline-none focus:ring-2 focus:ring-[#2563eb] resize-none placeholder-slate-500"
          />
          <div className="flex gap-2 justify-end">
            <button
              onClick={() => { setShow(false); setTarget(null); }}
              className="px-3 py-1.5 text-sm text-slate-400 hover:text-white transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={handleReject}
              disabled={pending || !target || !feedback.trim()}
              className="px-4 py-1.5 text-sm font-medium bg-orange-600 hover:bg-orange-700 disabled:opacity-50 text-white rounded-md transition-colors"
            >
              {pending ? 'Sending…' : (target ? `Send to ${FEEDBACK_TARGET_LABELS[target]}` : 'Send Back')}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
