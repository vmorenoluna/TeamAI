/**
 * Tests for _gitPush auto-refresh behavior.
 *
 * Verifies that when a gh OAuth token is rejected by the remote
 * ("Invalid username or token" / "Authentication failed"), the method
 * automatically runs `gh auth refresh` and retries once with a fresh token.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, existsSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';

// ── Hoisted mocks ──

const mockExecFileSync = vi.hoisted(() => vi.fn());

vi.mock('child_process', () => ({
  execFileSync: mockExecFileSync,
}));

vi.mock('../../src/lib/logger', () => ({
  warn: vi.fn(),
}));

vi.mock('../../src/lib/process-manager', () => ({
  processManager: {
    on: vi.fn(),
    off: vi.fn(),
    emit: vi.fn(),
    createSession: vi.fn(),
    sendMessage: vi.fn(),
    killSession: vi.fn(),
    getSession: vi.fn(),
    getAllSessions: vi.fn(() => []),
    getStaleSessions: vi.fn(() => []),
    removeStaleSession: vi.fn(),
    getTerminalSessions: vi.fn(() => []),
    killTerminalSession: vi.fn(),
    writeToSession: vi.fn(),
    terminateSession: vi.fn(),
  },
  containerSessionOpts: (projectRoot: string) => ({ projectRoot, permissionMode: 'bypassPermissions' as const }),
}));

vi.mock('../../src/lib/container-manager', () => ({
  readContainerConfig: vi.fn(() => ({ enabled: false, explicit: false })),
  readContainerRemoteUser: vi.fn(() => 'node'),
  containerManager: {
    ensureContainer: vi.fn(),
    getRunningContainer: vi.fn(() => null),
  },
  hostToContainerPath: vi.fn((p: string) => p),
  dockerAvailable: vi.fn(() => true),
  _resetDockerAvailableCache: vi.fn(),
}));

vi.mock('../../src/lib/providers', () => ({
  resolveProvider: vi.fn(() => ({ provider: 'anthropic', model: 'claude-sonnet-4-20250514' })),
  providerToSessionOpts: vi.fn(() => ({})),
}));

// ── Imports after mocks ──

import { getOrchestrator } from '../../src/lib/orchestrator';

type AnyOrch = any;

// ── Helpers ──

function setupTestDir(): { root: string; logFile: string; clean: () => void } {
  const root = join(tmpdir(), `teamai-gpr-${randomUUID().slice(0, 8)}`);
  mkdirSync(root, { recursive: true });
  const logFile = join(root, 'output.log');
  writeFileSync(logFile, ''); // ensure it exists
  const clean = () => {
    if (existsSync(root)) rmSync(root, { recursive: true, force: true });
  };
  return { root, logFile, clean };
}

const FAKE_TOKEN = 'gho_test123';
const FRESH_TOKEN = 'gho_fresh456';
const AUTH_ERROR = new Error(`
Command failed: git -c credential.helper= -c url.https://x-access-token:${FAKE_TOKEN}@github.com/.insteadOf=https://github.com/ push origin feat/test
remote: Invalid username or token. Password authentication is not supported for Git operations.
fatal: Authentication failed for 'https://github.com/user/repo.git/'
`.trim());

const AUTH_FAILED_ERROR = new Error(`
Command failed: git push origin feat/test
fatal: Authentication failed for 'https://github.com/user/repo.git/'
`.trim());

const GITLAB_AUTH_ERROR = new Error(`
Command failed: git -c credential.helper= -c url.https://x-access-token:${FAKE_TOKEN}@gitlab.com/.insteadOf=https://gitlab.com/ push origin feat/test
remote: HTTP Basic: Access denied. The provided password or token is incorrect or your account has 2FA enabled and you must use a personal access token in place of a password.
fatal: Authentication failed for 'https://gitlab.com/user/repo.git/'
`.trim());

const HTTP_401_ERROR = new Error(`
Command failed: git -c credential.helper= -c url.https://x-access-token:${FAKE_TOKEN}@github.com/.insteadOf=https://github.com/ push origin feat/test
error: RPC failed; HTTP 401 curl 22 The requested URL returned error: 401
fatal: the remote end hung up unexpectedly
`.trim());

const NON_AUTH_ERROR = new Error(`
Command failed: git push origin feat/test
! [rejected] feat/test -> feat/test (non-fast-forward)
`.trim());

// ── Tests ──

describe('_gitPush auto-refresh', () => {
  let testData: ReturnType<typeof setupTestDir>;
  let orch: AnyOrch;

  beforeEach(() => {
    vi.resetAllMocks();
    testData = setupTestDir();
    orch = getOrchestrator(testData.root) as AnyOrch;
  });

  afterEach(() => {
    testData.clean();
    vi.resetModules();
  });

  // ── Scenario 1: Token available, first attempt succeeds ───────────

  describe('token available, first attempt succeeds', () => {
    it('does not call gh auth refresh', () => {
      // _getToken → returns FAKE_TOKEN
      // _exec git call → succeeds (no throw)
      mockExecFileSync
        .mockImplementationOnce(() => FAKE_TOKEN)       // gh auth token
        .mockImplementationOnce(() => '');               // git push succeeds

      expect(() =>
        orch._gitPush(['push', 'origin', 'feat/test'], testData.logFile),
      ).not.toThrow();

      // gh auth token called once
      expect(mockExecFileSync).toHaveBeenCalledWith(
        'gh', ['auth', 'token'], expect.any(Object),
      );
      // git push called once with auth args
      expect(mockExecFileSync).toHaveBeenCalledWith(
        'git',
        expect.arrayContaining(['-c', 'credential.helper=', 'push', 'origin', 'feat/test']),
        expect.any(Object),
      );
      // gh auth refresh should NOT have been called
      const refreshCalls = mockExecFileSync.mock.calls.filter(
        (call: any[]) => call[0] === 'gh' && (call[1] as string[]).includes('refresh'),
      );
      expect(refreshCalls.length).toBe(0);
    });
  });

  // ── Scenario 2: Auth failure → refresh succeeds → retry succeeds ─

  describe('auth failure triggers refresh and retry', () => {
    it('refreshes token and retries once on "Invalid username or token"', () => {
      // _getToken → FAKE_TOKEN
      // first git push → throws AUTH_ERROR
      // gh auth refresh → succeeds
      // _getToken (retry) → FRESH_TOKEN
      // second git push → succeeds
      mockExecFileSync
        .mockImplementationOnce(() => FAKE_TOKEN)            // gh auth token
        .mockImplementationOnce(() => { throw AUTH_ERROR; }) // git push (fails)
        .mockImplementationOnce(() => '')                    // gh auth refresh (succeeds)
        .mockImplementationOnce(() => FRESH_TOKEN)           // gh auth token (retry)
        .mockImplementationOnce(() => '');                   // git push (retry succeeds)

      expect(() =>
        orch._gitPush(['push', 'origin', 'feat/test'], testData.logFile),
      ).not.toThrow();

      // gh auth token called twice (original + retry)
      expect(mockExecFileSync).toHaveBeenCalledWith(
        'gh', ['auth', 'token'], expect.any(Object),
      );
      // gh auth refresh called once
      expect(mockExecFileSync).toHaveBeenCalledWith(
        'gh', ['auth', 'refresh', '-s', 'repo'],
        expect.objectContaining({ encoding: 'utf-8' }),
      );
      // git push called twice (original + retry)
      const gitCalls = mockExecFileSync.mock.calls.filter(
        (call: any[]) => call[0] === 'git',
      );
      expect(gitCalls.length).toBe(2);

      // Second git call uses the fresh token in the args
      const retryArgs = gitCalls[1][1] as string[];
      const urlArg = retryArgs.find((a: string) => a.includes(`x-access-token:${FRESH_TOKEN}`));
      expect(urlArg).toBeDefined();
    });

    it('refreshes token and retries once on "Authentication failed"', () => {
      mockExecFileSync
        .mockImplementationOnce(() => FAKE_TOKEN)               // gh auth token
        .mockImplementationOnce(() => { throw AUTH_FAILED_ERROR; }) // git push (fails)
        .mockImplementationOnce(() => '')                       // gh auth refresh
        .mockImplementationOnce(() => FRESH_TOKEN)              // gh auth token (retry)
        .mockImplementationOnce(() => '');                      // git push (retry)

      expect(() =>
        orch._gitPush(['push', 'origin', 'feat/test'], testData.logFile),
      ).not.toThrow();

      // gh auth refresh was called
      const refreshCalls = mockExecFileSync.mock.calls.filter(
        (call: any[]) => call[0] === 'gh' && (call[1] as string[]).includes('refresh'),
      );
      expect(refreshCalls.length).toBe(1);
    });

    it('refreshes token and retries once on GitLab "HTTP Basic: Access denied"', () => {
      mockExecFileSync
        .mockImplementationOnce(() => FAKE_TOKEN)                  // gh auth token
        .mockImplementationOnce(() => { throw GITLAB_AUTH_ERROR; }) // git push (fails)
        .mockImplementationOnce(() => '')                           // gh auth refresh
        .mockImplementationOnce(() => FRESH_TOKEN)                  // gh auth token (retry)
        .mockImplementationOnce(() => '');                          // git push (retry)

      expect(() =>
        orch._gitPush(['push', 'origin', 'feat/test'], testData.logFile),
      ).not.toThrow();

      const refreshCalls = mockExecFileSync.mock.calls.filter(
        (call: any[]) => call[0] === 'gh' && (call[1] as string[]).includes('refresh'),
      );
      expect(refreshCalls.length).toBe(1);
    });

    it('refreshes token and retries once on HTTP 401 error', () => {
      mockExecFileSync
        .mockImplementationOnce(() => FAKE_TOKEN)               // gh auth token
        .mockImplementationOnce(() => { throw HTTP_401_ERROR; }) // git push (fails)
        .mockImplementationOnce(() => '')                        // gh auth refresh
        .mockImplementationOnce(() => FRESH_TOKEN)               // gh auth token (retry)
        .mockImplementationOnce(() => '');                       // git push (retry)

      expect(() =>
        orch._gitPush(['push', 'origin', 'feat/test'], testData.logFile),
      ).not.toThrow();

      const refreshCalls = mockExecFileSync.mock.calls.filter(
        (call: any[]) => call[0] === 'gh' && (call[1] as string[]).includes('refresh'),
      );
      expect(refreshCalls.length).toBe(1);
    });
  });

  // ── Scenario 3: Auth failure → refresh fails → original error ────

  describe('refresh fails, throws original error', () => {
    it('throws the redacted original error when refresh fails', () => {
      mockExecFileSync
        .mockImplementationOnce(() => FAKE_TOKEN)               // gh auth token
        .mockImplementationOnce(() => { throw AUTH_ERROR; })    // git push (fails)
        .mockImplementationOnce(() => {                         // gh auth refresh (fails)
          throw new Error('gh auth refresh: network error');
        })
        .mockImplementationOnce(() => {                         // Tier 2: credential helper also fails
          throw new Error('git push failed: no auth helper available');
        });

      try {
        orch._gitPush(['push', 'origin', 'feat/test'], testData.logFile);
        expect.fail('should have thrown');
      } catch (e: any) {
        expect(e.message).toContain('no auth helper available');
      }
    });
  });

  // ── Scenario 3b: Refresh succeeds → retry fails → Tier 2 fallback ─

  describe('refresh succeeds, retry fails, Tier 2 credential helper fallback', () => {
    it('does not retry more than once', () => {
      mockExecFileSync
        .mockImplementationOnce(() => FAKE_TOKEN)
        .mockImplementationOnce(() => { throw AUTH_ERROR; })
        .mockImplementationOnce(() => '')                       // refresh succeeds
        .mockImplementationOnce(() => FRESH_TOKEN)
        // Retry also fails with auth error — triggers Tier 2 credential helper fallback
        .mockImplementationOnce(() => { throw AUTH_ERROR; })
        .mockImplementationOnce(() => {                         // Tier 2: credential helper also fails
          throw new Error('credential helper fallback failed');
        });

      expect(() =>
        orch._gitPush(['push', 'origin', 'feat/test'], testData.logFile),
      ).toThrow('credential helper fallback failed');

      // gh auth refresh called exactly once (only on first failure, not Tier 2)
      const refreshCalls = mockExecFileSync.mock.calls.filter(
        (call: any[]) => call[0] === 'gh' && (call[1] as string[]).includes('refresh'),
      );
      expect(refreshCalls.length).toBe(1);
    });

    it('Tier 2 fires in correct scope (attempt=1) when retry fails with auth', () => {
      // Verifies the fix: Tier 2 falls back to credential helper from attempt=1
      // (not attempt=0, which was the bug before narrowing the try/catch).
      mockExecFileSync
        .mockImplementationOnce(() => FAKE_TOKEN)            // gh auth token
        .mockImplementationOnce(() => { throw AUTH_ERROR; }) // git push (fails) — Tier 1
        .mockImplementationOnce(() => '')                    // gh auth refresh (succeeds)
        .mockImplementationOnce(() => FRESH_TOKEN)           // gh auth token (retry)
        .mockImplementationOnce(() => { throw AUTH_ERROR; }) // retry fails with auth — Tier 2 at attempt=1
        .mockImplementationOnce(() => {                      // Tier 2: credential helper fails
          throw new Error('credential helper: no stored credentials');
        });

      try {
        orch._gitPush(['push', 'origin', 'feat/test'], testData.logFile);
        expect.fail('should have thrown');
      } catch (e: any) {
        // Tier 2 error propagates — no token in the message since _exec('', 2) has no token
        expect(e.message).toContain('no stored credentials');
        expect(e.message).not.toContain(FRESH_TOKEN);
      }

      // gh auth refresh called exactly once (Tier 2 does NOT refresh again)
      const refreshCalls = mockExecFileSync.mock.calls.filter(
        (call: any[]) => call[0] === 'gh' && (call[1] as string[]).includes('refresh'),
      );
      expect(refreshCalls.length).toBe(1);

      // git was called 3 times: original, retry, Tier 2 credential helper
      const gitCalls = mockExecFileSync.mock.calls.filter(
        (call: any[]) => call[0] === 'git',
      );
      expect(gitCalls.length).toBe(3);

      // Tier 2 call (3rd git call) has no auth args
      const tier2Args = gitCalls[2][1] as string[];
      expect(tier2Args).not.toContain('credential.helper=');
      expect(tier2Args.every((a: string) => !a.includes('x-access-token'))).toBe(true);
    });
  });

  // ── Scenario 4: Non-auth error → no refresh, error thrown ───────

  describe('non-auth error does not trigger refresh', () => {
    it('throws the error directly without calling gh auth refresh', () => {
      mockExecFileSync
        .mockImplementationOnce(() => FAKE_TOKEN)               // gh auth token
        .mockImplementationOnce(() => { throw NON_AUTH_ERROR; }); // git push (non-auth error)

      expect(() =>
        orch._gitPush(['push', 'origin', 'feat/test'], testData.logFile),
      ).toThrow(/non-fast-forward/);

      // gh auth refresh should NOT have been called
      const refreshCalls = mockExecFileSync.mock.calls.filter(
        (call: any[]) => call[0] === 'gh' && (call[1] as string[]).includes('refresh'),
      );
      expect(refreshCalls.length).toBe(0);
    });
  });

  // ── Scenario 5: No gh installed — fallback path ─────────────────

  describe('no gh installed — fallback to default credential helper', () => {
    it('runs git without auth args when gh auth token fails', () => {
      mockExecFileSync
        .mockImplementationOnce(() => {                        // gh auth token fails
          throw new Error('gh: command not found');
        })
        .mockImplementationOnce(() => {                        // git push also fails
          throw new Error('git push failed: no auth');
        });

      expect(() =>
        orch._gitPush(['push', 'origin', 'feat/test'], testData.logFile),
      ).toThrow('git push failed: no auth');

      // git should have been called WITHOUT auth args (no url.insteadOf)
      const gitCalls = mockExecFileSync.mock.calls.filter(
        (call: any[]) => call[0] === 'git',
      );
      expect(gitCalls.length).toBe(1);
      const gitArgs = gitCalls[0][1] as string[];
      expect(gitArgs).not.toContain('credential.helper=');
      expect(gitArgs.every((a: string) => !a.includes('x-access-token'))).toBe(true);
    });

    it('does not attempt gh auth refresh when no token available', () => {
      // Use a non-auth error to verify it doesn't trigger refresh even with a refreshable error
      const NO_GH_AUTH_ERROR = new Error(`
Command failed: git push origin feat/test
remote: Invalid username or token.
fatal: Authentication failed for 'https://github.com/user/repo.git/'
`.trim());

      mockExecFileSync
        .mockImplementationOnce(() => { throw new Error('gh: command not found'); })
        .mockImplementationOnce(() => { throw NO_GH_AUTH_ERROR; });

      expect(() =>
        orch._gitPush(['push', 'origin', 'feat/test'], testData.logFile),
      ).toThrow(/Invalid username or token/);

      // gh auth refresh should NOT have been called (no token to refresh)
      const refreshCalls = mockExecFileSync.mock.calls.filter(
        (call: any[]) => call[0] === 'gh' && (call[1] as string[]).includes('refresh'),
      );
      expect(refreshCalls.length).toBe(0);
    });
  });

  // ── Scenario 6: Token redaction in retry path ───────────────────

  describe('token redaction', () => {
    it('redacts the fresh token on retry failure', () => {
      expect.hasAssertions();
      mockExecFileSync
        .mockImplementationOnce(() => FAKE_TOKEN)               // gh auth token
        .mockImplementationOnce(() => { throw AUTH_ERROR; })    // git push (fails)
        .mockImplementationOnce(() => '')                       // refresh succeeds
        .mockImplementationOnce(() => FRESH_TOKEN)              // gh auth token (retry)
        .mockImplementationOnce(() => {                         // retry fails with non-auth error — Tier 2
          throw new Error(                                      // does NOT fire, redacted error propagates
            `Command failed: git -c url.https://x-access-token:${FRESH_TOKEN}@github.com/ push`);
        });

      try {
        orch._gitPush(['push', 'origin', 'feat/test'], testData.logFile);
      } catch (e: any) {
        // The error propagates from attempt 1 — redacted with FRESH_TOKEN
        expect(e.message).not.toContain(FRESH_TOKEN);
        expect(e.message).toContain('[REDACTED]');
      }
    });
  });
});
