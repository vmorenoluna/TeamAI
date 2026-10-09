/**
 * Integration-style unit tests for defaults/create-task-cli.mjs — the
 * standalone, dependency-free script terminal sessions run to file a bare
 * backlog ticket (see process-manager.ts's createTerminalSession).
 *
 * Runs the real script as a child process against a throwaway temp
 * directory rather than mocking fs — it has no collaborators to mock and
 * its whole value is "does the file that lands on disk actually match what
 * TaskStore.create() would have written".
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync, readFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const CLI_PATH = join(__dirname, '..', '..', 'defaults', 'create-task-cli.mjs');

function run(args: string[]): { status: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync(process.execPath, [CLI_PATH, ...args], { encoding: 'utf-8' });
    return { status: 0, stdout, stderr: '' };
  } catch (err) {
    const e = err as { status: number; stdout: string; stderr: string };
    return { status: e.status, stdout: e.stdout, stderr: e.stderr };
  }
}

describe('create-task-cli.mjs', () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), 'teamai-create-task-cli-'));
  });

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
  });

  it('creates a bare backlog task.json with only title, description, and phase set', () => {
    const result = run([
      '--project', projectDir,
      '--title', 'Investigate AC-T1 regression',
      '--description', 'Fresh job on HEAD shows AC-T1 dropped from 95.7% to 59.3%.',
    ]);

    expect(result.status).toBe(0);

    const taskPath = join(projectDir, '.teamai', 'investigate-ac-t1-regression', 'task.json');
    expect(existsSync(taskPath)).toBe(true);

    const task = JSON.parse(readFileSync(taskPath, 'utf-8'));
    expect(task.title).toBe('Investigate AC-T1 regression');
    expect(task.description).toBe('Fresh job on HEAD shows AC-T1 dropped from 95.7% to 59.3%.');
    expect(task.phase).toBe('backlog');
    expect(task.slug).toBe('investigate-ac-t1-regression');
    expect(typeof task.id).toBe('string');
    expect(task.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(task.createdAt).toBe(task.updatedAt);
    expect(task.spec).toBeUndefined();
    expect(task.plan).toBeUndefined();
    // Never mislabel the source badge — TaskStore.create() itself leaves
    // `source` undefined for the UI's own "Add Task" button; this CLI must
    // match, or the UI would render a bogus "Ideation"/"Competitor Analysis"
    // badge (task-detail.tsx only special-cases those two values).
    expect(task.source).toBeUndefined();
  });

  it('does not write spec.md or plan.json alongside the bare ticket', () => {
    run(['--project', projectDir, '--title', 'Fix: flaky retry test', '--description', 'Retry test intermittently times out.']);

    const dir = join(projectDir, '.teamai', 'fix-flaky-retry-test');
    expect(existsSync(join(dir, 'task.json'))).toBe(true);
    expect(existsSync(join(dir, 'spec.md'))).toBe(false);
    expect(existsSync(join(dir, 'plan.json'))).toBe(false);
  });

  it('dedupes slugs the same way TaskStore.create() does, appending -2, -3, ...', () => {
    run(['--project', projectDir, '--title', 'Add dark mode', '--description', 'first']);
    run(['--project', projectDir, '--title', 'Add dark mode', '--description', 'second']);
    run(['--project', projectDir, '--title', 'Add dark mode', '--description', 'third']);

    expect(existsSync(join(projectDir, '.teamai', 'add-dark-mode', 'task.json'))).toBe(true);
    expect(existsSync(join(projectDir, '.teamai', 'add-dark-mode-2', 'task.json'))).toBe(true);
    expect(existsSync(join(projectDir, '.teamai', 'add-dark-mode-3', 'task.json'))).toBe(true);
  });

  it('creates the .teamai directory if the project has never had a ticket before', () => {
    expect(existsSync(join(projectDir, '.teamai'))).toBe(false);

    const result = run(['--project', projectDir, '--title', 'First ever ticket', '--description', 'x']);

    expect(result.status).toBe(0);
    expect(existsSync(join(projectDir, '.teamai', 'first-ever-ticket', 'task.json'))).toBe(true);
  });

  it('falls back to slug "task" when the title is entirely non-alphanumeric', () => {
    const result = run(['--project', projectDir, '--title', '!!!', '--description', 'x']);

    expect(result.status).toBe(0);
    expect(existsSync(join(projectDir, '.teamai', 'task', 'task.json'))).toBe(true);
  });

  it('fails with a clear error and exit code 1 when --title is missing', () => {
    const result = run(['--project', projectDir, '--description', 'x']);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('--title');
  });

  it('fails with a clear error and exit code 1 when --description is missing', () => {
    const result = run(['--project', projectDir, '--title', 'x']);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('--description');
  });

  it('fails with a clear error and exit code 1 when --project is missing', () => {
    const result = run(['--title', 'x', '--description', 'x']);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('--project');
  });

  it('fails when the project path does not exist', () => {
    const result = run(['--project', join(projectDir, 'does-not-exist'), '--title', 'x', '--description', 'x']);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('does not exist');
  });

  it('reuses an existing .teamai directory without erroring', () => {
    mkdirSync(join(projectDir, '.teamai'), { recursive: true });

    const result = run(['--project', projectDir, '--title', 'Second project ticket', '--description', 'x']);

    expect(result.status).toBe(0);
    expect(existsSync(join(projectDir, '.teamai', 'second-project-ticket', 'task.json'))).toBe(true);
  });
});
