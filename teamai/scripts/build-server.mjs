import { build } from 'esbuild';

await build({
  entryPoints: ['server.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  packages: 'external',
  outfile: 'dist-server/server.cjs',
  // Not bundled — it's expected to be missing in production; server.ts's
  // dynamic import()+try/catch around it relies on that to no-op there.
  external: ['./scripts/clear-port-3001.mjs'],
});
