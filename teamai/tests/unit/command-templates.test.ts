// @vitest-environment node

/**
 * command-templates — include expansion, `$ARGUMENTS` rendering, and the
 * invariants every shipped command template must hold.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import {
  expandCommandIncludes, listCommandNames, readCommandTemplate, renderCommand,
} from '../../src/lib/command-templates';

describe('command-templates (fixture directory)', () => {
  let dir: string;

  beforeEach(() => {
    dir = join(tmpdir(), `teamai-cmds-${randomUUID().slice(0, 8)}`);
    mkdirSync(join(dir, '_shared'), { recursive: true });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('expands include lines in place, recursively, trimming the fragment\'s trailing newline', () => {
    writeFileSync(join(dir, '_shared', 'inner.md'), 'INNER\n');
    writeFileSync(join(dir, '_shared', 'outer.md'), 'OUTER start\n<!-- @include _shared/inner.md -->\nOUTER end\n\n');
    expect(expandCommandIncludes('a\n<!-- @include _shared/outer.md -->\nb', dir))
      .toBe('a\nOUTER start\nINNER\nOUTER end\nb');
  });

  it('only treats a whole-line include directive as an include', () => {
    writeFileSync(join(dir, '_shared', 'x.md'), 'X');
    const text = 'see `<!-- @include _shared/x.md -->` inline';
    expect(expandCommandIncludes(text, dir)).toBe(text);
  });

  it('throws on a missing include instead of silently dropping a section', () => {
    expect(() => expandCommandIncludes('<!-- @include _shared/nope.md -->', dir)).toThrow(/not found/);
  });

  it('refuses includes that resolve outside the commands directory', () => {
    expect(() => expandCommandIncludes('<!-- @include ../secret.md -->', dir)).toThrow(/outside/);
  });

  it('refuses unbounded include recursion', () => {
    writeFileSync(join(dir, '_shared', 'loop.md'), '<!-- @include _shared/loop.md -->');
    expect(() => expandCommandIncludes('<!-- @include _shared/loop.md -->', dir)).toThrow(/nesting/);
  });

  it('lists top-level .md templates only, never the _shared fragments directory', () => {
    writeFileSync(join(dir, 'b.md'), 'b');
    writeFileSync(join(dir, 'a.md'), 'a');
    writeFileSync(join(dir, 'notes.txt'), 'n');
    writeFileSync(join(dir, '_shared', 'frag.md'), 'f');
    expect(listCommandNames(dir)).toEqual(['a', 'b']);
  });

  it('substitutes every $ARGUMENTS literally, even when args contain replacement patterns', () => {
    writeFileSync(join(dir, 'c.md'), 'head $ARGUMENTS mid $ARGUMENTS tail');
    expect(renderCommand('c', 'x $& $1 $$ y', dir)).toBe('head x $& $1 $$ y mid x $& $1 $$ y tail');
  });

  it('appends ARGUMENTS when the template has no placeholder (Claude Code\'s own expansion)', () => {
    writeFileSync(join(dir, 'm.md'), 'Merge the branch.\n\n');
    expect(renderCommand('m', 'origin/main', dir)).toBe('Merge the branch.\n\nARGUMENTS: origin/main');
  });

  it('throws for an unknown command', () => {
    expect(() => readCommandTemplate('missing', dir)).toThrow(/Unknown agent command/);
  });
});

/** Commands the orchestrator renders for pipeline sessions. */
const PIPELINE_COMMANDS = ['spec', 'spec-revise', 'plan', 'plan-revise', 'implement', 'implement-fix', 'qa-review', 'merge'];

describe('shipped command templates', () => {
  const names = listCommandNames();

  it('include the per-mode pipeline commands', () => {
    expect(names).toEqual(expect.arrayContaining(PIPELINE_COMMANDS));
  });

  for (const name of names) {
    describe(name, () => {
      const text = readCommandTemplate(name);

      it('starts with its own header line (how agents and logs identify the command)', () => {
        expect(text.startsWith(`<!-- .claude/commands/${name}.md -->\n`)).toBe(true);
      });

      it('has every include resolved', () => {
        expect(text).not.toMatch(/<!--\s*@include/);
      });

      if (PIPELINE_COMMANDS.includes(name)) {
        it('takes the orchestrator\'s request through at most one $ARGUMENTS placeholder', () => {
          expect(text.split('$ARGUMENTS').length).toBeLessThanOrEqual(2);
        });
      }
    });
  }
});
