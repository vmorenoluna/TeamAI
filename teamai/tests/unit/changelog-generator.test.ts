// @vitest-environment node

import { describe, it, expect } from 'vitest';
import {
  parseCommitLog,
  formatChangelog,
  COMMIT_RECORD_SEP,
  COMMIT_FIELD_SEP,
} from '@/lib/changelog';

const FS = COMMIT_FIELD_SEP;
const RS = COMMIT_RECORD_SEP;

/** Build one commit record: `<hash>\x1f<subject>\x1f<body>\x1e`. */
function commit(hash: string, subject: string, body = ''): string {
  return [hash, subject, body].join(FS) + RS;
}

describe('parseCommitLog', () => {
  it('parses conventional commits with type, scope, and description', () => {
    const entries = parseCommitLog(
      commit('abc1234', 'feat(auth): add login endpoint') +
        commit('def5678', 'fix(ui)!: repair broken toggle'),
    );
    expect(entries).toEqual([
      { type: 'feat', description: 'add login endpoint', breaking: false },
      { type: 'fix', description: 'repair broken toggle', breaking: true },
    ]);
  });

  it('treats non-conventional subjects as "other"', () => {
    const entries = parseCommitLog(commit('abc1234', 'random non-conventional message'));
    expect(entries).toEqual([
      { type: 'other', description: 'random non-conventional message', breaking: false },
    ]);
  });

  it('detects BREAKING CHANGE in the message body', () => {
    const entries = parseCommitLog(
      commit('abc1234', 'feat: rewrite engine', 'BREAKING CHANGE: new API'),
    );
    expect(entries[0].breaking).toBe(true);
  });

  it('ignores a missing subject even when a hash is present', () => {
    expect(parseCommitLog(commit('abc1234', ''))).toEqual([]);
  });

  it('returns an empty array for blank input', () => {
    expect(parseCommitLog('')).toEqual([]);
    expect(parseCommitLog('\n\n')).toEqual([]);
  });
});

describe('formatChangelog', () => {
  it('groups entries by type in stable section order and marks breaking changes', () => {
    const md = formatChangelog(
      [
        { type: 'fix', description: 'correct a crash', breaking: false },
        { type: 'feat', description: 'add dark mode', breaking: false },
        { type: 'feat', description: 'drop legacy API', breaking: true },
        { type: 'other', description: 'misc tidy-up', breaking: false },
      ],
      '2026-08-16',
    );

    expect(md).toContain('# Changelog');
    expect(md).toContain('## [2026-08-16]');
    expect(md).toContain('### Added');
    expect(md).toContain('### Fixed');
    expect(md).toContain('### Other');
    expect(md).toContain('- add dark mode');
    expect(md).toContain('- **Breaking:** drop legacy API');
    expect(md).toContain('- correct a crash');

    // Section order: Added before Fixed before Other.
    const added = md.indexOf('### Added');
    const fixed = md.indexOf('### Fixed');
    const other = md.indexOf('### Other');
    expect(added).toBeLessThan(fixed);
    expect(fixed).toBeLessThan(other);
  });

  it('omits sections with no entries', () => {
    const md = formatChangelog([{ type: 'docs', description: 'update README', breaking: false }], '2026-08-16');
    expect(md).toContain('### Documentation');
    expect(md).not.toContain('### Added');
    expect(md).not.toContain('### Fixed');
  });

  it('produces a header-only changelog for no entries', () => {
    const md = formatChangelog([], '2026-08-16');
    expect(md).toBe('# Changelog\n\n## [2026-08-16]\n');
  });
});
