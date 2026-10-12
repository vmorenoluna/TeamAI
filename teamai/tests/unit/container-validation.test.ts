import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, utimesSync } from 'fs';
import { spawnSync } from 'child_process';
import os from 'os';
import path from 'path';
import {
  findProjectDir, NATIVE_MODULES_CHECK_SCRIPT, nativeModulesCheckCommand,
  readValidationRecord, writeValidationRecord, computeFingerprint, isContainerBlocked,
  describeFailure, ContainerValidationError,
} from '../../src/lib/container-validation';
import { ContainerManager } from '../../src/lib/container-manager';
import { analyzeProject, generateDevcontainer } from '../../src/lib/devcontainer-generator';

let root: string;

beforeEach(() => { root = mkdtempSync(path.join(os.tmpdir(), 'container-validation-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

const touch = (rel: string, content = '') => {
  mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  writeFileSync(path.join(root, rel), content);
};

describe('findProjectDir', () => {
  it('returns "" when the root itself is a project', () => {
    touch('package.json', '{}');
    touch('sub/package.json', '{}');
    expect(findProjectDir(root)).toBe('');
  });

  it('finds a project one level down', () => {
    touch('README.md');
    touch('teamai/package.json', '{}');
    expect(findProjectDir(root)).toBe('teamai');
  });

  it('finds a project two levels down but not three', () => {
    touch('a/b/go.mod');
    expect(findProjectDir(root)).toBe('a/b');
    rmSync(path.join(root, 'a'), { recursive: true, force: true });
    touch('a/b/c/go.mod');
    expect(findProjectDir(root)).toBe('');
  });

  it('prefers the alphabetically first shallow candidate and skips node_modules and dot dirs', () => {
    touch('node_modules/x/package.json', '{}');
    touch('.hidden/package.json', '{}');
    touch('zeta/package.json', '{}');
    touch('alpha/package.json', '{}');
    expect(findProjectDir(root)).toBe('alpha');
  });

  it('returns "" when there is no project at all', () => {
    touch('notes/readme.txt');
    expect(findProjectDir(root)).toBe('');
  });
});

describe('native modules check', () => {
  const run = (dir: string) =>
    spawnSync(process.execPath, ['-e', NATIVE_MODULES_CHECK_SCRIPT], { cwd: dir, encoding: 'utf-8' });
  const pkg = (name: string) => touch(`node_modules/${name}/package.json`, '{}');
  const here = `${process.platform}-${process.arch}`;

  it('passes when there is no node_modules yet', () => {
    expect(run(root).status).toBe(0);
  });

  it('passes when the matching platform variant is installed', () => {
    pkg(`@rollup/rollup-${here}-gnu`);
    pkg('@esbuild/' + here);
    pkg('left-pad');
    expect(run(root).status).toBe(0);
  });

  it('passes when other platforms are installed alongside the matching one', () => {
    pkg('@rollup/rollup-win32-x64-msvc');
    pkg(`@rollup/rollup-${here}`);
    expect(run(root).status).toBe(0);
  });

  it('fails when a native package group only has other platforms (host-installed tree)', () => {
    const other = process.platform === 'win32' ? 'darwin-arm64' : 'win32-x64';
    pkg(`@rollup/rollup-${other}-msvc`);
    pkg('@esbuild/' + other);
    const res = run(root);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('@rollup/rollup');
    expect(res.stderr).toContain('@esbuild');
    expect(res.stderr).toContain('installed on the host');
  });

  it('is runnable through the shell command the container uses', () => {
    if (process.platform === 'win32') return; // base64/sh pipeline is container-side (Linux)
    const res = spawnSync('sh', ['-c', nativeModulesCheckCommand()], { cwd: root, encoding: 'utf-8' });
    expect(res.status).toBe(0);
  });
});

describe('persisted validation record', () => {
  it('round-trips and ignores garbage', () => {
    expect(readValidationRecord(root)).toBeNull();
    writeValidationRecord(root, { status: 'failed', fingerprint: 'abc', validatedAt: new Date().toISOString(), failedStep: 'Build', error: 'boom' });
    expect(readValidationRecord(root)).toMatchObject({ status: 'failed', failedStep: 'Build' });
    touch('.teamai/container-validation.json', '{"status":"weird"}');
    expect(readValidationRecord(root)).toBeNull();
  });

  it('computeFingerprint changes with devcontainer, lockfile, container id and commands only', () => {
    touch('.devcontainer/devcontainer.json', '{"a":1}');
    touch('package-lock.json', 'lock-1');
    const base = computeFingerprint(root, '', 'c1', ['npm ci']);
    expect(computeFingerprint(root, '', 'c1', ['npm ci'])).toBe(base);
    expect(computeFingerprint(root, '', 'c2', ['npm ci'])).not.toBe(base);
    expect(computeFingerprint(root, '', 'c1', ['npm install'])).not.toBe(base);
    touch('package-lock.json', 'lock-2');
    expect(computeFingerprint(root, '', 'c1', ['npm ci'])).not.toBe(base);
    touch('package-lock.json', 'lock-1');
    touch('.devcontainer/devcontainer.json', '{"a":2}');
    expect(computeFingerprint(root, '', 'c1', ['npm ci'])).not.toBe(base);
  });

  it('reads lockfiles from the project subdirectory', () => {
    touch('app/package-lock.json', 'one');
    const a = computeFingerprint(root, 'app', 'c', []);
    touch('app/package-lock.json', 'two');
    expect(computeFingerprint(root, 'app', 'c', [])).not.toBe(a);
  });

  it('isContainerBlocked: only a failed result blocks, and editing the devcontainer lifts it', () => {
    expect(isContainerBlocked(root)).toBe(false);
    touch('.devcontainer/devcontainer.json', '{}');
    const past = new Date(Date.now() - 60_000);
    utimesSync(path.join(root, '.devcontainer/devcontainer.json'), past, past);
    writeValidationRecord(root, { status: 'passed', fingerprint: 'f', validatedAt: new Date().toISOString() });
    expect(isContainerBlocked(root)).toBe(false);
    writeValidationRecord(root, { status: 'failed', fingerprint: 'f', validatedAt: new Date().toISOString(), failedStep: 'Tests' });
    expect(isContainerBlocked(root)).toBe(true);
    const future = new Date(Date.now() + 60_000);
    utimesSync(path.join(root, '.devcontainer/devcontainer.json'), future, future);
    expect(isContainerBlocked(root)).toBe(false);
  });

  it('describeFailure names the step, the output tail, and how to unblock', () => {
    const text = describeFailure({ failedStep: 'Native modules', error: 'line1\nthe real reason' });
    expect(text).toContain('Native modules');
    expect(text).toContain('the real reason');
    expect(text).toContain('Re-validate');
  });
});

describe('ContainerManager validation gate', () => {
  const info = { containerId: 'cid-1', remoteWorkspaceFolder: '/workspaces/p' };
  let manager: ContainerManager;

  const stubRunning = (m: ContainerManager) => {
    vi.spyOn(m as never, '_ensureRunning' as never).mockResolvedValue(info as never);
    (m as unknown as { records: Map<string, unknown> }).records.set(root, { projectRoot: root, containerId: 'cid-1', validationPromise: null });
  };

  beforeEach(() => {
    touch('package.json', '{"name":"p","scripts":{"build":"x","test":"y"}}');
    touch('.devcontainer/devcontainer.json', '{}');
  });

  it('does nothing when enforcement is off', async () => {
    manager = new ContainerManager();
    stubRunning(manager);
    const validate = vi.spyOn(manager, 'validateContainer');
    await expect(manager.ensureContainer(root)).resolves.toEqual(info);
    expect(validate).not.toHaveBeenCalled();
  });

  it('validates an unvalidated container and blocks with CONTAINER_INVALID when it fails', async () => {
    manager = new ContainerManager({ enforceValidation: true });
    stubRunning(manager);
    vi.spyOn(manager, 'validateContainer').mockImplementation(async () => {
      writeValidationRecord(root, { status: 'failed', fingerprint: 'x', validatedAt: new Date().toISOString(), failedStep: 'Native modules', error: 'win32 only' });
      return false;
    });
    const err = await manager.ensureContainer(root).catch(e => e);
    expect(err).toBeInstanceOf(ContainerValidationError);
    expect(err.code).toBe('CONTAINER_INVALID');
    expect(err.message).toContain('Native modules');
    expect(err.message).toContain('win32 only');
  });

  it('lets a container through once it has passed, without validating again', async () => {
    manager = new ContainerManager({ enforceValidation: true });
    stubRunning(manager);
    const validate = vi.spyOn(manager, 'validateContainer').mockImplementation(async () => {
      // Record exactly what the real run would persist for this setup.
      const steps = await (manager as never as { _buildValidationSteps(r: string, d: string): Promise<{ command: string }[]> })._buildValidationSteps(root, '');
      writeValidationRecord(root, {
        status: 'passed', validatedAt: new Date().toISOString(),
        fingerprint: computeFingerprint(root, '', 'cid-1', steps.map(s => s.command)),
      });
      return true;
    });
    await expect(manager.ensureContainer(root)).resolves.toEqual(info);
    await expect(manager.ensureContainer(root)).resolves.toEqual(info);
    expect(validate).toHaveBeenCalledTimes(1);
  });

  it('re-validates when the devcontainer definition changes after a pass', async () => {
    manager = new ContainerManager({ enforceValidation: true });
    stubRunning(manager);
    let runs = 0;
    vi.spyOn(manager, 'validateContainer').mockImplementation(async () => {
      runs++;
      const steps = await (manager as never as { _buildValidationSteps(r: string, d: string): Promise<{ command: string }[]> })._buildValidationSteps(root, '');
      writeValidationRecord(root, {
        status: 'passed', validatedAt: new Date().toISOString(),
        fingerprint: computeFingerprint(root, '', 'cid-1', steps.map(s => s.command)),
      });
      return true;
    });
    await manager.ensureContainer(root);
    touch('.devcontainer/devcontainer.json', '{"changed":true}');
    await manager.ensureContainer(root);
    expect(runs).toBe(2);
  });

  it('re-runs validation on every start while the last result is a failure', async () => {
    manager = new ContainerManager({ enforceValidation: true });
    stubRunning(manager);
    const validate = vi.spyOn(manager, 'validateContainer').mockImplementation(async () => {
      writeValidationRecord(root, { status: 'failed', fingerprint: 'x', validatedAt: new Date().toISOString(), failedStep: 'Build', error: 'e' });
      return false;
    });
    await expect(manager.ensureContainer(root)).rejects.toThrow(/Build/);
    await expect(manager.ensureContainer(root)).rejects.toThrow(/Build/);
    expect(validate).toHaveBeenCalledTimes(2);
  });

  it('reports the persisted status without touching Docker', async () => {
    manager = new ContainerManager();
    await expect(manager.getValidationStatus(root)).resolves.toEqual({ status: 'unknown' });
    writeValidationRecord(root, { status: 'failed', fingerprint: 'x', validatedAt: '2026-01-01T00:00:00.000Z', failedStep: 'Tests', error: 'e' });
    await expect(manager.getValidationStatus(root)).resolves.toMatchObject({ status: 'failed', failedStep: 'Tests' });
  });
});

describe('devcontainer generation for a project in a subdirectory', () => {
  it('analyses the subdirectory project and scopes the node_modules volume and install to it', () => {
    touch('README.md');
    touch('teamai/package.json', JSON.stringify({ name: 'x', scripts: { build: 'b', test: 't' } }));
    touch('teamai/package-lock.json', '{}');
    const info = analyzeProject(root);
    expect(info.type).toBe('node');
    expect(info.relativeDir).toBe('teamai');

    const parsed = JSON.parse(generateDevcontainer(root, info));
    expect(JSON.stringify(parsed.mounts)).toContain('${containerWorkspaceFolder}/teamai/node_modules');
    expect(parsed.postCreateCommand).toContain('chown node:node teamai/node_modules');
    expect(parsed.postCreateCommand).toContain('cd teamai && ');
  });

  it('keeps the root layout for a root-level project', () => {
    touch('package.json', JSON.stringify({ name: 'x' }));
    const info = analyzeProject(root);
    expect(info.relativeDir).toBeUndefined();
    const parsed = JSON.parse(generateDevcontainer(root, info));
    expect(JSON.stringify(parsed.mounts)).toContain('${containerWorkspaceFolder}/node_modules');
    expect(parsed.postCreateCommand).toContain('cd . && ');
  });
});
