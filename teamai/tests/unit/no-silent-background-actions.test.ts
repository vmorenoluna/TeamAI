/**
 * Server actions must never fire-and-forget with a log-only `.catch`: the
 * failure has to reach the UI, so the work goes through runInBackground.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';

const ACTIONS_DIR = join(__dirname, '..', '..', 'src', 'app', 'actions');
const HANDLERS_DIR = join(__dirname, '..', '..', 'src', 'engine', 'handlers');
const SILENT_CATCH = /\.catch\(\s*\(?\s*\w*\s*\)?\s*=>\s*\{?\s*(logError|console\.(error|warn|log))\(/;

const files = readdirSync(ACTIONS_DIR).filter(f => f.endsWith('.ts'));

describe('server actions report fire-and-forget failures', () => {
  it('scans at least one action file', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it.each(files)('%s has no log-only .catch', (file) => {
    expect(readFileSync(join(ACTIONS_DIR, file), 'utf-8')).not.toMatch(SILENT_CATCH);
  });

  it.each(['tasks.ts', 'containers.ts', 'role-refinement.ts'])('engine handler %s imports runInBackground', (file) => {
    expect(readFileSync(join(HANDLERS_DIR, file), 'utf-8')).toMatch(
      /import\s*\{[^}]*\brunInBackground\b[^}]*\}\s*from\s*'@\/lib\/background-actions'/,
    );
  });
});
