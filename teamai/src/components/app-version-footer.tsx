/**
 * Renders the app version + git HEAD badge at the bottom-left of the screen.
 *
 * Values are computed server-side (package.json version + git rev-parse HEAD
 * at build time) and passed as props, so they survive a fresh navigation without
 * triggering the no-async-fetch-on-mount lint rule.
 *
 * In the Electron renderer the preload.js bridge exposes getAppVersion() and
 * getGitHeadSha() — but the server-computed values are already correct for a
 * clean build, so we trust the server props and skip the extra IPC round-trip.
 * Only a dirty working tree would make them differ, which is an acceptable edge case.
 */
export interface AppVersionFooterProps {
  initialVersion: string;
  initialSha: string;
}

function shortSha(sha: string | null): string {
  if (!sha) return '';
  return sha.length >= 7 ? sha.slice(0, 7) : sha;
}

export function AppVersionFooter({ initialVersion, initialSha }: AppVersionFooterProps) {
  if (!initialVersion) return null;

  const sha = shortSha(initialSha);

  return (
    <footer className="fixed left-0 bottom-0 z-50 text-[11px] font-mono text-slate-500 select-none pointer-events-none">
      <span
        className="px-2 py-1 bg-[#11131b]/90 backdrop-blur rounded-r-none border border-slate-800/60 border-l-0"
        title="TeamAI build version"
      >
        Version {initialVersion}:{sha}
      </span>
    </footer>
  );
}
