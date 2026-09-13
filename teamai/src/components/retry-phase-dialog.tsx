'use client';

import { useState } from 'react';
import { getPhaseClearDescription, type PhaseClearDescription } from '@/lib/orchestrator/artifacts';

// ── Types ──────────────────────────────────────────────────────────────────

export type DialogPhaseOption = PhaseClearDescription;

export interface RetryPhaseDialogProps {
  taskTitle: string;
  /** The phases to offer.  When length === 1 the phase selector is hidden. */
  phases: DialogPhaseOption[];
  /** Pre-selected phase (should be one of `phases`). */
  defaultPhase: string;
  onCancel: () => void;
  onConfirm: (phase: string) => void;
}

// ── Component ──────────────────────────────────────────────────────────────

export function RetryPhaseDialog({
  taskTitle,
  phases,
  defaultPhase,
  onCancel,
  onConfirm,
}: RetryPhaseDialogProps) {
  const options = phases.map(p => ({
    ...p,
    description: getPhaseClearDescription(p.phase),
  }));

  const [selected, setSelected] = useState(defaultPhase);
  const singlePhase = options.length === 1;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center pointer-events-auto">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/60"
        onClick={onCancel}
      />

      {/* Dialog — stopPropagation prevents clicks from bubbling to the
           kanban card wrapper, which would select the task and apply
           pointer-events-none to the board (freezing this dialog). */}
      <div
        className="relative bg-[#1e2333] rounded-xl shadow-2xl shadow-black/40 border border-[#1e293b] p-6 w-full max-w-md mx-4"
        onClick={e => e.stopPropagation()}
      >
        <h2 className="text-base font-semibold text-white mb-1">
          {singlePhase ? 'Move Task' : 'Choose Resume Phase'}
        </h2>
        <p className="text-xs text-slate-400 mb-4">
          {singlePhase
            ? `Moving "${taskTitle}" — this will clear artifacts.`
            : `"${taskTitle}" — pick which phase to resume from.`}
        </p>

        {/* Phase options (hidden when only one) */}
        {!singlePhase && (
          <fieldset className="mb-4 space-y-2">
            <legend className="sr-only">Resume phase</legend>
            {options.map(opt => (
              <label
                key={opt.phase}
                className={`flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition-colors ${
                  selected === opt.phase
                    ? 'border-[#2563eb] bg-[#2563eb]/10'
                    : 'border-[#334155] hover:border-[#475569]'
                }`}
              >
                <input
                  type="radio"
                  name="resumePhase"
                  value={opt.phase}
                  checked={selected === opt.phase}
                  onChange={() => setSelected(opt.phase)}
                  className="mt-0.5 shrink-0 accent-[#2563eb]"
                />
                <div>
                  <span className="text-sm font-medium text-white block">
                    Resume from {opt.label}
                  </span>
                  <span className="text-xs text-slate-400">
                    {opt.description}
                  </span>
                </div>
              </label>
            ))}
          </fieldset>
        )}

        {/* Single-phase case: show explanation inline */}
        {singlePhase && options[0] && (
          <div className="mb-4 p-3 rounded-lg border border-[#334155] bg-[#1a1f2e]">
            <span className="text-sm font-medium text-white block">
              Resume from {options[0].label}
            </span>
            <span className="text-xs text-slate-400">
              {options[0].description}
            </span>
          </div>
        )}

        {/* Budget reset is no longer a choice — a retry always clears
             qaAttempt/wakeupAttemptCount/deliverableFailCounts so a counter
             carried over from the failed run can't trip a cap almost
             instantly on the very next attempt. */}
        <p className="mb-4 text-xs text-slate-400">
          This gives the task a fresh QA/wakeup-attempt budget for this round.
        </p>

        {/* Actions */}
        <div className="flex justify-end gap-3 pt-4">
          <button
            type="button"
            onClick={onCancel}
            className="px-4 py-2 text-sm text-slate-400 hover:text-white transition-colors"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => onConfirm(selected)}
            className="px-4 py-2 text-sm font-medium bg-[#2563eb] text-white rounded-lg hover:bg-[#1d4ed8] transition-colors"
          >
            {singlePhase ? 'Move & Resume' : 'Resume'}
          </button>
        </div>
      </div>
    </div>
  );
}
