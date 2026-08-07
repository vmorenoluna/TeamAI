'use client';

import { useState, useTransition, useEffect, useRef } from 'react';
import { saveContainerConfig, getContainerState, getValidationSteps } from '@/app/actions/containers';
import type { ContainerConfig } from '@/app/actions/containers';
import type { ContainerState, ValidationStep } from '@/lib/container-manager';

const STATE_BADGE: Record<ContainerState, { label: string; cls: string }> = {
  stopped:    { label: 'Stopped',      cls: 'bg-slate-700 text-slate-400' },
  generating: { label: 'Generating…',  cls: 'bg-purple-900/40 text-purple-300' },
  starting:   { label: 'Starting…',    cls: 'bg-blue-900/40 text-blue-300' },
  validating: { label: 'Validating…',  cls: 'bg-amber-900/40 text-amber-300' },
  running:    { label: 'Running',      cls: 'bg-green-900/40 text-green-300' },
  restarting: { label: 'Restarting…',  cls: 'bg-amber-900/40 text-amber-300' },
};

function projectTypeLabel(type: string): string {
  if (!type || type === 'unknown' || type === 'generic') return 'project';
  if (type === 'jvm') return 'Java project';
  return type;
}

interface Props {
  config: ContainerConfig & { generated?: boolean; projectType?: string };
  initialState: ContainerState;
  projectPath: string;
}

export function ContainerConfigEditor({ config, initialState, projectPath }: Props) {
  const [enabled, setEnabled] = useState(config.enabled);
  const [state, setState] = useState<ContainerState>(initialState);
  const [generated, setGenerated] = useState(config.generated ?? false);
  const [projectType, setProjectType] = useState(config.projectType ?? '');
  const [isPending, startTransition] = useTransition();
  const [logLines, setLogLines] = useState<string[]>([]);
  const [validationSteps, setValidationSteps] = useState<ValidationStep[]>([]);
  const wsRef = useRef<WebSocket | null>(null);
  const logEndRef = useRef<HTMLDivElement>(null);

  // Auto-scroll log viewer to bottom when new lines arrive
  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [logLines]);

  // Subscribe to live container-state, container-log, and container-validation events
  useEffect(() => {
    const ws = new WebSocket(`ws://${window.location.host}/ws`);
    wsRef.current = ws;
    ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        if (msg.type === 'container-state' && msg.projectRoot === projectPath) {
          setState(msg.state as ContainerState);
        } else if (msg.type === 'container-log' && msg.projectRoot === projectPath) {
          setLogLines(prev => [...prev.slice(-99), msg.message as string]);
        } else if (msg.type === 'container-validation' && msg.projectRoot === projectPath) {
          setValidationSteps(prev => {
            const step = msg.step as ValidationStep;
            const idx = prev.findIndex(s => s.name === step.name);
            if (idx >= 0) {
              const next = [...prev];
              next[idx] = step;
              return next;
            }
            return [...prev, step];
          });
        }
      } catch { /* ignore */ }
    };
    return () => {
      if (ws.readyState === WebSocket.CONNECTING) {
        ws.addEventListener('open', () => ws.close());
      } else {
        ws.close();
      }
    };
  }, [projectPath]);

  // Periodically re-query container state and validation steps
  useEffect(() => {
    let cancelled = false;
    const id = setInterval(async () => {
      try {
        const fresh = await getContainerState();
        if (!cancelled) setState(fresh);
        const steps = await getValidationSteps();
        if (!cancelled && steps.length > 0) setValidationSteps(steps);
      } catch { /* ignore */ }
    }, 3000);
    return () => { cancelled = true; clearInterval(id); };
  }, [projectPath]);

  function toggle() {
    const next = !enabled;
    setEnabled(next);
    setLogLines([]);
    setValidationSteps([]);
    startTransition(async () => {
      const result = await saveContainerConfig({ enabled: next });
      if (result.generated) {
        setGenerated(true);
        setProjectType(result.projectType ?? '');
      }
    });
  }

  const badge = STATE_BADGE[state];
  const isBootstrapPhase = state === 'generating' || state === 'starting' || state === 'validating';

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between p-3 rounded-lg border border-[#1e293b] bg-[#1a1f2e]">
        <div className="space-y-0.5">
          <p className="text-sm font-medium text-slate-200">
            Run agents in devcontainer
          </p>
          <p className="text-xs text-slate-500">
            {generated
              ? `Auto-generated .devcontainer/devcontainer.json for your ${projectTypeLabel(projectType)}. Claude CLI, gh CLI, and git are pre-configured.`
              : 'Requires .devcontainer/devcontainer.json in the project. TeamAI will auto-generate one if missing.'
            }
          </p>
        </div>
        <button
          onClick={toggle}
          disabled={isPending}
          aria-checked={enabled}
          role="switch"
          className={`relative ml-4 inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors focus:outline-none disabled:opacity-50 ${
            enabled ? 'bg-[#2563eb]' : 'bg-[#334155]'
          }`}
        >
          <span
            className={`inline-block h-4 w-4 rounded-full bg-white shadow transition-transform ${
              enabled ? 'translate-x-4' : 'translate-x-0'
            }`}
          />
        </button>
      </div>

      {enabled && (
        <>
          <div className="flex items-center gap-2 px-1">
            <span className="text-xs text-slate-400">Container status:</span>
            <span className={`text-[10px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded ${badge.cls}`}>
              {badge.label}
            </span>
          </div>

          {/* Validation step progress */}
          {validationSteps.length > 0 && (
            <div className="px-1 space-y-1">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">Validation</span>
              {validationSteps.map(step => (
                <div key={step.name} className="flex items-center gap-2 text-xs">
                  <span className={step.status === 'passed' ? 'text-green-400' : step.status === 'failed' ? 'text-red-400' : step.status === 'running' ? 'text-blue-400 animate-pulse' : 'text-slate-600'}>
                    {step.status === 'passed' ? '✓' : step.status === 'failed' ? '✗' : step.status === 'running' ? '▶' : '○'}
                  </span>
                  <span className={step.status === 'failed' ? 'text-red-300' : 'text-slate-400'}>
                    {step.name}
                  </span>
                  {step.status === 'failed' && step.error && (
                    <span className="text-[10px] text-red-500 truncate max-w-[300px]" title={step.error}>
                      — {step.error.slice(0, 80)}{step.error.length > 80 ? '…' : ''}
                    </span>
                  )}
                </div>
              ))}
            </div>
          )}

          {/* Progress log */}
          {isBootstrapPhase && logLines.length > 0 && (
            <div className="px-1">
              <div className="max-h-32 overflow-y-auto rounded bg-[#0d1117] border border-[#1e293b] p-2 font-mono text-[10px] text-slate-400 leading-relaxed">
                {logLines.map((line, i) => (
                  <div key={i} className="whitespace-pre-wrap break-all">{line}</div>
                ))}
                <div ref={logEndRef} />
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
