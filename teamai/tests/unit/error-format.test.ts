import { describe, expect, it } from 'vitest';
import { formatActionError } from '@/lib/error-format';

describe('formatActionError', () => {
  it('uses err.message when err is an Error instance', () => {
    expect(formatActionError('save pipeline config', new Error('disk full'))).toBe(
      'Failed to save pipeline config: disk full',
    );
  });

  it('falls back to "Unknown error" when err is a plain string', () => {
    expect(formatActionError('save pipeline config', 'plain string reason')).toBe(
      'Failed to save pipeline config: Unknown error',
    );
  });

  it('falls back to "Unknown error" when err is null', () => {
    expect(formatActionError('retry', null)).toBe(
      'Failed to retry: Unknown error',
    );
  });

  it('falls back to "Unknown error" when err is undefined', () => {
    expect(formatActionError('retry', undefined)).toBe(
      'Failed to retry: Unknown error',
    );
  });

  it('falls back to "Unknown error" when err is a plain object', () => {
    // Object with a `code` field but no `Error` prototype — should
    // NOT leak the object's string-representation.
    expect(formatActionError('merge', { code: 500, message: 'should be ignored' })).toBe(
      'Failed to merge: Unknown error',
    );
  });

  it('falls back to "Unknown error" when Error has empty message string', () => {
    // Strengthened guard (vs. the user's literal ternary spec):
    // `err instanceof Error && err.message ? err.message : 'Unknown error'`.
    // An `Error` instance with empty `.message` is treated like a non-Error
    // reject for fallback purposes — prevents the broken
    // `'Failed to <verb>: '` (trailing colon-space, empty suffix) banner
    // output that the literal-ternary guard would produce.
    expect(formatActionError('save', new Error(''))).toBe(
      'Failed to save: Unknown error',
    );
  });

  it('falls back to "Unknown error" when err is a number', () => {
    expect(formatActionError('start', 42)).toBe(
      'Failed to start: Unknown error',
    );
  });

  it('embeds the verb verbatim with no normalization', () => {
    // Spaces, hyphens, and punctuation in the verb are preserved.
    expect(formatActionError('create pull-request', new Error('auth failed'))).toBe(
      'Failed to create pull-request: auth failed',
    );
  });

  it('produces an empty-prefix-free template even with single-word verb', () => {
    expect(formatActionError('sync', new Error('EACCES'))).toBe(
      'Failed to sync: EACCES',
    );
  });

  it('treats subclassed Error via prototype chain as a regular Error', () => {
    // `instanceof Error` walks the prototype chain, so a subclassed
    // Error with a non-empty message surfaces `.message` in the banner
    // exactly like a plain `new Error(...)` would — cheap insurance
    // against future `instanceof` regressions (e.g., shadowing the
    // constructor or scoping the Symbol.hasInstance check).
    class AppError extends Error {}
    expect(formatActionError('retry', new AppError('boom'))).toBe(
      'Failed to retry: boom',
    );
  });

  it('falls back to "Unknown error" when subclassed Error has empty message', () => {
    // Subclassed Error constructed with no args → `.message === ''` —
    // same strengthened-guard path as a plain Error, still falls back.
    class PlainSubclass extends Error {}
    expect(formatActionError('retry', new PlainSubclass())).toBe(
      'Failed to retry: Unknown error',
    );
  });
});
