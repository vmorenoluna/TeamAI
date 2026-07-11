'use client';

import { useState, useEffect, useCallback } from 'react';

/**
 * Play a subtle two-tone chime when the update is ready.
 * Uses Web Audio API — no audio files needed.
 */
function playNotificationSound() {
  try {
    const ctx = new AudioContext();
    const now = ctx.currentTime;

    // First tone (pleasant ding)
    const osc1 = ctx.createOscillator();
    const gain1 = ctx.createGain();
    osc1.type = 'sine';
    osc1.frequency.value = 880; // A5
    gain1.gain.setValueAtTime(0.15, now);
    gain1.gain.exponentialRampToValueAtTime(0.001, now + 0.3);
    osc1.connect(gain1);
    gain1.connect(ctx.destination);
    osc1.start(now);
    osc1.stop(now + 0.3);

    // Second tone (higher, shorter)
    const osc2 = ctx.createOscillator();
    const gain2 = ctx.createGain();
    osc2.type = 'sine';
    osc2.frequency.value = 1108; // C#6
    gain2.gain.setValueAtTime(0.12, now + 0.15);
    gain2.gain.exponentialRampToValueAtTime(0.001, now + 0.45);
    osc2.connect(gain2);
    gain2.connect(ctx.destination);
    osc2.start(now + 0.15);
    osc2.stop(now + 0.45);
  } catch {
    // Silently ignore — Web Audio may not be available in all environments
  }
}

const SOUND_KEY = 'teamai:update-sound-played';

export function useUpdater() {
  const [updateReady, setUpdateReady] = useState(false);
  const [downloadProgress, setDownloadProgress] = useState<number | null>(null);

  useEffect(() => {
    const api = window.electronAPI;
    if (!api) return;

    // Check if an update was already downloaded before this component mounted
    // (handles persistence across page navigations and refreshes)
    api.getUpdateStatus().then(({ updateDownloaded }) => {
      if (updateDownloaded) {
        setUpdateReady(true);
        tryNotify();
      }
    });

    api.onDownloadProgress((p) => setDownloadProgress(p));
    api.onUpdateReady(() => {
      setDownloadProgress(null);
      setUpdateReady(true);
      tryNotify();
    });

    function tryNotify() {
      // Play chime exactly once per session — sessionStorage survives SPA
      // navigations but resets when the app is fully closed/restarted.
      if (typeof sessionStorage !== 'undefined' && !sessionStorage.getItem(SOUND_KEY)) {
        playNotificationSound();
        sessionStorage.setItem(SOUND_KEY, '1');
      }
    }

    return () => {
      api.removeUpdateReadyListener();
      api.removeDownloadProgressListener();
    };
  }, []);

  const installUpdate = useCallback(() => {
    window.electronAPI?.installUpdate();
  }, []);

  return { updateReady, downloadProgress, installUpdate };
}
