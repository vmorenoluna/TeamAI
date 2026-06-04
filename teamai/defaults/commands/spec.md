<!-- .claude/commands/spec.md -->
Read and adopt the role defined in .claude/roles/analyst.md before proceeding.

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
2. Read the `spec_revision_feedback.md` file at the same path — this contains the QA reviewer's spec concerns that triggered the revision.
3. Address EVERY concern listed in the feedback:
   - If the concern points to a wrong assumption, correct it in the spec
   - If the concern identifies missing requirements, add them
   - If the concern identifies contradictory criteria, resolve the contradiction
4. Preserve valid parts of the spec that the feedback doesn't challenge — only change what needs changing.
5. Validate the revised spec against the original feature description — does the revised spec still satisfy the feature request, corrected for the discovered issues?
6. Re-run Step 2 (Codebase Research) to ensure the revised spec is grounded in the current codebase reality.
7. Write the revised spec to the SAME path as the original spec.md (overwrite it).

### Revision Output
After writing the revised spec, print:
- The path to the revised spec file
- A summary of what changed and why
- Confirmation that all spec concerns from the feedback were addressed
