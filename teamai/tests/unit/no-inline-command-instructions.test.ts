/**
 * No Inline Command Instructions
 *
 * `defaults/commands/*.md` are the single source of truth for the instructions
 * TeamAI hands an agent. Source code must render a command (command-templates.ts)
 * or point at it — never carry its text as a string literal. This test fails
 * when any run of NGRAM_SIZE consecutive words in a source string literal also
 * occurs, consecutively, in a command template.
 *
 * Tokens: lower-cased text, every maximal run of [a-z0-9_] is one token
 * (markdown, punctuation, backticks and escapes are ignored).
 * Source corpus: string / no-substitution-template / template head, middle and
 * tail text of every .ts/.tsx under src/ plus server.ts (tests excluded),
 * joined in source order — so `'a b ' + 'c d'` is caught. Comments and JSX text
 * are not collected.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative } from 'path';
import ts from 'typescript';
import { listCommandNames, readCommandTemplate } from '@/lib/command-templates';

const NGRAM_SIZE = 10;

interface AllowEntry {
  file: string;
  command: string;
  reason: string;
}

interface Violation {
  file: string;
  command: string;
  words: string;
}

const ALLOW_LIST: AllowEntry[] = [
  {
    file: 'src/app/actions/roadmap.ts',
    command: 'roadmap',
    reason: "category type union mirrors the command's output enum",
  },
];

export function tokenize(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9_]+/g) ?? [];
}

/** Map every NGRAM_SIZE-gram of every command to the (first) command containing it. */
export function buildIndex(commands: Record<string, string>): Map<string, string> {
  const index = new Map<string, string>();
  for (const [name, text] of Object.entries(commands)) {
    const tokens = tokenize(text);
    for (let i = 0; i + NGRAM_SIZE <= tokens.length; i++) {
      const gram = tokens.slice(i, i + NGRAM_SIZE).join(' ');
      if (!index.has(gram)) index.set(gram, name);
    }
  }
  return index;
}

/** Text of every string-ish literal in source order, joined with a single space. */
export function collectLiteralText(source: string, fileName: string): string {
  const kind = fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, kind);
  const parts: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      parts.push(node.text);
    } else if (
      node.kind === ts.SyntaxKind.TemplateHead ||
      node.kind === ts.SyntaxKind.TemplateMiddle ||
      node.kind === ts.SyntaxKind.TemplateTail
    ) {
      parts.push((node as ts.TemplateLiteralLikeNode).text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return parts.join(' ');
}

/** Violations for one source file: each distinct (command) match, with the first matched words. */
export function detectViolations(
  source: string,
  fileName: string,
  index: Map<string, string>,
): Violation[] {
  const tokens = tokenize(collectLiteralText(source, fileName));
  const found = new Map<string, Violation>();
  for (let i = 0; i + NGRAM_SIZE <= tokens.length; i++) {
    const words = tokens.slice(i, i + NGRAM_SIZE).join(' ');
    const command = index.get(words);
    if (command && !found.has(command)) found.set(command, { file: fileName, command, words });
  }
  return [...found.values()];
}

/** Split violations into those not allow-listed, and allow-list entries that matched nothing. */
export function applyAllowList(
  violations: Violation[],
  allowList: AllowEntry[],
): { unexpected: Violation[]; stale: AllowEntry[] } {
  for (const entry of allowList) {
    if (!entry.reason.trim()) throw new Error(`Allow-list entry for ${entry.file}/${entry.command} has no reason`);
  }
  const used = new Set<AllowEntry>();
  const unexpected = violations.filter(v => {
    const entry = allowList.find(e => e.file === v.file && e.command === v.command);
    if (entry) used.add(entry);
    return !entry;
  });
  return { unexpected, stale: allowList.filter(e => !used.has(e)) };
}

function listSourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name !== 'node_modules') listSourceFiles(full, out);
    } else if (/\.tsx?$/.test(name) && !name.includes('.test.')) {
      out.push(full);
    }
  }
  return out;
}

function loadCommands(): Record<string, string> {
  const commands: Record<string, string> = {};
  for (const name of listCommandNames()) commands[name] = readCommandTemplate(name);
  return commands;
}

function scanRepo(index: Map<string, string>): Violation[] {
  const root = process.cwd();
  const files = [...listSourceFiles(join(root, 'src')), join(root, 'server.ts')];
  const violations: Violation[] = [];
  for (const abs of files) {
    const rel = relative(root, abs).replace(/\\/g, '/');
    violations.push(...detectViolations(readFileSync(abs, 'utf-8'), rel, index));
  }
  return violations;
}

const fmt = (v: Violation) => `${v.file} duplicates command "${v.command}": "${v.words}"`;

describe('no inline command instructions', () => {
  const commands = loadCommands();
  const index = buildIndex(commands);

  it('has a command corpus to compare against', () => {
    expect(Object.keys(commands).length).toBeGreaterThan(0);
    expect(index.size).toBeGreaterThan(0);
  });

  it('every allow-list entry has a non-empty reason', () => {
    for (const e of ALLOW_LIST) expect(e.reason.trim().length).toBeGreaterThan(0);
  });

  it('source string literals do not duplicate command text', () => {
    const { unexpected } = applyAllowList(scanRepo(index), ALLOW_LIST);
    expect(unexpected.map(fmt)).toEqual([]);
  });

  it('has no stale allow-list entries', () => {
    const { stale } = applyAllowList(scanRepo(index), ALLOW_LIST);
    expect(stale.map(e => `${e.file} / ${e.command}`)).toEqual([]);
  });

  describe('detector fixtures', () => {
    const words = tokenize(commands['create-task']).slice(100, 100 + NGRAM_SIZE);
    // Pick a window that is unique to create-task so the named command is deterministic.
    const gram = words.join(' ');
    const expectedCommand = index.get(gram);

    it('fixture window comes from create-task', () => {
      expect(expectedCommand).toBe('create-task');
    });

    it('flags 10 copied words in a literal, naming the command', () => {
      const v = detectViolations(`const x = '${words.join(' ')}';`, 'f.ts', index);
      expect(v.map(x => x.command)).toEqual(['create-task']);
    });

    it('ignores 9 copied words', () => {
      expect(detectViolations(`const x = '${words.slice(0, 9).join(' ')}';`, 'f.ts', index)).toEqual([]);
    });

    it('flags 10 words split across concatenated literals', () => {
      const src = `const x = '${words.slice(0, 5).join(' ')} ' + '${words.slice(5).join(' ')}';`;
      expect(detectViolations(src, 'f.ts', index).map(x => x.command)).toEqual(['create-task']);
    });

    it('ignores 10 words that only occur in a // comment', () => {
      expect(detectViolations(`// ${words.join(' ')}\nconst x = 1;`, 'f.ts', index)).toEqual([]);
    });

    it('flags words in template literal parts', () => {
      const src = `const x = \`${words.slice(0, 5).join(' ')} \${y} ${words.slice(5).join(' ')}\`;`;
      expect(detectViolations(src, 'f.ts', index).map(x => x.command)).toEqual(['create-task']);
    });

    it('reports an allow-list entry with no match as stale', () => {
      const { unexpected, stale } = applyAllowList([], [
        { file: 'src/nowhere.ts', command: 'create-task', reason: 'fixture' },
      ]);
      expect(unexpected).toEqual([]);
      expect(stale).toHaveLength(1);
    });

    it('rejects an allow-list entry with an empty reason', () => {
      expect(() => applyAllowList([], [{ file: 'a.ts', command: 'spec', reason: '  ' }])).toThrow(/no reason/);
    });
  });
});
