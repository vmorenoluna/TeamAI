<!-- .claude/commands/role-refinement-analysis.md -->
You are diagnosing why a TeamAI pipeline ticket failed repeatedly. This command is internal to TeamAI — do not modify it, and do not adopt any pipeline role persona (you are not the analyst, planner, coder, QA reviewer, or merger).

Classify the root cause as exactly one of:
(a) a **role-prompt gap** — a missing or misworded persona/practice instruction in `.claude/roles/*.md`. This includes BOTH project-specific conventions AND universal analysis/engineering-discipline practices (e.g. "verify a cited artifact's evidence hasn't gone stale before trusting it", "don't delegate investigation to a later phase") — the test for role vs. command is *mechanical reliance*, not how project-specific or how universally-applicable the missing instruction is;
(b) an **orchestration-contract gap** — something the orchestrator or another pipeline phase MECHANICALLY relies on (an artifact schema, an output format that gets parsed, an execution-environment safety rule, a phase-transition mechanic) that's undocumented or wrong in `.claude/commands/*.md`;
(c) genuine task difficulty, a spec problem, or a code bug.

Only (a) produces role edits. (b) is an upstream command change, never a role edit. A missing guardrail that would help on every project but that nothing downstream parses or mechanically depends on is (a), not (b) — do not default it to (c) just because it isn't "project-specific."

Known contract-gap classes that are NOT role edits:
- an undocumented orchestrator mechanism (e.g. the `subtask_wakeup-st<id>.json` schema and its detach/nohup requirement, worktree/port discipline),
- a `.gitignore` / `git add -f` trap when committing verification evidence,
- an interactive-only tool that no-ops in headless sessions.
- a rule for one work mode only (spec revision, re-plan, QA rework, cherry-pick conflict resolution) — each mode has its own command, and a role file is loaded identically in every mode, so a role cannot target one.

A role gap is a persona or practice instruction missing or misworded in `.claude/roles/*.md`: house style, a repo-specific convention, a misworded project convention, OR a generic analysis/verification-discipline practice that isn't tied to any orchestrator mechanism.

Read the paths in $ARGUMENTS as **paths** (do not rely on summaries):
- `FAILURE_ARTIFACTS`: the task's QA report, event history, plan, and logs.
- `ROLE_FILES`: the project's current role files under `.claude/roles/`.

Write a single JSON object to the path given as `OUTPUT_FILE` in $ARGUMENTS, with exactly this shape:
{
  "isRolePromptGap": boolean,
  "contractGap": boolean,
  "contractFile": string|null,
  "rootCause": string,
  "confidence": "high"|"medium"|"low",
  "diagnosis": string,
  "edits": [ { "roleFile": string, "mode": "append"|"replace", "rationale": string, "proposedContent": string, "riskClass": "additive"|"modifying" } ]
}

Rules:
- `roleFile` must be the bare filename only (e.g. `"coder.md"`), never a path — even though `ROLE_FILES` above lists full paths so you can read the files, echo back only the final path segment.
- Prefer mode:"append" for additive fixes (a short block appended to the role file).
- If it is NOT a role-prompt gap, set isRolePromptGap:false, leave edits empty, and explain the real cause in diagnosis.
- If it IS a contract gap, also set contractGap:true and contractFile to the affected file under defaults/commands/ (e.g. "implement.md"), say so explicitly in diagnosis, and name the file that needs the upstream fix — never emit a role edit for it.
- Write diagnosis as a self-contained, copyable prompt the user can paste into a TeamAI-repo agent.

Write ONLY the JSON file. Do not write anything else.
