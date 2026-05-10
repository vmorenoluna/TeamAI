'use client';

import { useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { resumeTask } from '@/app/actions/recovery';
import type { InterruptedTask } from '@/lib/recovery';

export function RecoveryBanner({ tasks }: { tasks: InterruptedTask[] }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  if (tasks.length === 0) return null;

  function handleResume(task: InterruptedTask) {
    startTransition(async () => {
      await resumeTask(task);
      router.refresh();
    });
  }

  return (      <div className="shrink-0 bg-amber-950/30 border-b border-amber-800/50 px-6 py-3">
      <p className="text-xs font-semibold text-amber-300 mb-2">
        {tasks.length} interrupted task{tasks.length > 1 ? 's' : ''} detected from previous session
      </p>
      <div className="flex flex-wrap gap-2">
        {tasks.map(task => (
          <button
            key={task.taskId}
            onClick={() => handleResume(task)}
            disabled={isPending}
            className="px-3 py-1 text-xs font-medium bg-amber-600 hover:bg-amber-700 disabled:opacity-50 text-white rounded-md transition-colors"
          >
            Resume: {task.title} ({task.phase})
          </button>
        ))}
      </div>
    </div>
  );
}
