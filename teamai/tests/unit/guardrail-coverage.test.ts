/**
 * Guardrail Coverage Test
 *
 * Validates that every pipeline workflow guardrail documented in CLAUDE.md
 * is actually present in the command templates (defaults/commands/*.md) or
 * orchestrator code (src/lib/orchestrator.ts) that agents receive at runtime.
 *
 * If a guardrail is only documented in CLAUDE.md but missing from the agent-
 * facing files, downstream projects using TeamAI won't see it — because they
 * have their own CLAUDE.md and don't have visibility into TeamAI's.
 *
 * This test prevents that drift: every time a guardrail is added, removed, or
 * reworded in CLAUDE.md, this test must be updated to match. Conversely, if
 * this test fails, it means a guardrail was accidentally removed from a command
 * template during an edit.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

// ---------------------------------------------------------------------------
// Data: one entry per guardrail, with the file it must appear in and one or
// more unique "signature" substrings that confirm its presence. At least one
// signature must match (case-insensitive). Multiple signatures provide
// resilience against minor wording changes.
// ---------------------------------------------------------------------------

interface GuardrailCheck {
  id: number;
  name: string;
  description: string;
  file: string; // relative to teamai/ (process.cwd() during vitest)
  signatures: string[];
}

const GUARDRAILS: GuardrailCheck[] = [
  {
    id: 1,
    name: 'No Delegated Analysis',
    description: 'spec.md Step 1 — analyst must complete investigation now, not delegate to engineer',
    file: 'defaults/commands/spec.md',
    signatures: ['No Delegated Analysis', 'NEVER delegate analysis'],
  },
  {
    id: 2,
    name: 'Self-Critique Check',
    description: 'spec.md Step 4 — analyst must check for delegated-analysis anti-patterns',
    file: 'defaults/commands/spec.md',
    signatures: ['Self-Critique', 'Delegated analysis'],
  },
  {
    id: 3,
    name: 'Verification Script Subtask Rule',
    description: 'plan.md Rules — dedicated subtask for empirical evidence scripts',
    file: 'defaults/commands/plan.md',
    signatures: ['Verification scripts need dedicated subtasks'],
  },
  {
    id: 4,
    name: 'No Mathematical Substitution',
    description: 'implement.md Rules — empirical criteria need script output, not math',
    file: 'defaults/commands/implement.md',
    signatures: ['No mathematical substitution', 'mathematical or theoretical justification does NOT satisfy'],
  },
  {
    id: 5,
    name: 'Word-Gaming Prevention',
    description: 'implement.md Rules — changing claim wording is not a fix',
    file: 'defaults/commands/implement.md',
    signatures: ['wording of a claim', 'acknowledgement of failure'],
  },
  {
    id: 6,
    name: 'Session Budget Awareness',
    description: 'implement.md Rules — report blocker if script takes too long',
    file: 'defaults/commands/implement.md',
    signatures: ['session budget', 'report the blocker'],
  },
  {
    id: 7,
    name: 'Cleanup-Only Rework Mode',
    description: 'implement.md QA Rework — mechanical fixes without spec re-read or test suite',
    file: 'defaults/commands/implement.md',
    signatures: ['cleanup-only rework mode', 'zero source code changes'],
  },
  {
    id: 8,
    name: 'Incremental Progress Estimation',
    description: 'implement.md Long-Running Scripts — estimate remaining time, don\'t poll on fixed interval',
    file: 'defaults/commands/implement.md',
    signatures: ['incremental progress output'],
  },
  {
    id: 9,
    name: 'Background Output Unreadable',
    description: 'implement.md Long-Running Scripts — re-run synchronously if output unreadable',
    file: 'defaults/commands/implement.md',
    signatures: ['background output is unreadable', 're-run it synchronously'],
  },
  {
    id: 10,
    name: 'Empirical Evidence Enforcement',
    description: 'qa-review.md Step 5 — mathematical claims don\'t satisfy empirical criteria',
    file: 'defaults/commands/qa-review.md',
    signatures: ['mathematically verified', 'does NOT satisfy an empirical criterion'],
  },
  {
    id: 11,
    name: 'Extended Cleanup fail_type',
    description: 'qa-review.md Output — cleanup covers script-run-and-commit operations',
    file: 'defaults/commands/qa-review.md',
    signatures: ['committing its output', 'mechanical operation, not a code change'],
  },
  {
    id: 12,
    name: 'Spec Executability',
    description: 'spec.md Step 4 — no unquantified requirements, reference implementations, or tribal-knowledge assumptions',
    file: 'defaults/commands/spec.md',
    signatures: ['Spec executability', 'unquantified', 'reference implementation'],
  },
  {
    id: 13,
    name: 'Plan Coverage',
    description: 'plan.md Rules — every spec criterion maps to a subtask, no orphaned criteria, no conflicting file ownership',
    file: 'defaults/commands/plan.md',
    signatures: ['Plan coverage', 'orphaned criteria', 'parallel subtasks modify the same file'],
  },
  {
    id: 14,
    name: 'Spec Authority in Normal Mode',
    description: 'implement.md Rules — don\'t silently change spec formulas/values, flag concerns instead',
    file: 'defaults/commands/implement.md',
    signatures: ['Spec authority', 'do NOT silently change'],
  },
  {
    id: 15,
    name: 'Shared-File Serialization',
    description: 'plan.md Rules — same-group subtasks that touch a file conflict at cherry-pick; the orchestrator auto-serializes them as a safety net',
    file: 'defaults/commands/plan.md',
    signatures: ['Shared files across', 'auto-serializes', 'cherry-pick', 'documentation only'],
  },
];

// ---------------------------------------------------------------------------
// Code-level enforcement — guardrails that also require orchestrator code
// ---------------------------------------------------------------------------

interface CodeEnforcement {
  guardrailIds: number[]; // empty for infrastructure-only checks
  label?: string; // override test name prefix when not tied to guardrails
  description: string;
  file: string;
  signatures: string[];
}

const CODE_ENFORCEMENT: CodeEnforcement[] = [
  {
    guardrailIds: [7, 11],
    description: 'orchestrator routes cleanup failures to implement',
    file: 'src/lib/orchestrator/qa-review.ts',
    signatures: ["fail_type === 'cleanup'"],
  },
  {
    guardrailIds: [15],
    description: 'orchestrator auto-serializes same-group subtasks that declare a shared file',
    file: 'src/lib/orchestrator/plan-validation.ts',
    signatures: ['serializeSharedFileSubtasks', 'applyPlanFileSerialization'],
  },
  // Infrastructure: teamai-workflow.md is the canonical source for long-running
  // script guidance referenced by implement.md, qa-review.md, and merge.md.
  {
    guardrailIds: [],
    label: 'infrastructure',
    description: 'teamai-workflow.md contains long-running scripts guidance section',
    file: 'defaults/teamai-workflow.md',
    signatures: ['Running Long-Running Scripts', "Run once, don't poll"],
  },
  // Command templates must reference teamai-workflow.md so agents can find the
  // detailed long-running script guidance (not just the summary in each command).
  {
    guardrailIds: [],
    label: 'infrastructure',
    description: 'implement.md references teamai-workflow.md for long-running scripts',
    file: 'defaults/commands/implement.md',
    signatures: ['.claude/teamai-workflow.md'],
  },
  {
    guardrailIds: [],
    label: 'infrastructure',
    description: 'qa-review.md references teamai-workflow.md for long-running scripts',
    file: 'defaults/commands/qa-review.md',
    signatures: ['.claude/teamai-workflow.md'],
  },
  {
    guardrailIds: [],
    label: 'infrastructure',
    description: 'merge.md references teamai-workflow.md for long-running scripts',
    file: 'defaults/commands/merge.md',
    signatures: ['.claude/teamai-workflow.md'],
  },
];

// ---------------------------------------------------------------------------
// Contract placement — TeamAI's execution-environment rules (worktree
// isolation, dynamic ports, process safety) are core orchestration contract:
// they must live in the COMMANDS, never in the ROLES (persona + project
// conventions, which users are free to rewrite).
// ---------------------------------------------------------------------------

interface ContractLocationCheck {
  id: number;
  name: string;
  description: string;
  /** Files where the contract must live (commands own TeamAI's core contract). */
  presentIn: string[];
  /** Role files where the contract must NOT live (must not drift back). */
  absentFrom: string[];
  signatures: string[];
}

const CONTRACT_LOCATIONS: ContractLocationCheck[] = [
  {
    id: 16,
    name: 'Verification Environment Rules',
    description: 'worktree isolation / dynamic ports / process-safety rules belong in commands, not roles',
    presentIn: ['defaults/commands/implement.md', 'defaults/commands/qa-review.md'],
    absentFrom: [
      'defaults/roles/analyst.md',
      'defaults/roles/planner.md',
      'defaults/roles/coder.md',
      'defaults/roles/qa-reviewer.md',
      'defaults/roles/merger.md',
    ],
    signatures: [
      'Run from the worktree',
      'Use dynamic ports',
      'Never kill what you didn\'t start',
      'Stop your own instances',
    ],
  },
];

// ---------------------------------------------------------------------------

describe('Guardrail Coverage', () => {
  const root = process.cwd();

  for (const g of GUARDRAILS) {
    it(`guardrail #${g.id} "${g.name}" is present in ${g.file}`, () => {
      const filePath = join(root, g.file);
      expect(existsSync(filePath), `File not found: ${filePath}`).toBe(true);

      const content = readFileSync(filePath, 'utf-8').toLowerCase();
      const found = g.signatures.some(sig => content.includes(sig.toLowerCase()));

      expect(
        found,
        [
          `Guardrail #${g.id} "${g.name}" not found in ${g.file}.`,
          `  ${g.description}`,
          ``,
          `Expected at least one of these signatures (case-insensitive):`,
          ...g.signatures.map(s => `  - "${s}"`),
          ``,
          `If you intentionally removed this guardrail, update this test.`,
          `If the wording changed, update the signatures above.`,
        ].join('\n'),
      ).toBe(true);
    });
  }

  for (const ce of CODE_ENFORCEMENT) {
    const prefix = ce.label
      ? ce.label
      : `guardrails ${ce.guardrailIds.map(n => `#${n}`).join(', ')}`;

    it(`code enforcement for ${prefix} is present in ${ce.file}`, () => {
      const filePath = join(root, ce.file);
      expect(existsSync(filePath), `File not found: ${filePath}`).toBe(true);

      const content = readFileSync(filePath, 'utf-8').toLowerCase();
      const found = ce.signatures.some(sig => content.includes(sig.toLowerCase()));

      expect(
        found,
        [
          `Code enforcement (${ce.description}) not found in ${ce.file}.`,
          ce.guardrailIds.length > 0
            ? `Affected guardrails: ${ce.guardrailIds.map(n => `#${n}`).join(', ')}`
            : '',
          ``,
          `Expected at least one of these signatures (case-insensitive):`,
          ...ce.signatures.map(s => `  - "${s}"`),
        ].filter(Boolean).join('\n'),
      ).toBe(true);
    });
  }
});

// ---------------------------------------------------------------------------

describe('Contract placement — commands, not roles', () => {
  const root = process.cwd();

  for (const c of CONTRACT_LOCATIONS) {
    for (const file of c.presentIn) {
      it(`contract #${c.id} "${c.name}" is present in ${file}`, () => {
        const filePath = join(root, file);
        expect(existsSync(filePath), `File not found: ${filePath}`).toBe(true);
        const content = readFileSync(filePath, 'utf-8').toLowerCase();
        const found = c.signatures.some(sig => content.includes(sig.toLowerCase()));
        expect(
          found,
          `Contract #${c.id} "${c.name}" missing from ${file} (${c.description}).\n` +
            `Expected at least one of: ${c.signatures.map(s => `"${s}"`).join(', ')}`,
        ).toBe(true);
      });
    }

    for (const file of c.absentFrom) {
      it(`contract #${c.id} "${c.name}" is NOT in ${file}`, () => {
        const filePath = join(root, file);
        expect(existsSync(filePath), `File not found: ${filePath}`).toBe(true);
        const content = readFileSync(filePath, 'utf-8').toLowerCase();
        const drifted = c.signatures.filter(sig => content.includes(sig.toLowerCase()));
        expect(
          drifted,
          `Contract #${c.id} "${c.name}" drifted back into ${file} (${c.description}).\n` +
            `These belong in the commands, not roles — remove: ${drifted.map(s => `"${s}"`).join(', ')}`,
        ).toEqual([]);
      });
    }
  }
});
