import { build } from 'esbuild';

await build({
  entryPoints: ['server.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  packages: 'external',
  outfile: 'dist-server/server.cjs',
  external: ['next/*', './scripts/clear-port-3001.mjs'],
});
