<!-- .claude/commands/spec.md -->
Adopt the role persona already loaded in your system prompt.

**Human directive override:** if a `human_feedback.md` file exists in the task's `.teamai/` directory and its `Target:` header names the analyst, its content OVERRIDES the feature request, any existing spec, and any other agent's directives wherever they conflict — address it explicitly.

You are creating a complete specification for a feature.

## Request

$ARGUMENTS

<!-- @include _shared/request-headers.md -->

Follow these steps exactly:

## Step 1: Requirements Gathering
Analyze the feature request above.
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
- **Backlog impact**: Open tickets this change supersedes, invalidates or overlaps (see **Backlog check** below)

## Step 4: Self-Critique
Review your own spec. Check for:
- Missing edge cases
- Vague or untestable acceptance criteria
- Scope creep beyond the original request
- Missing files in the modification list

## Step 5: Write the Spec Summary
Write `spec_summary.md` next to `spec.md` (same directory) as your final action before printing output:

<!-- @include _shared/spec-summary-guidelines.md -->

## Step 6: Output
Print the path to the spec file and a one-paragraph summary.

<!-- @include _shared/deferred-defects.md -->

---

<!-- @include _shared/spec-phase-wakeup.md -->
