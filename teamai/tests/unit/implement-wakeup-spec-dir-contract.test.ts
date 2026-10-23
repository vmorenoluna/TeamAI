/**
 * The implement command's wakeup contract must point a coder at the one spec
 * directory the orchestrator reads (`$TEAMAI_SPEC_DIR`, outside the worktree)
 * and have it record a PID the host OS can probe. A coder that wrote a relative
 * `.teamai/<slug>/` path put its wakeup file in a worktree copy the orchestrator
 * never scans, and a Git Bash `$!` PID is unknown to the native liveness check.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const body = readFileSync(join(process.cwd(), 'defaults', 'commands', '_shared', 'implement-body.md'), 'utf-8');

describe('implement-body wakeup contract', () => {
  it('states that the spec directory is outside the worktree and must be addressed absolutely', () => {
    expect(body).toContain('is **not** inside your worktree');
    expect(body).toContain('SPEC_DIR=');
    expect(body).not.toMatch(/inside the\s+worktree and gitignored/);
  });

  it('records the OS-native PID for Windows Git Bash and leaves Linux/macOS `$!` as is', () => {
    expect(body).toContain('/proc/$pid/winpid');
    expect(body).toContain('echo "$pid" > "$TEAMAI_SPEC_DIR/job-st<ID>.pid"');
    expect(body).toContain('Linux and macOS');
  });
});
