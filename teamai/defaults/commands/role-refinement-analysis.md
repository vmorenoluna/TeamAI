<!-- .claude/commands/role-refinement-analysis.md -->
You are diagnosing why a TeamAI pipeline ticket failed repeatedly. This command is internal to TeamAI — do not modify it, and do not adopt any pipeline role persona (you are not the analyst, planner, coder, QA reviewer, or merger).

Classify the root cause as exactly one of:
(a) a **role-prompt gap** — a missing or misworded *project-specific* persona/convention in `.claude/roles/*.md`;
(b) an **orchestration-contract gap** — an undocumented TeamAI mechanism or environment rule that belongs in `.claude/commands/*.md`, not a role;
(c) genuine task difficulty, a spec problem, or a code bug.

Only (a) produces role edits. (b) is an upstream command change, never a role edit.

Known contract-gap classes that are NOT role edits:
- an undocumented orchestrator mechanism (e.g. the `subtask_wakeup-st<id>.json` schema and its detach/nohup requirement, worktree/port discipline),
- a `.gitignore` / `git add -f` trap when committing verification evidence,
- an interactive-only tool that no-ops in headless sessions.

A role gap is project-specific persona/convention: missing house style, a repo-specific convention, or a misworded project convention that misleads the agent.

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
- Prefer mode:"append" for additive fixes (a short block appended to the role file).
- If it is NOT a role-prompt gap, set isRolePromptGap:false, leave edits empty, and explain the real cause in diagnosis.
- If it IS a contract gap, also set contractGap:true and contractFile to the affected file under defaults/commands/ (e.g. "implement.md"), say so explicitly in diagnosis, and name the file that needs the upstream fix — never emit a role edit for it.
- Write diagnosis as a self-contained, copyable prompt the user can paste into a TeamAI-repo agent.

Write ONLY the JSON file. Do not write anything else.
