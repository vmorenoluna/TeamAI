'use client';

import { useState, useTransition, useEffect } from 'react';
import { analyzeFailedTask, applyRefinementAction, applyAndRetryRefinementAction, dismissRefinementAction } from '@/app/actions/role-refinement';
import type { RoleRefinementMode, RoleRefinementSuggestion } from '@/lib/role-refinement';
import type { Task } from '@/lib/task-store';
import { UnifiedDiff } from './unified-diff';
import { CopyButton } from './copy-button';
import { formatActionError } from '@/lib/error-format';

interface Props {
  task: Task;
  suggestion: RoleRefinementSuggestion | null;
  /** All non-dismissed outcomes, newest first. */
  suggestions?: RoleRefinementSuggestion[];
  roleFiles: Record<string, string>;
  mode: RoleRefinementMode;
  /** Optional — TaskPanel wires this to re-fetch getTaskFull so the card
   *  reflects apply/dismiss immediately (client-managed data). */
  onRefinementChanged?: () => void;
}

const CONFIDENCE_STYLES: Record<string, string> = {
  high: 'bg-emerald-900/30 text-emerald-400 border-emerald-800/40',
  medium: 'bg-amber-900/30 text-amber-400 border-amber-800/40',
  low: 'bg-slate-800/40 text-slate-400 border-slate-700/40',
};

function RoleRefinementSuggestionCard({ task, suggestion, roleFiles, mode, onRefinementChanged }: Props) {
  const [localAnalyzing, setLocalAnalyzing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  // Per-edit hand-tuned text before applying (the RoleEditor textarea affordance).
  const [edits, setEdits] = useState<Record<string, string> | null>(null);
  const [editMode, setEditMode] = useState<Record<string, boolean>>({});

  // Once a terminal record arrives (via TaskPanel refresh / router.refresh),
  // drop the local analyzing flag so the card doesn't flip back. This is a
  // prop-derived reset, not a fetch — the local flag only mirrors the click
  // while the server-stamped status catches up.
  useEffect(() => {
    if (suggestion || task.refinementStatus !== 'analyzing') {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setLocalAnalyzing(false);
    }
  }, [suggestion, task.refinementStatus]);

  if (mode === 'off' || task.phase !== 'failed') return null;

  // Applied outcomes stay visible as history. Dismissed and superseded records
  // are filtered by the parent surface and are never rendered here.
  if (suggestion?.status === 'applied') {
    return (
      <div className="rounded-lg border border-emerald-800/40 bg-[#11131b] p-3 flex items-center gap-2" data-component="role-refinement-applied">
        <span className="text-sm">✅</span>
        <p className="text-xs text-emerald-300 flex-1">Role-prompt refinement applied.</p>
        <span className="text-[10px] text-slate-500">Analysis retained</span>
      </div>
    );
  }

  const suggested = suggestion?.status === 'suggested';
  const noGap = suggestion?.status === 'no-gap';
  const analyzing = localAnalyzing || task.refinementStatus === 'analyzing' || suggestion?.status === 'analyzing';

  function runAction(action: () => Promise<{ success: boolean; error?: string }>) {
    setError(null);
    startTransition(async () => {
      try {
        const result = await action();
        if (!result.success) {
          setError(result.error || 'Action failed');
          return;
        }
        onRefinementChanged?.();
      } catch (err) {
        setError(formatActionError('refinement action', err));
      }
    });
  }

  function handleApply() {
    if (!suggestion) return;
    runAction(() => applyRefinementAction(suggestion.id, edits ?? undefined));
  }

  function handleApplyAndRetry() {
    if (!suggestion) return;
    runAction(() => applyAndRetryRefinementAction(suggestion.id, edits ?? undefined));
  }

  function handleDismiss() {
    if (!suggestion) return;
    runAction(() => dismissRefinementAction(suggestion.id));
  }

  // ── Analyzing ────────────────────────────────────────────────────────────
  // Show the spinner both before the record exists (click → server stamp) and
  // once it does (`analyzeFailure` writes the record synchronously with status
  // 'analyzing' — the SSE refresh then delivers it while the session still
  // runs for minutes). A 'suggested'/'no-gap' record always wins over a stale
  // localAnalyzing / task flag so the terminal card never hides behind the
  // spinner.
  if (analyzing && (!suggestion || suggestion.status === 'analyzing')) {
    return (
      <div className="rounded-lg border border-[#334155]/60 bg-[#11131b] p-3 flex items-center gap-3">
        <span className="w-3.5 h-3.5 rounded-full border border-blue-400 border-t-transparent animate-spin" />
        <p className="text-xs text-slate-400">
          Reading QA reports and agent logs to diagnose the failure…
        </p>
      </div>
    );
  }

  if (!suggestion) return null;

  // ── No gap ───────────────────────────────────────────────────────────────
  if (noGap) {
    return (
      <div className="rounded-lg border border-[#334155]/60 bg-[#11131b] p-4 space-y-2" data-component="role-refinement-no-gap">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-sm">ℹ️</span>
          <h4 className="text-xs font-semibold text-slate-300">Not a role-prompt gap</h4>
          <span className="ml-auto flex items-center gap-2">
            <CopyButton text={suggestion.diagnosis} label="diagnosis" />
            <button
              onClick={handleDismiss}
              disabled={isPending}
              className="text-[11px] text-slate-500 hover:text-slate-300 transition-colors disabled:opacity-50"
            >
              Dismiss
            </button>
          </span>
        </div>
        <p className="text-xs text-slate-400 leading-relaxed whitespace-pre-wrap">{suggestion.diagnosis}</p>
        {error && <p className="text-[11px] text-red-400">{error}</p>}
      </div>
    );
  }

  // ── Suggested ────────────────────────────────────────────────────────────
  if (suggested) {
    return (
      <div className="rounded-lg border border-[#2563eb]/40 bg-[#11131b] p-4 space-y-3" data-component="role-refinement-suggested">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-sm">💡</span>
          <h4 className="text-xs font-semibold text-slate-200">Suggested role-prompt refinement</h4>
          <span className={`text-[10px] font-medium px-2 py-0.5 rounded-full border ${CONFIDENCE_STYLES[suggestion.confidence] ?? CONFIDENCE_STYLES.low}`}>
            {suggestion.confidence}
          </span>
          <span className="ml-auto flex items-center gap-2">
            <button
              onClick={handleDismiss}
              disabled={isPending}
              className="text-[11px] text-slate-500 hover:text-slate-300 transition-colors disabled:opacity-50"
            >
              Dismiss
            </button>
          </span>
        </div>

        <p className="text-xs text-slate-300 leading-relaxed">{suggestion.rootCause}</p>

        <div className="space-y-3">
          {suggestion.edits.map((edit, i) => {
            const edited = (edits ?? {})[edit.roleFile] ?? edit.proposedContent;
            const editing = editMode[edit.roleFile] ?? false;
            const current = roleFiles[edit.roleFile] ?? '';
            return (
              <div key={`${edit.roleFile}-${i}`} className="space-y-1.5">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-[11px] font-mono text-blue-300">{edit.roleFile}</span>
                  <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded ${
                    edit.mode === 'append'
                      ? 'bg-emerald-900/30 text-emerald-400'
                      : 'bg-amber-900/30 text-amber-400'
                  }`}>
                    {edit.mode}
                  </span>
                  <span className="text-[10px] text-slate-600">{edit.riskClass}</span>
                  <button
                    onClick={() => setEditMode(m => ({ ...m, [edit.roleFile]: !(m[edit.roleFile] ?? false) }))}
                    className="ml-auto text-[11px] text-slate-500 hover:text-slate-300 transition-colors"
                  >
                    {editing ? 'Cancel edit' : 'Edit'}
                  </button>
                </div>
                <p className="text-[11px] text-slate-500 leading-relaxed">{edit.rationale}</p>

                {editing ? (
                  <textarea
                    value={edited}
                    onChange={e => setEdits(prev => ({ ...(prev ?? {}), [edit.roleFile]: e.target.value }))}
                    rows={10}
                    data-component={`role-refinement-edit-${edit.roleFile}`}
                    className="w-full px-3 py-2 text-xs font-mono border border-[#334155] rounded-lg bg-[#1e2333] text-white focus:outline-none focus:ring-2 focus:ring-[#2563eb] resize-y"
                  />
                ) : (
                  <UnifiedDiff current={current} proposed={edited} />
                )}
              </div>
            );
          })}
        </div>

        <div className="flex items-center gap-2 pt-1">
          <button
            onClick={handleApply}
            disabled={isPending}
            data-component="apply-refinement-button"
            className="px-3 py-1.5 text-xs font-medium bg-[#2563eb] text-white rounded-lg hover:bg-[#1d4ed8] disabled:opacity-50 transition-colors"
          >
            {isPending ? 'Applying…' : 'Apply'}
          </button>
          <button
            onClick={handleApplyAndRetry}
            disabled={isPending}
            data-component="apply-retry-refinement-button"
            className="px-3 py-1.5 text-xs font-medium bg-emerald-800/50 text-emerald-300 rounded-lg hover:bg-emerald-700/60 disabled:opacity-50 transition-colors"
          >
            Apply & Retry
          </button>
        </div>
        {error && <p className="text-[11px] text-red-400">{error}</p>}
      </div>
    );
  }

  return null;
}

/**
 * Failed-task analysis surface. The trigger is intentionally independent of
 * the outcome cards: every failed task keeps an Analyze failure button, while
 * every non-dismissed analysis result remains visible beneath it.
 */
export function RoleRefinementCard({ task, suggestion, suggestions = [], roleFiles, mode, onRefinementChanged }: Props) {
  const [localAnalyzing, setLocalAnalyzing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  if (mode === 'off' || task.phase !== 'failed') return null;

  const allRecords = suggestions.length > 0
    ? suggestions.filter(s => s.status !== 'dismissed' && s.status !== 'superseded')
    : suggestion ? [suggestion] : [];
  const analysisInFlight = allRecords.some(s => s.status === 'analyzing') ||
    (allRecords.length === 0 && (task.refinementStatus === 'analyzing' || localAnalyzing));
  // The in-progress record is represented by the shared trigger status above;
  // only completed outcomes are rendered as history cards.
  const records = allRecords.filter(s => s.status !== 'analyzing');
  const analyzing = analysisInFlight;

  function handleAnalyze() {
    setError(null);
    setLocalAnalyzing(true);
    startTransition(async () => {
      try {
        const result = await analyzeFailedTask(task.id);
        if (!result.success) {
          setLocalAnalyzing(false);
          setError(result.error || 'Failed to start analysis');
        }
      } catch (err) {
        setLocalAnalyzing(false);
        setError(formatActionError('analyze failure', err));
      }
    });
  }

  return (
    <div className="space-y-3" data-component="role-refinement-surface">
      <div className="rounded-lg border border-[#334155]/60 bg-[#11131b] p-3 flex items-center gap-3 flex-wrap">
        <span className="text-sm">🔍</span>
        <p className="text-xs text-slate-400 flex-1 min-w-[200px]">
          Keeps failing the same way? Analyze whether a role prompt has a gap.
        </p>
        <button
          onClick={handleAnalyze}
          disabled={isPending || analyzing}
          data-component="analyze-failure-button"
          className="text-[11px] font-medium px-2.5 py-1 rounded-md bg-[#2563eb]/20 text-blue-300 hover:bg-[#2563eb]/30 transition-colors disabled:opacity-50"
        >
          🔍 Analyze failure
        </button>
        {analyzing && (
          <p className="w-full text-[11px] text-slate-500">
            <span className="inline-block w-3 h-3 mr-1 rounded-full border border-blue-400 border-t-transparent animate-spin align-[-2px]" />
            Reading QA reports and agent logs to diagnose the failure…
          </p>
        )}
        {error && <p className="w-full text-[11px] text-red-400">{error}</p>}
      </div>

      {task.refinementEscalated && (
        <div
          className="rounded-lg border border-amber-500/40 bg-amber-950/20 p-3 flex items-center gap-3 flex-wrap"
          data-component="role-refinement-escalated"
        >
          <span className="text-sm">⚠️</span>
          <p className="text-xs text-amber-300 flex-1 min-w-[200px]">
            A role refinement was applied but the task failed the same way — human review needed.
          </p>
        </div>
      )}

      {records.map(record => (
        <RoleRefinementSuggestionCard
          key={record.id}
          task={task}
          suggestion={record}
          roleFiles={roleFiles}
          mode={mode}
          onRefinementChanged={onRefinementChanged}
        />
      ))}
    </div>
  );
}
