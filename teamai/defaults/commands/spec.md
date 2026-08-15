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

**CRITICAL — No Delegated Analysis:** Investigation and root-cause analysis are pre-spec activities. If the feature request asks you to "investigate", "analyse", or "determine the correct value for" something, complete that investigation yourself NOW — read the logs, derive the formula, determine the thresholds — and embed the findings directly into the spec's technical sections. NEVER delegate analysis to the engineer via requirements like "determine the correct value" or "analyse why X fails". By the time the spec reaches the engineer, every concrete value, formula, and threshold must already be decided and justified.

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
- **Delegated analysis**: Are any requirements worded as research tasks ("analyse", "investigate", "determine") instead of concrete, computed specifications?
- **Spec executability**: Are any requirements unquantified ("fast enough", "sufficient", "reasonable")? Are there reference implementations ("do it like module X") instead of concrete specs? Does every requirement stand alone — can an engineer with no prior context implement it without guessing?
- **Unresolved conditionals**: Does the spec contain conditional/fallback language ("if X still happens, do Y", "consider Z if needed")? Every fork must be resolved to one concrete choice — rewrite the acceptance criteria and formulas to reflect that choice. A finished spec must never describe a branch that wasn't actually chosen.
- **Unverified predictions**: Does the spec state the effect of a change on real behavior ("this resolves...", "this fixes...") without that effect having actually been measured? If so, either verify it now or rewrite it explicitly as a hypothesis, not a fact.

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
7. **Resolve every conditional you introduce.** If your fix involves a fork ("if the measured effect still shows the problem, do Y instead"), do not write the fork into the spec — pick one branch now and write only that branch's acceptance criteria and formulas. A spec with an unresolved fallback clause will fail review again.
8. Write the revised spec to the SAME path as the original spec.md (overwrite it).
9. **Verify you actually changed something.** Diff what you just wrote against the spec content you read in step 1. For each concern in `spec_revision_feedback.md`, find the specific line(s) that changed to address it. If any concern has no corresponding change, you have not addressed it — go back and fix the spec before proceeding to output.

### Revision Output
After writing the revised spec, print:
- The path to the revised spec file
- For each concern in `spec_revision_feedback.md`: the specific before → after change that addresses it (quote the old and new text/value/formula, not just a paraphrase)
- Confirmation that all spec concerns from the feedback were addressed, each backed by the diff above
