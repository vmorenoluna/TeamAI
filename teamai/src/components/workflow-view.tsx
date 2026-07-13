'use client';

import { useState, useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { usePhaseSync } from '@/hooks/use-phase-sync';
import { TaskModal } from './task-modal';
import { PIPELINE_PHASES } from '@/constants/phases';
import type { WorkflowTask } from '@/app/actions/workflow';

// ── Layout constants ─────────────────────────────────────────────────────────

const DIAGRAM_PANEL_W = 420;
const POPOVER_W = 260;
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
  ['backlog', 'spec'], ['spec', 'plan'], ['plan', 'implement'], ['implement', 'qa-review'],
  ['qa-review', 'awaiting-review'], ['awaiting-review', 'merge'], ['awaiting-review', 'create-pr'],
  ['merge', 'done'], ['create-pr', 'pr-open'], ['pr-open', 'done'],
];

const BACKWARD_TRANSITIONS: [string, string][] = [['qa-review', 'implement'], ['pr-open', 'implement']];
const REQUEST_CHANGES_TRANSITIONS: [string, string][] = [['awaiting-review', 'implement']];
const SPEC_REVISION_TRANSITIONS: [string, string][] = [['awaiting-review', 'spec']];
const FAILURE_TRANSITIONS: [string, string][] = [['implement', 'failed'], ['qa-review', 'failed']];

// ── Helpers ──────────────────────────────────────────────────────────────────

function phaseIndex(phase: string): number { return PIPELINE_PHASES.findIndex(p => p.phase === phase); }
function nodeY(idx: number): number { return idx * PITCH; }
function nodeCenterY(idx: number): number { return nodeY(idx) + NODE_H / 2; }

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
    <div onClick={onClick} className={`rounded-lg border px-3 py-2 text-xs transition-colors cursor-pointer ${wt.qaBounces > 0 ? 'border-amber-500/40 bg-amber-500/5 hover:border-amber-500/60' : 'border-slate-700 bg-slate-800/30 hover:border-slate-600'}`}>
      <div className="font-medium text-slate-200 truncate" title={wt.task.title}>{wt.task.title}</div>
      <div className="flex items-center gap-3 mt-1 text-[10px] text-slate-500">
        {wt.qaBounces > 0 && (
          <span className="flex items-center gap-1 text-amber-400" title={`${wt.qaBounces} QA bounce${wt.qaBounces !== 1 ? 's' : ''}`}>
            <span className="inline-block w-1.5 h-1.5 rounded-full bg-amber-500/60" />{wt.qaBounces}x QA
          </span>
        )}
        {wt.enteredPhaseAt && (<span>{timeInPhase(wt.enteredPhaseAt)}</span>)}
      </div>
    </div>
  );
}

function PhasePopover({ label, tasks, popoverStyle, onSelectTask }: {
  label: string; tasks: WorkflowTask[]; popoverStyle: React.CSSProperties; onSelectTask: (id: string) => void;
}) {
  return (
    <div className="absolute z-20" style={{ ...popoverStyle, width: POPOVER_W }} onMouseEnter={e => { e.stopPropagation(); }}>
      <div className="bg-[#1e2333] rounded-lg border border-[#334155] shadow-xl shadow-black/40 overflow-hidden animate-fade-in">
        <div className="px-3 py-2 border-b border-[#1e293b]">
          <div className="flex items-center gap-2">
            <h3 className="text-xs font-semibold text-white">{label}</h3>
            <span className="text-[10px] text-slate-500">{tasks.length} ticket{tasks.length !== 1 ? 's' : ''}</span>
          </div>
        </div>
        <div className="p-2 space-y-1.5 max-h-72 overflow-y-auto">
          {tasks.length > 0 ? tasks.map(wt => (<TaskCard key={wt.task.id} wt={wt} onClick={() => onSelectTask(wt.task.id)} />))
            : (<p className="text-xs text-slate-500 px-2 py-4 text-center">No tickets currently in this phase.</p>)}
        </div>
      </div>
    </div>
  );
}

// ── Main component ───────────────────────────────────────────────────────────

interface Props { workflowTasks: WorkflowTask[]; projectPath: string; }

export function WorkflowView({ workflowTasks, projectPath }: Props) {
  usePhaseSync({ project: projectPath });

  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [hoveredPhase, setHoveredPhase] = useState<string | null>(null);
  const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => { return () => { if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current); }; }, []);

  function handlePhaseEnter(phase: string) {
    if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
    hoverTimerRef.current = setTimeout(() => setHoveredPhase(phase), 180);
  }
  function handlePhaseLeave() { if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current); setHoveredPhase(null); }

  const { tasksByPhase, otherTasks } = useMemo(() => {
    const byPhase = new Map<string, WorkflowTask[]>();
    const other: WorkflowTask[] = [];
    for (const phase of PIPELINE_PHASES) byPhase.set(phase.phase, []);
    for (const wt of workflowTasks) {
      const existing = byPhase.get(wt.task.phase);
      if (existing) existing.push(wt); else other.push(wt);
    }
    return { tasksByPhase: byPhase, otherTasks: other };
  }, [workflowTasks]);

  const totalRows = otherTasks.length > 0 ? PIPELINE_PHASES.length + 1 : PIPELINE_PHASES.length;
  const diagramHeight = totalRows * PITCH;

  const [hoveredTransition, setHoveredTransition] = useState<string | null>(null);

  function renderArrows(): React.ReactNode[] {
    const arrows: React.ReactNode[] = [];
    const arrowKey = (from: string, to: string) => `${from}→${to}`;
    const isHovered = (key: string) => hoveredTransition === key;

    const addStraightArrow = (from: string, to: string, baseClass: string, hoverClass: string) => {
      const fi = phaseIndex(from); const ti = phaseIndex(to);
      if (fi < 0 || ti < 0) return;
      const key = arrowKey(from, to); const h = isHovered(key);
      arrows.push(
        <g key={key}>
          <line x1={CENTER_X} y1={nodeY(fi) + NODE_H} x2={CENTER_X} y2={nodeY(ti) - 6} stroke="transparent" strokeWidth="14" className="cursor-pointer" onMouseEnter={() => setHoveredTransition(key)} onMouseLeave={() => setHoveredTransition(null)} />
          <line x1={CENTER_X} y1={nodeY(fi) + NODE_H} x2={CENTER_X} y2={nodeY(ti) - 6} className={`transition-all duration-200 ${baseClass} ${h ? hoverClass : ''}`} markerEnd={h ? 'url(#arrow-down-hover)' : 'url(#arrow-down)'} />
        </g>);
    };

    const addRightCurve = (from: string, to: string, baseClass: string, hoverClass: string) => {
      const fi = phaseIndex(from); const ti = phaseIndex(to);
      if (fi < 0 || ti < 0) return;
      const sy = nodeCenterY(fi); const ty = nodeCenterY(ti); const cx = RIGHT_X + CURVE_OFFSET;
      const key = arrowKey(from, to); const h = isHovered(key);
      const d = `M ${RIGHT_X + 2},${sy} C ${cx},${sy} ${cx},${ty} ${RIGHT_X + 6},${ty}`;
      arrows.push(
        <g key={key}>
          <path d={d} fill="none" stroke="transparent" strokeWidth="14" className="cursor-pointer" onMouseEnter={() => setHoveredTransition(key)} onMouseLeave={() => setHoveredTransition(null)} />
          <path d={d} fill="none" className={`transition-all duration-200 ${baseClass} ${h ? hoverClass : ''}`} markerEnd={h ? 'url(#arrow-right-hover)' : 'url(#arrow-right)'} />
        </g>);
    };

    const addLeftCurve = (from: string, to: string, baseClass: string, hoverClass: string, marker: string, markerHover: string, label?: string, textFill?: string, labelX?: number) => {
      const fi = phaseIndex(from); const ti = phaseIndex(to);
      if (fi < 0 || ti < 0) return;
      const sy = nodeCenterY(fi); const ty = nodeCenterY(ti); const cx = LEFT_X - CURVE_OFFSET;
      const midY = (sy + ty) / 2; const lx = labelX ?? cx - 10;
      const key = arrowKey(from, to); const h = isHovered(key);
      const d = `M ${LEFT_X - 2},${sy} C ${cx},${sy} ${cx},${ty} ${LEFT_X},${ty}`;
      arrows.push(
        <g key={key}>
          <path d={d} fill="none" stroke="transparent" strokeWidth="14" className="cursor-pointer" onMouseEnter={() => setHoveredTransition(key)} onMouseLeave={() => setHoveredTransition(null)} />
          <path d={d} fill="none" className={`transition-all duration-200 ${baseClass} ${h ? hoverClass : ''}`} markerEnd={`url(#${h ? markerHover : marker})`} />
        </g>);
      if (label) { arrows.push(<text key={`${key}-label`} x={lx} y={midY} fill={h ? (textFill ?? '#94a3b8') : (textFill ?? '#94a3b8')} textAnchor="middle" dominantBaseline="central" className={`text-[9px] font-medium transition-all duration-200 ${h ? 'opacity-100' : 'opacity-60'}`}>{label}</text>); }
    };

    for (const [from, to] of FORWARD_TRANSITIONS) {
      const fi = phaseIndex(from); const ti = phaseIndex(to);
      if (fi < 0 || ti < 0) continue;
      if (ti === fi + 1) addStraightArrow(from, to, 'stroke-slate-600 stroke-[1.5]', 'stroke-slate-400 stroke-[2.5] drop-shadow-[0_0_6px_rgba(148,163,184,0.3)]');
      else addRightCurve(from, to, 'stroke-slate-600 stroke-[1.5]', 'stroke-slate-400 stroke-[2.5] drop-shadow-[0_0_6px_rgba(148,163,184,0.3)]');
    }

    let bounceLabelIdx = 0;
    for (const [from, to] of BACKWARD_TRANSITIONS) {
      const staggerX = (LEFT_X - CURVE_OFFSET - 55) + bounceLabelIdx * 16;
      addLeftCurve(from, to, 'stroke-amber-500/60 stroke-[1.5] stroke-dasharray-[4_4]', 'stroke-amber-400 stroke-[2.5] stroke-dasharray-[4_4] drop-shadow-[0_0_8px_rgba(245,158,11,0.4)]', 'arrow-left-amber', 'arrow-left-amber-hover', 'bounce back', '#f59e0b99', staggerX);
      bounceLabelIdx++;
    }

    for (const [from, to] of REQUEST_CHANGES_TRANSITIONS) {
      addLeftCurve(from, to, 'stroke-orange-500/60 stroke-[1.5] stroke-dasharray-[4_4]', 'stroke-orange-400 stroke-[2.5] stroke-dasharray-[4_4] drop-shadow-[0_0_8px_rgba(249,115,22,0.4)]', 'arrow-left-orange', 'arrow-left-orange-hover', 'request changes', '#f9731699', (LEFT_X - CURVE_OFFSET) - 58);
    }

    let failLabelIdx = 0;
    for (const [from, to] of FAILURE_TRANSITIONS) {
      const staggerX = (LEFT_X - CURVE_OFFSET - 60) + failLabelIdx * 16;
      addLeftCurve(from, to, 'stroke-red-500/50 stroke-[1.5] stroke-dasharray-[4_4]', 'stroke-red-400 stroke-[2.5] stroke-dasharray-[4_4] drop-shadow-[0_0_8px_rgba(239,68,68,0.4)]', 'arrow-left-red', 'arrow-left-red-hover', 'max attempts', '#ef444488', staggerX);
      failLabelIdx++;
    }

    for (const [from, to] of SPEC_REVISION_TRANSITIONS) {
      addLeftCurve(from, to, 'stroke-indigo-500/60 stroke-[1.5] stroke-dasharray-[4_4]', 'stroke-indigo-400 stroke-[2.5] stroke-dasharray-[4_4] drop-shadow-[0_0_8px_rgba(99,102,241,0.4)]', 'arrow-left-indigo', 'arrow-left-indigo-hover', 'spec revision', '#818cf899', (LEFT_X - CURVE_OFFSET) - 58);
    }

    return arrows;
  }

  const diagramRef = useRef<HTMLDivElement>(null);
  const [popoverStyle, setPopoverStyle] = useState<React.CSSProperties>({ top: 0, left: NODE_W + 12 });
  const isEmpty = workflowTasks.length === 0;

  useLayoutEffect(() => {
    if (!hoveredPhase) return;
    const idx = hoveredPhase === '__other__' ? PIPELINE_PHASES.length : phaseIndex(hoveredPhase);
    if (idx < 0) return;
    const containerEl = diagramRef.current;
    if (!containerEl) return;
    const containerRect = containerEl.getBoundingClientRect();
    const nodeTop = containerRect.top + nodeY(idx);
    const nodeRight = containerRect.left + LEFT_MARGIN + NODE_W;
    const overflowRight = nodeRight + 12 + POPOVER_W > window.innerWidth;
    const left = overflowRight ? -(POPOVER_W + 12) : NODE_W + 12;
    const taskCount = hoveredPhase === '__other__' ? otherTasks.length : (tasksByPhase.get(hoveredPhase)?.length ?? 0);
    const popoverEstH = taskCount === 0 ? 100 : 52 + Math.min(taskCount * 54, 288);
    const popoverBottom = nodeTop + popoverEstH;
    const top = popoverBottom > window.innerHeight - 8 ? -(popoverBottom - window.innerHeight + 8) : 0;
    setPopoverStyle({ top, left });
  }, [hoveredPhase, otherTasks.length, tasksByPhase]);

  return (
    <div className="flex flex-col h-full bg-[#11131b]">
      <div className="shrink-0 flex items-center justify-between px-6 py-4 border-b border-[#1e293b] bg-[#11131b]">
        <div>
          <h1 className="text-base font-semibold text-white">Workflow</h1>
          <p className="text-xs text-slate-400 mt-0.5">Pipeline state diagram — hover over a phase to see its tickets.</p>
        </div>
        <div className="flex items-center gap-3 text-xs text-slate-500">
          <span className="flex items-center gap-1"><span className="inline-block w-2 h-0.5 bg-amber-500/60 rounded" />bounce</span>
          <span className="flex items-center gap-1"><span className="inline-block w-2 h-0.5 bg-orange-500/60 rounded" />request changes</span>
          <span className="flex items-center gap-1"><span className="inline-block w-2 h-0.5 bg-indigo-500/60 rounded" />spec revision</span>
          <span className="flex items-center gap-1"><span className="inline-block w-2 h-0.5 bg-red-500/50 rounded" />failure</span>
        </div>
      </div>

      <div className={`flex-1 ${selectedTaskId ? 'overflow-hidden pointer-events-none select-none' : ''}`} onMouseLeave={() => { handlePhaseLeave(); setHoveredTransition(null); }}>
        <div className="flex justify-center pt-6 pb-12">
          <div ref={diagramRef} className="relative overflow-visible shrink-0" style={{ width: DIAGRAM_PANEL_W, height: diagramHeight }}>
            {isEmpty ? (
              <div className="flex items-center justify-center h-full text-sm text-slate-500">No tickets yet — create one from the Board.</div>
            ) : (
              <>
                <svg className="absolute inset-0 overflow-visible" width={RIGHT_X + CURVE_OFFSET + 10} height={diagramHeight}>
                  <defs>
                    <marker id="arrow-down" viewBox="0 0 10 10" refX="5" refY="0" markerWidth="6" markerHeight="6" markerUnits="userSpaceOnUse"><polygon points="0,0 5,10 10,0" className="fill-slate-600" /></marker>
                    <marker id="arrow-down-hover" viewBox="0 0 10 10" refX="5" refY="0" markerWidth="6" markerHeight="6" markerUnits="userSpaceOnUse"><polygon points="0,0 5,10 10,0" className="fill-slate-400" /></marker>
                    <marker id="arrow-right" viewBox="0 0 10 10" refX="0" refY="5" markerWidth="6" markerHeight="6" markerUnits="userSpaceOnUse"><polygon points="0,5 10,0 10,10" className="fill-slate-600" /></marker>
                    <marker id="arrow-right-hover" viewBox="0 0 10 10" refX="0" refY="5" markerWidth="6" markerHeight="6" markerUnits="userSpaceOnUse"><polygon points="0,5 10,0 10,10" className="fill-slate-400" /></marker>
                    <marker id="arrow-left-amber" viewBox="0 0 10 10" refX="10" refY="5" markerWidth="6" markerHeight="6" markerUnits="userSpaceOnUse"><polygon points="0,0 10,5 0,10" className="fill-amber-500/60" /></marker>
                    <marker id="arrow-left-amber-hover" viewBox="0 0 10 10" refX="10" refY="5" markerWidth="6" markerHeight="6" markerUnits="userSpaceOnUse"><polygon points="0,0 10,5 0,10" className="fill-amber-400" /></marker>
                    <marker id="arrow-left-orange" viewBox="0 0 10 10" refX="10" refY="5" markerWidth="6" markerHeight="6" markerUnits="userSpaceOnUse"><polygon points="0,0 10,5 0,10" className="fill-orange-500/60" /></marker>
                    <marker id="arrow-left-orange-hover" viewBox="0 0 10 10" refX="10" refY="5" markerWidth="6" markerHeight="6" markerUnits="userSpaceOnUse"><polygon points="0,0 10,5 0,10" className="fill-orange-400" /></marker>
                    <marker id="arrow-left-red" viewBox="0 0 10 10" refX="10" refY="5" markerWidth="6" markerHeight="6" markerUnits="userSpaceOnUse"><polygon points="0,0 10,5 0,10" className="fill-red-500/50" /></marker>
                    <marker id="arrow-left-red-hover" viewBox="0 0 10 10" refX="10" refY="5" markerWidth="6" markerHeight="6" markerUnits="userSpaceOnUse"><polygon points="0,0 10,5 0,10" className="fill-red-400" /></marker>
                    <marker id="arrow-left-indigo" viewBox="0 0 10 10" refX="10" refY="5" markerWidth="6" markerHeight="6" markerUnits="userSpaceOnUse"><polygon points="0,0 10,5 0,10" className="fill-indigo-500/60" /></marker>
                    <marker id="arrow-left-indigo-hover" viewBox="0 0 10 10" refX="10" refY="5" markerWidth="6" markerHeight="6" markerUnits="userSpaceOnUse"><polygon points="0,0 10,5 0,10" className="fill-indigo-400" /></marker>
                  </defs>
                  {renderArrows()}
                </svg>

                {PIPELINE_PHASES.map((phase, idx) => {
                  const tasks = tasksByPhase.get(phase.phase) ?? [];
                  const hasTasks = tasks.length > 0;
                  const hasActive = tasks.some(wt => wt.isActive);
                  const isHovered = hoveredPhase === phase.phase;
                  return (
                    <div key={phase.phase} className={`absolute rounded-lg transition-all duration-150 ${hasActive ? 'animate-pulse-glow' : ''}`} style={{ top: nodeY(idx), left: LEFT_MARGIN, width: NODE_W, height: NODE_H }} onMouseEnter={() => handlePhaseEnter(phase.phase)} onMouseLeave={handlePhaseLeave}>
                      <div className={`h-full flex items-center px-3 rounded-lg border-2 text-xs font-semibold cursor-pointer transition-all ${hasTasks ? `${phase.color} text-white border-opacity-100` : 'border-slate-700 bg-slate-800/50 text-slate-500'} ${isHovered ? 'scale-105 shadow-lg shadow-black/30' : ''}`}>
                        <div className="flex items-center justify-between"><span>{phase.label}</span>{hasTasks && (<span className={`ml-2 px-1.5 py-0.5 rounded-full text-[10px] font-bold ${isHovered ? 'bg-white/20 text-white' : 'bg-slate-700/50 text-slate-400'}`}>{tasks.length}</span>)}</div>
                      </div>
                      {isHovered && (<PhasePopover label={phase.label} tasks={tasks} popoverStyle={popoverStyle} onSelectTask={setSelectedTaskId} />)}
                    </div>);
                })}

                {otherTasks.length > 0 && (
                  <div key="other" className={`absolute rounded-lg transition-all duration-150 ${otherTasks.some(wt => wt.isActive) ? 'animate-pulse-glow' : ''}`} style={{ top: nodeY(PIPELINE_PHASES.length), left: LEFT_MARGIN, width: NODE_W, height: NODE_H }} onMouseEnter={() => handlePhaseEnter('__other__')} onMouseLeave={handlePhaseLeave}>
                    <div className={`h-full flex items-center px-3 rounded-lg border-2 border-dashed border-slate-600 bg-slate-800/40 text-xs font-semibold text-slate-400 cursor-pointer transition-all ${hoveredPhase === '__other__' ? 'scale-105 shadow-lg shadow-black/30' : ''}`}>
                      <div className="flex items-center justify-between"><span>Other</span><span className={`ml-2 px-1.5 py-0.5 rounded-full text-[10px] font-bold ${hoveredPhase === '__other__' ? 'bg-white/20 text-white' : 'bg-slate-700/50 text-slate-400'}`}>{otherTasks.length}</span></div>
                    </div>
                    {hoveredPhase === '__other__' && (<PhasePopover label="Other" tasks={otherTasks} popoverStyle={popoverStyle} onSelectTask={setSelectedTaskId} />)}
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      </div>

      {selectedTaskId && (
        <TaskModal taskId={selectedTaskId} onClose={() => setSelectedTaskId(null)} />
      )}
    </div>
  );
}
