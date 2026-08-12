'use client';

import { useState, useEffect, useCallback } from 'react';
import { saveContainerConfig, resetDockerAvailability } from '@/app/actions/containers';

interface Props {
  projectPath: string | null;
}

/** Dialog shown when container mode is enabled but Docker is not running.
 *  Listens for the container-docker-missing WebSocket event and offers
 *  two resolutions: disable container mode, or acknowledge Docker is now running. */
export function ContainerDockerMissingDialog({ projectPath }: Props) {
  const [visible, setVisible] = useState(false);
  const [resolving, setResolving] = useState(false); // disable-container-mode in flight
  const [dockerChecking, setDockerChecking] = useState(false); // cache-reset in flight

  // Listen for container-docker-missing WebSocket events
  const handleMessage = useCallback((e: MessageEvent) => {
    try {
      const msg = JSON.parse(e.data);
      if (msg.type === 'container-docker-missing' && msg.projectRoot === projectPath) {
        setVisible(true);
      }
    } catch { /* ignore malformed messages */ }
  }, [projectPath]);

  useEffect(() => {
    if (!projectPath) return;
    const ws = new WebSocket(
      `ws://${window.location.host}/ws?project=${encodeURIComponent(projectPath)}`
    );
    ws.addEventListener('message', handleMessage);
    return () => {
      ws.removeEventListener('message', handleMessage);
      if (ws.readyState === WebSocket.CONNECTING) {
        ws.addEventListener('open', () => ws.close());
      } else {
        ws.close();
      }
    };
  }, [projectPath, handleMessage]);

  async function disableContainerMode() {
    setResolving(true);
    try {
      await saveContainerConfig({ enabled: false });
      setVisible(false);
    } catch {
      // Keep dialog open on error so the user can try the other option
    } finally {
      setResolving(false);
    }
  }

  async function dockerStarted() {
    setDockerChecking(true);
    try {
      await resetDockerAvailability();
      setVisible(false);
    } catch {
      // Keep dialog open on error so the user can retry
    } finally {
      setDockerChecking(false);
    }
  }

  if (!visible || !projectPath) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div
        className="absolute inset-0 bg-black/60"
        onClick={() => setVisible(false)}
      />
      <div className="relative bg-[#1e2333] rounded-xl shadow-2xl shadow-amber-950/30 border border-amber-800/40 p-6 w-full max-w-md mx-4 animate-modal-in">
        {/* Icon + Title */}
        <div className="flex items-start gap-3 mb-4">
          <div className="shrink-0 w-10 h-10 rounded-full bg-amber-900/30 border border-amber-700/30 flex items-center justify-center text-lg">
            🐳
          </div>
          <div>
            <h2 className="text-base font-semibold text-amber-300">
              Docker Not Running
            </h2>
            <p className="mt-1 text-sm text-slate-400 leading-relaxed">
              Container mode is enabled for this project, but Docker is not
              running. TeamAI cannot start or resume tasks without the container
              environment.
            </p>
          </div>
        </div>

        {/* Action hint */}
        <p className="text-xs text-slate-500 mb-4 pl-[52px]">
          Start Docker Desktop and wait for it to be ready, or disable container
          mode to run tasks directly on your host machine.
        </p>

        {/* Actions */}
        <div className="flex gap-3 justify-end">
          <button
            onClick={disableContainerMode}
            disabled={resolving || dockerChecking}
            className="px-4 py-2 text-sm text-slate-300 border border-[#334155] rounded-lg bg-[#1a1f2e] hover:bg-[#252b3b] hover:border-[#475569] transition-colors disabled:opacity-50"
          >
            {resolving ? 'Disabling…' : 'Disable Container Mode'}
          </button>
          <button
            onClick={dockerStarted}
            disabled={resolving || dockerChecking}
            className="px-4 py-2 text-sm font-medium bg-amber-700 text-white rounded-lg hover:bg-amber-600 transition-colors disabled:opacity-50"
          >
            {dockerChecking ? (
              <span className="inline-flex items-center gap-1.5">
                <svg className="animate-spin h-3.5 w-3.5" viewBox="0 0 24 24" fill="none">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
                Checking Docker…
              </span>
            ) : (
              <>I&apos;ve Started Docker</>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
