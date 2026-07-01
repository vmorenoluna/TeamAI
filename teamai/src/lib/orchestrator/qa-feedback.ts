import { existsSync, readFileSync, writeFileSync } from 'fs';
import path from 'path';
import type { TaskStore } from '../task-store';

interface QaCriterion {
  status?: string;
  criterion?: string;
  name?: string;
  fix_needed?: string;
  notes?: string;
  evidence?: string;
}

interface QaIssue {
  description?: string;
  message?: string;
  file?: string;
  fix_needed?: string;
  severity?: string;
}

interface QaReport {
  overall?: string;
  criteria?: QaCriterion[];
  additional_issues?: QaIssue[];
  issues?: QaIssue[];
  fail_type?: string;
}

/** Write QA feedback for bouncing back to implement */
export function writeQaFeedback(specPath: string, report: QaReport): void {
  const feedbackPath = path.join(specPath, 'qa_feedback.md');
  let content = `# QA Feedback\n\n`;
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
      content += `- [${issue.severity || 'error'}] ${desc}${file}${fix}\n`;
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
                    return (
                      acLower.includes(critLower) ||
                      acLower.split(/\s+/).some((w: string) => critLower.split(/\s+/).every((cw: string) => w.includes(cw)))
                    );
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
                subtask.acceptance_criteria.push(`[QA ISSUE (${issue.severity || 'unknown'}): ${desc}${fix ? ` → Fix: ${fix}` : ''}]`);
                subtask.qa_flagged = true;
                modified = true;
              }
            }
          }
        }
        if (modified) {
          writeFileSync(planPath, JSON.stringify(plan, null, 2));
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
          content += `- ${issue.severity ? `[${issue.severity}] ` : ''}${desc}\n`;
        }
      }
    } catch { /* skip */ }
  }

  content += `\n---\n*Generated automatically on ${new Date().toISOString()}*\n`;
  writeFileSync(summaryPath, content);
  taskStore.update(taskId, { completionSummary: content });
}
