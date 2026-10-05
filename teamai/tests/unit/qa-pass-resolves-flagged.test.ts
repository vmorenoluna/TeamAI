/**
 * resolveQaFlaggedSubtasksOnPass: a QA PASS resolves the subtasks the previous FAIL flagged
 * (the "5 / 7 subtasks completed" board bug) without blind-stamping subtasks QA never flagged.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { resolveQaFlaggedSubtasksOnPass } from '../../src/lib/orchestrator/qa-review';
import type { TaskPipeline } from '../../src/lib/orchestrator/types';

describe('resolveQaFlaggedSubtasksOnPass', () => {
  let dir: string;
  let pipeline: TaskPipeline;
  const planPath = () => join(dir, 'plan.json');

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'qa-pass-plan-'));
    pipeline = { taskId: 't1', specPath: dir } as TaskPipeline;
  });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('completes qa_flagged subtasks and drops the marker', () => {
    writeFileSync(planPath(), JSON.stringify({
      complexity: 1,
      subtasks: [
        { id: 1, title: 'a', completed: true },
        { id: 4, title: 'b', completed: false, qa_flagged: true },
        { id: 6, title: 'c', qa_flagged: true },
      ],
    }));
    resolveQaFlaggedSubtasksOnPass(pipeline);
    const plan = JSON.parse(readFileSync(planPath(), 'utf-8'));
    expect(plan.subtasks).toEqual([
      { id: 1, title: 'a', completed: true },
      { id: 4, title: 'b', completed: true },
      { id: 6, title: 'c', completed: true },
    ]);
    expect(plan.complexity).toBe(1);
  });

  it('leaves subtasks QA never flagged exactly as they are (honest count)', () => {
    const raw = JSON.stringify({ subtasks: [{ id: 1, completed: true }, { id: 2, completed: false }, { id: 3 }] });
    writeFileSync(planPath(), raw);
    resolveQaFlaggedSubtasksOnPass(pipeline);
    expect(readFileSync(planPath(), 'utf-8')).toBe(raw);
  });

  it('does not throw when plan.json is missing or malformed', () => {
    expect(() => resolveQaFlaggedSubtasksOnPass(pipeline)).not.toThrow();
    writeFileSync(planPath(), 'not json');
    expect(() => resolveQaFlaggedSubtasksOnPass(pipeline)).not.toThrow();
  });
});
