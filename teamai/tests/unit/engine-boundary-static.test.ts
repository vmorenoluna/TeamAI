import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join, relative } from 'path';

const ROOT = join(__dirname, '..', '..');

const ENGINE_ONLY_SYMBOLS = [
  'getOrchestrator', 'processManager', 'runInBackground', 'isBackgroundPending', 'getBackgroundResult',
  'setAutoModeState', 'retryAutoMerge', 'containerManager', 'checkDockerAvailable',
];

const SERVER_FORBIDDEN_MODULES = [
  '@/lib/orchestrator', './src/lib/orchestrator', 'process-manager', 'auto-mode', 'recovery',
  'role-refinement-watcher', 'container-manager', 'orchestrator/worktree-ops',
];

interface ImportStatement {
  typeOnly: boolean;
  /** Names inside `{ ... }` (with `type` markers resolved), default/namespace names included. */
  valueNames: string[];
  specifier: string;
}

/** Parses static `import ... from '...'` and bare `import '...'` statements out of a source string. */
export function parseImports(source: string): ImportStatement[] {
  const result: ImportStatement[] = [];
  const re = /^\s*import\s+(type\s+)?([^'"]*?)\s*from\s*['"]([^'"]+)['"]|^\s*import\s*['"]([^'"]+)['"]/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    if (m[4]) {
      result.push({ typeOnly: false, valueNames: [], specifier: m[4] });
      continue;
    }
    const typeOnly = !!m[1];
    const clause = m[2];
    const valueNames: string[] = [];
    const braces = clause.match(/\{([^}]*)\}/);
    if (braces) {
      for (const part of braces[1].split(',')) {
        const item = part.trim();
        if (!item || /^type\s/.test(item)) continue;
        const asMatch = item.match(/^(\w+)\s+as\s+\w+$/);
        valueNames.push(asMatch ? asMatch[1] : item);
      }
    }
    const outside = clause.replace(/\{[^}]*\}/, '').replace(/,/g, ' ').trim();
    for (const name of outside.split(/\s+/)) {
      if (name && name !== '*' && name !== 'as') valueNames.push(name);
    }
    result.push({ typeOnly, valueNames, specifier: m[3] });
  }
  return result;
}

/** Rule 1: engine-only symbols imported as values (returns the offending symbols). */
export function findEngineOnlyValueImports(source: string): string[] {
  const found: string[] = [];
  for (const imp of parseImports(source)) {
    if (imp.typeOnly) continue;
    for (const name of imp.valueNames) {
      if (ENGINE_ONLY_SYMBOLS.includes(name)) found.push(name);
    }
  }
  return found;
}

/** Rule 2: engine-client may only import ./protocol or type-only (returns the offending specifiers). */
export function findEngineClientViolations(source: string): string[] {
  return parseImports(source)
    .filter(imp => !imp.typeOnly && imp.specifier !== './protocol')
    .map(imp => imp.specifier);
}

/** Rule 3: server.ts importing engine-side modules (returns the offending specifiers). */
export function findServerViolations(source: string): string[] {
  return parseImports(source)
    .map(imp => imp.specifier)
    .filter(spec => SERVER_FORBIDDEN_MODULES.some(forbidden => {
      if (forbidden.startsWith('@/') || forbidden.startsWith('./')) {
        return spec === forbidden || spec.startsWith(forbidden + '/');
      }
      return spec.split('/').some(seg => seg === forbidden) || spec.endsWith('/' + forbidden) || spec.includes(forbidden);
    }));
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(entry)) out.push(full);
  }
  return out;
}

describe('engine boundary: rule detectors', () => {
  it('rule 1 flags value imports of engine-only symbols, including aliased and multi-line ones', () => {
    expect(findEngineOnlyValueImports(`import { processManager } from '@/lib/process-manager';`)).toEqual(['processManager']);
    expect(findEngineOnlyValueImports(`import { getOrchestrator as go } from '@/lib/orchestrator';`)).toEqual(['getOrchestrator']);
    expect(findEngineOnlyValueImports(`import {\n  runInBackground,\n  type Foo,\n} from '@/lib/background-actions';`)).toEqual(['runInBackground']);
    expect(findEngineOnlyValueImports(`import { checkDockerAvailable, type ContainerState } from '@/lib/container-manager';`)).toEqual(['checkDockerAvailable']);
  });

  it('rule 1 ignores type-only imports and unrelated names', () => {
    expect(findEngineOnlyValueImports(`import type { processManager } from '@/lib/process-manager';`)).toEqual([]);
    expect(findEngineOnlyValueImports(`import { type containerManager } from '@/lib/container-manager';`)).toEqual([]);
    expect(findEngineOnlyValueImports(`import { engineCall } from '@/engine/engine-client';`)).toEqual([]);
  });

  it('rule 2 flags non-protocol value imports in engine-client', () => {
    expect(findEngineClientViolations(`import { getOrchestrator } from '@/lib/orchestrator';`)).toEqual(['@/lib/orchestrator']);
    expect(findEngineClientViolations(`import { handlers } from './handlers';`)).toEqual(['./handlers']);
  });

  it('rule 2 allows ./protocol and type-only imports', () => {
    expect(findEngineClientViolations(`import { EngineUnavailableError } from './protocol';\nimport type { Task } from '@/lib/task-store';`)).toEqual([]);
  });

  it('rule 3 flags every forbidden module in server.ts', () => {
    const fixtures = [
      '@/lib/orchestrator', './src/lib/orchestrator', './src/lib/process-manager', './src/lib/auto-mode',
      './src/lib/recovery', './src/lib/role-refinement-watcher', './src/lib/container-manager',
      './src/lib/orchestrator/worktree-ops',
    ];
    for (const spec of fixtures) {
      expect(findServerViolations(`import { x } from '${spec}';`), spec).toEqual([spec]);
    }
    expect(findServerViolations(`import './src/lib/recovery';`)).toEqual(['./src/lib/recovery']);
  });

  it('rule 3 allows the modules server.ts legitimately imports', () => {
    const ok = `import { appEvents } from './src/lib/app-events';\nimport { startEngine } from './src/engine/engine-host';\nimport { projectStore } from './src/lib/project-store';`;
    expect(findServerViolations(ok)).toEqual([]);
  });
});

describe('engine boundary: repository sources', () => {
  it('no file under src/app imports an engine-only value', () => {
    const violations: string[] = [];
    for (const file of walk(join(ROOT, 'src', 'app'))) {
      const found = findEngineOnlyValueImports(readFileSync(file, 'utf-8'));
      if (found.length > 0) violations.push(`${relative(ROOT, file)}: ${found.join(', ')}`);
    }
    expect(violations).toEqual([]);
  });

  it('src/engine/engine-client.ts imports only ./protocol and types', () => {
    const source = readFileSync(join(ROOT, 'src', 'engine', 'engine-client.ts'), 'utf-8');
    expect(parseImports(source).length).toBeGreaterThan(0);
    expect(findEngineClientViolations(source)).toEqual([]);
  });

  it('server.ts does not import engine-side modules', () => {
    const source = readFileSync(join(ROOT, 'server.ts'), 'utf-8');
    expect(parseImports(source).length).toBeGreaterThan(0);
    expect(findServerViolations(source)).toEqual([]);
  });
});
