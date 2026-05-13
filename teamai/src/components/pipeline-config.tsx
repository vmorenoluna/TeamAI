'use client';

import { useState, useTransition } from 'react';
import { savePipelineConfig } from '@/app/actions/pipeline';
import type { PipelineConfig } from '@/app/actions/pipeline';

const ALL_PHASES = ['spec', 'plan', 'implement', 'qa-review', 'merge'] as const;

export function PipelineConfigEditor({ config }: { config: PipelineConfig }) {
  const [phases, setPhases] = useState<string[]>(config.phases);
  const [maxQa, setMaxQa] = useState(config.maxQaAttempts);
  const [parallel, setParallel] = useState(config.parallelSubtasks);
  const [saved, setSaved] = useState(false);
  const [isPending, startTransition] = useTransition();

  function togglePhase(phase: string) {
    setPhases(prev =>
      prev.includes(phase) ? prev.filter(p => p !== phase) : [...prev, phase]
    );
  }

  function handleSave() {
    startTransition(async () => {
      await savePipelineConfig({ phases, maxQaAttempts: maxQa, parallelSubtasks: parallel });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    });
  }

  return (
    <div className="space-y-4">
      <div>
        <p className="text-xs font-medium text-slate-400 mb-2">Active phases</p>
        <div className="flex flex-wrap gap-2">
          {ALL_PHASES.map(phase => (
            <label key={phase} className="flex items-center gap-1.5 cursor-pointer">
              <input
                type="checkbox"
                checked={phases.includes(phase)}
                onChange={() => togglePhase(phase)}
                className="rounded border-[#334155] bg-[#11131b]"
              />
              <span className="text-sm text-slate-300 capitalize">
                {phase.replace('-', ' ')}
              </span>
            </label>
          ))}
        </div>
      </div>

      <div className="flex items-center gap-4">
        <div>
          <label className="text-xs font-medium text-slate-400 block mb-1">
            Max QA attempts
          </label>
          <input
            type="number"
            min={1}
            max={10}
            value={maxQa}
            onChange={e => setMaxQa(Number(e.target.value))}
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
