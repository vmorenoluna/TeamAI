// @vitest-environment node

/**
 * Template coverage for the targeted human-feedback feature.
 *
 * 1. The "human directive overrides everything" rule must be baked into every
 *    command template — not just injected at runtime — so the agent honors the
 *    directive even if the runtime block is stripped. The role files
 *    intentionally do NOT repeat it: each command tells the agent to adopt its
 *    role, so the rule is delivered once via the command.
 * 2. The repo's own `.claude/` role/command files must mirror `defaults/`
 *    (the canonical template source synced to target projects). Divergence
 *    means a stale or contradictory instruction can leak to agents running on
 *    TeamAI itself.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'fs';
import { join } from 'path';

const root = process.cwd();

/** Command templates that must carry the override rule. The role files each
 *  command loads do not repeat it — the command is the single source. */
const OVERRIDE_FILES: string[] = [
  'defaults/commands/spec.md',
  'defaults/commands/plan.md',
  'defaults/commands/implement.md',
  'defaults/commands/qa-review.md',
];

function normalize(s: string): string {
  return s.replace(/\r\n/g, '\n');
}

function mdFiles(dir: string): string[] {
  return readdirSync(join(root, dir)).filter(f => f.endsWith('.md')).sort();
}

describe('human directive template coverage', () => {
  for (const file of OVERRIDE_FILES) {
    it(`${file} documents the human directive override rule`, () => {
      const p = join(root, file);
      expect(existsSync(p), `Missing template: ${file}`).toBe(true);
      const content = readFileSync(p, 'utf-8').toLowerCase();
      expect(content, `${file} is missing the override rule`).toContain('human directive');
      expect(content, `${file} must state the directive OVERRIDES other agents`).toContain('overrides');
    });
  }

  describe('.claude/ mirrors defaults/', () => {
    const dirs: [string, string][] = [
      ['commands', 'commands'],
      ['roles', 'roles'],
    ];

    for (const [defaultsDir, claudeDir] of dirs) {
      it(`${claudeDir} has the same file set as ${defaultsDir}`, () => {
        expect(mdFiles(join('.claude', claudeDir))).toEqual(mdFiles(join('defaults', defaultsDir)));
      });

      it(`${claudeDir} file contents match ${defaultsDir}`, () => {
        for (const f of mdFiles(join('defaults', defaultsDir))) {
          const defaults = normalize(readFileSync(join(root, 'defaults', defaultsDir, f), 'utf-8'));
          const claude = normalize(readFileSync(join(root, '.claude', claudeDir, f), 'utf-8'));
          expect(claude, `${claudeDir}/${f} drifted from ${defaultsDir}/${f}`).toBe(defaults);
        }
      });
    }
  });
});
