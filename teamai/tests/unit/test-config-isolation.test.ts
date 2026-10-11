/**
 * Guards the rule that no test may touch the real ~/.teamai: tests/global-setup.ts
 * gives every run a private TEAMAI_CONFIG_DIR, and project-store.ts refuses to
 * resolve to the real user config dir while running under vitest.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { homedir, tmpdir } from 'os';
import { join, resolve } from 'path';
import { realpathSync } from 'fs';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('test config isolation', () => {
  it('every run has a private config dir inside the OS temp dir', () => {
    const dir = process.env.TEAMAI_CONFIG_DIR;
    expect(dir).toBeTruthy();
    expect(resolve(dir!).toLowerCase().startsWith(resolve(realpathSync(tmpdir())).toLowerCase())).toBe(true);
    expect(resolve(dir!).toLowerCase()).not.toBe(resolve(join(homedir(), '.teamai')).toLowerCase());
  });

  it('refuses to resolve to the real user config dir', async () => {
    vi.stubEnv('TEAMAI_CONFIG_DIR', '');
    vi.resetModules();
    const { ProjectStore } = await import('../../src/lib/project-store');
    expect(() => new ProjectStore()).toThrow(/Refusing to use the real config dir/);
  });
});
