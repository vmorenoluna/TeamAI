<!-- .claude/commands/spec-summary.md -->
Adopt the role persona already loaded in your system prompt.

The spec phase ended with `spec.md` written but no `spec_summary.md` next to it. Your only
job in this session is to write that summary.

## Request

$ARGUMENTS

## Instructions
1. Read the spec at the path given in the request. Do NOT modify `spec.md`.
2. Write `spec_summary.md` next to it (same directory):

- **Roughly 3–8 lines of plain prose**, capturing the feature's intent and the key decisions made in this spec — the "why" behind non-obvious choices (the approach picked over alternatives, notable formulas/thresholds and why, how tricky edge cases are handled). Do not restate the requirements list or acceptance criteria verbatim; summarize the reasoning, not the checklist.
- Write it for another agent or a human reviewer to understand the spec's reasoning without reading the full document — `spec.md` itself is not committed to git and is deleted once the task completes, so this summary becomes the durable record of the spec, embedded in the pull request's description.

3. Print the path of the summary you wrote.
