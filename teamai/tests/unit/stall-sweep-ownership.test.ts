/**
 * Stall-Sweep Ownership Test
 *
 * `sweepStalledTasks()` (src/lib/recovery.ts) is the SINGLE owner of session
 * stall-kills. It reads each project's configured idle/tool-stall thresholds
 * and kills with the 'stalled' reason, which the stall-recovery retry
 * classification depends on. A second, hardcoded sweep in server.ts once
 * ignored those thresholds and killed legitimate long-running tool calls
 * without the 'stalled' reason.
 *
 * server.ts is the custom Next.js server entry point and cannot be imported
 * in a unit test, so — like guardrail-coverage.test.ts — these tests read the
 * sources as text and assert on their content.
 */

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'fs';
import { join, resolve } from 'path';

const serverSrc = readFileSync(resolve(process.cwd(), 'server.ts'), 'utf8');

/**
 * The stall sweep runs in the engine process, not the API server. Find the
 * engine-side file that drives it (the engine entry, or a module under
 * src/engine/); it is empty until that entry exists.
 */
function readSweepHost(): string {
  const engineDir = resolve(process.cwd(), 'src/engine');
  const candidates = [resolve(process.cwd(), 'engine.ts'), ...readdirSync(engineDir).map(f => join(engineDir, f))];
  for (const file of candidates) {
    if (!existsSync(file) || !file.endsWith('.ts')) continue;
    const src = readFileSync(file, 'utf8');
    if (src.includes('sweepStalledTasks()') && src.includes('setInterval(')) return src;
  }
  return '';
}
const sweepHostSrc = readSweepHost();
const hasSweepHost = sweepHostSrc !== '';
const recoverySrc = readFileSync(resolve(process.cwd(), 'src/lib/recovery.ts'), 'utf8');

/** The contiguous `//` comment block directly above the sweep's `setInterval`. */
function commentAboveSweepInterval(): string {
  const lines = sweepHostSrc.split('\n');
  const callIdx = lines.findIndex(l => l.includes('setInterval('));
  expect(callIdx).toBeGreaterThan(0);
  let i = callIdx - 1;
  // Skip the interval constant declaration sitting between comment and call.
  while (i >= 0 && lines[i].trim().startsWith('const ')) i--;
  const block: string[] = [];
  while (i >= 0 && lines[i].trim().startsWith('//')) {
    block.unshift(lines[i]);
    i--;
  }
  return block.join('\n');
}

describe('stall-sweep ownership', () => {
  it('AC1: server.ts has no duplicate hardcoded stall sweep', () => {
    // These identifiers belonged to the removed inline kill loop; their
    // reappearance means a second stall-kill path has been reintroduced.
    expect(serverSrc).not.toContain('getStalledSessions');
    expect(serverSrc).not.toContain('STALLED_SESSION_TIMEOUT_MS');
  });

  it('AC1: server.ts no longer owns any sweep interval', () => {
    expect(serverSrc).not.toContain('sweepStalledTasks');
  });

  it.skipIf(!hasSweepHost)('AC2: the engine still drives sweepStalledTasks() from the setInterval', () => {
    const idx = sweepHostSrc.indexOf('setInterval(');
    expect(idx).toBeGreaterThan(-1);
    const afterInterval = sweepHostSrc.slice(idx, idx + 200);
    expect(afterInterval).toContain('sweepStalledTasks()');
  });

  it('AC2: recovery.ts owns the stall decision via per-project thresholds', () => {
    expect(recoverySrc).toContain('processManager.getStalledSessions(');
  });

  it("AC2: recovery.ts kills stalled sessions with the 'stalled' reason", () => {
    expect(recoverySrc).toContain("processManager.killSession(session.id, 'stalled'");
  });

  it.skipIf(!hasSweepHost)('AC6: anti-regression comment above the setInterval names the owner and why', () => {
    const comment = commentAboveSweepInterval().toLowerCase();
    expect(comment).toContain('sweepstalledtasks');
    expect(comment).toContain('per-project');
    expect(comment).toContain('stalled');
  });
});
