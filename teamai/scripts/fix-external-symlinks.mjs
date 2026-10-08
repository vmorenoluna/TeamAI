// Next's build step marks native-addon dependencies (e.g. node-pty) as server
// externals by creating a symlink under `.next/node_modules/<pkg>-<hash>` that
// points at the real package in the project's `node_modules/`. Two problems
// with that for Electron packaging:
//
//  1. Next writes the symlink target as an ABSOLUTE path — fine for
//     `next start` run in place, but it breaks once the whole project
//     directory is copied somewhere else (e.g. into an Electron package's
//     `resources/app/`), since the symlink still points at the original
//     build machine's path.
//  2. electron-builder doesn't do a plain glob copy of `node_modules` — it
//     cross-references the actual npm dependency graph to decide what to
//     include, so an ad hoc folder placed anywhere under any
//     `node_modules/` (nested or top-level) gets pruned as "not a real
//     dependency", `files` glob or not.
//
// This deletes each such symlink and replaces it with an equivalent tiny
// proxy package (package.json + index.js that `require()`s the real
// package via a relative path) placed under a plain, ordinary
// `external-shims/` directory instead — outside node_modules entirely, so
// none of the above applies. electron/main.js adds that directory to
// NODE_PATH so Node's module resolution still finds it at runtime.
import { readdirSync, statSync, readlinkSync, unlinkSync, mkdirSync, writeFileSync, existsSync } from 'fs';
import { join, dirname, basename, relative, isAbsolute, resolve } from 'path';

const shimsRoot = join(process.cwd(), 'external-shims');

function fixSymlinksIn(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const entryPath = join(dir, entry.name);
    if (entry.isSymbolicLink()) {
      const target = readlinkSync(entryPath);
      const targetPath = isAbsolute(target) ? target : resolve(dirname(entryPath), target);
      if (statSync(entryPath).isDirectory()) {
        unlinkSync(entryPath);

        const proxyName = basename(entryPath);
        const proxyDir = join(shimsRoot, proxyName);
        if (!existsSync(proxyDir)) {
          mkdirSync(proxyDir, { recursive: true });
          const relativeTarget = relative(proxyDir, targetPath).split('\\').join('/');
          writeFileSync(
            join(proxyDir, 'package.json'),
            JSON.stringify({ name: proxyName, main: 'index.js' }, null, 2) + '\n'
          );
          writeFileSync(
            join(proxyDir, 'index.js'),
            `module.exports = require(${JSON.stringify(relativeTarget)});\n`
          );
          console.log(`[fix-external-symlinks] ${proxyDir} -> require('${relativeTarget}') (replaces symlink at ${entryPath}, was ${target})`);
        }
      }
      continue;
    }
    if (entry.isDirectory() && entry.name === 'node_modules') {
      fixSymlinksIn(entryPath);
    }
  }
}

fixSymlinksIn('.next');
