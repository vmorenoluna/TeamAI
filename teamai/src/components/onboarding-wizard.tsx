'use client';

import { useState, useCallback } from 'react';
import { checkTools } from '@/app/actions/tools';
import { addProject } from '@/app/actions/projects';
import { completeOnboarding } from '@/app/actions/onboarding';
import { useServerMutation } from '@/hooks/use-server-mutation';
import { DirectoryBrowser } from './directory-browser';
import { formatActionError } from '@/lib/error-format';
import type { ToolStatus } from '@/lib/tool-checker';

// ── Types ──────────────────────────────────────────────────────────────────

type Step = 'welcome' | 'tools' | 'project' | 'done';

const STEPS: { key: Step; label: string }[] = [
  { key: 'welcome', label: 'Welcome' },
  { key: 'tools', label: 'Prerequisites' },
  { key: 'project', label: 'Add Project' },
  { key: 'done', label: 'Ready' },
];

const TOOL_ORDER: Record<string, number> = {
  claude: 0, git: 1, gh: 2, docker: 3, devcontainer: 4,
};

function sortTools(tools: ToolStatus[]): ToolStatus[] {
  return [...tools].sort((a, b) => (TOOL_ORDER[a.name] ?? 99) - (TOOL_ORDER[b.name] ?? 99));
}

// ── Component ──────────────────────────────────────────────────────────────

export function OnboardingWizard() {
  const [step, setStep] = useState<Step>('welcome');
  const stepIndex = STEPS.findIndex(s => s.key === step);

  // ── Tools step state ──────────────────────────────────────────────────
  const [tools, setTools] = useState<ToolStatus[]>([]);
  const [toolsLoading, setToolsLoading] = useState(false);
  const [toolsError, setToolsError] = useState<string | null>(null);
  const [toolsFetched, setToolsFetched] = useState(false);

  // ── Project step state ────────────────────────────────────────────────
  const [pathValue, setPathValue] = useState('');
  const [showBrowser, setShowBrowser] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);

  const { run, isPending } = useServerMutation();

  // ── Tool check ────────────────────────────────────────────────────────

  const fetchTools = useCallback(async () => {
    setToolsLoading(true);
    setToolsError(null);
    try {
      const result = await checkTools();
      setTools(sortTools(result));
      setToolsFetched(true);
    } catch (err) {
      setToolsError(formatActionError('check tools', err));
    } finally {
      setToolsLoading(false);
    }
  }, []);

  // Auto-fetch tools when arriving at tools step
  function goToStep(next: Step) {
    setStep(next);
    if (next === 'tools' && !toolsFetched) {
      fetchTools();
    }
  }

  // ── Project registration ──────────────────────────────────────────────

  function handleAddProject(formData: FormData) {
    setAddError(null);
    run(async () => {
      try {
        const result = await addProject(formData);
        if ('error' in result) {
          setAddError(result.error);
          throw new Error(result.error);
        }
        setStep('done');
      } catch (err) {
        if (err instanceof Error && err.message) {
          setAddError(err.message);
        }
        throw err;
      }
    });
  }

  function handleBrowseSelect(path: string) {
    setPathValue(path);
    setShowBrowser(false);
  }

  // ── Completion ────────────────────────────────────────────────────────

  function handleFinish() {
    run(async () => {
      await completeOnboarding();
    });
  }

  // ── Derived state ─────────────────────────────────────────────────────

  const criticalMissing = tools.filter(t => !t.found && (t.name === 'claude' || t.name === 'git'));
  const canProceedFromTools = toolsFetched && criticalMissing.length === 0;

  // ── Render ────────────────────────────────────────────────────────────

  return (
    <>
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" />

      {/* Wizard card */}
      <div className="relative bg-[#1e2333] rounded-xl shadow-2xl shadow-black/40 border border-[#1e293b] w-full max-w-lg mx-4 animate-modal-in overflow-hidden">
        {/* Step indicators */}
        <div className="flex items-center gap-1 px-6 pt-5 pb-0">
          {STEPS.map((s, i) => (
            <div key={s.key} className="flex items-center gap-1 flex-1 last:flex-[0]">
              <div
                className={`w-6 h-6 rounded-full flex items-center justify-center text-[10px] font-semibold shrink-0 transition-colors ${
                  i < stepIndex
                    ? 'bg-green-900/40 text-green-400 border border-green-700/50'
                    : i === stepIndex
                      ? 'bg-[#2563eb] text-white'
                      : 'bg-[#1e293b] text-slate-600 border border-[#334155]'
                }`}
              >
                {i < stepIndex ? '✓' : i + 1}
              </div>
              {i < STEPS.length - 1 && (
                <div
                  className={`flex-1 h-0.5 rounded ${
                    i < stepIndex ? 'bg-green-700/50' : 'bg-[#1e293b]'
                  }`}
                />
              )}
            </div>
          ))}
        </div>
        <div className="flex justify-between px-6 mt-2 mb-0">
          {STEPS.map(s => (
            <span
              key={s.key}
              className={`text-[10px] font-medium transition-colors ${
                STEPS.findIndex(st => st.key === s.key) <= stepIndex
                  ? 'text-slate-400'
                  : 'text-slate-700'
              }`}
            >
              {s.label}
            </span>
          ))}
        </div>

        <div className="p-6">
          {/* ── Step 1: Welcome ────────────────────────────────────────── */}
          {step === 'welcome' && (
            <div className="text-center space-y-4">
              <div className="text-4xl mb-2">🤖</div>
              <h2 className="text-xl font-bold text-white">Welcome to TeamAI</h2>
              <p className="text-sm text-slate-400 leading-relaxed max-w-sm mx-auto">
                TeamAI orchestrates multiple Claude Code agents through automated
                software development pipelines — from spec to merge, in parallel.
              </p>
              <div className="bg-[#1a1f2e] border border-[#334155] rounded-lg p-3 text-left space-y-2">
                <p className="text-xs text-slate-300">
                  <span className="font-semibold text-white">We&apos;ll help you:</span>
                </p>
                <ul className="text-xs text-slate-400 space-y-1.5 list-disc list-inside">
                  <li>Verify the CLI tools TeamAI needs are installed</li>
                  <li>Register your first project</li>
                  <li>Get you ready to run your first pipeline</li>
                </ul>
              </div>
            </div>
          )}

          {/* ── Step 2: Prerequisites (Tool Checks) ────────────────────── */}
          {step === 'tools' && (
            <div className="space-y-4">
              <div>
                <h2 className="text-base font-semibold text-white">Prerequisites</h2>
                <p className="text-xs text-slate-400 mt-1">
                  TeamAI relies on these CLI tools. Claude CLI and Git are required;
                  GitHub CLI and Docker are optional but recommended.
                </p>
              </div>

              {toolsError && (
                <div role="alert" className="p-2.5 bg-red-900/30 border border-red-800/50 rounded-lg flex items-start justify-between gap-2">
                  <p className="text-xs text-red-300 flex-1">{toolsError}</p>
                  <button onClick={() => setToolsError(null)} aria-label="Dismiss error" className="text-red-500 hover:text-red-300 text-sm leading-none transition-colors">✕</button>
                </div>
              )}

              {toolsLoading && tools.length === 0 ? (
                <div className="text-xs text-slate-500 animate-pulse py-4 text-center">
                  Checking installed tools…
                </div>
              ) : tools.length > 0 ? (
                <div className="border border-[#1e293b] rounded-lg overflow-hidden">
                  {tools.map(t => (
                    <div
                      key={t.name}
                      className={`px-4 py-2.5 border-b border-[#1e293b] last:border-b-0 flex items-center gap-3 ${
                        !t.found ? 'bg-red-900/10' : ''
                      }`}
                    >
                      <span
                        className={`shrink-0 w-2 h-2 rounded-full ${
                          t.found ? 'bg-green-500' : 'bg-red-500'
                        }`}
                      />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="text-xs font-medium text-slate-200">
                            {t.label}
                          </span>
                          {(t.name === 'claude' || t.name === 'git') && (
                            <span className="text-[10px] font-semibold uppercase text-amber-400">
                              required
                            </span>
                          )}
                          {t.name === 'gh' && (
                            <span className="text-[10px] font-semibold uppercase text-slate-500">
                              recommended
                            </span>
                          )}
                          {t.found && t.version && (
                            <span className="text-[10px] text-slate-600 truncate max-w-[200px]" title={t.version}>
                              {t.version.slice(0, 60)}
                            </span>
                          )}
                        </div>
                        {!t.found && t.error && (
                          <p className="text-[10px] text-red-400 mt-0.5">{t.error}</p>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              ) : null}

              <button
                onClick={fetchTools}
                disabled={toolsLoading}
                className="px-3 py-1.5 text-xs text-slate-400 hover:text-slate-200 border border-[#334155] hover:border-[#475569] rounded transition-colors disabled:opacity-40"
              >
                {toolsLoading ? 'Checking…' : 'Recheck'}
              </button>

              {/* Claude auth note */}
              <div className="p-3 rounded-lg border border-amber-800/40 bg-amber-900/10">
                <p className="text-xs text-amber-300/80 leading-relaxed">
                  <span className="font-semibold text-amber-300">Claude CLI Auth:</span>{' '}
                  TeamAI spawns Claude CLI terminal sessions — authentication is handled
                  by the CLI itself, not by API keys. If you haven&apos;t already, run{' '}
                  <code className="text-[11px] bg-amber-900/30 px-1 py-0.5 rounded text-amber-200">
                    claude login
                  </code>{' '}
                  in your terminal before running your first pipeline task.
                </p>
              </div>

              {toolsFetched && criticalMissing.length > 0 && (
                <p className="text-xs text-red-400">
                  Claude CLI and Git are required to continue. Install them and click Recheck.
                </p>
              )}
            </div>
          )}

          {/* ── Step 3: Add Project ────────────────────────────────────── */}
          {step === 'project' && (
            <div className="space-y-4">
              <div>
                <h2 className="text-base font-semibold text-white">Add Your First Project</h2>
                <p className="text-xs text-slate-400 mt-1">
                  Register a git repository for TeamAI to work on. TeamAI will
                  scaffold the necessary config files automatically.
                </p>
              </div>

              <form id="onboarding-add-project-form" action={handleAddProject} className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-slate-300 mb-1">
                    Project Path
                  </label>
                  <div className="flex gap-2">
                    <input
                      name="path"
                      required
                      value={pathValue}
                      onChange={e => setPathValue(e.target.value)}
                      placeholder="/home/user/my-project"
                      className="flex-1 min-w-0 px-3 py-2 text-sm border border-[#334155] rounded-lg bg-[#11131b] text-white focus:outline-none focus:ring-2 focus:ring-[#2563eb] placeholder-slate-500"
                    />
                    <button
                      type="button"
                      onClick={() => setShowBrowser(true)}
                      className="px-3 py-2 text-sm border border-[#334155] rounded-lg bg-[#1a1f2e] text-slate-300 hover:bg-[#1e293b] transition-colors shrink-0"
                    >
                      Browse
                    </button>
                  </div>
                </div>

                <div>
                  <label className="block text-sm font-medium text-slate-300 mb-1">
                    Project Name{' '}
                    <span className="font-normal text-slate-500">(optional)</span>
                  </label>
                  <input
                    name="name"
                    placeholder="My Project"
                    className="w-full px-3 py-2 text-sm border border-[#334155] rounded-lg bg-[#11131b] text-white focus:outline-none focus:ring-2 focus:ring-[#2563eb] placeholder-slate-500"
                  />
                </div>

                <p className="text-xs text-slate-500 leading-relaxed">
                  TeamAI will create{' '}
                  <code className="text-[11px] bg-[#1e293b] px-1 py-0.5 rounded">.claude/</code>{' '}
                  (roles, commands) and{' '}
                  <code className="text-[11px] bg-[#1e293b] px-1 py-0.5 rounded">.teamai/</code>{' '}
                  (config) directories inside your project. Nothing is overwritten — existing
                  files are preserved.
                </p>
              </form>

              {addError && (
                <p className="text-sm text-red-400">{addError}</p>
              )}
            </div>
          )}

          {/* ── Step 4: Done ───────────────────────────────────────────── */}
          {step === 'done' && (
            <div className="text-center space-y-4">
              <div className="text-4xl mb-2">🚀</div>
              <h2 className="text-xl font-bold text-white">You&apos;re All Set!</h2>

              <div className="bg-[#1a1f2e] border border-[#334155] rounded-lg p-4 text-left space-y-3">
                {tools.length > 0 ? (
                  <div className="flex items-center gap-2">
                    <span className="text-green-400 text-sm">✓</span>
                    <span className="text-xs text-slate-300">
                      Required tools detected{' '}
                      <span className="text-slate-500">
                        ({tools.filter(t => t.found).length}/{tools.length} available)
                      </span>
                    </span>
                  </div>
                ) : (
                  <div className="flex items-center gap-2">
                    <span className="text-slate-500 text-sm">○</span>
                    <span className="text-xs text-slate-500">
                      Tool checks skipped — visit Settings → Tool Paths to verify
                    </span>
                  </div>
                )}
                <div className="flex items-center gap-2">
                  <span className="text-green-400 text-sm">✓</span>
                  <span className="text-xs text-slate-300">
                    Project registered
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-green-400 text-sm">✓</span>
                  <span className="text-xs text-slate-300">
                    Config files scaffolded
                  </span>
                </div>
              </div>

              <div className="bg-[#1a1f2e] border border-[#334155] rounded-lg p-3 text-left">
                <p className="text-xs text-slate-400 leading-relaxed">
                  <span className="font-semibold text-white">What&apos;s next?</span>
                  <br />
                  Head to the <span className="text-slate-300">Kanban</span> board,
                  click <span className="text-slate-300">+ New Task</span>, and describe what
                  you want to build. TeamAI will run it through the pipeline — from spec
                  to merge.
                </p>
              </div>
            </div>
          )}
        </div>

        {/* ── Footer: navigation buttons ───────────────────────────────── */}
        <div className="px-6 py-4 border-t border-[#1e293b] bg-[#11131b]/50 flex items-center justify-between">
          <div>
            {step !== 'welcome' && step !== 'done' && (
              <button
                type="button"
                onClick={() => {
                  const prev = STEPS[stepIndex - 1];
                  if (prev) setStep(prev.key);
                }}
                className="px-4 py-2 text-sm text-slate-400 hover:text-white transition-colors"
              >
                ← Back
              </button>
            )}
          </div>

          <div className="flex gap-3">
            {step === 'welcome' && (
              <button
                type="button"
                onClick={() => goToStep('tools')}
                className="px-5 py-2 text-sm font-medium bg-[#2563eb] text-white rounded-lg hover:bg-[#1d4ed8] transition-colors"
              >
                Get Started
              </button>
            )}

            {step === 'tools' && (
              <button
                type="button"
                onClick={() => goToStep('project')}
                disabled={!canProceedFromTools}
                title={
                  !toolsFetched
                    ? 'Tool checks are still running…'
                    : !canProceedFromTools
                      ? 'Claude CLI and Git are required'
                      : undefined
                }
                className="px-5 py-2 text-sm font-medium bg-[#2563eb] text-white rounded-lg hover:bg-[#1d4ed8] disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                Continue
              </button>
            )}

            {step === 'project' && (
              <button
                type="submit"
                form="onboarding-add-project-form"
                disabled={isPending || !pathValue.trim()}
                className="px-5 py-2 text-sm font-medium bg-[#2563eb] text-white rounded-lg hover:bg-[#1d4ed8] disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                {isPending ? 'Adding…' : 'Add Project'}
              </button>
            )}

            {step === 'done' && (
              <button
                type="button"
                onClick={handleFinish}
                disabled={isPending}
                className="px-5 py-2 text-sm font-medium bg-[#2563eb] text-white rounded-lg hover:bg-[#1d4ed8] disabled:opacity-40 transition-colors"
              >
                {isPending ? 'Finishing…' : 'Start Using TeamAI'}
              </button>
            )}

            {/* Skip link on all steps except done */}
            {step !== 'done' && (
              <button
                type="button"
                onClick={handleFinish}
                className="px-3 py-2 text-sm text-slate-600 hover:text-slate-400 transition-colors"
              >
                Skip
              </button>
            )}
          </div>
        </div>
      </div>
    </div>

    {/* Directory Browser — rendered outside the wizard's stacking context (z-50)
        so its own z-index isn't trapped. Matches the project-selector pattern. */}
    {showBrowser && (
      <DirectoryBrowser
        onSelect={handleBrowseSelect}
        onClose={() => setShowBrowser(false)}
      />
    )}
    </>
  );
}
