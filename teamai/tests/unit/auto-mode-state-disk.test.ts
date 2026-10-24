/**
 * getAutoModeState reads the persisted .teamai/auto-mode.json (the runner lives
 * in the engine process), not the in-memory map.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { getAutoModeState } from '@/lib/auto-mode-state';

describe('getAutoModeState (disk-backed)', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'auto-mode-disk-'));
    (globalThis as { __autoModeProjectStates?: Map<string, unknown> }).__autoModeProjectStates = new Map();
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('reads enabled/maxParallel from disk when the in-memory map is empty', () => {
    mkdirSync(join(root, '.teamai'), { recursive: true });
    writeFileSync(join(root, '.teamai', 'auto-mode.json'), JSON.stringify({ enabled: true, maxParallel: 3 }));
    expect(getAutoModeState(root)).toMatchObject({ enabled: true, maxParallel: 3 });
  });

  it('defaults to disabled / 1 when the file is missing', () => {
    expect(getAutoModeState(root)).toMatchObject({ enabled: false, maxParallel: 1 });
  });

  it('defaults when the file is corrupt', () => {
    mkdirSync(join(root, '.teamai'), { recursive: true });
    writeFileSync(join(root, '.teamai', 'auto-mode.json'), '{not json');
    expect(getAutoModeState(root)).toMatchObject({ enabled: false, maxParallel: 1 });
  });
});
