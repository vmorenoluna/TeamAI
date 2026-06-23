import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { parseSessionLimitReset, formatCountdown } from '@/lib/rate-limit';

// ── parseSessionLimitReset ───────────────────────────────────────────────────

describe('parseSessionLimitReset', () => {
  beforeEach(() => {
    // Freeze time to 2026-06-23T10:00:00Z (noon UTC)
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-23T10:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns null for text without reset pattern', () => {
    expect(parseSessionLimitReset('some random text')).toBeNull();
    expect(parseSessionLimitReset('')).toBeNull();
  });

  it('parses morning time with am suffix', () => {
    // resets at 3:00am UTC → 3:00 UTC today
    // Since it's 10:00 UTC now, 3:00 is in the past → tomorrow 3:00
    const tomorrow = new Date(Date.UTC(2026, 5, 24, 3, 0, 0));
    const result = parseSessionLimitReset('resets 3:00 am UTC');
    expect(result).toBe(Math.floor(tomorrow.getTime() / 1000));
  });

  it('parses afternoon time with pm suffix', () => {
    // resets at 4:30pm UTC → 16:30 UTC today
    // It's 10:00 UTC now, 16:30 is still in the future
    const reset = new Date(Date.UTC(2026, 5, 23, 16, 30, 0));
    const result = parseSessionLimitReset('resets 4:30 pm UTC');
    expect(result).toBe(Math.floor(reset.getTime() / 1000));
  });

  it('handles 12am (midnight) correctly', () => {
    const tomorrow = new Date(Date.UTC(2026, 5, 24, 0, 0, 0));
    const result = parseSessionLimitReset('resets 12:00 am UTC');
    expect(result).toBe(Math.floor(tomorrow.getTime() / 1000));
  });

  it('handles 12pm (noon) correctly', () => {
    // It's 10:00 UTC now, 12:00 is in the future today
    const reset = new Date(Date.UTC(2026, 5, 23, 12, 0, 0));
    const result = parseSessionLimitReset('resets 12:00 pm UTC');
    expect(result).toBe(Math.floor(reset.getTime() / 1000));
  });

  it('parses without (UTC) marker', () => {
    // 5:00pm → 17:00 UTC today
    const reset = new Date(Date.UTC(2026, 5, 23, 17, 0, 0));
    const result = parseSessionLimitReset('resets 5:00 pm');
    expect(result).toBe(Math.floor(reset.getTime() / 1000));
  });

  it('parses with session limit prefix text', () => {
    // Claude's actual message: "You've hit your session limit · resets 3:45pm (UTC)"
    const reset = new Date(Date.UTC(2026, 5, 23, 15, 45, 0));
    const result = parseSessionLimitReset(
      "You've hit your session limit · resets 3:45pm (UTC)"
    );
    expect(result).toBe(Math.floor(reset.getTime() / 1000));
  });

  it('parses with mixed case', () => {
    const reset = new Date(Date.UTC(2026, 5, 23, 14, 0, 0));
    const result = parseSessionLimitReset('Session limit — resets 2:00 PM UTC');
    expect(result).toBe(Math.floor(reset.getTime() / 1000));
  });

  it('returns null for malformed time', () => {
    expect(parseSessionLimitReset('resets 25:00 pm')).toBeNull();
    // Missing minutes
    expect(parseSessionLimitReset('resets 3 pm')).toBeNull();
  });

  it('returns null for extreme numeric value 9999999999 (orchestrator test fixture)', () => {
    // The orchestrator test uses resetsAt: 9999999999 as a fixture.
    // When it appears as text, parseSessionLimitReset should return null
    // (no time pattern match) rather than crash or overflow.
    expect(parseSessionLimitReset('9999999999')).toBeNull();
    expect(parseSessionLimitReset('rate_limit_info: { resetsAt: 9999999999 }')).toBeNull();
  });

  it('advances to tomorrow if reset time is already past', () => {
    // 8:00am UTC today is already past (it's 10:00)
    const tomorrow = new Date(Date.UTC(2026, 5, 24, 8, 0, 0));
    const result = parseSessionLimitReset('resets 8:00 am UTC');
    expect(result).toBe(Math.floor(tomorrow.getTime() / 1000));
  });
});

// ── formatCountdown ──────────────────────────────────────────────────────────

describe('formatCountdown', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-23T10:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('formats seconds-only countdown', () => {
    // 30 seconds from now
    const resetsAt = Math.floor(Date.now() / 1000) + 30;
    expect(formatCountdown(resetsAt)).toBe('30s');
  });

  it('zero-pads seconds under 10', () => {
    const resetsAt = Math.floor(Date.now() / 1000) + 5;
    expect(formatCountdown(resetsAt)).toBe('5s');
  });

  it('formats minutes and seconds', () => {
    // 2 minutes 30 seconds from now
    const resetsAt = Math.floor(Date.now() / 1000) + 150;
    expect(formatCountdown(resetsAt)).toBe('2:30');
  });

  it('zero-pads minutes under 10', () => {
    const resetsAt = Math.floor(Date.now() / 1000) + 570; // 9:30
    expect(formatCountdown(resetsAt)).toBe('9:30');
  });

  it('formats hours and minutes', () => {
    // 3 hours 15 minutes from now
    const resetsAt = Math.floor(Date.now() / 1000) + 11700;
    expect(formatCountdown(resetsAt)).toBe('3h 15m');
  });

  it('handles exact hour boundary', () => {
    // exactly 2 hours from now
    const resetsAt = Math.floor(Date.now() / 1000) + 7200;
    expect(formatCountdown(resetsAt)).toBe('2h 0m');
  });

  it('rounds up fractional seconds via Math.ceil', () => {
    // 1.5 seconds → ceil to 2
    const resetsAt = Math.floor(Date.now() / 1000) + 2;
    // small delay to give 1.5s remaining
    vi.advanceTimersByTime(500);
    // Now: 10:00:00.500 UTC, resetsAt = 10:00:02 UTC → diff = 1500ms → ceil(1.5) = 2s
    expect(formatCountdown(resetsAt)).toBe('2s');
  });

  it('returns 0s when already past', () => {
    const resetsAt = Math.floor(Date.now() / 1000) - 10; // 10s in the past
    expect(formatCountdown(resetsAt)).toBe('0s');
  });
});
