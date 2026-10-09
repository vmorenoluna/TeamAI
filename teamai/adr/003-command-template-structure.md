# ADR 003: Command Template Structure — Structured Template Philosophy

**Date:** 2026-07-03

**Status:** Accepted

## Context

TeamAI command templates (`.claude/commands/*.md`) are prompts injected into Claude CLI subprocess sessions. They instruct role-adopting agents (coder, qa-reviewer, planner, analyst) on how to perform their phase of the pipeline.

The original templates used flat numbered lists for all instructions — mode detection, guardrails, workflow steps, edge cases — all in one long sequence. Agents frequently missed critical instructions buried mid-list, especially when those instructions contradicted a strong environmental signal. The most common failure pattern: an agent sees "all subtasks `completed: true`" in `plan.json` and concludes "nothing to do," ignoring item 5 of 9 in a QA rework list that says "fix issues even if all subtasks are done."

LLM agents exhibit **primacy/recency bias** when reading long numbered lists — they attend to the first and last items more than the middle. They also exhibit **signal-override**: a strong environmental signal ("completed: true") overrides a weaker textual instruction ("fix issues anyway") unless the textual instruction is made prominent enough to compete.

## Decision

Command templates follow a **structured tiered approach**:

| Tier | Element | Purpose | When to use |
|------|---------|---------|-------------|
| 0 | **Mode detection trigger** | Route agent to correct mode section | Only for a mode the agent must detect itself (e.g., `qa-review.md`'s rework pass) |
| 1 | **Scannable callout** | Override environmental signals | Always — the first thing an agent reads in a mode section |
| 2 | **Scenario-specific subsections** | Resolve common misinterpretations | When multiple agents have made the same mistake |
| 3 | **Numbered lists** | Detailed workflow steps | For procedural "do this, then that" instructions |

### Adapting to Simpler Templates

Not every template needs all four tiers. The structure scales down for
templates that have a single mode and no known misinterpretation patterns:

| Template complexity | Applied tiers | Example |
|---------------------|---------------|---------|
| **Agent-detected modes + known anti-patterns** | All four tiers (0–3) | `qa-review.md` (first pass + rework pass) |
| **Single-mode + known anti-patterns** | Tier 1 + Tier 2 + Tier 3 | `implement-fix.md` (QA rework) |
| **Single-mode, well-understood** | Tier 3 only | `spec.md`, `merge.md` |
| **Single-mode with a common mistake** | Tier 1 + Tier 3 | A template where agents consistently skip one step |

**Guidelines for deciding:**
- **Start with Tier 3 only** (numbered steps). This is the minimum viable template.
- **Add Tier 1** when agents consistently miss one instruction. Evidence: task
  failure logs showing the same mistake across 3+ pipeline runs.
- **Add Tier 2** when a specific scenario causes misinterpretation. Evidence: QA
  reports or completion summaries citing a specific misunderstanding pattern.
- **Add Tier 0** only when the template bifurcates into modes the agent must
  detect itself. A mode the orchestrator can choose is a separate command
  instead (ADR 009). Single-mode templates never need Tier 0. Tier 0 is
  documented below in the Mode Detection section.
- **Don't pre-emptively add callouts.** If no agent has made the mistake yet,
  don't add a callout for it. Callouts exist to fix real failures, not hypothetical
  ones. A template with 5 callouts for problems that never happened is noise.

`spec.md`, `plan.md`, and `merge.md` are single-mode templates — they have Tier 3
only. `implement-fix.md` is the canonical template with known anti-patterns — it
uses Tiers 1–3. `qa-review.md` is the one template with an agent-detected mode: it
uses Tier 0 (rework detection), Tier 1 (rework callout), Tier 2 (First QA Pass /
Rework Pass subsections), and Tier 3 (numbered steps).

### Tier 0: Mode Detection

When the orchestrator knows the mode, it sends that mode's own command (ADR 009) and
the template needs no detection. Tier 0 is for the remaining case: a mode only the
agent can establish, by checking the task's files.

**Format: a step at the very top of the template that routes to a mode subsection:**
```markdown
## Step 0: Detect Rework Pass (run first, before anything else)

Check whether a previous `qa_report.json` already exists in `.teamai/{slug}/`.
```

`qa-review.md` uses it: a previous `qa_report.json` means the coder has reworked the
branch, and the agent continues in `### Rework Pass`; otherwise it continues in
`### First QA Pass`.

**Design rules for mode detection:**
- **Place it first.** Mode detection comes before the Tier 1 callout. If the agent
  reads the callout first but isn't in that mode, the callout is confusing.
- **Use a concrete check.** "Check whether `qa_report.json` exists" is something the
  agent can verify. Avoid vague triggers like "If this is a rework pass."
- **One mode trigger per section.** Don't chain multiple detection conditions.
- **Prefer a separate command.** If the orchestrator can tell the modes apart from
  state that survives a restart, split the template into one command per mode
  instead of adding Tier 0.
- **Not needed for single-mode templates.** See "Adapting to Simpler Templates" above.

### Tier 1: Scannable Callout

A blockquote (`>`) at the very top of a mode section. Uses `⚠️` and bold text to grab attention. States the most-missed instruction in a single sentence.

**Format:**
```markdown
> ⚠️ **THE ONE THING YOU MUST NOT FORGET.** Explanation of why this matters,
> even when environmental signals suggest otherwise.
```

**Examples from the codebase:**

`implement-fix.md` QA Rework Mode:
```markdown
> ⚠️ **CRITICAL: THERE IS STILL WORK TO DO.** QA found failures — that means
> something is broken or missing, regardless of what `plan.json` says about
> subtask completion status. QA findings are the ground truth.
```

`qa-review.md` Step 0 (Rework Pass):
```markdown
> ⚠️ **REWORK PASS: DON'T SKIP VERIFICATION.** A previous QA report exists —
> that means the coder has made changes, and your job is to verify those changes
> haven't broken anything.
```

`qa-review.md` Step 6 (Run Test Suite):
```markdown
> ⚠️ **ON REWORK PASSES: Run the FULL suite.** The coder was told to run tests,
> but they may have introduced regressions in areas QA previously passed.
```

`qa-review.md` Step 8 (Domain Logic Check):
```markdown
> ⚠️ **REWORK PASS: Check for unauthorized formula changes.** The coder was told
> NOT to change formulas, algorithms, or domain logic during QA fixes.
```

**Design rules for callouts:**
- **Lead with the consequence of forgetting.** "THERE IS STILL WORK TO DO" is more effective than "Remember to check for QA issues."
- **Name the conflicting environmental signal.** "regardless of what `plan.json` says" directly addresses the signal that caused the failure.
- **One callout per section.** If you have two critical things to say, pick the one agents miss most often. The second goes in a scenario subsection.
- **Use bold and emoji sparingly.** `⚠️` is reserved for callouts — don't use it in regular text.

### Tier 2: Scenario-Specific Subsections

A named `###` subsection that addresses one specific misinterpretation scenario. Each subsection has its own header, making it scannable and searchable by an agent that jumps to the section matching its situation.

**Examples from the codebase:**

`implement-fix.md` — "When All Subtasks Are Already Completed":
```markdown
### When All Subtasks Are Already Completed

If every plan subtask is marked `completed: true` but QA still found failures:

- **Do NOT treat this as "nothing to do."** QA failures mean the implementation
  is incomplete, even if every subtask was marked done.
- Your job is **surgical rework**, not re-implementation.
- Read the QA feedback. Fix every listed issue. That's the entire scope.
```

`implement-fix.md` — "Cleanup-Only Rework Mode":
```markdown
### Cleanup-Only Rework Mode

**Before reading the full QA feedback**, check if `fail_type` in the QA report
is `"cleanup"`. If so, you are in **cleanup-only rework mode**:
- The QA issues require only mechanical operations with zero source code changes.
- Do NOT re-read the full spec. Do NOT run the test suite.
```

`qa-review.md` — "First QA Pass" / "Rework Pass":
```markdown
### First QA Pass

**If it does NOT exist** (first QA pass) → proceed normally from Step 1.

### Rework Pass

**If it DOES exist** (this is a rework pass):
1. Read the previous `qa_report.json`...
```

`qa-review.md` — Review Process sub-sections:
```markdown
### Step 1–4: Gather Evidence
### Step 5: Evaluate Each Criterion
```

**Design rules for scenario subsections:**
- **Name the scenario in the header.** "When All Subtasks Are Already Completed" is immediately recognizable to an agent looking at `plan.json` and seeing `completed: true`.

  **Naming conventions for subsection headers:**
  - **Use "When X" for conditional scenarios** the agent must detect: "When All Subtasks Are Already Completed," "When the sweep output is a committed artifact."
  - **Use the agent's internal monologue** for anti-patterns: "Do NOT treat this as 'nothing to do'."
  - **Use imperative descriptions** for mode variants: "Cleanup-Only Rework Mode," "Standard QA Rework Steps."
  - **Use phase names** for bifurcations: "First QA Pass," "Rework Pass."
  - **Use step ranges** for grouping procedural steps: "Step 1–4: Gather Evidence," "Step 5: Evaluate Each Criterion."

- **Use the agent's own internal monologue.** "Do NOT treat this as 'nothing to do'" addresses the exact thought the agent will have.
- **One scenario per subsection.** Don't combine "all subtasks done" with "cleanup mode" — they're different situations.
- **Hybrid subsection + numbered list is valid.** When a scenario subsection needs ordered steps (e.g., `qa-review.md`'s Rework Pass has a 6-step numbered list inside the `### Rework Pass` subsection), this is a natural composition: the subsection header answers "which situation am I in?" and the numbered list answers "what do I do in this situation?" The numbered list belongs to the subsection — don't extract it into a separate top-level section.
- **Keep it to 4–8 bullet points.** If you need more, the subsection is doing too much — split it or move details to a numbered list.
- **Place before the numbered workflow.** The agent should read the scenario subsection *before* starting the procedural steps, so it knows which steps apply.

### Tier 3: Numbered Lists

Sequential, ordered steps for the agent to execute. Use numbered lists for procedural workflows where order matters.

**Examples from the codebase:**

`implement-fix.md` Standard QA Rework Steps:
```markdown
### Standard QA Rework Steps

1. Read the QA feedback FIRST. It takes priority over everything else.
2. Address ONLY the QA issues listed.
3. Do NOT re-read the full spec or re-validate criteria that QA already passed.
...
9. **CRITICAL: Do NOT change formulas, algorithms, or domain logic.**
```

`qa-review.md` Step 0 Rework Pass (1–6):
```markdown
### Rework Pass

1. Read the previous `qa_report.json`.
2. Read `head_at_review` from the previous report.
3. Run: `git diff <head_at_review>...HEAD --name-only`
...
```

**Design rules for numbered lists:**
- **Keep items short.** Each step should be one sentence (2–3 at most). If a step needs multi-paragraph explanation, it should be a subsection instead.
- **Order matters.** Steps should be executed in the listed order. If order doesn't matter, use bullet points.
- **Bold the action verb.** "**Run** the full test suite" is scannable; "The full test suite should be run" is not.
- **Never bury a callout in a numbered list.** If step 5 of 9 says "do X even if Y," and agents consistently miss it, promote it to a Tier 1 callout or Tier 2 subsection. The numbered list is for workflow, not for overriding environmental signals.
- **Reference the callout and subsections.** Numbered step 1 can say "See the callout above — QA findings are the ground truth" to reinforce the connection.

### Repetition Guidance: When to Repeat vs. State Once

A common question: if an instruction is critical, shouldn't it appear in ALL three
tiers? The answer is **no** — repetition creates noise, and noise dilutes signal.

| Instruction type | State it in | Rationale |
|------------------|-------------|-----------|
| Environmental signal override (e.g., "QA is the ground truth") | Tier 1 callout | The callout is the one place an agent can't miss it. Repeating it in Tier 2 and Tier 3 makes it feel like boilerplate. |
| Mode-specific procedural steps (e.g., "Run the full test suite") | Tier 3 numbered list | These are workflow items — they belong in the ordered list. Adding them to a callout overstates their importance. |
| Situational anti-patterns (e.g., "Do NOT treat `completed: true` as nothing to do") | Tier 2 subsection | The subsection is the right granularity — it's scannable by agents in that situation, not a global alarm. |
| Cross-mode invariants (e.g., "Don't touch `.teamai/` files") | A `_shared/` fragment included by every mode's command | These apply regardless of mode — every mode's command includes the same fragment (ADR 009), as a plain rules block (not the `⚠️` callout, which is reserved for the mode's most-missed instruction). |

**When TO repeat:**
- **Cross-mode invariants** (rules that apply in ALL modes) reach every mode
  through a `_shared/` fragment that each mode's command includes — for example,
  `implement.md` and `implement-fix.md` both include `_shared/implement-body.md`,
  which holds the pipeline-artifact and no-push rules. Keep them in a plain rules block, not the
  `⚠️` callout, which is reserved for the mode-specific most-missed instruction.
- **The "don't re-read the spec" instruction** appears in both the Tier 1 callout
  and the Tier 2 subsection in `implement-fix.md` — this is intentional because agents
  in the "all subtasks done" scenario are the most likely to re-read the spec.

**When NOT to repeat:**
- **Don't restate the callout verbatim in numbered list items.** Step 1 can say
  "See the callout above" instead of repeating the whole message.
- **Don't add a callout for every rule.** `⚠️` should appear at most once per
  mode section. If everything is `⚠️`, nothing is.

### Beyond Templates: Programmatic Callouts

The three-tier philosophy extends beyond `.md` template files. When the orchestrator
generates prompts programmatically (not from a command template), it applies the same
Tier 1 principle — inject a scannable callout directly into the constructed prompt.

**Synthetic subtask 9999 (`implement.ts`):** When QA feedback exists but no plan
subtask has a matching `qa_flagged` marker, the orchestrator synthesizes a one-shot
subtask with id 9999. The description is built by `buildSyntheticReworkDescription()`,
which leads with a Tier 1 callout:

```typescript
export function buildSyntheticReworkDescription(qaContent: string): string {
  return (
    `⚠️ ALL PLAN SUBTASKS ARE DONE — THIS IS TARGETED REWORK, NOT FRESH IMPLEMENTATION.\n\n` +
    `QA found failures that could not be automatically mapped to specific plan subtasks. ` +
    `The original plan subtasks are already implemented — do NOT re-read or re-implement them. ` +
    `Do NOT re-read the spec. Your ONLY job is to fix the QA issues listed below.\n\n` +
    `**QA feedback (source of truth):**\n\n${qaContent}`
  );
}
```

This follows the same pattern as the template callouts:
- **Leads with the critical instruction:** "ALL PLAN SUBTASKS ARE DONE — THIS IS TARGETED REWORK"
- **Names the conflicting environmental signal:** "do NOT re-read or re-implement them"
- **One callout per prompt:** The header is the first thing the agent reads.

**Why extract to a function:** `buildSyntheticReworkDescription` is exported and
unit-tested independently. The tests (`orchestrator-robustness.test.ts`) verify:
- The `ALL PLAN SUBTASKS ARE DONE` header is present
- QA content is included verbatim
- Spec re-reading is prohibited
- Re-implementation is prohibited
- The header labels QA feedback as "source of truth"

Extracting prompt-building into exported pure functions is the code-level
equivalent of a Tier 1 callout — it makes the critical instruction independently
verifiable without running the full pipeline.

**General principle:** When the orchestrator constructs prompts programmatically
(e.g., for synthetic subtasks, wakeup re-entry headers, deliverable re-verification
prompts), follow the same pattern:
1. Export the prompt builder as a pure function with a descriptive name
2. Lead with a `⚠️` scannable header that names the conflicting environmental signal
3. Write unit tests that verify the header and key content lines are present
4. Keep the function focused — build ONE callout, not the entire prompt

## Status

Accepted. All command templates in `defaults/commands/` follow this structure.

## Consequences

### Positive

- **Fewer "nothing to do" failures.** `implement-fix.md`'s callout and subsection address the most common QA rework failure mode — agents interpreting `completed: true` as "no work needed."
- **Scannable by agents.** The `###` headers create a table of contents that agents can jump to. An agent entering "cleanup mode" finds "### Cleanup-Only Rework Mode" without reading the entire section.
- **Testable.** Scenario subsections can be verified with unit tests on extracted prompt-builder functions (e.g., `buildSyntheticReworkDescription`).
- **Consistent across templates.** All templates follow the same structured tiered approach, reducing the cognitive load for template authors and making reviews predictable.

### Negative

- **Longer templates.** Adding callouts and subsections increases template length. This is acceptable because the structure compensates — agents skip to their relevant subsection rather than reading everything.
- **Maintenance overhead.** When a new misinterpretation is discovered, a new subsection must be added. The structured approach makes this easy (add a `###` section with 4–8 bullets) but it still requires a template update.
- **Callout dilution.** If every section has a callout, none stand out. Reserve `⚠️` blockquotes for the most-missed instruction per section.

## Alternatives Considered

### Flat numbered lists (original approach)
Rejected because agents miss mid-list items, especially when environmental signals contradict them.

### All-callouts, no numbered lists
Rejected because some instructions genuinely need sequential ordering (e.g., "read the QA report, then fix issues, then run tests"). Numbered lists are the right tool for procedural workflows.

### Inline bold text without blockquotes
Rejected because bold text within a paragraph doesn't create enough visual separation. The `>` blockquote creates a distinct visual block that agents treat as a "pay attention" signal.

## References

- `defaults/commands/implement-fix.md` — QA Rework Mode (canonical callout + subsection + steps example)
- ADR 009 — one command per work mode
- `defaults/commands/qa-review.md` — Step 0 and Steps 6–8 (callout + subsection pattern)
- `src/lib/orchestrator/implement.ts` — `buildSyntheticReworkDescription()` (extracted prompt builder, testable via unit tests)
- Bug report: task 437920fa — agent missed implement.md point 5, treated `completed: true` as "nothing to do"
