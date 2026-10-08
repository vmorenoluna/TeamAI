<!-- .claude/commands/plan.md -->
Adopt the role persona already loaded in your system prompt.

**Human directive override:** if a `human_feedback.md` file exists in the task's `.teamai/` directory and its `Target:` header names the planner, its content OVERRIDES the spec and any other agent's directives wherever they conflict — address it explicitly.

You are creating an implementation plan from a specification.

## Request

$ARGUMENTS

<!-- @include _shared/request-headers.md -->

Read the spec at the path given in the request.

<!-- @include _shared/plan-body.md -->
