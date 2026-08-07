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
  /** Default for the budget-reset toggle. */
  budgetDefault: boolean;
  onCancel: () => void;
  onConfirm: (phase: string, resetBudget: boolean) => void;
}

// ── Component ──────────────────────────────────────────────────────────────

export function RetryPhaseDialog({
  taskTitle,
  phases,
  defaultPhase,
  budgetDefault,
  onCancel,
  onConfirm,
}: RetryPhaseDialogProps) {
  const options = phases.map(p => ({
    ...p,
    description: getPhaseClearDescription(p.phase),
  }));

  const [selected, setSelected] = useState(defaultPhase);
  const [resetBudget, setResetBudget] = useState(budgetDefault);
  const singlePhase = options.length === 1;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/60"
        onClick={onCancel}
      />

      {/* Dialog */}
      <div className="relative bg-[#1e2333] rounded-xl shadow-2xl shadow-black/40 border border-[#1e293b] p-6 w-full max-w-md mx-4">
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

        {/* Budget reset toggle */}
        <label className="flex items-center gap-3 p-3 rounded-lg border border-[#334155] cursor-pointer hover:border-[#475569] transition-colors">
          <input
            type="checkbox"
            checked={resetBudget}
            onChange={e => setResetBudget(e.target.checked)}
            className="shrink-0 accent-[#2563eb]"
          />
          <div>
            <span className="text-sm font-medium text-white block">
              Reset QA-attempt budget
            </span>
            <span className="text-xs text-slate-400">
              {resetBudget
                ? 'The QA-attempt counter will be reset — the task gets a fresh budget for this round.'
                : 'The QA-attempt counter will be preserved — previous attempts still count toward the circuit breaker.'}
            </span>
          </div>
        </label>

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
            onClick={() => onConfirm(selected, resetBudget)}
            className="px-4 py-2 text-sm font-medium bg-[#2563eb] text-white rounded-lg hover:bg-[#1d4ed8] transition-colors"
          >
            {singlePhase ? 'Move & Resume' : 'Resume'}
          </button>
        </div>
      </div>
    </div>
  );
}
