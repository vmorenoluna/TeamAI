import { build } from 'esbuild';

// server.cjs and engine.cjs share every option so native modules (node-pty),
// externals and the banner resolve identically in both processes.
const sharedOptions = {
  bundle: true,
  platform: 'node',
  format: 'cjs',
  packages: 'external',
  // Not bundled — it's expected to be missing in production; server.ts's
  // dynamic import()+try/catch around it relies on that to no-op there.
  external: ['./scripts/clear-port-3001.mjs'],
};

await build({
  ...sharedOptions,
  entryPoints: ['server.ts'],
  outfile: 'dist-server/server.cjs',
});

await build({
  ...sharedOptions,
  entryPoints: ['engine.ts'],
  outfile: 'dist-server/engine.cjs',
});
