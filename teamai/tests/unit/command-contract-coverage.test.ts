/**
 * Command contract coverage — per work mode.
 *
 * guardrail-coverage.test.ts pins individual rules to individual files. This
 * suite pins the orchestration contract to the WORK MODES an agent can be
 * dispatched into (see tests/utils/agent-prompts.ts): every rule the
 * orchestrator or a later phase mechanically relies on must be present in the
 * instructions that govern each mode that needs it — the wakeup file schema
 * for every phase that can launch a long job, the plan.json schema for both
 * fresh plans and re-plans, the "don't push" rule for every session that
 * commits, and so on.
 *
 * It is written against the mode, not the file, so restructuring the command
 * files (splitting a mode out into its own command, sharing sections between
 * commands) must keep every row here passing.
 *
 * Signatures: at least one per rule must appear (case-insensitive).
 */
import { describe, it, expect } from 'vitest';
import { commandInstructions, type AgentMode } from '../utils/agent-prompts';

interface Rule { rule: string; signatures: string[] }

const r = (rule: string, ...signatures: string[]): Rule => ({ rule, signatures });

// ── Rule groups ──────────────────────────────────────────────────────────

const PIPELINE_PREAMBLE: Rule[] = [
  r('adopt the injected role persona', 'Adopt the role persona'),
  r('human directive override precedence', 'Human directive override'),
];

const PHASE_WAKEUP: Rule[] = [
  r('phase wakeup file name', 'phase_wakeup.json'),
  r('wakeup schema: wakeup_at', '"wakeup_at"'),
  r('wakeup schema: expected_artifact', '"expected_artifact"'),
  r('wakeup schema: progress_log_path', '"progress_log_path"'),
  r('detach long jobs so they outlive the session', 'nohup'),
  r('no inline waiting tools', 'Do NOT call an interactive `ScheduleWakeup`-style tool'),
  r('shell polling loops are inline waiting too', 'Shell polling loops count as waiting inline'),
  r('re-entry header handling', 'WAKEUP RE-ENTRY'),
  r('relaunch with a different command resets the budget', 'materially different'),
  r('spec dir env var for job files', 'TEAMAI_SPEC_DIR'),
];

const SUBTASK_WAKEUP: Rule[] = [
  r('per-subtask wakeup file name', 'subtask_wakeup-st<ID>.json'),
  r('wakeup schema: subtask_id', '"subtask_id"'),
  r('wakeup schema: wakeup_at', '"wakeup_at"'),
  r('wakeup schema: expected_artifact', '"expected_artifact"'),
  r('wakeup schema: progress_log_path', '"progress_log_path"'),
  r('detach long jobs so they outlive the session', 'nohup'),
  r('job files live inside the worktree, never /tmp', 'never in `/tmp`'),
  r('no inline waiting tools', 'Do NOT call an interactive `ScheduleWakeup`-style tool'),
  r('shell polling loops are inline waiting too', 'Shell polling loops count as waiting inline'),
  r('re-entry header handling', 'WAKEUP RE-ENTRY'),
  r('relaunch with a different command resets the budget', 'materially different'),
  r('blocked-subtask declaration file', 'subtask_blocked-st<ID>.json'),
];

const SPEC_OUTPUTS: Rule[] = [
  r('spec summary file', 'spec_summary.md'),
  r('deferred defects reported as parsed [BUG] lines', '[BUG] Fix:'),
];

const PLAN_CONTRACT: Rule[] = [
  r('plan.json schema: parallel_group', '"parallel_group"'),
  r('plan.json schema: depends_on', '"depends_on"'),
  r('files_to_create deliverables', 'files_to_create'),
  r('run-only gate subtasks flag', '"verify_only": true'),
  r('ticket-deferral marker QA auto-passes', "[SKIPPED] Ticket creation is the analyst's responsibility"),
  r('unverifiable criteria routed via plan_gaps.md', 'plan_gaps.md'),
  r('every spec criterion maps to a subtask', 'Plan coverage'),
  r('depends_on enforced across groups', '`depends_on` IS enforced'),
  r('gitignored artifacts need git add -f', 'git add -f'),
  r('no forward references between subtasks', 'never refers to a later subtask'),
];

const CODER_CONTRACT: Rule[] = [
  r('never push from the agent', 'Do NOT push'),
  r('run verification from the worktree', 'Run from the worktree'),
  r('dynamic ports', 'Use dynamic ports'),
  r("never kill other agents' processes", "Never kill what you didn't start"),
  r('scope limited to the subtask files', 'You may ONLY modify files explicitly listed'),
  r('pipeline artifacts are read-only', 'Do NOT create, modify, delete, stage, or commit pipeline artifacts'),
  r('files_to_create deliverables', 'files_to_create'),
  r('verify nothing in scope is left uncommitted', 'git status --porcelain'),
  r('verification-only subtasks commit an empty commit', 'git commit --allow-empty'),
  r('gitignored artifacts need git add -f', 'git add -f'),
  r('out-of-scope bugs reported as parsed [BUG] lines', '[BUG] Fix:'),
  r('never foreground a known-long job', 'NEVER foreground a known-long job'),
];

const QA_REWORK: Rule[] = [
  r('cleanup-only rework mode', 'Cleanup-Only Rework Mode'),
  r('persisted failures first', 'PERSISTED FAILURE'),
  r('QA criteria markers', '[QA CORRECTION]'),
  r('QA-fallback rework subtask scope', '(id 9999)'),
  r('fix_needed is the required change', 'fix_needed'),
  r('formula changes escalate as spec concerns', 'escalate it as a spec concern'),
];

// ── Mode → required rules ────────────────────────────────────────────────

const CONTRACT: Partial<Record<AgentMode, Rule[]>> = {
  'spec': [
    ...PIPELINE_PREAMBLE, ...PHASE_WAKEUP, ...SPEC_OUTPUTS,
    r('acceptance criteria format', 'Given/When/Then'),
    r('self-critique step', 'Self-Critique'),
  ],
  'spec-revise': [
    ...PIPELINE_PREAMBLE, ...PHASE_WAKEUP,
    r('spec summary file', 'spec_summary.md'),
    r('revision feedback file', 'spec_revision_feedback.md'),
    r('address every concern', 'Address EVERY concern'),
    r('preserve unchallenged parts', 'Preserve valid parts'),
    r('scoped research only', 'scoped to the feedback'),
    r('resolve every conditional', 'Resolve every conditional'),
    r('never write the archived baseline', 'archived previous version'),
    r('verify the spec actually changed', 'Verify you actually changed something'),
    r('before → after change report', 'before → after'),
  ],
  'plan': [...PIPELINE_PREAMBLE, ...PHASE_WAKEUP, ...PLAN_CONTRACT],
  'plan-revise': [
    ...PIPELINE_PREAMBLE, ...PHASE_WAKEUP, ...PLAN_CONTRACT,
    r('keep completed subtasks completed', '`completed: true`'),
    r('re-run only invalidated subtasks, dropping stale qa_flagged', 'qa_flagged'),
    r('rewrite plan.json in place', 'Rewrite `plan.json` in place'),
    r('scoped replan preserves unlisted subtasks byte-for-byte', 'byte-for-byte'),
  ],
  'implement': [...PIPELINE_PREAMBLE, ...SUBTASK_WAKEUP, ...CODER_CONTRACT],
  'implement-fix': [...PIPELINE_PREAMBLE, ...SUBTASK_WAKEUP, ...CODER_CONTRACT, ...QA_REWORK],
  'qa-review': [
    ...PIPELINE_PREAMBLE, ...PHASE_WAKEUP,
    r('rework-pass detection', 'Detect Rework Pass'),
    r('rework carry-forward keyed on head_at_review', 'head_at_review'),
    r('report schema: fail_type', '"fail_type"'),
    r('report schema: subtask_ids', '"subtask_ids"'),
    r('report schema: files_to_fix', '"files_to_fix"'),
    r('report schema: spec_concerns', '"spec_concerns"'),
    r('report written to the exact absolute path given', 'exact absolute path'),
    r('partial report checkpointing', 'IN_PROGRESS'),
    r('ticket-deferral auto-pass', "[SKIPPED] Ticket creation is the analyst's responsibility"),
    r('implementation summary on PASS', 'implementation_summary.md'),
    r('run verification from the worktree', 'Run from the worktree'),
  ],
  'merge': [
    r('adopt the injected role persona', 'Adopt the role persona'),
    r('never push from the agent', 'Do NOT push'),
    r('stage the merge for review before committing', '--no-commit'),
  ],
  'spec-summary': [
    r('adopt the injected role persona', 'Adopt the role persona'),
    r('summary length and focus', 'Roughly 3–8 lines of plain prose'),
    r('summary is the durable record embedded in the PR', 'embedded in the pull request'),
    r('never touch spec.md', 'Do NOT modify `spec.md`'),
  ],
  'resolve-cherry-pick': [
    r('adopt the injected role persona', 'Adopt the role persona'),
    r('never push from the agent', 'Do NOT push'),
    r('tests run before the cherry-pick is completed', 'Do NOT run `git cherry-pick --continue` yet'),
    r('remaining test failures are reported, never hidden', 'state clearly in your summary which tests fail'),
    r('only an unresolvable conflict is left unfinished', 'Leave the cherry-pick unfinished only if'),
    r('non-interactive continue', 'GIT_EDITOR=true git cherry-pick --continue'),
  ],
};

describe('command contract coverage per work mode', () => {
  for (const [mode, rules] of Object.entries(CONTRACT) as [AgentMode, Rule[]][]) {
    describe(mode, () => {
      const instructions = commandInstructions(mode);

      it('has instructions', () => {
        expect(instructions, `no instructions govern mode "${mode}"`).not.toBeNull();
      });

      for (const { rule, signatures } of rules) {
        it(`carries: ${rule}`, () => {
          const text = (instructions ?? '').toLowerCase();
          const found = signatures.some(sig => text.includes(sig.toLowerCase()));
          expect(found, `mode "${mode}" is missing "${rule}" (looked for: ${signatures.join(' | ')})`).toBe(true);
        });
      }
    });
  }
});
