import { createRequire } from 'node:module';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SKIP_DIRS = new Set(['node_modules', '.next', 'external-shims', 'locales']);
const SERVER_EXTENSIONS = new Set(['.js', '.cjs', '.mjs', '.json']);

function isFile(path) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function isDirectory(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function findPackagedAppRoots(outputDir) {
  const roots = [];
  const visit = (dir) => {
    if (isDirectory(join(dir, '.next', 'server'))) {
      roots.push(dir);
      return;
    }
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory() && !SKIP_DIRS.has(entry.name)) {
        visit(join(dir, entry.name));
      }
    }
  };

  visit(outputDir);
  return roots;
}

function listServerFiles(dir, result = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      listServerFiles(path, result);
    } else if (SERVER_EXTENSIONS.has(entry.name.slice(entry.name.lastIndexOf('.')))) {
      result.push(path);
    }
  }
  return result;
}

export function checkPackagedApp(appRoot) {
  const serverRoot = join(appRoot, '.next', 'server');
  const shimsRoot = join(appRoot, 'external-shims');
  if (!isDirectory(serverRoot)) {
    throw new Error(`Packaged app is missing .next/server: ${appRoot}`);
  }

  const serverFiles = listServerFiles(serverRoot);
  const referencedShimNames = new Set();
  for (const file of serverFiles) {
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(/require\([\"']([^\"']+-[a-f0-9]{16})[\"']\)/g)) {
      referencedShimNames.add(match[1]);
    }
  }
  // Some platform builds have no native externals and therefore correctly
  // produce neither shim references nor an external-shims directory.
  const shimEntries = isDirectory(shimsRoot)
    ? readdirSync(shimsRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory())
    : [];
  const shimNames = new Set(shimEntries.map((entry) => entry.name));
  const failures = [];
  for (const shimName of referencedShimNames) {
    if (!shimNames.has(shimName)) {
      failures.push(`${shimName}: referenced by a Next.js server bundle but missing from external-shims`);
    }
  }
  for (const entry of shimEntries) {
    const shimName = entry.name;
    const shimDir = join(shimsRoot, shimName);
    const packagePath = join(shimDir, 'package.json');
    if (!isFile(packagePath)) {
      failures.push(`${shimName}: missing package.json`);
      continue;
    }
    const packageJson = JSON.parse(readFileSync(packagePath, 'utf8'));
    if (packageJson.name !== shimName) {
      failures.push(`${shimName}: package.json name does not match its directory`);
      continue;
    }

    const entryPath = join(shimDir, packageJson.main || 'index.js');
    if (!isFile(entryPath)) {
      failures.push(`${shimName}: missing shim entry ${entryPath}`);
      continue;
    }
    const entrySource = readFileSync(entryPath, 'utf8');
    const requireMatch = entrySource.match(/require\(("[^"]+")\)/);
    if (!requireMatch) {
      failures.push(`${shimName}: shim entry has no static require target`);
      continue;
    }
    try {
      createRequire(entryPath).resolve(JSON.parse(requireMatch[1]));
    } catch (error) {
      failures.push(`${shimName}: shim entry cannot resolve its target (${error.message})`);
      continue;
    }

    if (!referencedShimNames.has(shimName)) {
      failures.push(`${shimName}: not referenced by any Next.js server bundle`);
    }
  }

  if (failures.length > 0) {
    throw new Error(`Release package smoke test failed for ${appRoot}:\n- ${failures.join('\n- ')}`);
  }

  return { appRoot, shimCount: shimEntries.length };
}

export function checkReleaseOutput(outputDir) {
  if (!isDirectory(outputDir)) {
    throw new Error(`Electron output directory does not exist: ${outputDir}`);
  }
  const appRoots = findPackagedAppRoots(outputDir);
  if (appRoots.length === 0) {
    throw new Error(`No unpacked Electron app with .next/server found under ${outputDir}`);
  }
  return appRoots.map(checkPackagedApp);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const outputDir = resolve(process.argv[2] || 'dist-electron');
  try {
    for (const result of checkReleaseOutput(outputDir)) {
      console.log(`[release-smoke] ${result.appRoot}: ${result.shimCount} external shim(s) verified`);
    }
  } catch (error) {
    console.error(`[release-smoke] ${error.message}`);
    process.exitCode = 1;
  }
}
