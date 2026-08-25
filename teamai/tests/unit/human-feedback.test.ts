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
  buildSubtaskScopeNote,
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

  it('round-trips reviewer-selected subtask ids', () => {
    writeHumanFeedback(dir, 'coder', 'Rework these', [2, 5]);
    expect(readFileSync(feedbackFilePath(dir), 'utf-8')).toBe(
      '# Human Review Feedback\nTarget: coder\nSubtasks: 2,5\n\nRework these\n',
    );
    expect(readHumanFeedback(dir)).toEqual({
      target: 'coder',
      subtaskIds: [2, 5],
      message: 'Rework these',
    });
  });

  it('parses reviewer-selected subtask ids for a planner target', () => {
    writeHumanFeedback(dir, 'planner', 'Re-plan only the migration', [2, 5]);
    expect(readFileSync(feedbackFilePath(dir), 'utf-8')).toBe(
      '# Human Review Feedback\nTarget: planner\nSubtasks: 2,5\n\nRe-plan only the migration\n',
    );
    expect(readHumanFeedback(dir)).toEqual({
      target: 'planner',
      subtaskIds: [2, 5],
      message: 'Re-plan only the migration',
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

  it('clears any pending preserve-list snapshot from a prior interrupted replan', () => {
    // A crash mid-replan can leave plan_preserve_snapshot.json on disk. Any new
    // directive must invalidate it — it would otherwise be mistaken for a fresh
    // baseline on the next scoped planner replan.
    const snapshotPath = join(dir, 'plan_preserve_snapshot.json');
    writeFileSync(snapshotPath, '[{"subtask":{"id":2},"index":1}]');
    writeHumanFeedback(dir, 'planner', 'Re-plan the migration only', [1]);
    expect(existsSync(snapshotPath)).toBe(false);
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

describe('buildSubtaskScopeNote', () => {
  it('formats the scoped subtasks as a bullet list (rework mode)', () => {
    const note = buildSubtaskScopeNote([
      { id: 2, title: 'Fix auth module' },
      { id: 5, title: 'Add rate limiting' },
    ]);
    expect(note).toContain('rework ONLY these');
    expect(note).toContain('#2: Fix auth module');
    expect(note).toContain('#5: Add rate limiting');
  });

  it('expresses preserve-list semantics in replan mode', () => {
    const note = buildSubtaskScopeNote(
      [
        { id: 2, title: 'Fix auth module' },
        { id: 4, title: 'Add rate limiting' },
      ],
      'replan',
    );
    expect(note).toContain('re-plan ONLY these, do not regenerate or alter any other subtask');
    expect(note).toContain('#2: Fix auth module');
    expect(note).toContain('#4: Add rate limiting');
    expect(note).toContain('Every subtask NOT listed above must be preserved byte-for-byte');
    expect(note).toContain('acceptance_criteria');
  });

  it('keeps the coder note wording for the default rework mode', () => {
    const note = buildSubtaskScopeNote([{ id: 2, title: 'Fix auth module' }]);
    expect(note).toContain('rework ONLY these, do not touch others');
    expect(note).not.toContain('re-plan ONLY these');
    expect(note).not.toContain('byte-for-byte');
  });

  it('returns an empty string for no subtasks in either mode', () => {
    expect(buildSubtaskScopeNote([])).toBe('');
    expect(buildSubtaskScopeNote([], 'replan')).toBe('');
  });
});

describe('humanDirectiveFor', () => {
  it('returns the full override for the targeted agent', () => {
    writeHumanFeedback(dir, 'coder', 'Use the new client');
    const block = humanDirectiveFor(dir, 'coder');
    expect(block).toContain('OVERRIDES EVERYTHING');
  });

  it('surfaces the scoped subtasks in the coder override when plan.json lists them', () => {
    writeFileSync(join(dir, 'plan.json'), JSON.stringify({
      subtasks: [
        { id: 2, title: 'Fix auth module' },
        { id: 5, title: 'Add rate limiting' },
      ],
    }));
    writeHumanFeedback(dir, 'coder', 'Tighten these up', [2, 5]);
    const block = humanDirectiveFor(dir, 'coder');
    expect(block).toContain('OVERRIDES EVERYTHING');
    expect(block).toContain('#2: Fix auth module');
    expect(block).toContain('#5: Add rate limiting');
  });

  it('surfaces the planner preserve-list note in the planner override when plan.json lists them', () => {
    writeFileSync(join(dir, 'plan.json'), JSON.stringify({
      subtasks: [
        { id: 2, title: 'Fix auth module' },
        { id: 5, title: 'Add rate limiting' },
      ],
    }));
    writeHumanFeedback(dir, 'planner', 'Re-plan only the migration', [2]);
    const block = humanDirectiveFor(dir, 'planner');
    expect(block).toContain('OVERRIDES EVERYTHING');
    expect(block).toContain('re-plan ONLY these');
    expect(block).toContain('#2: Fix auth module');
    expect(block).toContain('byte-for-byte');
    // The planner note must NOT use the coder's rework wording.
    expect(block).not.toContain('rework ONLY these');
  });

  it('omits the scope note when plan.json is missing or no ids are selected', () => {
    writeHumanFeedback(dir, 'coder', 'Tighten these up', [2, 5]);
    const block = humanDirectiveFor(dir, 'coder');
    expect(block).toContain('OVERRIDES EVERYTHING');
    expect(block).not.toContain('rework ONLY these');
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
