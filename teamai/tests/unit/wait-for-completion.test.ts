/**
 * Defect 7 regression tests: waitForCompletion must reject when a session is
 * terminated by a signal (SIGTERM/SIGKILL), not resolve as if it completed
 * successfully.
 *
 * Background: a signal-killed child process reports code=null to Node's
 * 'exit' event — the old handler treated code===null as a clean exit and
 * resolved. When the stalled-session sweep killed a hung agent session, the
 * pipeline awaiting it would then proceed as if the session had succeeded,
 * never reaching a completion or failure state — the task stayed stuck in
 * 'implement' forever with no Retry button and no way to auto-resume.
 */
import { describe, it, expect } from 'vitest';
import { waitForCompletion } from '../../src/lib/orchestrator/rate-limit';
import { SessionKilledError, SessionExitedError } from '../../src/lib/orchestrator/errors';
import { RateLimitError } from '../../src/lib/orchestrator/rate-limit';
import { processManager } from '../../src/lib/process-manager';

// waitForCompletion falls back to the global processManager EventEmitter
// when no per-session emitter is registered (see rate-limit.ts's own
// "BUG-20 / T29" comment) — exactly the case for a sessionId that was never
// passed through processManager.createSession(). That fallback is the
// simplest, most direct way to drive the exit handler under test without
// spawning a real child process.
const deps = { parseSessionLimitReset: () => null };

describe('waitForCompletion — Defect 7 (killed session vs clean exit)', () => {
  it('rejects with SessionKilledError when the session is killed by SIGTERM (code: null)', async () => {
    const sessionId = `test-sigterm-${Date.now()}`;
    const promise = waitForCompletion(sessionId, deps);

    processManager.emit('exit', { sessionId, code: null, signal: 'SIGTERM' });

    await expect(promise).rejects.toBeInstanceOf(SessionKilledError);
    await expect(promise).rejects.toThrow('SIGTERM');
  });

  it('rejects with SessionKilledError when the session is killed by SIGKILL (code: null)', async () => {
    const sessionId = `test-sigkill-${Date.now()}`;
    const promise = waitForCompletion(sessionId, deps);

    processManager.emit('exit', { sessionId, code: null, signal: 'SIGKILL' });

    await expect(promise).rejects.toBeInstanceOf(SessionKilledError);
    await expect(promise).rejects.toThrow('SIGKILL');
  });

  it('does NOT resolve when a killed session reports code: null (regression guard)', async () => {
    // This is the exact bug: the old handler had `code === null` in its
    // resolve() branch, so a killed session with no signal info would have
    // been treated as a success. `.rejects` below fails loudly if the
    // promise resolves instead, which is the direct regression guard.
    const sessionId = `test-no-false-resolve-${Date.now()}`;
    const promise = waitForCompletion(sessionId, deps);

    processManager.emit('exit', { sessionId, code: null, signal: 'SIGTERM' });

    await expect(promise).rejects.toBeInstanceOf(SessionKilledError);
  });

  it('still resolves cleanly on a normal exit (code: 0, no signal)', async () => {
    const sessionId = `test-clean-exit-${Date.now()}`;
    const promise = waitForCompletion(sessionId, deps);

    processManager.emit('exit', { sessionId, code: 0, signal: null });

    await expect(promise).resolves.toBeUndefined();
  });

  it('still rejects with SessionExitedError on a genuine non-zero exit with no signal', async () => {
    const sessionId = `test-nonzero-exit-${Date.now()}`;
    const promise = waitForCompletion(sessionId, deps);

    processManager.emit('exit', { sessionId, code: 1, signal: null });

    await expect(promise).rejects.toBeInstanceOf(SessionExitedError);
  });

  it('signal-kill takes priority over a pending session-limit rejection', async () => {
    // Ordering check: the fix put the signal check first in onExit, ahead of
    // the pre-existing sessionLimitResetsAt branch. A session that was both
    // flagged for a session limit AND then killed should still surface as a
    // kill, not be misreported as a rate-limit pause.
    const sessionId = `test-signal-priority-${Date.now()}`;
    const promise = waitForCompletion(sessionId, deps);

    processManager.emit('raw', { sessionId, data: 'session limit reached, resets 3:00pm UTC' });
    processManager.emit('exit', { sessionId, code: null, signal: 'SIGTERM' });

    await expect(promise).rejects.toBeInstanceOf(SessionKilledError);
  });

  it('still rejects with RateLimitError via exit when no signal is present (reordering did not break existing behavior)', async () => {
    const sessionId = `test-rate-limit-preserved-${Date.now()}`;
    const promise = waitForCompletion(sessionId, deps);

    processManager.emit('raw', { sessionId, data: 'session limit reached, resets 3:00pm UTC' });
    processManager.emit('exit', { sessionId, code: 1, signal: null });

    await expect(promise).rejects.toBeInstanceOf(RateLimitError);
  });

  it('rejects with SessionKilledError when wasExplicitlyKilled is set but no signal was reported (Docker exec masks the signal as an exit code)', async () => {
    // In container mode the immediate child is `docker exec`; Docker delivers
    // the signal to the process INSIDE the container and reports its own
    // exit purely via a `128 + signal` code (143 for SIGTERM) with
    // `signal: null` on the host side. killSession() sets
    // wasExplicitlyKilled unconditionally specifically so this case is still
    // detectable even though the OS-level signal itself never reaches us.
    const sessionId = `test-docker-masked-kill-${Date.now()}`;
    (processManager as any).sessions.set(sessionId, { wasExplicitlyKilled: true, killReason: undefined, stallKind: undefined });

    const promise = waitForCompletion(sessionId, deps);
    processManager.emit('exit', { sessionId, code: 143, signal: null });

    try {
      await expect(promise).rejects.toBeInstanceOf(SessionKilledError);
    } finally {
      (processManager as any).sessions.delete(sessionId);
    }
  });

  it('does NOT misclassify a genuine non-zero exit as a kill when wasExplicitlyKilled is unset', async () => {
    const sessionId = `test-not-killed-${Date.now()}`;
    (processManager as any).sessions.set(sessionId, { wasExplicitlyKilled: false });

    const promise = waitForCompletion(sessionId, deps);
    processManager.emit('exit', { sessionId, code: 143, signal: null });

    try {
      await expect(promise).rejects.toBeInstanceOf(SessionExitedError);
    } finally {
      (processManager as any).sessions.delete(sessionId);
    }
  });

  it('ignores exit events for a different sessionId', async () => {
    const sessionId = `test-scoped-${Date.now()}`;
    const promise = waitForCompletion(sessionId, deps);

    processManager.emit('exit', { sessionId: 'some-other-session', code: null, signal: 'SIGKILL' });
    processManager.emit('exit', { sessionId, code: 0, signal: null });

    await expect(promise).resolves.toBeUndefined();
  });
});
