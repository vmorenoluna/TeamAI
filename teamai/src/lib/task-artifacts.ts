import { join } from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { detectDefaultBranch } from '@/lib/orchestrator';
import type { QAReportData } from '@/lib/stream-types';
import { readTextIfExists } from '@/lib/fs-async';

const execFileAsync = promisify(execFile);

export interface CommonArtifacts {
  spec: string | null;
  qaReport: QAReportData | null;
  humanFeedback: string | null;
  diff: string | null;
}

async function readHumanFeedback(dir: string): Promise<string | null> {
  const text = await readTextIfExists(join(dir, 'human_feedback.md'));
  if (text === null) return null;
  const raw = text.replace(/^# Human Review Feedback\n\n/, '').trim();
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
  const spec = await readTextIfExists(specPath);

  // ── qa_report ──
  const qaPath = join(dir, 'qa_report.json');
  let qaReport: QAReportData | null = null;
  try {
    const qaRaw = await readTextIfExists(qaPath);
    if (qaRaw !== null) qaReport = JSON.parse(qaRaw);
  } catch {
    // invalid JSON — return null and warn so operators can spot QA agent corruption
    console.warn(`[task-artifacts] Invalid JSON in ${qaPath} — QA agent may have produced corrupt output`);
  }

  // ── human_feedback ──
  const humanFeedback = await readHumanFeedback(dir);

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
    diff = await readTextIfExists(join(dir, 'diff.txt'));
  }

  return { spec, qaReport, humanFeedback, diff };
}
