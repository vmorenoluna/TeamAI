import { existsSync, readFileSync, writeFileSync } from 'fs';
import path from 'path';
import type { TaskStore } from '../task-store';
import type { QaReport } from './types';
import { warn } from '../logger';

/** Write QA feedback for bouncing back to implement */
export function writeQaFeedback(
  specPath: string,
  report: QaReport,
  persistedCriterionFailCounts?: Record<string, number>,
): void {
  const feedbackPath = path.join(specPath, 'qa_feedback.md');
  let content = `# QA Feedback\n\n`;

  // Persisted FAIL criteria escalation: inject at the very top so the coder
  // sees it before anything else. These are criteria that have failed
  // identically across 2+ consecutive QA cycles.
  if (persistedCriterionFailCounts) {
    const escalated = Object.entries(persistedCriterionFailCounts)
      .filter(([, count]) => count >= 2)
      .map(([name, count]) => ({ name, count }));
    if (escalated.length > 0) {
      content += `## ⚠️ PERSISTED FAILURES — RESOLVE THESE FIRST ⚠️\n\n`;
      content += `The following criteria have failed **identically** across multiple consecutive QA cycles. `;
      content += `They MUST be resolved before addressing anything else below. `;
      content += `Do NOT deprioritize a persisted failure in favor of another issue.\n\n`;
      for (const { name, count } of escalated) {
        content += `> **"${name}"** — this exact criterion has failed **${count} times in a row**.\n`;
        content += `> Before considering it resolved, enumerate every case, verify each assertion direction (not comments/labels), and confirm the count meets the requirement.\n\n`;
      }
      content += `---\n\n`;
    }
  }

  content += `## ⚠️ IMPORTANT: QA Feedback OVERRIDES the plan\n\n`;
  content += `The issues listed below represent the latest requirements. `;
  content += `Where QA feedback and the plan's acceptance criteria conflict, **follow the QA feedback**. `;
  content += `The plan may be outdated — QA findings are the ground truth.\n\n`;
  content += `## Overall: ${report.overall}\n\n`;
  if (report.fail_type) {
    content += `**fail_type**: ${report.fail_type}\n\n`;
  }
  if (report.criteria) {
    content += `## Failed Criteria\n\n`;
    for (const c of report.criteria) {
      if (c.status === 'FAIL') {
        const name = c.criterion || c.name || 'Unknown criterion';
        const fix = c.fix_needed ? ` → Fix: ${c.fix_needed}` : '';
        content += `- **${name}**: ${c.notes || c.evidence || 'No details provided'}${fix}\n`;
      }
    }
  }
  if (report.additional_issues || report.issues) {
    const issues = (report.additional_issues ?? report.issues)!;
    content += `\n## Additional Issues\n\n`;
    for (const issue of issues) {
      const desc = issue.description || issue.message || JSON.stringify(issue);
      const file = issue.file ? ` (${issue.file})` : '';
      const fix = issue.fix_needed ? ` → Fix: ${issue.fix_needed}` : '';
      content += `- ${desc}${file}${fix}\n`;
    }
  }
  writeFileSync(feedbackPath, content);

  // Patch plan.json subtask acceptance criteria from QA findings
  const planPath = path.join(specPath, 'plan.json');
  if (existsSync(planPath)) {
    try {
      const plan = JSON.parse(readFileSync(planPath, 'utf-8'));
      if (plan.subtasks) {
        let modified = false;
        if (report.criteria) {
          for (const c of report.criteria) {
            if (c.status === 'FAIL' && c.fix_needed) {
              const criterionName = c.criterion || c.name || '';
              for (const subtask of plan.subtasks) {
                if (!subtask.acceptance_criteria) continue;
                const idx = subtask.acceptance_criteria.findIndex(
                  (ac: string) => {
                    const acLower = ac.toLowerCase();
                    const critLower = criterionName.toLowerCase();
                    // Primary: direct substring match
                    if (acLower.includes(critLower)) return true;
                    // Secondary: token-overlap scoring — match if ≥50% of criterion-name tokens
                    // (minus common stopwords) appear in the acceptance criterion text
                    const STOP_WORDS = new Set(['the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been',
                      'of', 'in', 'to', 'for', 'on', 'at', 'by', 'with', 'from', 'as', 'into', 'through',
                      'and', 'or', 'not', 'no', 'but', 'if', 'then', 'else', 'when', 'than', 'so',
                      'that', 'this', 'these', 'those', 'it', 'its', 'has', 'have', 'had', 'do', 'does',
                      'should', 'must', 'shall', 'will', 'can', 'may', 'would', 'could', 'might']);
                    const critTokens = critLower.split(/\s+/).filter(w => w.length > 1 && !STOP_WORDS.has(w));
                    if (critTokens.length === 0) return false;
                    const matchCount = critTokens.filter(cw => acLower.includes(cw)).length;
                    return matchCount >= Math.ceil(critTokens.length / 2);
                  }
                );
                if (idx >= 0) {
                  subtask.acceptance_criteria[idx] += ` [QA CORRECTION: ${c.fix_needed}]`;
                  subtask.qa_flagged = true;
                  modified = true;
                }
              }
            }
          }
        }
        const issues = report.additional_issues || report.issues;
        if (issues) {
          for (const issue of issues) {
            const desc = issue.description || issue.message || '';
            const fix = issue.fix_needed || '';
            if (!desc && !fix) continue;
            for (const subtask of plan.subtasks) {
              if (!subtask.files || !Array.isArray(subtask.files)) continue;
              if (issue.file && subtask.files.some((f: string) => {
                const issueBase = issue.file!.replace(/^.*[\\/]/, '');
                const fileBase = f.replace(/^.*[\\/]/, '');
                return fileBase === issueBase || f.endsWith(issue.file!) || issue.file!.endsWith(f);
              })) {
                if (!subtask.acceptance_criteria) subtask.acceptance_criteria = [];
                subtask.acceptance_criteria.push(`[QA ISSUE: ${desc}${fix ? ` → Fix: ${fix}` : ''}]`);
                subtask.qa_flagged = true;
                modified = true;
              }
            }
          }
        }
        if (modified) {
          try {
            writeFileSync(planPath, JSON.stringify(plan, null, 2));
          } catch (err) {
            // The qa_feedback.md written above is the primary channel, but a
            // failed plan.json patch silently drops subtask-level targeting —
            // surface it instead of swallowing.
            warn('qa-feedback', `Failed to patch plan.json with QA feedback at ${planPath}`, err);
          }
        }
      }
    } catch { /* best-effort */ }
  }
}

/** Write a completion summary when the task fails (max QA attempts reached) */
export function writeCompletionSummary(
  specPath: string,
  qaAttempt: number,
  taskId: string,
  taskStore: TaskStore,
): void {
  const summaryPath = path.join(specPath, 'completion_summary.md');
  let content = `# Completion Summary\n\n`;
  content += `Task failed after ${qaAttempt} QA attempts.\n\n`;

  const planPath = path.join(specPath, 'plan.json');
  if (existsSync(planPath)) {
    try {
      const plan = JSON.parse(readFileSync(planPath, 'utf-8'));
      if (plan.subtasks) {
        content += `## Plan Subtasks\n\n`;
        for (const s of plan.subtasks) {
          const done = s.completed ? 'COMPLETED' : 'NOT COMPLETED';
          content += `- [${s.completed ? 'x' : ' '}] **${s.title}** — ${done}\n`;
        }
      }
    } catch { /* skip */ }
  }

  const reportPath = path.join(specPath, 'qa_report.json');
  if (existsSync(reportPath)) {
    try {
      const report = JSON.parse(readFileSync(reportPath, 'utf-8'));
      content += `\n## Last QA Report\n\n`;
      content += `Overall: **${report.overall}**\n\n`;
      if (report.criteria) {
        content += `| Criterion | Status | Notes |\n`;
        content += `|-----------|--------|-------|\n`;
        for (const c of report.criteria) {
          const name = c.criterion || c.name || '-';
          content += `| ${name} | ${c.status} | ${c.notes || c.evidence || '-'} |\n`;
        }
      }
      if (report.additional_issues || report.issues) {
        const issues = report.additional_issues || report.issues;
        content += `\n### Issues\n\n`;
        for (const issue of issues) {
          const desc = issue.description || issue.message || JSON.stringify(issue);
          content += `- ${desc}\n`;
        }
      }
    } catch { /* skip */ }
  }

  content += `\n---\n*Generated automatically on ${new Date().toISOString()}*\n`;
  writeFileSync(summaryPath, content);
  taskStore.update(taskId, { completionSummary: content });
}
