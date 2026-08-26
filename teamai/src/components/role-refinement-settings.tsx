'use client';

import { useState, useTransition, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { setRoleRefinementConfigAction, applyRefinementAction, dismissRefinementAction, revertRefinementAction } from '@/app/actions/role-refinement';
import { getAvailableModels } from '@/app/actions/providers';
import type { RoleRefinementConfig, RoleRefinementMode, RoleRefinementSuggestion } from '@/lib/role-refinement';
import { CopyButton } from './copy-button';
import { formatActionError } from '@/lib/error-format';

interface Props {
  config: RoleRefinementConfig;
  suggestions: RoleRefinementSuggestion[];
  /** id → title map for resolving source-task display names. */
  tasks: Record<string, string>;
}

const CONFIDENCE_STYLES: Record<string, string> = {
  high: 'bg-emerald-900/30 text-emerald-400 border-emerald-800/40',
  medium: 'bg-amber-900/30 text-amber-400 border-amber-800/40',
  low: 'bg-slate-800/40 text-slate-400 border-slate-700/40',
};

function taskLabel(suggestion: RoleRefinementSuggestion, tasks: Record<string, string>): string {
  return suggestion.sourceTaskIds
    .map(id => tasks[id] ?? id.slice(0, 8))
    .join(', ');
}

export function RoleRefinementSettings({ config, suggestions, tasks }: Props) {
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const [models, setModels] = useState<string[]>([]);

  // Model dropdown options (same pattern as the provider-config editor): load
  // once on mount from the provider model list; a failure is non-fatal because
  // the select always includes the currently configured model.
  const loadModels = useCallback(async () => {
    try {
      const result = await getAvailableModels('anthropic');
      if (result.models.length > 0) setModels(result.models);
    } catch { /* non-fatal */ }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadModels();
  }, [loadModels]);

  const pending = suggestions.filter(s => s.status === 'suggested' || s.status === 'analyzing');
  const noGaps = suggestions.filter(s => s.status === 'no-gap');
  const applied = suggestions.filter(s => s.status === 'applied');
  const history = suggestions.filter(s => s.status === 'dismissed' || s.status === 'superseded');

  function patchConfig(patch: Partial<RoleRefinementConfig>) {
    setError(null);
    startTransition(async () => {
      try {
        await setRoleRefinementConfigAction({ ...config, ...patch });
      } catch (err) {
        setError(formatActionError('update role refinement config', err));
      }
    });
  }

  function setMode(mode: RoleRefinementMode) {
    patchConfig({ mode });
  }

  function runAction(action: () => Promise<{ success: boolean; error?: string }>) {
    setError(null);
    startTransition(async () => {
      try {
        const result = await action();
        if (!result.success) setError(result.error || 'Action failed');
      } catch (err) {
        setError(formatActionError('role refinement action', err));
      }
    });
  }

  return (
    <section data-component="role-refinements" className="space-y-5">
      <div>
        <h2 className="text-sm font-semibold text-slate-200 mb-1">Role Refinements</h2>
        <p className="text-xs text-slate-400 mb-3">
          When a task fails, the assistant can analyze whether a project role prompt
          has a gap and suggest a diff you review before applying. Changes take effect
          on the next pipeline run and are backed up for one-click revert.
        </p>

        {/* Mode control — Off / Manual / Auto. Auto auto-triggers analysis on
            recurrence but every edit still needs human approval (Phase 3 adds
            auto-apply, gated by the autoApply checkbox below). */}
        <div className="flex items-center gap-1">
          {(['off', 'manual', 'auto'] as RoleRefinementMode[]).map(m => (
            <button
              key={m}
              onClick={() => setMode(m)}
              disabled={isPending}
              data-component={`role-refinement-mode-${m}`}
              className={`px-3 py-1.5 text-xs font-medium rounded-l-lg rounded-r-lg transition-colors disabled:opacity-50 first:rounded-r-none last:rounded-l-none ${
                config.mode === m
                  ? 'bg-[#2563eb]/25 text-blue-300 border border-[#2563eb]/50'
                  : 'bg-[#1a1f2e] text-slate-400 border border-[#1e293b] hover:text-slate-200'
              }`}
            >
              {m === 'off' ? 'Off' : m === 'manual' ? 'Manual' : 'Auto'}
            </button>
          ))}
          <span className="ml-2 text-[10px] text-slate-500">
            {config.mode === 'off'
              ? 'Hidden everywhere — no analysis runs.'
              : config.mode === 'manual'
                ? 'Analyze on demand from the failed task card.'
                : 'Auto-analyzes recurring failures; you still approve every edit.'}
          </span>
        </div>

        {/* Analysis model — the failure-analysis agent is a generic session
            (no pipeline role persona), so its model is configured here, not via
            the role providers. Defaults to sonnet. */}
        <div className="mt-3">
          <label className="flex items-center gap-2 text-xs text-slate-400">
            <span className="shrink-0">Analysis model</span>
            <select
              value={config.model}
              onChange={e => patchConfig({ model: e.target.value })}
              disabled={isPending}
              data-component="role-refinement-model"
              className="flex-1 min-w-0 px-2 py-1 text-xs bg-[#1a1f2e] border border-[#1e293b] rounded text-slate-200 disabled:opacity-50"
            >
              {(models.includes(config.model) ? models : [config.model, ...models]).map(m => (
                <option key={m} value={m} className="bg-[#11131b]">{m}</option>
              ))}
            </select>
          </label>
          <p className="text-[10px] text-slate-600 mt-1">
            The model that runs the failure analysis. The analysis agent is a generic session — it
            is not told to act as any pipeline role (its instructions come from an internal command).
          </p>
        </div>

        {/* Auto-mode controls (§5.2): daily spend cap + the Phase-3 auto-apply opt-in. */}
        {config.mode === 'auto' && (
          <div className="mt-3 space-y-3 border border-[#1e293b] rounded-lg bg-[#0f1219] p-3">
            <label className="flex items-start gap-2 text-xs text-slate-400 cursor-pointer">
              <input
                type="checkbox"
                checked={config.autoApply}
                onChange={e => patchConfig({ autoApply: e.target.checked })}
                disabled={isPending}
                data-component="role-refinement-autoapply"
                className="mt-0.5 accent-[#2563eb]"
              />
              <span>
                Auto-apply suggested edits
                <span className="block text-[10px] text-slate-600 mt-0.5">
                  Only additive, low-risk edits are ever auto-applied, and every
                  change is backed up and revertable. (Takes effect with the
                  Phase-3 auto-apply policy.)
                </span>
              </span>
            </label>
            <label className="flex items-center gap-2 text-xs text-slate-400">
              <span>Max auto-analyses per day</span>
              <input
                type="number"
                min={1}
                max={50}
                value={config.maxAutoAnalysesPerDay}
                onChange={e => patchConfig({ maxAutoAnalysesPerDay: Math.max(1, Number(e.target.value) || 1) })}
                disabled={isPending}
                data-component="role-refinement-max-auto"
                className="w-16 px-2 py-1 text-xs bg-[#1a1f2e] border border-[#1e293b] rounded text-slate-200"
              />
            </label>
          </div>
        )}

        {error && <p className="mt-2 text-[11px] text-red-400">{error}</p>}
      </div>

      {/* Pending suggestions */}
      <div>
        <h3 className="text-xs font-semibold text-slate-300 uppercase tracking-wider mb-2">
          Pending suggestions ({pending.length})
        </h3>
        {pending.length === 0 ? (
          <p className="text-xs text-slate-600">No pending suggestions.</p>
        ) : (
          <div className="border border-[#1e293b] rounded-lg divide-y divide-[#1e293b] overflow-hidden">
            {pending.map(s => (
              <div key={s.id} className="px-4 py-3 bg-[#11131b]">
                <div className="flex items-center gap-2 flex-wrap">
                  {s.status === 'analyzing' && (
                    <span className="w-3 h-3 rounded-full border border-blue-400 border-t-transparent animate-spin" />
                  )}
                  <span className="text-xs text-slate-300 truncate">{taskLabel(s, tasks)}</span>
                  <span className={`text-[10px] font-medium px-2 py-0.5 rounded-full border ${CONFIDENCE_STYLES[s.confidence] ?? CONFIDENCE_STYLES.low}`}>
                    {s.confidence}
                  </span>
                  <span className="text-[10px] text-slate-600">{s.status}</span>
                  <div className="ml-auto flex items-center gap-2">
                    <Link
                      href={`/task/${s.sourceTaskIds[0]}`}
                      className="text-[11px] text-blue-400 hover:text-blue-300 transition-colors"
                    >
                      Review →
                    </Link>
                    {s.status === 'suggested' && (
                      <button
                        onClick={() => runAction(() => applyRefinementAction(s.id))}
                        disabled={isPending}
                        className="text-[11px] font-medium px-2 py-1 rounded bg-[#2563eb]/25 text-blue-300 hover:bg-[#2563eb]/40 transition-colors disabled:opacity-50"
                      >
                        Apply
                      </button>
                    )}
                    <button
                      onClick={() => runAction(() => dismissRefinementAction(s.id))}
                      disabled={isPending}
                      className="text-[11px] text-slate-500 hover:text-slate-300 transition-colors disabled:opacity-50"
                    >
                      Dismiss
                    </button>
                  </div>
                </div>
                <p className="mt-1.5 text-[11px] text-slate-400 leading-relaxed">{s.rootCause}</p>
                {s.edits.length > 0 && (
                  <p className="mt-1 text-[10px] text-slate-600 font-mono">
                    {s.edits.map(e => `${e.roleFile} (${e.mode})`).join(', ')}
                  </p>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Non-gap findings — first-class outcome, diagnosis is copyable */}
      {noGaps.length > 0 && (
        <div>
          <h3 className="text-xs font-semibold text-slate-300 uppercase tracking-wider mb-2">
            Not role-prompt gaps ({noGaps.length})
          </h3>
          <div className="border border-[#1e293b] rounded-lg divide-y divide-[#1e293b] overflow-hidden">
            {noGaps.map(s => (
              <div key={s.id} className="px-4 py-3 bg-[#11131b]">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-xs text-slate-300 truncate">{taskLabel(s, tasks)}</span>
                  {s.contractGap && s.contractFile && (
                    <span className="text-[10px] font-medium px-2 py-0.5 rounded bg-purple-900/40 text-purple-300">
                      contract gap — defaults/commands/{s.contractFile}
                    </span>
                  )}
                  <span className="ml-auto flex items-center gap-2">
                    <CopyButton text={s.diagnosis} label="diagnosis" />
                    <button
                      onClick={() => runAction(() => dismissRefinementAction(s.id))}
                      disabled={isPending}
                      className="text-[11px] text-slate-500 hover:text-slate-300 transition-colors disabled:opacity-50"
                    >
                      Dismiss
                    </button>
                  </span>
                </div>
                <p className="mt-1.5 text-[11px] text-slate-400 leading-relaxed whitespace-pre-wrap">{s.diagnosis}</p>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Applied history with revert */}
      <div>
        <h3 className="text-xs font-semibold text-slate-300 uppercase tracking-wider mb-2">
          Applied refinements ({applied.length})
        </h3>
        {applied.length === 0 ? (
          <p className="text-xs text-slate-600">Nothing applied yet.</p>
        ) : (
          <div className="border border-[#1e293b] rounded-lg divide-y divide-[#1e293b] overflow-hidden">
            {applied.map(s => (
              <div key={s.id} className="px-4 py-3 bg-[#11131b] flex items-center gap-2 flex-wrap">
                <span className="text-xs text-slate-300 truncate">{taskLabel(s, tasks)}</span>
                {s.appliedBy === 'auto' && (
                  <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-purple-900/40 text-purple-300" data-component="auto-applied-badge">
                    auto
                  </span>
                )}
                <span className="text-[10px] text-slate-600">
                  applied {s.appliedAt ? new Date(s.appliedAt).toLocaleString() : ''}
                </span>
                {s.model && (
                  <span className="text-[10px] font-mono text-slate-500" data-component="suggestion-model">
                    {s.model}
                  </span>
                )}
                <div className="ml-auto flex items-center gap-2">
                  {s.edits.map(e => (
                    <span key={e.roleFile} className="text-[10px] font-mono text-emerald-400/80">
                      {e.roleFile}
                    </span>
                  ))}
                  <button
                    onClick={() => runAction(() => revertRefinementAction(s.id))}
                    disabled={isPending}
                    data-component={`revert-refinement-${s.id}`}
                    className="text-[11px] text-amber-400 hover:text-amber-300 transition-colors disabled:opacity-50"
                  >
                    ↺ Revert
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Dismissed / superseded history — collapsible */}
      {history.length > 0 && (
        <details className="border border-[#1e293b] rounded-lg bg-[#0f1219]">
          <summary className="px-4 py-2.5 text-xs text-slate-500 cursor-pointer hover:text-slate-300 transition-colors select-none">
            Dismissed & superseded ({history.length})
          </summary>
          <div className="px-4 pb-3 space-y-1.5">
            {history.map(s => (
              <p key={s.id} className="text-[11px] text-slate-600">
                {taskLabel(s, tasks)} — {s.status} {s.updatedAt ? `(${new Date(s.updatedAt).toLocaleString()})` : ''}
              </p>
            ))}
          </div>
        </details>
      )}
    </section>
  );
}
