// @vitest-environment node

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import {
  writeHumanFeedback,
  readHumanFeedback,
  isFeedbackTarget,
  targetToResumePhase,
  buildOverrideDirective,
  buildContextNote,
  humanDirectiveFor,
  consumeFeedbackIfDue,
  feedbackFilePath,
} from '../../src/lib/orchestrator/human-feedback';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'human-feedback-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('writeHumanFeedback / readHumanFeedback', () => {
  it('writes a file with the header, Target line, and message', () => {
    writeHumanFeedback(dir, 'coder', 'Please use the new API client');
    const raw = readFileSync(feedbackFilePath(dir), 'utf-8');
    expect(raw).toBe('# Human Review Feedback\nTarget: coder\n\nPlease use the new API client\n');
  });

  it('parses the target and message back', () => {
    writeHumanFeedback(dir, 'analyst', 'The formula must be derived, not assumed');
    expect(readHumanFeedback(dir)).toEqual({
      target: 'analyst',
      message: 'The formula must be derived, not assumed',
    });
  });

  it('returns null when no feedback file exists', () => {
    expect(readHumanFeedback(dir)).toBeNull();
  });

  it('treats a legacy file without a Target line as target=undefined', () => {
    writeFileSync(feedbackFilePath(dir), '# Human Review Feedback\n\nFix the colors\n');
    expect(readHumanFeedback(dir)).toEqual({ message: 'Fix the colors' });
  });

  it('handles CRLF line endings in a legacy file', () => {
    writeFileSync(feedbackFilePath(dir), '# Human Review Feedback\r\n\r\nFix the colors\r\n');
    expect(readHumanFeedback(dir)).toEqual({ message: 'Fix the colors' });
  });
});

describe('isFeedbackTarget', () => {
  it('accepts the four valid targets', () => {
    for (const t of ['analyst', 'planner', 'coder', 'qa-reviewer']) {
      expect(isFeedbackTarget(t)).toBe(true);
    }
  });

  it('rejects invalid targets', () => {
    for (const t of ['merger', '', 'general', 42, null, undefined]) {
      expect(isFeedbackTarget(t)).toBe(false);
    }
  });
});

describe('targetToResumePhase', () => {
  it('maps every target to its resume phase', () => {
    expect(targetToResumePhase('analyst')).toBe('spec');
    expect(targetToResumePhase('planner')).toBe('plan');
    expect(targetToResumePhase('coder')).toBe('implement');
    expect(targetToResumePhase('qa-reviewer')).toBe('qa-review');
  });
});

describe('directive blocks', () => {
  const feedback = { target: 'coder' as const, message: 'Switch to fetch, drop axios' };

  it('buildOverrideDirective contains the message and override framing', () => {
    const block = buildOverrideDirective(feedback);
    expect(block).toContain('OVERRIDES EVERYTHING');
    expect(block).toContain('Switch to fetch, drop axios');
    expect(block).toContain('the engineer (coder)');
  });

  it('buildContextNote frames the directive as context for another agent', () => {
    const block = buildContextNote(feedback);
    expect(block).toContain('HUMAN DIRECTIVE CONTEXT');
    expect(block).toContain('Switch to fetch, drop axios');
    expect(block).not.toContain('OVERRIDES EVERYTHING');
  });
});

describe('humanDirectiveFor', () => {
  it('returns the full override for the targeted agent', () => {
    writeHumanFeedback(dir, 'coder', 'Use the new client');
    const block = humanDirectiveFor(dir, 'coder');
    expect(block).toContain('OVERRIDES EVERYTHING');
  });

  it('returns a context note to QA for a directive aimed at another agent', () => {
    writeHumanFeedback(dir, 'coder', 'Use the new client');
    const block = humanDirectiveFor(dir, 'qa-reviewer');
    expect(block).toContain('HUMAN DIRECTIVE CONTEXT');
    expect(block).not.toContain('OVERRIDES EVERYTHING');
  });

  it('returns the full override to QA when QA itself is the target', () => {
    writeHumanFeedback(dir, 'qa-reviewer', 'Re-review the auth module only');
    const block = humanDirectiveFor(dir, 'qa-reviewer');
    expect(block).toContain('OVERRIDES EVERYTHING');
  });

  it('returns nothing for a downstream non-QA phase', () => {
    writeHumanFeedback(dir, 'coder', 'Use the new client');
    expect(humanDirectiveFor(dir, 'planner')).toBe('');
  });

  it('returns nothing when no feedback is present', () => {
    expect(humanDirectiveFor(dir, 'coder')).toBe('');
  });
});

describe('consumeFeedbackIfDue', () => {
  it('deletes the file at the target-specific consuming phase', () => {
    writeHumanFeedback(dir, 'coder', 'Use the new client');
    consumeFeedbackIfDue(dir, 'qa-review');
    expect(existsSync(feedbackFilePath(dir))).toBe(false);
  });

  it('keeps the file before the consuming phase', () => {
    writeHumanFeedback(dir, 'coder', 'Use the new client');
    consumeFeedbackIfDue(dir, 'implement');
    expect(existsSync(feedbackFilePath(dir))).toBe(true);
  });

  it('does nothing when no feedback is present', () => {
    expect(() => consumeFeedbackIfDue(dir, 'qa-review')).not.toThrow();
  });
});
