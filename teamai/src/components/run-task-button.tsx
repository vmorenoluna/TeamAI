'use client';

import { useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { runTask } from '@/app/actions/tasks';

export function RunTaskButton({ taskId }: { taskId: string }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  function handleRun() {
    startTransition(async () => {
      await runTask(taskId);
      // No router.refresh() here — PhaseSyncer on this page handles live updates via WebSocket
    });
  }

  return (
    <button
      onClick={handleRun}
      disabled={isPending}
      className="px-4 py-1.5 text-sm font-medium bg-green-600 hover:bg-green-700 disabled:opacity-50 text-white rounded-md transition-colors"
    >
      {isPending ? 'Starting…' : 'Run Pipeline'}
    </button>
  );
}
