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
import { execFileSync } from 'child_process';
import { getToolPath } from '../tool-checker';
import { logToOutput } from './helpers';
import path from 'path';

/**
 * Push (or pull) a branch to/from origin, injecting a GitHub OAuth token
 * via http.extraheader when the gh CLI is available.
 *
 * Falls back to a plain git command when gh is not installed or
 * not authenticated.
 */
export function gitPush(projectRoot: string, pushArgs: string[], logFile: string): void {
  const specPath = path.dirname(logFile);
  const noPromptEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0' };

  // Helper: obtain the gh OAuth token.
  const _getToken = (): string => {
    try {
      return execFileSync(getToolPath('gh'), ['auth', 'token'], { encoding: 'utf-8', stdio: 'pipe' }).trim();
    } catch {
      return '';
    }
  };

  const token = _getToken();

  // Resolve the actual remote URL so we can embed the token directly.
  let _remoteUrl: string | null = null;
  let _remoteIdx = -1;
  if (token) {
    try {
      for (let i = 1; i < pushArgs.length; i++) {
        if (!pushArgs[i].startsWith('-')) {
          _remoteIdx = i;
          _remoteUrl = execFileSync('git', ['remote', 'get-url', pushArgs[i]], {
            encoding: 'utf-8', stdio: 'pipe', cwd: projectRoot,
          }).trim();
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
  const _exec = (t: string, attempt: number): void => {
    const args = _buildInjectedArgs(t) ?? pushArgs;
    try {
      execFileSync('git', args, { cwd: projectRoot, stdio: 'pipe', env: noPromptEnv });
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
          execFileSync(getToolPath('gh'), ['auth', 'refresh', '-s', 'repo', '--hostname', hostname], {
            encoding: 'utf-8', stdio: 'pipe', timeout: 30_000,
          });
          freshToken = _getToken();
        } catch (refreshErr) {
          const refreshMsg = refreshErr instanceof Error
            ? refreshErr.message : String(refreshErr);
          logToOutput(specPath, `[GIT] gh auth refresh failed: ${refreshMsg}\n`);
        }

        if (freshToken) {
          logToOutput(specPath, '[GIT] Token refreshed — retrying\n');
          _exec(freshToken, 1);
          return;
        }
      }

      // Tier 2: gh token still rejected — fall back to system credential helper.
      if (attempt <= 1 && t && AUTH_RE.test(raw)) {
        logToOutput(specPath,
          '[GIT] gh token rejected — falling back to system credential helper\n');
        _exec('', 2);
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

  _exec(token, 0);
}
