'use client';

import { useState, useEffect, useRef } from 'react';
import { extractText } from '@/lib/stream-types';
import { RATE_LIMIT_PATTERN, parseSessionLimitReset, formatCountdown } from '@/lib/rate-limit';
import type { SessionEvent } from './use-session-stream';

/**
 * Shared hook for rate-limit detection and auto-resume countdown.
 *
 * - Watches stream events for rate-limit messages
 * - When detected, parses the reset time and starts a countdown
 * - Auto-resumes by calling `onRetry` when the countdown completes
 * - Provides `resetRateLimit()` to clear all rate-limit state (call in cancel/send handlers)
 *
 * Callbacks are stored in refs so the detection useEffect only re-runs
 * when streamEvents change — not on every render from new callback references.
 */
export function useRateLimitAutoResume(
  streamEvents: SessionEvent[],
  onRetry: () => void,
  onRateLimitDetected?: () => void,
  onCancelAutoResume?: () => void,
): {
  rateLimited: boolean;
  rateLimitMessage: string;
  autoResumeAt: number | null;
  countdown: string;
  resetRateLimit: () => void;
  handleCancelAutoResume: () => void;
} {
  const [rateLimited, setRateLimited] = useState(false);
  const [rateLimitMessage, setRateLimitMessage] = useState('');
  const [autoResumeAt, setAutoResumeAt] = useState<number | null>(null);
  const [countdown, setCountdown] = useState('');

  // Keep callback refs current without triggering effect re-runs
  const onRateLimitDetectedRef = useRef(onRateLimitDetected);
  const onRetryRef = useRef(onRetry);
  const onCancelAutoResumeRef = useRef(onCancelAutoResume);

  // Sync refs in an effect to avoid "Cannot update ref during render" in StrictMode
  useEffect(() => {
    onRateLimitDetectedRef.current = onRateLimitDetected;
    onRetryRef.current = onRetry;
    onCancelAutoResumeRef.current = onCancelAutoResume;
  });

  // Detect rate-limit in stream events — only re-runs when streamEvents change
  useEffect(() => {
    for (const e of streamEvents) {
      const text = extractText(e.event);
      if (text && RATE_LIMIT_PATTERN.test(text)) {
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setRateLimited(true);
        onRateLimitDetectedRef.current?.();
        const resetsAt = parseSessionLimitReset(text);
        if (resetsAt) {
          setAutoResumeAt(resetsAt);
          setCountdown(formatCountdown(resetsAt));
          setRateLimitMessage(`Session limit hit — auto-resuming ${formatCountdown(resetsAt)}`);
        } else {
          const match = text.match(/resets\s+(\d+:\d+\s*[ap]m)/i);
          setRateLimitMessage(match ? `Session limit hit — resets ${match[1]} UTC` : text.slice(0, 200));
        }
        return;
      }
    }
  }, [streamEvents]);

  // Auto-resume countdown
  useEffect(() => {
    if (autoResumeAt === null) return;
    const timer = setInterval(() => {
      const remaining = autoResumeAt - Math.floor(Date.now() / 1000);
      if (remaining <= 0) {
        clearInterval(timer);
        setRateLimited(false);
        setRateLimitMessage('');
        setAutoResumeAt(null);
        setCountdown('');
        onRetryRef.current();
      } else {
        setCountdown(formatCountdown(autoResumeAt));
        setRateLimitMessage(`Session limit hit — auto-resuming ${formatCountdown(autoResumeAt)}`);
      }
    }, 1000);
    return () => clearInterval(timer);
  }, [autoResumeAt]);

  const resetRateLimit = () => {
    setRateLimited(false);
    setRateLimitMessage('');
    setAutoResumeAt(null);
    setCountdown('');
  };

  const handleCancelAutoResume = () => {
    setAutoResumeAt(null);
    setCountdown('');
    setRateLimited(false);
    setRateLimitMessage('');
    onCancelAutoResumeRef.current?.();
  };

  return {
    rateLimited,
    rateLimitMessage,
    autoResumeAt,
    countdown,
    resetRateLimit,
    handleCancelAutoResume,
  };
}
