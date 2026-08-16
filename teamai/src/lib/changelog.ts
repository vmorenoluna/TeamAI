/**
 * Deterministic changelog generation.
 *
 * Replaces the former agent-based `/changelog` flow: grouping conventional
 * commits and rendering Keep-a-Changelog markdown is a mechanical
 * transformation that does not need a model. The pure parse/format helpers
 * are exported for unit testing; generateChangelogFile is the entry point
 * used by the roadmap action.
 */
import { execFileSync } from 'child_process';
import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';

export interface ChangelogEntry {
  /** Conventional-commit type: feat | fix | chore | docs | refactor | test | other */
  type: string;
  /** Commit subject after the `type(scope)!:` prefix. */
  description: string;
  /** True when the commit is flagged breaking (`!` or `BREAKING CHANGE`). */
  breaking: boolean;
}

/**
 * Record/field separators for the `git log` pretty format. Control characters
 * cannot appear in commit messages, so they are unambiguous delimiters.
 */
export const COMMIT_RECORD_SEP = '\x1e'; // between commits
export const COMMIT_FIELD_SEP = '\x1f'; // between hash/subject/body

const TYPE_ORDER = ['feat', 'fix', 'chore', 'docs', 'refactor', 'test', 'other'] as const;

const TYPE_LABELS: Record<string, string> = {
  feat: 'Added',
  fix: 'Fixed',
  chore: 'Changed',
  docs: 'Documentation',
  refactor: 'Refactored',
  test: 'Tests',
  other: 'Other',
};

/**
 * Parse `git log --pretty=format:"%h%x1f%s%x1f%b%x1e"` output into typed
 * changelog entries. Each record is `<hash>\x1f<subject>\x1f<body>\x1e`;
 * the subject carries the conventional-commit type, while `BREAKING CHANGE`
 * is detected in either the subject or the body.
 */
export function parseCommitLog(log: string): ChangelogEntry[] {
  const entries: ChangelogEntry[] = [];
  for (const record of log.split(COMMIT_RECORD_SEP)) {
    if (!record) continue;
    const [, subject = '', body = ''] = record.split(COMMIT_FIELD_SEP);
    const message = subject.trim();
    if (!message) continue;
    const breaking = /\bBREAKING CHANGE\b/i.test(message + '\n' + body);
    const match = message.match(/^([a-z][a-z0-9-]*)(?:\([^)]*\))?(!)?:\s*(.+)$/i);
    if (match) {
      entries.push({
        type: match[1].toLowerCase(),
        description: match[3].trim(),
        breaking: breaking || !!match[2],
      });
    } else {
      entries.push({ type: 'other', description: message, breaking });
    }
  }
  return entries;
}

/** Render typed entries as Keep-a-Changelog markdown for the given date. */
export function formatChangelog(entries: ChangelogEntry[], date: string): string {
  const groups = new Map<string, string[]>();
  for (const entry of entries) {
    const list = groups.get(entry.type) ?? [];
    list.push(`${entry.breaking ? '**Breaking:** ' : ''}${entry.description}`);
    groups.set(entry.type, list);
  }

  const lines: string[] = ['# Changelog', '', `## [${date}]`, ''];
  for (const type of TYPE_ORDER) {
    const items = groups.get(type);
    if (!items || items.length === 0) continue;
    lines.push(`### ${TYPE_LABELS[type]}`, '');
    for (const item of items) lines.push(`- ${item}`);
    lines.push('');
  }
  return lines.join('\n').trimEnd() + '\n';
}

/**
 * Generate `.teamai/roadmap/changelog-<date>.md` from recent git history.
 * Tolerates a non-git directory (produces an empty changelog) so the action
 * never throws just because the project has no repository yet.
 */
export function generateChangelogFile(projectPath: string): { filename: string; content: string } {
  const date = new Date().toISOString().slice(0, 10);
  let log = '';
  try {
    log = execFileSync(
      'git',
      [
        'log',
        '--no-merges',
        '-n',
        '200',
        `--pretty=format:%h%x1f%s%x1f%b%x1e`,
      ],
      {
        cwd: projectPath,
        encoding: 'utf-8',
        stdio: 'pipe',
      },
    );
  } catch {
    log = ''; // not a git repository — emit an empty changelog
  }

  const content = formatChangelog(parseCommitLog(log), date);
  const dir = join(projectPath, '.teamai', 'roadmap');
  mkdirSync(dir, { recursive: true });
  const filename = `changelog-${date}.md`;
  writeFileSync(join(dir, filename), content);
  return { filename, content };
}
