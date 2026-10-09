// @vitest-environment node

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { spawnSync } from 'child_process';
import { TaskStore } from '@/lib/task-store';
import { boardFingerprint, openTickets } from '@/lib/orchestrator/backlog-check';

const CLI = join(process.cwd(), 'defaults', 'create-task-cli.mjs');
const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) { try { rmSync(dirs.pop()!, { recursive: true, force: true }); } catch { /* best-effort */ } }
});

function project(): string {
  const root = mkdtempSync(join(tmpdir(), 'teamai-cli-'));
  dirs.push(root);
  new TaskStore(root).create('11111111-1111-4111-8111-111111111111', 'Existing', 'already here');
  return root;
}
const run = (...args: string[]) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf-8' });

describe('create-task-cli board gate', () => {
  it('--list prints the open tickets with the same fingerprint the orchestrator computes', () => {
    const root = project();
    const out = JSON.parse(run('--project', root, '--list').stdout);
    expect(out.tickets.map((t: { title: string }) => t.title)).toEqual(['Existing']);
    expect(out.fingerprint).toBe(boardFingerprint(openTickets(new TaskStore(root), '')));
  });

  it('requires --board', () => {
    const r = run('--project', project(), '--title', 'Fix: x', '--description', 'y');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('--board');
  });

  it('creates with a current fingerprint and refuses (exit 3) with a stale one', () => {
    const root = project();
    const { fingerprint } = JSON.parse(run('--project', root, '--list').stdout);
    const ok = run('--project', root, '--board', fingerprint, '--title', 'Fix: first', '--description', 'd');
    expect(ok.status).toBe(0);
    const stale = run('--project', root, '--board', fingerprint, '--title', 'Fix: second', '--description', 'd');
    expect(stale.status).toBe(3);
    expect(stale.stderr).toContain('Fix: first');
    expect(new TaskStore(root).getAll().some(t => t.title === 'Fix: second')).toBe(false);
    expect(existsSync(join(root, '.teamai', '.board.lock'))).toBe(false);
  });
});
