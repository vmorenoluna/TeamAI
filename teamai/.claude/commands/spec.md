<!-- .claude/commands/spec.md -->
Adopt the role persona already loaded in your system prompt.

**Human directive override:** if a `human_feedback.md` file exists in the task's `.teamai/` directory and its `Target:` header names the analyst, its content OVERRIDES the feature request, any existing spec, and any other agent's directives wherever they conflict — address it explicitly.

You are creating a complete specification for a feature. Follow these steps exactly:

## Step 1: Requirements Gathering
Analyze the feature request: $ARGUMENTS
Think through:
- What is the user trying to achieve?
- What are the acceptance criteria? List at least 5 testable criteria.
- What are the edge cases and error states?
- What are the dependencies on existing code?

## Step 2: Codebase Research
Use Glob and Grep to find:
- Related existing code (patterns, highly relevant naming conventions, similar features)
- Test files that cover adjacent functionality
- Configuration files that may need updates
- API routes, database schemas, or types that are relevant

## Step 3: Write Specification
Create the file `.teamai/{feature-slug}/spec.md` containing:
- **Overview**: One paragraph describing the feature and its motivation
- **Requirements**: Numbered list of specific, unambiguous requirements
- **Acceptance Criteria**: Testable conditions (Given/When/Then format)
- **Files to Modify**: List each file with a one-line rationale
- **New Files to Create**: List with purpose
- **Dependencies & Risks**: External dependencies, breaking changes, migration needs

## Step 4: Self-Critique
Review your own spec. Check for:
- Missing edge cases
- Vague or untestable acceptance criteria
- Scope creep beyond the original request
- Missing files in the modification list

## Step 5: Output
Print the path to the spec file and a one-paragraph summary.

---

## Revision Mode

If the prompt begins with `REVISION:` you are revising an existing spec, not writing from scratch. Follow this modified workflow:

### Revision Workflow
1. Read the existing spec at the path provided in the prompt.
2. Read the `spec_revision_feedback.md` file at the same path — this contains the concerns that triggered the revision (from the QA reviewer's findings or the human reviewer's directive).
3. Address EVERY concern listed in the feedback:
   - If the concern points to a wrong assumption, correct it in the spec
   - If the concern identifies missing requirements, add them
   - If the concern identifies contradictory criteria, resolve the contradiction
4. Preserve valid parts of the spec that the feedback doesn't challenge — only change what needs changing.
5. Validate the revised spec against the original feature description — does the revised spec still satisfy the feature request, corrected for the discovered issues?
6. Re-run Step 2 (Codebase Research) scoped to the feedback's scope. Research only the
   files, modules, and configuration the concerns actually name (plus their adjacent tests
   and immediate dependencies) to ensure the revised spec is grounded in current codebase
   reality. Do NOT re-run a full-codebase Glob/Grep sweep — a revision triggered by a
   single concern does not need to re-map the whole repository.
7. **Resolve every conditional you introduce.** If your fix involves a fork ("if the measured effect still shows the problem, do Y instead"), do not write the fork into the spec — pick one branch now and write only that branch's acceptance criteria and formulas. A spec with an unresolved fallback clause will fail review again.
8. Write the revised spec to `spec.md` (the path given in the prompt) — the versioned baseline file you read in step 1 (e.g. `spec_v1.md`) is the archived previous version; do NOT write to it.
9. **Verify you actually changed something.** Diff what you just wrote against the spec content you read in step 1. For each concern in `spec_revision_feedback.md`, find the specific line(s) that changed to address it. If any concern has no corresponding change, you have not addressed it — go back and fix the spec before proceeding to output.

### Revision Output
After writing the revised spec, print:
- The path to the revised spec file
- For each concern in `spec_revision_feedback.md`: the specific before → after change that addresses it (quote the old and new text/value/formula, not just a paraphrase)
- Confirmation that all spec concerns from the feedback were addressed, each backed by the diff above
