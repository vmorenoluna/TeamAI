import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { detectDefaultBranch } from '@/lib/orchestrator';
import type { QAReportData } from '@/lib/stream-types';

const execFileAsync = promisify(execFile);

export interface CommonArtifacts {
  spec: string | null;
  qaReport: QAReportData | null;
  humanFeedback: string | null;
  diff: string | null;
}

function readHumanFeedback(dir: string): string | null {
  const path = join(dir, 'human_feedback.md');
  if (!existsSync(path)) return null;
  const raw = readFileSync(path, 'utf-8').replace(/^# Human Review Feedback\n\n/, '').trim();
  return raw || null;
}

/**
 * Read the artifacts shared by {@link getTaskArtifacts} and {@link getTaskFull}:
 * spec, QA report, human feedback, and git diff.
 *
 * @param dir          The task's `.teamai/<slug>/` directory.
 * @param projectPath  The project root (used for git diff).
 * @param branch       Optional git branch name for computing the diff.
 */
export async function readCommonArtifacts(
  dir: string,
  projectPath: string,
  branch?: string | null,
): Promise<CommonArtifacts> {
  // ── spec ──
  const specPath = join(dir, 'spec.md');
  const spec = existsSync(specPath) ? readFileSync(specPath, 'utf-8') : null;

  // ── qa_report ──
  const qaPath = join(dir, 'qa_report.json');
  let qaReport: QAReportData | null = null;
  if (existsSync(qaPath)) {
    try {
      qaReport = JSON.parse(readFileSync(qaPath, 'utf-8'));
    } catch {
      // invalid JSON — return null and warn so operators can spot QA agent corruption
      console.warn(`[task-artifacts] Invalid JSON in ${qaPath} — QA agent may have produced corrupt output`);
    }
  }

  // ── human_feedback ──
  const humanFeedback = readHumanFeedback(dir);

  // ── git diff ──
  let diff: string | null = null;
  if (branch) {
    try {
      const base = await detectDefaultBranch(projectPath);
      const promise = execFileAsync('git', ['diff', `${base}...${branch}`], {
        cwd: projectPath,
        encoding: 'utf-8',
        maxBuffer: 32 * 1024 * 1024,
      });
      promise.child?.stdin?.end();
      diff = (await promise).stdout;
    } catch {
      diff = null;
    }
  }
  // Fallback: pre-canned diff.txt for demo / mocked tasks
  if (!diff) {
    const diffPath = join(dir, 'diff.txt');
    if (existsSync(diffPath)) diff = readFileSync(diffPath, 'utf-8');
  }

  return { spec, qaReport, humanFeedback, diff };
}
