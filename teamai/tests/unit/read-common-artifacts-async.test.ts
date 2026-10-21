import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { execFileSync } from 'child_process';
import os from 'os';
import path from 'path';
import { readCommonArtifacts } from '../../src/lib/task-artifacts';

describe('readCommonArtifacts (async)', () => {
  let root: string;
  let repo: string;
  let dir: string;

  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' });

  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), 'rca-'));
    repo = path.join(root, 'repo');
    dir = path.join(root, 'task');
    mkdirSync(repo);
    mkdirSync(dir);
    git('init', '-b', 'main');
    git('config', 'user.email', 't@t.dev');
    git('config', 'user.name', 'T');
    writeFileSync(path.join(repo, 'a.txt'), 'one\n');
    git('add', 'a.txt');
    git('commit', '-m', 'init');
    git('checkout', '-b', 'feat/x');
    writeFileSync(path.join(repo, 'a.txt'), 'one\ntwo\n');
    git('commit', '-am', 'change');
    git('checkout', 'main');
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('returns the base...branch diff from a real repo (AC10)', async () => {
    const r = await readCommonArtifacts(dir, repo, 'feat/x');
    expect(r.diff).toContain('diff --git a/a.txt b/a.txt');
    expect(r.diff).toContain('+two');
  });

  it('falls back to diff.txt when the branch does not exist', async () => {
    writeFileSync(path.join(dir, 'diff.txt'), 'canned');
    const r = await readCommonArtifacts(dir, repo, 'does-not-exist');
    expect(r.diff).toBe('canned');
  });

  it('returns null diff when the branch does not exist and there is no diff.txt', async () => {
    const r = await readCommonArtifacts(dir, repo, 'does-not-exist');
    expect(r.diff).toBeNull();
  });

  it('returns all-null artifacts for an empty directory', async () => {
    const r = await readCommonArtifacts(dir, repo);
    expect(r).toEqual({ spec: null, qaReport: null, humanFeedback: null, diff: null });
  });

  it('reads spec, qa_report and human_feedback (header stripped)', async () => {
    writeFileSync(path.join(dir, 'spec.md'), '# Spec');
    writeFileSync(path.join(dir, 'qa_report.json'), JSON.stringify({ overall: 'PASS' }));
    writeFileSync(path.join(dir, 'human_feedback.md'), '# Human Review Feedback\n\n  Fix it  \n');
    const r = await readCommonArtifacts(dir, repo);
    expect(r.spec).toBe('# Spec');
    expect(r.qaReport).toEqual({ overall: 'PASS' });
    expect(r.humanFeedback).toBe('Fix it');
  });

  it('returns null human feedback when the file is blank after stripping', async () => {
    writeFileSync(path.join(dir, 'human_feedback.md'), '# Human Review Feedback\n\n  \n');
    const r = await readCommonArtifacts(dir, repo);
    expect(r.humanFeedback).toBeNull();
  });

  it('returns null qa_report and warns on invalid JSON', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      writeFileSync(path.join(dir, 'qa_report.json'), '{not json');
      const r = await readCommonArtifacts(dir, repo);
      expect(r.qaReport).toBeNull();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('Invalid JSON'));
    } finally {
      warn.mockRestore();
    }
  });

  it('rejects when spec.md cannot be read (a directory, not ENOENT)', async () => {
    mkdirSync(path.join(dir, 'spec.md'));
    await expect(readCommonArtifacts(dir, repo)).rejects.toThrow();
  });

  it('rejects when human_feedback.md cannot be read', async () => {
    mkdirSync(path.join(dir, 'human_feedback.md'));
    await expect(readCommonArtifacts(dir, repo)).rejects.toThrow();
  });

  it('rejects when diff.txt cannot be read', async () => {
    mkdirSync(path.join(dir, 'diff.txt'));
    await expect(readCommonArtifacts(dir, repo)).rejects.toThrow();
  });

  it('returns null qa_report when qa_report.json cannot be read', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      mkdirSync(path.join(dir, 'qa_report.json'));
      const r = await readCommonArtifacts(dir, repo);
      expect(r.qaReport).toBeNull();
    } finally {
      warn.mockRestore();
    }
  });
});
