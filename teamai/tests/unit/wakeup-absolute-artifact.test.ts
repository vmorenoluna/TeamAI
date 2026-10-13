import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, utimesSync } from 'fs';
import os from 'os';
import path from 'path';
import { checkArtifactProgress } from '../../src/lib/orchestrator/wakeup';

describe('checkArtifactProgress with an absolute expected_artifact', () => {
  let root: string;
  let cwd: string;
  let artifact: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), 'wakeup-abs-'));
    cwd = path.join(root, 'worktree');
    mkdirSync(cwd);
    // The spec directory lives outside the worktree, so agents record the
    // artifact as an absolute path.
    artifact = path.join(root, 'spec', 'job.log');
    mkdirSync(path.dirname(artifact));
    writeFileSync(artifact, 'done');
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('sees an absolute artifact that was updated after the schedule snapshot', () => {
    const scheduledAt = Date.now() - 60_000;
    utimesSync(artifact, new Date(), new Date());
    const r = checkArtifactProgress(cwd, artifact, scheduledAt);
    expect(r.producedThisCycle).toBe(true);
    expect(r.currentMtime).not.toBeNull();
  });

  it('reports no progress for an absolute artifact whose mtime has not advanced', () => {
    const mtime = Date.now() - 60_000;
    utimesSync(artifact, new Date(mtime), new Date(mtime));
    const r = checkArtifactProgress(cwd, artifact, mtime);
    expect(r.producedThisCycle).toBe(false);
    expect(r.currentMtime).not.toBeNull();
  });

  it('still resolves a cwd-relative artifact', () => {
    writeFileSync(path.join(cwd, 'rel.log'), 'x');
    const r = checkArtifactProgress(cwd, 'rel.log', null);
    expect(r.producedThisCycle).toBe(true);
  });
});
