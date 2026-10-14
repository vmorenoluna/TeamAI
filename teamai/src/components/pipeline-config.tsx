'use client';

import { useState, useTransition } from 'react';
import { savePipelineConfig } from '@/app/actions/pipeline';
import type { PipelineConfig } from '@/app/actions/pipeline';
import { formatActionError } from '@/lib/error-format';
import { BudgetPairInputs } from '@/components/budget-pair-inputs';

const QA_ATTEMPTS_TOOLTIP =
  "Consecutive QA rounds without progress before the task fails. A round makes progress when something that failed in the previous round now passes, nothing that passed before now fails, and the set of failures hasn't been seen before; a progressing round resets this count to 0, as does a spec revision. Default: 3.";
const QA_ROUNDS_TOOLTIP =
  'Hard cap on the total number of QA rounds for a task, whether or not the rounds make progress. Bounds fix/undo oscillation, QA finding new issues every round, and token spend. Spec revisions do not reset it; Retry and human Request Changes (other than to the Analyst) do. Must be at least Max QA attempts. Default: 3 × Max QA attempts (9).';
const SCOPE_STALL_TOOLTIP =
  "Consecutive scope-arbitration rounds in which a subtask's set of files changed outside its listed files stops shrinking before the task fails. A round makes progress when that set gets smaller. Default: 2.";
const SCOPE_REPLANS_TOOLTIP =
  'Hard cap on the total number of scope-arbitration sessions per task, whether or not the rounds make progress; exhausting it fails the task. Must be at least Max scope stall. Default: 3 × Max scope stall (6).';

export function PipelineConfigEditor({ config }: { config: PipelineConfig }) {
  const [maxQa, setMaxQa] = useState(config.maxQaAttempts);
  const [maxQaRounds, setMaxQaRounds] = useState(config.maxQaRounds);
  const [maxScopeStall, setMaxScopeStall] = useState(config.maxScopeStall);
  const [maxScopeReplans, setMaxScopeReplans] = useState(config.maxScopeReplans);
  const [parallel, setParallel] = useState(config.parallelSubtasks);
  const [autoParallel, setAutoParallel] = useState(config.autoModeMaxParallel);
  const [idleStall, setIdleStall] = useState(config.idleStallMinutes);
  const [toolStall, setToolStall] = useState(config.toolStallMinutes);
  const [maxImplementRetries, setMaxImplementRetries] = useState(config.maxImplementRetries);
  const [recordHistory, setRecordHistory] = useState(config.recordHistoryInGit);
  const [phasesTrailer, setPhasesTrailer] = useState(config.includePhasesTrailer);
  const [saved, setSaved] = useState(false);
  // Regression-fix contract: surfaces Server Action failures (raw-throw path).
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function handleSave() {
    setError(null);
    if (maxQaRounds < maxQa) {
      setError(formatActionError('save pipeline config', new Error(`Max QA rounds (${maxQaRounds}) must be at least Max QA attempts (${maxQa})`)));
      return;
    }
    if (maxScopeReplans < maxScopeStall) {
      setError(formatActionError('save pipeline config', new Error(`Max scope replans (${maxScopeReplans}) must be at least Max scope stall (${maxScopeStall})`)));
      return;
    }
    startTransition(async () => {
      try {
        await savePipelineConfig({ maxQaAttempts: maxQa, maxQaRounds, maxScopeStall, maxScopeReplans, parallelSubtasks: parallel, autoModeMaxParallel: autoParallel, idleStallMinutes: idleStall, toolStallMinutes: toolStall, maxImplementRetries, recordHistoryInGit: recordHistory, includePhasesTrailer: phasesTrailer });
        setSaved(true);
        setTimeout(() => setSaved(false), 2000);
      } catch (err) {
        setError(formatActionError('save pipeline config', err));
      }
    });
  }

  return (
    <div data-component="pipeline-config" className="space-y-4">
      {/* Error banner — surfaces Server Action throws from handleSave. */}
      {error && (
        <div
          role="alert"
          className="p-2.5 bg-red-900/30 border border-red-800/50 rounded-lg flex items-start justify-between gap-2"
        >
          <p className="text-xs text-red-300 flex-1">{error}</p>
          <button
            onClick={() => setError(null)}
            aria-label="Dismiss error"
            className="text-red-500 hover:text-red-300 text-sm leading-none transition-colors"
          >
            ✕
          </button>
        </div>
      )}
      <div className="flex items-center gap-4 flex-wrap">
        <BudgetPairInputs
          stall={{
            label: 'Max QA attempts',
            tooltip: QA_ATTEMPTS_TOOLTIP,
            value: maxQa,
            min: 1,
            max: 10,
            onChange: setMaxQa,
          }}
          rounds={{
            label: 'Max QA rounds',
            tooltip: QA_ROUNDS_TOOLTIP,
            value: maxQaRounds,
            min: 1,
            max: 30,
            onChange: setMaxQaRounds,
          }}
        />
        <BudgetPairInputs
          stall={{
            label: 'Max scope stall',
            tooltip: SCOPE_STALL_TOOLTIP,
            value: maxScopeStall,
            min: 1,
            max: 10,
            onChange: setMaxScopeStall,
          }}
          rounds={{
            label: 'Max scope replans',
            tooltip: SCOPE_REPLANS_TOOLTIP,
            value: maxScopeReplans,
            min: 1,
            max: 30,
            onChange: setMaxScopeReplans,
          }}
        />
        <div title="Single cap governing every retry-and-give-up circuit breaker inside the implement phase: a subtask's declared deliverable still missing after its session ends, a wakeup-pending subtask's background job never producing its artifact, or a full implement pass ending with any subtask still incomplete. All bypass QA entirely and fail the task once exceeded, rather than pushing to an expensive QA review that would only confirm what plan.json already shows. Default: 3.">
          <label className="text-xs font-medium text-slate-400 block mb-1">
            Max implement retries
          </label>
          <input
            type="number"
            min={1}
            max={10}
            value={maxImplementRetries}
            onChange={e => setMaxImplementRetries(Number(e.target.value))}
            className="w-20 px-2 py-1 text-sm border border-[#334155] rounded bg-[#11131b] text-white focus:outline-none focus:ring-2 focus:ring-[#2563eb]"
          />
        </div>
        <label className="flex items-center gap-2 cursor-pointer mt-4">
          <input
            type="checkbox"
            checked={parallel}
            onChange={e => setParallel(e.target.checked)}
            className="rounded border-[#334155] bg-[#11131b]"
          />
          <span className="text-sm text-slate-300">Parallel subtasks</span>
        </label>
        <div>
          <label className="text-xs font-medium text-slate-400 block mb-1">
            Auto mode max parallel tasks
          </label>
          <input
            type="number"
            min={1}
            max={10}
            value={autoParallel}
            onChange={e => setAutoParallel(Number(e.target.value))}
            className="w-20 px-2 py-1 text-sm border border-[#334155] rounded bg-[#11131b] text-white focus:outline-none focus:ring-2 focus:ring-[#2563eb]"
          />
        </div>
      </div>

      <div className="flex items-center gap-4 flex-wrap">
        <div title="Minutes a session can sit idle (no tool running, no new message) before the stall-detector terminates it. A session genuinely thinking through a multi-file investigation between tool calls can go quiet — too tight a value kills real progress. Default: 15 min.">
          <label className="text-xs font-medium text-slate-400 block mb-1">
            Idle stall threshold (min)
          </label>
          <input
            type="number"
            min={1}
            max={120}
            value={idleStall}
            onChange={e => setIdleStall(Number(e.target.value))}
            className="w-20 px-2 py-1 text-sm border border-[#334155] rounded bg-[#11131b] text-white focus:outline-none focus:ring-2 focus:ring-[#2563eb]"
          />
        </div>
        <div title="Minutes a single tool call can run with no output before the stall-detector terminates the session. A cold compile, large test suite, or slow network call can legitimately take many minutes. Default: 30 min.">
          <label className="text-xs font-medium text-slate-400 block mb-1">
            Tool stall threshold (min)
          </label>
          <input
            type="number"
            min={1}
            max={180}
            value={toolStall}
            onChange={e => setToolStall(Number(e.target.value))}
            className="w-20 px-2 py-1 text-sm border border-[#334155] rounded bg-[#11131b] text-white focus:outline-none focus:ring-2 focus:ring-[#2563eb]"
          />
        </div>
      </div>

      <div className="flex items-center gap-4 flex-wrap">
        <label
          className="flex items-start gap-2 cursor-pointer"
          title="Write Task/Task-ID/QA/Phases trailers into merge commits and PR bodies, and keep a reconstructable DONE-ticket history from git. When off, no ticket metadata is written anywhere — completed tickets leave no reconstructable history in TeamAI and disappear from the DONE column after a restart."
        >
          <input
            type="checkbox"
            checked={recordHistory}
            onChange={e => setRecordHistory(e.target.checked)}
            className="rounded border-[#334155] bg-[#11131b]"
          />
          <span className="text-sm text-slate-300">Record ticket history in git</span>
        </label>
        <label
          className={`flex items-start gap-2 ${recordHistory ? 'cursor-pointer' : 'cursor-not-allowed opacity-50'}`}
          title="Include the Phases: trailer (the pipeline phase chain, including QA retries) in commit messages and PR bodies. Only applies when 'Record ticket history in git' is on."
        >
          <input
            type="checkbox"
            checked={recordHistory && phasesTrailer}
            disabled={!recordHistory}
            onChange={e => setPhasesTrailer(e.target.checked)}
            className="rounded border-[#334155] bg-[#11131b]"
          />
          <span className="text-sm text-slate-300">Include Phases trailer</span>
        </label>
      </div>

      <button
        onClick={handleSave}
        disabled={isPending}
        className="px-4 py-1.5 text-sm font-medium bg-[#2563eb] text-white rounded-lg hover:bg-[#1d4ed8] disabled:opacity-40 transition-colors"
      >
        {saved ? 'Saved!' : isPending ? 'Saving…' : 'Save Pipeline Config'}
      </button>
    </div>
  );
}
