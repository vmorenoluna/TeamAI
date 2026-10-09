/**
 * Regression: a wakeup re-entry that ends silently (no phase_wakeup.json) but
 * wrote the phase's deliverables is a finished phase. Previously the
 * stale-artifact heuristic only watched the wakeup's old expected artifact —
 * a log from a job that a host restart had interrupted and the agent re-ran
 * under new names — so it re-armed until the attempt cap and failed a
 * completed spec as 'wakeup-exhausted'.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync, statSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { resolvePhaseWakeup } from '../../src/lib/orchestrator/wakeup';
import type { TaskPipeline } from '../../src/lib/orchestrator/types';

describe('resolvePhaseWakeup — deliverables written on a silent re-entry', () => {
  let root: string;
  let specDir: string;
  const deps = {
    getPipelineConfig: () => ({ maxImplementRetries: 3, wakeupScanRetryDelayMs: 0 }),
    scheduleWakeup: vi.fn(),
    savePipelineState: vi.fn(),
    writeCompletionSummary: vi.fn(),
    advancePhase: vi.fn(),
  };

  function makePipeline(attempts: number): TaskPipeline {
    return {
      taskId: 't1', specPath: specDir, wakeupUntil: new Date().toISOString(),
      wakeupCommand: 'job', wakeupArtifact: 'old/never-updated.log', wakeupAttemptCount: attempts,
      // the artifact has not changed since the wakeup was scheduled
      wakeupArtifactMtimeAtSchedule: statSync(join(root, 'old', 'never-updated.log')).mtimeMs,
    } as unknown as TaskPipeline;
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'teamai-wakeup-done-'));
    specDir = join(root, '.teamai', 't1');
    mkdirSync(specDir, { recursive: true });
    mkdirSync(join(root, 'old'), { recursive: true });
    writeFileSync(join(root, 'old', 'never-updated.log'), 'x');
    Object.values(deps).forEach(f => typeof f === 'function' && 'mockClear' in f && (f as ReturnType<typeof vi.fn>).mockClear());
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const run = (pipeline: TaskPipeline, deliverables: string[], sessionStartedAt: number) =>
    resolvePhaseWakeup({
      pipeline, specDir, cwd: root, wasReentry: true, sessionStartedAt,
      unitLabel: 'The spec phase', deliverables, deps,
    });

  it('clears wakeup state instead of re-arming or failing when deliverables are fresh', async () => {
    const started = Date.now() - 60_000;
    const spec = join(specDir, 'spec.md');
    const summary = join(specDir, 'spec_summary.md');
    writeFileSync(spec, 's'); writeFileSync(summary, 's');
    const pipeline = makePipeline(2); // one more stale cycle would hit the cap of 3

    expect(await run(pipeline, [spec, summary], started)).toBe('clear');
    expect(pipeline.wakeupCommand).toBeUndefined();
    expect(pipeline.wakeupAttemptCount).toBe(0);
    expect(deps.scheduleWakeup).not.toHaveBeenCalled();
    expect(deps.advancePhase).not.toHaveBeenCalled();
  });

  it('still re-arms when the deliverables predate this session', async () => {
    const spec = join(specDir, 'spec.md');
    writeFileSync(spec, 's');
    const old = new Date(Date.now() - 3_600_000);
    utimesSync(spec, old, old);
    const pipeline = makePipeline(0);

    expect(await run(pipeline, [spec], Date.now() - 60_000)).toBe('pending');
    expect(deps.scheduleWakeup).toHaveBeenCalledTimes(1);
  });

  it('still re-arms when only some deliverables exist', async () => {
    const spec = join(specDir, 'spec.md');
    writeFileSync(spec, 's');
    const pipeline = makePipeline(0);

    expect(await run(pipeline, [spec, join(specDir, 'spec_summary.md')], Date.now() - 60_000)).toBe('pending');
    expect(deps.scheduleWakeup).toHaveBeenCalledTimes(1);
  });
});
