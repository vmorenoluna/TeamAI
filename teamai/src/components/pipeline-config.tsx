'use client';

import { useState, useTransition } from 'react';
import { savePipelineConfig } from '@/app/actions/pipeline';
import type { PipelineConfig } from '@/app/actions/pipeline';

export function PipelineConfigEditor({ config }: { config: PipelineConfig }) {
  const [maxQa, setMaxQa] = useState(config.maxQaAttempts);
  const [parallel, setParallel] = useState(config.parallelSubtasks);
  const [autoParallel, setAutoParallel] = useState(config.autoModeMaxParallel);
  const [saved, setSaved] = useState(false);
  const [isPending, startTransition] = useTransition();

  function handleSave() {
    startTransition(async () => {
      await savePipelineConfig({ maxQaAttempts: maxQa, parallelSubtasks: parallel, autoModeMaxParallel: autoParallel });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    });
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-4 flex-wrap">
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
