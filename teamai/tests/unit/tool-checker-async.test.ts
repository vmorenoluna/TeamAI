/**
 * Real-process test: tool detection must not block the Node event loop.
 * No child_process mock here — a stub script stands in for docker.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { checkTool, _resetToolCheckCache } from '@/lib/tool-checker';

describe.skipIf(process.platform === 'win32')('checkTool — event loop', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tool-checker-async-'));
    // tools.json is resolved from process.cwd(), so point cwd at the temp dir
    vi.spyOn(process, 'cwd').mockReturnValue(dir);
    _resetToolCheckCache();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    _resetToolCheckCache();
    rmSync(dir, { recursive: true, force: true });
  });

  it('does not block timers while a slow tool is probed', async () => {
    const stub = join(dir, 'docker-stub.sh');
    writeFileSync(stub, '#!/bin/sh\nsleep 1\necho "Docker version 99.0"\n');
    chmodSync(stub, 0o755);
    writeFileSync(join(dir, 'tools.json'), JSON.stringify({ docker: stub }));

    const order: string[] = [];
    const timer = new Promise<void>(resolve => setTimeout(() => { order.push('timer'); resolve(); }, 50));
    const check = checkTool('docker').then(r => { order.push('check'); return r; });

    const [result] = await Promise.all([check, timer]);

    expect(order).toEqual(['timer', 'check']);
    expect(result.found).toBe(true);
    expect(result.version).toBe('Docker version 99.0');
    expect(result.customPath).toBe(true);
  });
});
