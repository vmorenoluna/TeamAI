/**
 * `normalizeWakeupArtifact`: an agent running in a container can declare its
 * wakeup `expected_artifact` as the container-absolute path it sees
 * (`/workspaces/<project>/.teamai/<slug>/…`). The orchestrator stats it on the
 * host, where that path does not exist, so the freshness check reported "not
 * updated" for a finished job on every re-entry and the attempt cap failed the
 * subtask. The declared path is normalised to one relative to the checked
 * directory before it is stored.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { normalizeWakeupArtifact, checkArtifactProgress } from '../../src/lib/orchestrator/wakeup';

describe('normalizeWakeupArtifact', () => {
  let root: string;
  let cwd: string;
  let specDir: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'wakeup-artifact-'));
    cwd = join(root, '.worktrees', 'my-task');
    specDir = join(root, '.teamai', 'my-task');
    mkdirSync(cwd, { recursive: true });
    mkdirSync(specDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('anchors a .teamai/<slug>/ path to the spec dir under the project root, not the worktree', () => {
    const { artifact } = normalizeWakeupArtifact('.teamai/my-task/job.log', cwd, specDir);
    expect(resolve(cwd, artifact!)).toBe(join(specDir, 'job.log'));
  });

  it('returns undefined when no artifact is declared', () => {
    expect(normalizeWakeupArtifact(undefined, cwd, specDir)).toEqual({ artifact: undefined });
    expect(normalizeWakeupArtifact('', cwd, specDir)).toEqual({ artifact: undefined });
  });

  it('keeps a relative path exactly as declared', () => {
    expect(normalizeWakeupArtifact('results/summary.jsonl', cwd, specDir))
      .toEqual({ artifact: 'results/summary.jsonl' });
  });

  it('anchors a relative .teamai/ path at the project root, where the spec dir lives', () => {
    expect(normalizeWakeupArtifact('.teamai/my-task/ac5/out.jsonl', cwd, specDir))
      .toEqual({ artifact: '../../.teamai/my-task/ac5/out.jsonl' });
  });

  it('maps a container-absolute spec-dir path onto the host project root', () => {
    const r = normalizeWakeupArtifact('/workspaces/proj/.teamai/my-task/ac5/out.jsonl', cwd, specDir);
    expect(r.warning).toBeUndefined();
    expect(r.artifact).toBe('../../.teamai/my-task/ac5/out.jsonl');
  });

  it('maps a container-absolute worktree path onto the host worktree', () => {
    const r = normalizeWakeupArtifact('/workspaces/proj/.worktrees/my-task/results/s.jsonl', cwd, specDir);
    expect(r.warning).toBeUndefined();
    expect(r.artifact).toBe('results/s.jsonl');
  });

  it('rewrites a host-absolute path inside the worktree relative to it', () => {
    const r = normalizeWakeupArtifact(join(cwd, 'a', 'b.json'), cwd, specDir);
    expect(r).toEqual({ artifact: 'a/b.json' });
  });

  it('drops an absolute path it cannot map and says why', () => {
    const r = normalizeWakeupArtifact('/tmp/job/out.jsonl', cwd, specDir);
    expect(r.artifact).toBeUndefined();
    expect(r.warning).toContain('/tmp/job/out.jsonl');
  });

  it('lets the freshness check see a file declared by its container path', () => {
    mkdirSync(join(specDir, 'ac5'), { recursive: true });
    writeFileSync(join(specDir, 'ac5', 'out.jsonl'), '{}\n');
    const { artifact } = normalizeWakeupArtifact('/workspaces/proj/.teamai/my-task/ac5/out.jsonl', cwd, specDir);
    const { producedThisCycle, currentMtime } = checkArtifactProgress(cwd, artifact, null);
    expect(currentMtime).not.toBeNull();
    expect(producedThisCycle).toBe(true);
  });
});
