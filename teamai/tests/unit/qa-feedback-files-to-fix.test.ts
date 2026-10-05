/**
 * files_to_fix: QA's structured list of the files a rework must change.
 * collectFilesToFix aggregates it, writeQaFeedback records it in qa_feedback.md,
 * readFilesToFix reads it back for the implement phase's deliverable freshness rule.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { collectFilesToFix, readFilesToFix, writeQaFeedback } from '../../src/lib/orchestrator/qa-feedback';
import type { QaReport } from '../../src/lib/orchestrator/types';

describe('files_to_fix', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'files-to-fix-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('unions files_to_fix across FAIL criteria and additional issues, normalising separators', () => {
    const report: QaReport = {
      overall: 'FAIL',
      criteria: [
        { criterion: 'A', status: 'FAIL', files_to_fix: ['a.log', 'dir\\b.log'] },
        { criterion: 'B', status: 'PASS' },
        { criterion: 'C', status: 'FAIL', files_to_fix: ['a.log'] },
      ],
      additional_issues: [{ description: 'x', files_to_fix: ['c.log'] }],
    };
    expect(collectFilesToFix(report)).toEqual(['a.log', 'dir/b.log', 'c.log']);
  });

  it('is [] when QA explicitly lists no file for every failing item', () => {
    const report: QaReport = { overall: 'FAIL', criteria: [{ criterion: 'A', status: 'FAIL', files_to_fix: [] }] };
    expect(collectFilesToFix(report)).toEqual([]);
  });

  it('is null (unspecified) when any failing item omits the field, or nothing failed', () => {
    expect(collectFilesToFix({
      overall: 'FAIL',
      criteria: [
        { criterion: 'A', status: 'FAIL', files_to_fix: ['a.log'] },
        { criterion: 'B', status: 'FAIL' },
      ],
    })).toBeNull();
    expect(collectFilesToFix({ overall: 'FAIL', criteria: [] })).toBeNull();
  });

  it('round-trips through qa_feedback.md, including the explicit-empty case', () => {
    writeQaFeedback(dir, { overall: 'FAIL', criteria: [{ criterion: 'A', status: 'FAIL', files_to_fix: ['a.log'] }] });
    expect(readFilesToFix(dir)).toEqual(['a.log']);
    expect(readFileSync(join(dir, 'qa_feedback.md'), 'utf-8')).toContain('## Files to fix');

    writeQaFeedback(dir, { overall: 'FAIL', criteria: [{ criterion: 'A', status: 'FAIL', files_to_fix: [] }] });
    expect(readFilesToFix(dir)).toEqual([]);
  });

  it('reads back null when QA did not specify, or there is no feedback file', () => {
    expect(readFilesToFix(dir)).toBeNull();
    writeQaFeedback(dir, { overall: 'FAIL', criteria: [{ criterion: 'A', status: 'FAIL' }] });
    expect(readFilesToFix(dir)).toBeNull();
    writeFileSync(join(dir, 'qa_feedback.md'), '# QA Feedback\n<!-- teamai:files_to_fix not-json -->\n');
    expect(readFilesToFix(dir)).toBeNull();
  });
});
