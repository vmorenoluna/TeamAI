'use client';

import { useEffect } from 'react';
import { TaskPanel } from './task-panel';
import type { FullData } from './task-panel';

interface Props {
  taskId: string;
  onClose: () => void;
  readonly?: boolean;
  cachedData?: FullData;
  onDataLoaded?: (data: FullData, taskId: string) => void;
  onError?: (error: string) => void;
  projectPath?: string;
}

/** Floating modal overlay with TaskPanel — used by kanban, roadmap, and workflow views. */
export function TaskModal({ taskId, onClose, readonly, cachedData, onDataLoaded, onError, projectPath }: Props) {
  // Close on Escape
  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [onClose]);

  return (
    <div className="absolute inset-0 z-40 flex items-center justify-center p-6">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/40 backdrop-blur-sm"
        onClick={onClose}
      />
      {/* Window */}
      <div
        className="relative w-[800px] max-w-[95vw] h-full max-h-[700px] rounded-xl shadow-2xl shadow-black/40 border border-[#1e293b] bg-[#11131b] overflow-hidden flex flex-col animate-modal-in"
        onClick={e => e.stopPropagation()}
      >
        <TaskPanel
          taskId={taskId}
          onClose={onClose}
          readonly={readonly}
          cachedData={cachedData}
          onDataLoaded={onDataLoaded}
          onError={onError}
          projectPath={projectPath}
        />
      </div>
    </div>
  );
}
