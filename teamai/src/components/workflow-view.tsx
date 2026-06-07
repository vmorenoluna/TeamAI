'use client';

import { useState, useEffect, useMemo } from 'react';
import { usePhaseSync } from '@/hooks/use-phase-sync';
import { TaskPanel } from './task-panel';
import { PIPELINE_PHASES } from '@/constants/phases';
import type { WorkflowTask } from '@/app/actions/workflow';

// ── Layout constants ─────────────────────────────────────────────────────────

const DIAGRAM_PANEL_W = 420;
const TICKET_PANEL_W = 340;
const NODE_H = 48;
const NODE_GAP = 24;
const PITCH = NODE_H + NODE_GAP;
const NODE_W = 200;
const LEFT_MARGIN = Math.floor((DIAGRAM_PANEL_W - NODE_W) / 2);
const CENTER_X = LEFT_MARGIN + NODE_W / 2;
const LEFT_X = LEFT_MARGIN;
const RIGHT_X = LEFT_MARGIN + NODE_W;
const CURVE_OFFSET = 80;

// ── Transition definitions ───────────────────────────────────────────────────

const FORWARD_TRANSITIONS: [string, string][] = [
  ['backlog', 'spec'],
  ['spec', 'plan'],
  ['plan', 'implement'],
  ['implement', 'qa-review'],
  ['qa-review', 'awaiting-review'],
  ['awaiting-review', 'merge'],
  ['awaiting-review', 'create-pr'],
  ['merge', 'done'],
  ['create-pr', 'pr-open'],
  ['pr-open', 'done'],
];

const BACKWARD_TRANSITIONS: [string, string][] = [
  ['qa-review', 'implement'],
  ['awaiting-review', 'implement'],
  ['pr-open', 'implement'],
];

const FAILURE_TRANSITIONS: [string, string][] = [
  ['implement', 'failed'],
  ['qa-review', 'failed'],
];

// ── Helpers ──────────────────────────────────────────────────────────────────

function phaseIndex(phase: string): number {
  return PIPELINE_PHASES.findIndex(p => p.phase === phase);
}

function nodeY(idx: number): number {
  return idx * PITCH;
}

function nodeCenterY(idx: number): number {
  return nodeY(idx) + NODE_H / 2;
}

function timeInPhase(enteredPhaseAt: string | null): string {
  if (!enteredPhaseAt) return '';
  const elapsed = Date.now() - new Date(enteredPhaseAt).getTime();
  const mins = Math.floor(elapsed / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

// ── Sub-components ───────────────────────────────────────────────────────────

function TaskCard({ wt, onClick }: { wt: WorkflowTask; onClick: () => void }) {
  return (
    <div
      onClick={onClick}
      className={`rounded-lg border px-3 py-2 text-xs transition-colors cursor-pointer ${
        wt.qaBounces > 0
          ? 'border-amber-500/40 bg-amber-500/5 hover:border-amber-500/60'
          : 'border-slate-700 bg-slate-800/30 hover:border-slate-600'
      }`}
    >
      <div className="font-medium text-slate-200 truncate" title={wt.task.title}>
        {wt.task.title}
      </div>
      <div className="flex items-center gap-3 mt-1 text-[10px] text-slate-500">
        {wt.qaBounces > 0 && (
          <span className="flex items-center gap-1 text-amber-400" title={`${wt.qaBounces} QA bounce${wt.qaBounces !== 1 ? 's' : ''}`}>
            <span className="inline-block w-1.5 h-1.5 rounded-full bg-amber-500/60" />
            {wt.qaBounces}x QA
          </span>
        )}
        {wt.enteredPhaseAt && (
          <span>{timeInPhase(wt.enteredPhaseAt)}</span>
        )}
      </div>
    </div>
  );
}

// ── Main component ───────────────────────────────────────────────────────────

interface Props {
  workflowTasks: WorkflowTask[];
}

export function WorkflowView({ workflowTasks }: Props) {
  usePhaseSync();

  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [hoveredPhase, setHoveredPhase] = useState<string | null>(null);

  // Close the task window on Escape key
  useEffect(() => {
    if (!selectedTaskId) return;
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setSelectedTaskId(null);
    }
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [selectedTaskId]);

  // Group tasks by phase
  const { tasksByPhase, otherTasks } = useMemo(() => {
    const byPhase = new Map<string, WorkflowTask[]>();
    const other: WorkflowTask[] = [];
    for (const phase of PIPELINE_PHASES) {
      byPhase.set(phase.phase, []);
    }
    for (const wt of workflowTasks) {
      const existing = byPhase.get(wt.task.phase);
      if (existing) {
        existing.push(wt);
      } else {
        other.push(wt);
      }
    }
    return { tasksByPhase: byPhase, otherTasks: other };
  }, [workflowTasks]);

  // Account for the Other node if present
  const totalRows = otherTasks.length > 0 ? PIPELINE_PHASES.length + 1 : PIPELINE_PHASES.length;
  const diagramHeight = totalRows * PITCH;

  // Build SVG arrow elements
  const svgArrows = useMemo(() => {
    const arrows: React.ReactNode[] = [];

    const addStraightArrow = (from: string, to: string, className: string) => {
      const fi = phaseIndex(from);
      const ti = phaseIndex(to);
      if (fi < 0 || ti < 0) return;
      arrows.push(
        <line
          key={`${from}→${to}`}
          x1={CENTER_X}
          y1={nodeY(fi) + NODE_H}
          x2={CENTER_X}
          y2={nodeY(ti) - 6}
          className={className}
          markerEnd="url(#arrow-down)"
        />,
      );
    };

    const addRightCurve = (from: string, to: string, className: string) => {
      const fi = phaseIndex(from);
      const ti = phaseIndex(to);
      if (fi < 0 || ti < 0) return;
      const sy = nodeCenterY(fi);
      const ty = nodeCenterY(ti);
      const cx = RIGHT_X + CURVE_OFFSET;
      arrows.push(
        <path
          key={`${from}→${to}`}
          d={`M ${RIGHT_X + 2},${sy} C ${cx},${sy} ${cx},${ty} ${RIGHT_X + 6},${ty}`}
          className={className}
          fill="none"
          markerEnd="url(#arrow-right)"
        />,
      );
    };

    const addLeftCurve = (from: string, to: string, className: string, marker: string, label?: string, textFill?: string) => {
      const fi = phaseIndex(from);
      const ti = phaseIndex(to);
      if (fi < 0 || ti < 0) return;
      const sy = nodeCenterY(fi);
      const ty = nodeCenterY(ti);
      const cx = LEFT_X - CURVE_OFFSET;
      const midY = (sy + ty) / 2;
      arrows.push(
        <path
          key={`${from}→${to}`}
          d={`M ${LEFT_X - 2},${sy} C ${cx},${sy} ${cx},${ty} ${LEFT_X},${ty}`}
          className={className}
          fill="none"
          markerEnd={`url(#${marker})`}
        />,
      );
      if (label) {
        arrows.push(
          <text
            key={`${from}→${to}-label`}
            x={cx - 10}
            y={midY}
            fill={textFill ?? '#94a3b8'}
            textAnchor="middle"
            dominantBaseline="central"
            transform={`rotate(-90, ${cx - 10}, ${midY})`}
            className="text-[9px] font-medium"
          >
            {label}
          </text>,
        );
      }
    };

    // Forward transitions: straight if adjacent, right curve if skipping
    for (const [from, to] of FORWARD_TRANSITIONS) {
      const fi = phaseIndex(from);
      const ti = phaseIndex(to);
      if (fi < 0 || ti < 0) continue;
      if (ti === fi + 1) {
        addStraightArrow(from, to, 'stroke-slate-600 stroke-[1.5]');
      } else {
        addRightCurve(from, to, 'stroke-slate-600 stroke-[1.5]');
      }
    }

    // Backward bounce-backs
    for (const [from, to] of BACKWARD_TRANSITIONS) {
      addLeftCurve(from, to, 'stroke-amber-500/60 stroke-[1.5] stroke-dasharray-[4_4]', 'arrow-left-amber', 'bounce back', '#f59e0b99');
    }

    // Failure transitions
    for (const [from, to] of FAILURE_TRANSITIONS) {
      addLeftCurve(from, to, 'stroke-red-500/50 stroke-[1.5] stroke-dasharray-[4_4]', 'arrow-left-red', 'max attempts', '#ef444488');
    }

    return arrows;
  }, []);

  const hoveredTasks = hoveredPhase ? (tasksByPhase.get(hoveredPhase) ?? []) : [];
  const isEmpty = workflowTasks.length === 0;

  return (
    <div className="flex flex-col h-full bg-[#11131b]">
      {/* Header */}
      <div className="shrink-0 flex items-center justify-between px-6 py-4 border-b border-[#1e293b] bg-[#11131b]">
        <div>
          <h1 className="text-base font-semibold text-white">Workflow</h1>
          <p className="text-xs text-slate-400 mt-0.5">
            Pipeline state diagram — hover over a phase to see its tickets.
          </p>
        </div>
        <div className="flex items-center gap-3 text-xs text-slate-500">
          <span className="flex items-center gap-1">
            <span className="inline-block w-2 h-0.5 bg-amber-500/60 rounded" />
            bounce
          </span>
          <span className="flex items-center gap-1">
            <span className="inline-block w-2 h-0.5 bg-red-500/50 rounded" />
            failure
          </span>
        </div>
      </div>

      {/* Main content: diagram + hover panel */}
      <div
        className={`flex-1 flex justify-center min-h-0 ${selectedTaskId ? 'overflow-hidden pointer-events-none select-none' : ''}`}
        onMouseLeave={() => setHoveredPhase(null)}
      >
        {/* Left: State diagram (always visible) */}
        <div className="shrink-0 overflow-y-auto border-r border-[#1e293b] p-6" style={{ width: DIAGRAM_PANEL_W }}>
          {isEmpty ? (
            <div className="flex items-center justify-center h-full text-sm text-slate-500">
              No tickets yet — create one from the Board.
            </div>
          ) : (
            <div className="relative" style={{ height: diagramHeight }}>
              {/* SVG arrow layer */}
              <svg
                className="absolute inset-0 pointer-events-none overflow-visible"
                width={RIGHT_X + CURVE_OFFSET + 10}
                height={diagramHeight}
              >
                <defs>
                  <marker id="arrow-down" viewBox="0 0 10 10" refX="5" refY="0" markerWidth="6" markerHeight="6" markerUnits="userSpaceOnUse">
                    <polygon points="0,0 5,10 10,0" className="fill-slate-600" />
                  </marker>
                  <marker id="arrow-right" viewBox="0 0 10 10" refX="0" refY="5" markerWidth="6" markerHeight="6" markerUnits="userSpaceOnUse">
                    <polygon points="0,5 10,0 10,10" className="fill-slate-600" />
                  </marker>
                  <marker id="arrow-left-amber" viewBox="0 0 10 10" refX="10" refY="5" markerWidth="6" markerHeight="6" markerUnits="userSpaceOnUse">
                    <polygon points="0,0 10,5 0,10" className="fill-amber-500/60" />
                  </marker>
                  <marker id="arrow-left-red" viewBox="0 0 10 10" refX="10" refY="5" markerWidth="6" markerHeight="6" markerUnits="userSpaceOnUse">
                    <polygon points="0,0 10,5 0,10" className="fill-red-500/50" />
                  </marker>
                </defs>
                {svgArrows}
              </svg>

              {/* Phase nodes */}
              <div className="relative z-10">
                {PIPELINE_PHASES.map((phase, idx) => {
                  const tasks = tasksByPhase.get(phase.phase) ?? [];
                  const hasTasks = tasks.length > 0;
                  const hasActive = tasks.some(wt => wt.isActive);
                  const isHovered = hoveredPhase === phase.phase;

                  return (
                    <div
                      key={phase.phase}
                      className="absolute transition-all duration-150"
                      style={{ top: nodeY(idx), left: LEFT_MARGIN, width: NODE_W }}
                      onMouseEnter={() => setHoveredPhase(phase.phase)}
                    >
                      <div
                        className={`px-3 py-2.5 rounded-lg border-2 text-xs font-semibold cursor-pointer transition-all ${
                          hasTasks
                            ? `${phase.color} text-white border-opacity-100`
                            : 'border-slate-700 bg-slate-800/50 text-slate-500'
                        } ${isHovered ? 'scale-105 shadow-lg shadow-black/30' : ''} ${hasActive ? 'animate-pulse-glow' : ''}`}
                      >
                        <div className="flex items-center justify-between">
                          <span>{phase.label}</span>
                          {hasTasks && (
                            <span className={`ml-2 px-1.5 py-0.5 rounded-full text-[10px] font-bold ${
                              isHovered ? 'bg-white/20 text-white' : 'bg-slate-700/50 text-slate-400'
                            }`}>
                              {tasks.length}
                            </span>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })}

                {/* Other (catch-all) node */}
                {otherTasks.length > 0 && (
                  <div
                    key="other"
                    className="absolute transition-all duration-150"
                    style={{ top: nodeY(PIPELINE_PHASES.length), left: LEFT_MARGIN, width: NODE_W }}
                    onMouseEnter={() => setHoveredPhase('__other__')}
                  >
                    <div className="px-3 py-2.5 rounded-lg border-2 border-dashed border-slate-600 bg-slate-800/40 text-xs font-semibold text-slate-400 cursor-pointer">
                      <div className="flex items-center justify-between">
                        <span>Other</span>
                        <span className="ml-2 px-1.5 py-0.5 rounded-full text-[10px] font-bold bg-slate-700/50 text-slate-400">
                          {otherTasks.length}
                        </span>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Right: Hover ticket panel */}
        <div className="shrink-0 overflow-y-auto p-6" style={{ width: TICKET_PANEL_W }}>
          {hoveredPhase ? (
            <div>
              <div className="flex items-center gap-2 mb-4">
                <h2 className="text-sm font-semibold text-white">
                  {hoveredPhase === '__other__'
                    ? 'Other'
                    : PIPELINE_PHASES.find(p => p.phase === hoveredPhase)?.label ?? hoveredPhase}
                </h2>
                <span className="text-xs text-slate-500">
                  {hoveredTasks.length} ticket{hoveredTasks.length !== 1 ? 's' : ''}
                </span>
              </div>
              {hoveredPhase === '__other__' ? (
                <div className="space-y-2" style={{ maxWidth: 340 }}>
                  {otherTasks.map(wt => (
                    <TaskCard key={wt.task.id} wt={wt} onClick={() => setSelectedTaskId(wt.task.id)} />
                  ))}
                </div>
              ) : hoveredTasks.length > 0 ? (
                <div className="space-y-2" style={{ maxWidth: 340 }}>
                  {hoveredTasks.map(wt => (
                    <TaskCard key={wt.task.id} wt={wt} onClick={() => setSelectedTaskId(wt.task.id)} />
                  ))}
                </div>
              ) : (
                <p className="text-sm text-slate-500">No tickets currently in this phase.</p>
              )}
            </div>
          ) : (
            <div className="flex items-center justify-center h-full text-sm text-slate-500">
              Hover over a phase on the left to see its tickets.
            </div>
          )}
        </div>
      </div>

      {/* Floating task detail modal */}
      {selectedTaskId && (
        <div className="absolute inset-0 z-40 flex items-center justify-center p-6">
          <div
            className="absolute inset-0 bg-black/40 backdrop-blur-sm"
            onClick={() => setSelectedTaskId(null)}
          />
          <div
            className="relative w-[800px] max-w-[95vw] h-full max-h-[700px] rounded-xl shadow-2xl shadow-black/40 border border-[#1e293b] bg-[#11131b] overflow-hidden flex flex-col animate-modal-in"
            onClick={e => e.stopPropagation()}
          >
            <TaskPanel
              taskId={selectedTaskId}
              onClose={() => setSelectedTaskId(null)}
            />
          </div>
        </div>
      )}
    </div>
  );
}
