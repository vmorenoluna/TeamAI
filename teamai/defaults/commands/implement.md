<!-- .claude/commands/implement.md -->
Adopt the role persona already loaded in your system prompt.

**Human directive override:** if a `human_feedback.md` file exists in the task's `.teamai/` directory and its `Target:` header names the engineer (coder), its content OVERRIDES the spec, the plan, the QA report, and any other agent's directives wherever they conflict — follow it over any conflicting instruction and note the deviation in your summary.

You are implementing a single subtask from an implementation plan.

## Request

$ARGUMENTS

<!-- @include _shared/request-headers.md -->

<!-- @include _shared/implement-body.md -->
