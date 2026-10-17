/**
 * Git push with GitHub OAuth token injection.
 *
 * Injects the gh CLI OAuth token via http.extraheader so git push works
 * reliably in non-interactive Node.js-spawned processes.  Falls back to
 * the system credential helper when gh is unavailable.
 *
 * Also used for `git pull --ff-only origin master` — the same token
 * injection works for authenticated pulls.
 */
import { execFile } from 'child_process';
import { promisify } from 'util';
import { getToolPath } from '../tool-checker';
import { logToOutput } from './helpers';
import path from 'path';

const execFileAsync = promisify(execFile);

/**
 * Push (or pull) a branch to/from origin, injecting a GitHub OAuth token
 * via http.extraheader when the gh CLI is available.
 *
 * Falls back to a plain git command when gh is not installed or
 * not authenticated.
 */
export async function gitPush(projectRoot: string, pushArgs: string[], logFile: string): Promise<void> {
  const specPath = path.dirname(logFile);
  const noPromptEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0' };

  // Helper: obtain the gh OAuth token.
  const _getToken = async (): Promise<string> => {
    try {
      const p = execFileAsync(getToolPath('gh'), ['auth', 'token'], { encoding: 'utf-8', timeout: 10_000 });
      p.child?.stdin?.end();
      return (await p).stdout.trim();
    } catch {
      return '';
    }
  };

  const token = await _getToken();

  // Resolve the actual remote URL so we can embed the token directly.
  let _remoteUrl: string | null = null;
  let _remoteIdx = -1;
  if (token) {
    try {
      for (let i = 1; i < pushArgs.length; i++) {
        if (!pushArgs[i].startsWith('-')) {
          _remoteIdx = i;
          const p = execFileAsync('git', ['remote', 'get-url', pushArgs[i]], {
            encoding: 'utf-8', cwd: projectRoot, timeout: 5_000,
          });
          p.child?.stdin?.end();
          _remoteUrl = (await p).stdout.trim();
          break;
        }
      }
    } catch {
      // Remote resolution failed — fall back to pushArgs as-is
    }
  }

  // Helper: inject the token via http.extraheader, keeping the remote name intact.
  const _buildInjectedArgs = (t: string): string[] | null => {
    if (!t || _remoteIdx < 0 || !_remoteUrl?.startsWith('https://')) return null;
    const encoded = Buffer.from(`x-access-token:${t}`).toString('base64');
    return ['-c', `http.extraheader=Authorization: Basic ${encoded}`, ...pushArgs];
  };

  // ── Execute the git command with tiered auth fallback ──

  const AUTH_RE = /invalid username or token|authentication failed|http basic: access denied|returned error: 401\b/i;
  const _exec = async (t: string, attempt: number): Promise<void> => {
    const args = _buildInjectedArgs(t) ?? pushArgs;
    try {
      const p = execFileAsync('git', args, {
        cwd: projectRoot, env: noPromptEnv, maxBuffer: 32 * 1024 * 1024,
      });
      p.child?.stdin?.end();
      await p;
    } catch (err) {
      const raw = err instanceof Error ? err.message : String(err);
      const safe = t ? raw.replaceAll(t, '[REDACTED]') : raw;

      // Tier 1: On first auth failure with a gh token, refresh and retry once.
      if (attempt === 0 && t && AUTH_RE.test(raw)) {
        logToOutput(specPath,
          '[GIT] gh token rejected by remote — attempting gh auth refresh\n');
        let freshToken = null;
        try {
          const hostname = _remoteUrl ? new URL(_remoteUrl).hostname : 'github.com';
          const rp = execFileAsync(getToolPath('gh'), ['auth', 'refresh', '-s', 'repo', '--hostname', hostname], {
            encoding: 'utf-8', timeout: 30_000,
          });
          rp.child?.stdin?.end();
          await rp;
          freshToken = await _getToken();
        } catch (refreshErr) {
          const refreshMsg = refreshErr instanceof Error
            ? refreshErr.message : String(refreshErr);
          logToOutput(specPath, `[GIT] gh auth refresh failed: ${refreshMsg}\n`);
        }

        if (freshToken) {
          logToOutput(specPath, '[GIT] Token refreshed — retrying\n');
          await _exec(freshToken, 1);
          return;
        }
      }

      // Tier 2: gh token still rejected — fall back to system credential helper.
      if (attempt <= 1 && t && AUTH_RE.test(raw)) {
        logToOutput(specPath,
          '[GIT] gh token rejected — falling back to system credential helper\n');
        await _exec('', 2);
        return;
      }

      throw new Error(safe);
    }
  };

  // Log token availability
  if (token) {
    logToOutput(specPath, '[GIT] Using gh OAuth token via http.extraheader\n');
  } else {
    logToOutput(specPath,
      '[GIT] gh token not available — falling back to default credential helper\n');
  }

  await _exec(token, 0);
}
