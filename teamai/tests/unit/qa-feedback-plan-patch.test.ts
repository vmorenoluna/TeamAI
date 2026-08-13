// @vitest-environment node

/**
 * Tests the plan.json patch step of writeQaFeedback in isolation:
 * a failed plan.json write must warn (not swallow) while qa_feedback.md
 * (the primary channel) is still written first.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockWarn, mockWriteFileSync } = vi.hoisted(() => ({
  mockWarn: vi.fn(),
  mockWriteFileSync: vi.fn(),
}));

vi.mock('fs', () => ({
  existsSync: vi.fn(() => true),
  readFileSync: vi.fn(() => JSON.stringify({
    subtasks: [
      {
        id: 1,
        title: 'Add feature',
        files: ['src/feature.ts'],
        acceptance_criteria: ['criterion text'],
      },
    ],
  })),
  writeFileSync: mockWriteFileSync,
}));

vi.mock('../../src/lib/logger', () => ({
  log: vi.fn(),
  warn: mockWarn,
  error: vi.fn(),
  info: vi.fn(),
}));

import { writeQaFeedback } from '../../src/lib/orchestrator/qa-feedback';

const report = {
  overall: 'FAIL',
  criteria: [{ status: 'FAIL', criterion: 'criterion text', fix_needed: 'fix it' }],
};

describe('writeQaFeedback — plan.json patch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockWriteFileSync.mockReset();
  });

  it('warns when the plan.json patch write fails (qa_feedback.md still written)', () => {
    // First write (qa_feedback.md) succeeds; second (plan.json) throws.
    mockWriteFileSync
      .mockImplementationOnce(() => undefined)
      .mockImplementationOnce(() => { throw new Error('disk full'); });

    expect(() => writeQaFeedback('/test/spec', report as never)).not.toThrow();

    expect(mockWarn).toHaveBeenCalledWith(
      'qa-feedback',
      expect.stringContaining('Failed to patch plan.json'),
      expect.anything(),
    );
  });

  it('does not warn when the plan.json patch write succeeds', () => {
    writeQaFeedback('/test/spec', report as never);

    expect(mockWarn).not.toHaveBeenCalled();
  });
});
