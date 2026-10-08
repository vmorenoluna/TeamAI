import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { join, relative, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('fix-external-symlinks', () => {
  it.each(['relative', 'absolute'] as const)('creates a portable shim for a %s symlink', (linkKind) => {
    const root = mkdtempSync(join(tmpdir(), 'teamai-external-shims-'));
    roots.push(root);
    const appRoot = join(root, 'app');
    const realPackage = join(appRoot, 'node_modules', 'node-pty');
    const nextModules = join(appRoot, '.next', 'node_modules');
    const shimName = 'node-pty-0123456789abcdef';
    const shimPath = join(nextModules, shimName);
    mkdirSync(realPackage, { recursive: true });
    mkdirSync(nextModules, { recursive: true });
    writeFileSync(join(realPackage, 'package.json'), JSON.stringify({ name: 'node-pty', main: 'index.js' }));
    writeFileSync(join(realPackage, 'index.js'), 'module.exports = { loaded: true };');

    const symlinkTarget = linkKind === 'absolute' ? realPackage : relative(nextModules, realPackage);
    const symlinkType = process.platform === 'win32' ? 'junction' : 'dir';
    symlinkSync(symlinkTarget, shimPath, symlinkType);
    if (linkKind === 'relative' && process.platform !== 'win32') {
      expect(readlinkSync(shimPath)).toBe(symlinkTarget);
    }
    execFileSync(process.execPath, [resolve('scripts/fix-external-symlinks.mjs')], { cwd: appRoot });

    const generatedShim = join(appRoot, 'external-shims', shimName);
    expect(readFileSync(join(generatedShim, 'package.json'), 'utf8')).toContain(shimName);
    const proxyEntry = join(generatedShim, 'index.js');
    expect(readFileSync(proxyEntry, 'utf8')).toContain('require(');
    expect(createRequire(import.meta.url)(proxyEntry)).toEqual({ loaded: true });
  });
});
