<!-- .claude/commands/create-task.md -->
You are creating a properly formatted kanban ticket that will appear on the TeamAI board.
Use your current role persona — you do not need to switch roles.
Follow these steps exactly:

## Step 1: Understand the Request
Extract the task description from the user's message or conversation context.
Determine:
- What type of task is this? Choose from: Bug Fix, Feature Request, Refactor, Documentation
- What is the core problem, user story, or goal?
- What are the acceptance criteria or requirements?

If the user did not provide enough detail, ASK clarifying questions before proceeding.
Do not guess what the user wants.

## Step 2: Format the Ticket
Use the appropriate template based on the task type you identified.

### Bug Fix
- Title prefix: `Fix: `
- Title example: `Fix: login form validation error on empty password`
- Description format:
```
## Current Behavior

Describe what currently happens (the bug).

## Expected Behavior

Describe what should happen instead.

## Steps to Reproduce
1. Go to ...
2. Click on ...
3. Observe ...

## Root Cause (if known)

## Affected Files
- path/to/file.ts
```

### Feature Request
- Title prefix: `Feat: `
- Title example: `Feat: add dark mode toggle to settings`
- Description format:
```
## User Story
As a [user type], I want [capability] so that [benefit].

## Acceptance Criteria
- [ ] Criterion 1
- [ ] Criterion 2
- [ ] Criterion 3

## Implementation Notes

Any relevant technical context, constraints, or design decisions.

## Affected Files
- path/to/file.ts
```

### Refactor
- Title prefix: `Refactor: `
- Title example: `Refactor: extract shared validation from login and signup`
- Description format:
```
## Motivation

Why this refactor is needed — what problem does it solve?

## Proposed Changes
- Change 1
- Change 2

## Affected Files
- path/to/file.ts

## Risks
- Risk 1
```

### Documentation
- Title prefix: `Docs: `
- Title example: `Docs: add API authentication guide`
- Description format:
```
## What needs documenting

Describe what is currently undocumented or unclear.

## Audience

Who is this documentation for? (developers, end users, ops)

## Outline
- Section 1
- Section 2
- Section 3
```

## Step 3: Write the Task File

A ticket is a JSON file at `.teamai/{slug}/task.json`. The slug is derived from the title.

### Slug Algorithm
Use the same algorithm as the TeamAI slugify() function:
1. Take the full title (including prefix)
2. Convert to lowercase
3. Replace every sequence of non-alphanumeric characters (anything except a-z and 0-9) with a single hyphen
4. Trim to 40 characters maximum

Examples:
- `Fix: login form validation error` → `fix-login-form-validation-error`
- `Feat: add dark mode toggle` → `feat-add-dark-mode-toggle`
- `Refactor: extract shared validation` → `refactor-extract-shared-validation`

### Directory and File Creation
```
mkdir -p .teamai/{slug}/
```

### task.json Format
Write exactly this JSON structure to `.teamai/{slug}/task.json`:

```json
{
  "id": "<UUID v4>",
  "title": "<full title with prefix>",
  "description": "<formatted description from Step 2>",
  "phase": "backlog",
  "createdAt": "<ISO 8601 timestamp>",
  "updatedAt": "<ISO 8601 timestamp>"
}
```

**Required fields**: id, title, description, phase, createdAt, updatedAt.

**id**: Generate a UUID v4. Preferred method: run `node -e "console.log(crypto.randomUUID())"`. Fallback: generate a random hex string in the format `xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx` where `x` is any hex digit and `y` is 8, 9, a, or b.

**phase**: Always `"backlog"` — new tickets start in the backlog column.

**Timestamps**: Use ISO 8601 format with milliseconds and Z suffix: `2025-01-15T10:30:00.000Z`.

## Step 4: Write the Specification

If the task is a **Feature Request**, write a `spec.md` alongside the `task.json` at `.teamai/{slug}/spec.md` based on your role:

- **Analyst**: ALWAYS write the spec. You are the spec owner — producing a complete specification is your core responsibility.
- **Coder**: Write the spec ONLY if the feature is related to code you're currently working on and you have enough context to produce a complete, concrete specification. If you lack full context, skip this step — the pipeline's spec phase will handle it.
- **QA Reviewer / Merger**: Skip this step. Spec writing is the analyst's domain.

This lets the ticket skip the spec phase when started — the pipeline detects existing `spec.md` files and advances directly to plan.

**Skip this step for Bug Fix and Refactor tickets.** Their structured descriptions already serve as the implementation specification. Documentation tickets also don't need a separate spec.

Write `spec.md` with these sections:

- **Overview**: One paragraph describing the feature and its motivation.
- **Requirements**: Numbered list of specific, unambiguous requirements.
- **Acceptance Criteria**: Testable conditions in Given/When/Then format. Include at least 3 criteria.
- **Files to Modify**: List each file with a one-line rationale.
- **New Files to Create**: List with purpose.
- **Dependencies & Risks**: External dependencies, breaking changes, migration needs.

### CRITICAL — No Delegated Analysis
Investigation and analysis must be completed NOW. If the feature requires determining a value, formula, threshold, or configuration, derive it yourself — read the codebase, check logs, compute the right number. Do NOT write requirements like "determine the correct value" or "analyse why X happens" — the engineer needs concrete specifications, not research tasks.

### Spec self-critique
Before finalizing, review your spec:
- Are there missing edge cases?
- Are requirements testable and quantified (not "fast enough" or "sufficient")?
- Is every value, formula, or threshold concretely specified?
- Can an engineer with no prior context implement this without guessing?

If the spec needs codebase research you can't complete from context, note it in the Dependencies section rather than guessing.

### Spec file path
Write the spec to `.teamai/{slug}/spec.md` — same directory as `task.json`.

## Step 5: Verify
After writing the files, read them back to verify:
1. `task.json` is valid JSON (no trailing commas, properly escaped strings)
2. All required task fields are present
3. The slug directory name matches slugify(title)
4. If you wrote `spec.md`, confirm every section is filled in and no delegated-analysis anti-patterns remain

## Step 6: Confirm
Print a summary:

**If you wrote a spec:**
- ✅ Ticket created: `{title}`
- 📁 `.teamai/{slug}/task.json`
- 📋 `.teamai/{slug}/spec.md` — spec included, ticket will skip spec phase on start
- 🏷️  Type: Feature Request

**If you did NOT write a spec:**
- ✅ Ticket created: `{title}`
- 📁 `.teamai/{slug}/task.json`
- 📋 No spec — pipeline will run spec phase when started
- 🏷️  Type: {Bug Fix | Feature Request | Refactor | Documentation}

Always end with:
- 🔄 Refresh the kanban board to see the new ticket in the Backlog column.

---

## Rules
1. **Never skip the prefix.** Every title must have `Fix:`, `Feat:`, `Refactor:`, or `Docs:`.
2. **Always write the description in the template format.** Structured descriptions make tickets actionable.
3. **Set phase to `"backlog"`.** New tickets always start there.
4. **Generate a proper UUID.** Do not reuse IDs or use sequential numbers.
5. **Use the slug algorithm exactly.** The kanban discovers tickets by scanning `.teamai/` subdirectories — an incorrect slug means the ticket won't appear.
6. **If unsure about the task type, ask.** Do not guess.
7. **Write a spec for Feature Requests — role-dependent.** Analyst agents MUST always include `spec.md` for feature tickets. Coder agents may include one if they have sufficient context from their current work. QA reviewer and merger agents should skip spec writing. Bug Fix and Refactor tickets don't need a spec; their descriptions serve as the spec.
