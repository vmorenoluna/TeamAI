/**
 * Static scan of router.refresh() call sites.
 *
 * Mutations rely on the server action's revalidatePath, and WebSocket-driven
 * views re-sync through usePhaseSync (onResync + reconnect re-sync). The only
 * places allowed to call router.refresh() are the fallbacks listed below.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const ROOT = path.resolve(__dirname, '../..');
const SRC = path.join(ROOT, 'src');

const ALLOWED_REFRESH_FILES = [
  'src/hooks/use-phase-sync.ts',
  'src/components/kanban-board.tsx',
  'src/components/workflow-view.tsx',
];

/** Drop block and line comments so prose mentioning router.refresh() is not counted as a call. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
}

function walk(dir: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...walk(full));
    else if (/\.(ts|tsx)$/.test(entry.name)) files.push(full);
  }
  return files;
}

function readCode(rel: string): string {
  return stripComments(fs.readFileSync(path.join(ROOT, rel), 'utf-8'));
}

describe('router.refresh() call sites', () => {
  it('use-server-mutation.ts has no useRouter and no refresh(', () => {
    const code = readCode('src/hooks/use-server-mutation.ts');
    expect(code).not.toContain('useRouter');
    expect(code).not.toContain('refresh(');
  });

  it('router.refresh( appears only in the allowed files', () => {
    const offenders = walk(SRC)
      .filter((file) => stripComments(fs.readFileSync(file, 'utf-8')).includes('router.refresh('))
      .map((file) => path.relative(ROOT, file).split(path.sep).join('/'))
      .sort();
    expect(offenders).toEqual([...ALLOWED_REFRESH_FILES].sort());
  });
});

describe('build info', () => {
  it('layout.tsx uses getBuildInfo and does not compute the SHA per render', () => {
    const raw = fs.readFileSync(path.join(ROOT, 'src/app/layout.tsx'), 'utf-8');
    expect(raw).toMatch(/import\s*\{[^}]*\bgetBuildInfo\b[^}]*\}\s*from\s*['"]@\/lib\/build-info['"]/);
    const code = stripComments(raw);
    for (const forbidden of ['unstable_cache', 'child_process', 'execSync']) {
      expect(code).not.toContain(forbidden);
    }
  });

  it('server.ts computes build info at startup', () => {
    expect(readCode('server.ts')).toContain('getBuildInfo()');
  });
});
