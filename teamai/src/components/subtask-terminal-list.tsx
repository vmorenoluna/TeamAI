'use client';

import { useState } from 'react';
import { SubtaskTerminal } from './subtask-terminal';

interface SubtaskTerminalInfo {
  id: number;
  title: string;
  log: string | null;
}

interface Props {
  taskId: string;
  subtaskTerminals: SubtaskTerminalInfo[];
  qaLog: string | null;
  orchestratorLog: string | null;
  sessionMap?: Record<string, string>;
}

export function SubtaskTerminalList({ taskId, subtaskTerminals, qaLog, orchestratorLog, sessionMap }: Props) {
  // Build the list of terminals
  interface TerminalDef {
    key: string; label: string; log: string | null; color: string; sessionIds: string[];
  }
  const terminals: TerminalDef[] = [];

  // Collect session IDs per terminal
  const coderSessionIds: string[] = [];
  const qaSessionIds: string[] = [];
  if (sessionMap) {
    for (const [k, v] of Object.entries(sessionMap)) {
      if (k === 'qa') {
        qaSessionIds.push(v);
      } else {
        coderSessionIds.push(v);
      }
    }
  }

  // Coder terminal: merges all subtask logs in ID order with separators
  const coderLog = subtaskTerminals.length > 0
    ? subtaskTerminals.map((t, i) => {
        if (!t.log) return '';
        return (i > 0 ? '\n\n═══ Subtask ' + t.id + ': ' + t.title + ' ═══\n\n' : '') + t.log;
      }).filter(Boolean).join('')
    : null;
  if (coderLog || subtaskTerminals.length > 0) {
    terminals.push({
      key: 'coder',
      label: `Coder${subtaskTerminals.length > 0 ? ` (${subtaskTerminals.length} subtask${subtaskTerminals.length > 1 ? 's' : ''})` : ''}`,
      log: coderLog,
      color: 'border-amber-500',
      sessionIds: coderSessionIds,
    });
  }

  // QA terminal
  if (qaLog) {
    terminals.push({
      key: 'qa',
      label: 'QA Review',
      log: qaLog,
      color: 'border-orange-500',
      sessionIds: qaSessionIds,
    });
  }

  // Orchestrator terminal
  if (orchestratorLog) {
    terminals.push({
      key: 'orchestrator',
      label: 'Orchestrator',
      log: orchestratorLog,
      color: 'border-slate-500',
      sessionIds: [],
    });
  }

  // Auto-expand if there's exactly one terminal with content
  const defaultExpanded = terminals.length === 1 ? terminals[0].key : null;
  const [expanded, setExpanded] = useState<string | null>(defaultExpanded);

  function toggle(key: string) {
    setExpanded(prev => prev === key ? null : key);
  }

  if (terminals.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-sm text-slate-400">
        No agent output yet. Run the pipeline to see terminal output.
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2 h-full overflow-auto p-4">
      {terminals.map(t => {
        const isExpanded = expanded === t.key;
        return (
          <div
            key={t.key}
            className={`flex flex-col rounded-lg overflow-hidden border-2 ${t.color} bg-slate-950 transition-all ${
              isExpanded ? 'flex-[2] min-h-0' : 'shrink-0'
            }`}
          >
            {/* Header — click to expand/collapse */}
            <button
              onClick={() => toggle(t.key)}
              className="flex items-center justify-between px-3 py-2 bg-[#1a1f2e] shrink-0 hover:bg-[#1e293b] transition-colors"
            >
              <div className="flex items-center gap-2">
                <span className="text-xs font-medium text-slate-300">
                  {t.label}
                </span>
                {!isExpanded && (
                  <span className="text-[10px] text-slate-500">
                    {t.log ? `${t.log.split('\n').length} lines` : 'no output'}
                  </span>
                )}
              </div>
              <span className="text-slate-400 text-sm">
                {isExpanded ? '▼' : '▶'}
              </span>
            </button>

            {/* Body — only rendered when expanded */}
            {isExpanded && (
              <div className="flex-1 min-h-0">
                <SubtaskTerminal
                  taskId={taskId}
                  terminalKey={t.key}
                  initialOutput={t.log}
                  sessionIds={t.sessionIds.length > 0 ? t.sessionIds : undefined}
                />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
