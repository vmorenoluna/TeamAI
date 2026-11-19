// @vitest-environment node

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import {
  readScopeDeferral, recordScopeDeferral, clearScopeDeferral, scopeDeferralPath,
} from '../../src/lib/orchestrator/scope-arbitration';
import { SCOPE_ARTIFACTS } from '../../src/lib/orchestrator/artifacts';

describe('scope deferral marker', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), 'scope-deferral-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('is absent until a deferral is recorded', () => {
    expect(readScopeDeferral(dir, 25)).toBeNull();
  });

  it('round-trips the base per subtask', () => {
    recordScopeDeferral(dir, 25, 'abc123');
    expect(readScopeDeferral(dir, 25)).toEqual({ base: 'abc123' });
    expect(readScopeDeferral(dir, 26)).toBeNull();
  });

  it('keeps the earliest base when a later session defers again', () => {
    recordScopeDeferral(dir, 25, 'first');
    recordScopeDeferral(dir, 25, 'second');
    expect(readScopeDeferral(dir, 25)).toEqual({ base: 'first' });
  });

  it('ignores an empty base', () => {
    recordScopeDeferral(dir, 25, '');
    expect(existsSync(scopeDeferralPath(dir, 25))).toBe(false);
  });

  it('treats a malformed marker as absent', () => {
    writeFileSync(scopeDeferralPath(dir, 25), '{not json');
    expect(readScopeDeferral(dir, 25)).toBeNull();
    writeFileSync(scopeDeferralPath(dir, 25), JSON.stringify({ base: 5 }));
    expect(readScopeDeferral(dir, 25)).toBeNull();
  });

  it('clear removes the marker and tolerates a missing one', () => {
    recordScopeDeferral(dir, 25, 'abc123');
    clearScopeDeferral(dir, 25);
    expect(readScopeDeferral(dir, 25)).toBeNull();
    expect(() => clearScopeDeferral(dir, 25)).not.toThrow();
  });

  it('is cleared with the other plan-bound scope artifacts', () => {
    expect(SCOPE_ARTIFACTS).toContain('scope_deferred-st25.json');
  });
});
