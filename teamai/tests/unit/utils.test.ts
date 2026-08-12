import { describe, it, expect } from 'vitest';
import { slugify, truncate } from '@/lib/utils';

describe('slugify', () => {
  it('converts a normal title to lowercase hyphenated slug', () => {
    expect(slugify('My Task Title')).toBe('my-task-title');
  });

  it('handles special characters by replacing them with hyphens', () => {
    expect(slugify('Fix bug: render() crashes on null')).toBe('fix-bug-render-crashes-on-null');
  });

  it('replaces leading/trailing whitespace with hyphens (implementation behavior)', () => {
    expect(slugify('  padded title  ')).toBe('-padded-title-');
  });

  it('collapses multiple hyphens into single hyphen', () => {
    expect(slugify('too---many---hyphens')).toBe('too-many-hyphens');
  });

  it('handles very long titles (truncates to 40 chars)', () => {
    const longTitle = 'A'.repeat(200) + ' B '.repeat(50);
    const result = slugify(longTitle);
    expect(result.length).toBeLessThanOrEqual(40);
    expect(result).not.toContain(' ');
  });

  it('returns empty string for empty input', () => {
    expect(slugify('')).toBe('');
  });

  it('replaces unicode/non-ascii characters with hyphens', () => {
    expect(slugify('café résumé')).toBe('caf-r-sum-');
  });
});

describe('truncate', () => {
  it('returns the string unchanged when within the limit', () => {
    expect(truncate('short', 10)).toBe('short');
  });

  it('returns the string unchanged when exactly at the limit', () => {
    expect(truncate('1234567890', 10)).toBe('1234567890');
  });

  it('truncates with an ASCII ellipsis, never exceeding the limit', () => {
    const result = truncate('A'.repeat(40_000), 255);
    expect(result.length).toBe(255);
    expect(result.endsWith('...')).toBe(true);
    expect(result).not.toContain('A'.repeat(40_000));
  });
});
