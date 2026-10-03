/**
 * Plan-time plan.json validation: deterministic serialization of subtasks that
 * would otherwise race on a shared file.
 *
 * The implement phase runs subtasks that share a `parallel_group` concurrently
 * (each in its own isolated worktree branched from the same base) and then
 * cherry-picks them back as one batch — so two subtasks in the SAME group that
 * declare the same file will always conflict at cherry-pick. A `depends_on`
 * edge does NOT prevent this (it is documentation-only; the runtime never
 * orders execution on it — only `parallel_group` placement does).
 *
 * This module detects that condition after the planner writes plan.json and
 * deterministically serializes the offending subtasks: the later subtask is
 * reassigned to a fresh, sequential `parallel_group` (so the two never run
 * concurrently) and a `depends_on` edge is recorded for traceability.
 *
 * Subtasks without an explicit `parallel_group` already run sequentially (one
 * per group, editing the feature branch directly) and are left untouched.
 */
import { existsSync, readFileSync, writeFileSync, renameSync, unlinkSync } from 'fs';
import path from 'path';
import { logToOutput } from './helpers';
import type { PlanSubtask } from './types';

/** A single serialization applied to fix a shared-file conflict. */
export interface SharedFileFix {
  /** The subtask that was moved to a later (sequential) group. */
  subtaskId: number;
  /** The shared files that triggered the move. */
  files: string[];
  /** Ids of the earlier subtasks it would have conflicted with. */
  dependsOn: number[];
  /** The group it was moved out of. */
  fromGroup: string;
  /** The sequential group it was moved into. */
  toGroup: string;
}

/** Generate a unique sequential group name under `original`. */
function nextSequentialGroupName(original: string, used: Set<string>): string {
  let n = 2;
  let candidate = `${original}.${n}`;
  while (used.has(candidate)) {
    n += 1;
    candidate = `${original}.${n}`;
  }
  used.add(candidate);
  return candidate;
}

/**
 * Serialize subtasks that share a file within the same `parallel_group`.
 *
 * Mutates `subtasks` in place. For each group whose members declare a shared
 * file, the later (conflicting) subtask is reassigned to a fresh sequential
 * group and given a `depends_on` edge to the earlier subtask(s) it overlaps
 * with. The result guarantees no two subtasks in the same `parallel_group`
 * declare the same file, which is the exact invariant the implement phase
 * needs to cherry-pick without conflict.
 *
 * Returns the list of applied fixes (empty if the plan was already safe).
 */
export function serializeSharedFileSubtasks(subtasks: PlanSubtask[]): SharedFileFix[] {
  const fixes: SharedFileFix[] = [];

  // Preload every explicit group name so generated names can't collide.
  const used = new Set<string>();
  for (const s of subtasks) {
    if (s.parallel_group != null) used.add(String(s.parallel_group));
  }

  // Group subtasks by explicit parallel_group, preserving plan order.
  const byGroup = new Map<string, PlanSubtask[]>();
  for (const s of subtasks) {
    if (s.parallel_group == null) continue;
    const key = String(s.parallel_group);
    if (!byGroup.has(key)) byGroup.set(key, []);
    byGroup.get(key)!.push(s);
  }

  for (const [groupKey, members] of byGroup) {
    if (members.length < 2) continue;

    // `slots[0]` keeps the original group name; later slots are fresh
    // sequential groups. A subtask lands in the first slot whose claimed
    // files don't overlap its own (greedy first-fit — deterministic).
    const slots: { name: string; files: Set<string> }[] = [
      { name: groupKey, files: new Set<string>() },
    ];

    for (let i = 0; i < members.length; i++) {
      const s = members[i];
      const files = s.files ?? [];
      let slot = slots.find(sl => files.every(f => !sl.files.has(f)));
      if (!slot) {
        slot = { name: nextSequentialGroupName(groupKey, used), files: new Set<string>() };
        slots.push(slot);
      }

      if (slot.name !== groupKey) {
        const earlier = members.slice(0, i);
        const dependsOn = earlier
          .filter(prev => (prev.files ?? []).some(f => files.includes(f)))
          .map(prev => prev.id);
        const conflictingFiles = files.filter(f =>
          earlier.some(prev => (prev.files ?? []).includes(f)),
        );
        s.parallel_group = slot.name;
        s.depends_on = Array.from(new Set([...(s.depends_on ?? []), ...dependsOn]));
        fixes.push({
          subtaskId: s.id,
          files: conflictingFiles,
          dependsOn: [...dependsOn],
          fromGroup: groupKey,
          toGroup: slot.name,
        });
      }

      for (const f of files) slot.files.add(f);
    }
  }

  return fixes;
}

/**
 * Read plan.json from `specPath`, serialize any shared-file conflicts, persist
 * the result, and log a summary to output.log. Returns the applied fixes
 * (empty when plan.json is missing, malformed, or already safe).
 */
export function applyPlanFileSerialization(specPath: string): SharedFileFix[] {
  const planPath = path.join(specPath, 'plan.json');
  if (!existsSync(planPath)) return [];

  let plan: { subtasks?: PlanSubtask[] };
  try {
    plan = JSON.parse(readFileSync(planPath, 'utf-8'));
  } catch (err) {
    logToOutput(specPath,
      `\n[PLAN] plan.json is malformed — skipping shared-file serialization: ${err instanceof Error ? err.message : String(err)}\n`);
    return [];
  }

  const subtasks = Array.isArray(plan.subtasks) ? plan.subtasks : [];
  const fixes = serializeSharedFileSubtasks(subtasks);
  if (fixes.length === 0) return [];

  try {
    const tmpPath = planPath + '.tmp';
    writeFileSync(tmpPath, JSON.stringify(plan, null, 2));
    renameSync(tmpPath, planPath);
  } catch (err) {
    logToOutput(specPath,
      `\n[PLAN] Failed to persist serialized plan.json: ${err instanceof Error ? err.message : String(err)}\n`);
    return [];
  }

  for (const fix of fixes) {
    const shared = fix.files.map(f => `"${f}"`).join(', ');
    const deps = fix.dependsOn.length === 1 ? `subtask ${fix.dependsOn[0]}` : `subtasks ${fix.dependsOn.join(', ')}`;
    logToOutput(specPath,
      `\n[PLAN] Serialized subtask ${fix.subtaskId} out of group "${fix.fromGroup}" into "${fix.toGroup}" — ` +
      `it shares ${shared} with ${deps} (added depends_on)\n`);
  }

  return fixes;
}

// ── Undeclared cross-subtask ordering references ──────────────────────────

/** A prose reference to another subtask's ordering requirement that isn't
 *  reflected in `depends_on` — see detectUndeclaredSubtaskReferences. */
export interface UndeclaredDependencyReference {
  /** The subtask whose description contains the reference. */
  subtaskId: number;
  /** The other subtask id it references without declaring as a dependency. */
  referencedId: number;
  /** The sentence the reference was found in (trimmed, for the log line). */
  sentence: string;
  /** `earlier`: the referenced subtask runs before this one, so the fix is a
   *  `depends_on` edge. `later`: it runs after (higher parallel_group, or the
   *  same/no group and a higher id) - a depends_on edge would point forward
   *  and never be satisfied, so the fix is to drop the reference. */
  direction: 'earlier' | 'later';
}

/** Words whose presence near a subtask-id reference signals an ordering
 *  requirement — "see Subtask 3" is not a dependency, "confirm Subtask 3 has
 *  finished before starting this one" is. Kept intentionally permissive
 *  (a false positive is just a log line; a false negative is silent). */
const ORDERING_CUES = [
  'after', 'before', 'once', 'until', 'finish', 'complete', 'confirm',
  'must have', 'no concurrent', 'sequenced', 'depends on', 'requires',
  'blocked by', 'wait for', 'shut down', 'prerequisite',
];

/**
 * Scan every subtask's `description` for a mention of another subtask's id
 * (e.g. "Subtask 13", "Subtasks 13 and 14") that (a) is not itself, (b) is
 * not already declared in that subtask's own `depends_on`, and (c) appears
 * in a sentence containing an ordering cue word (see ORDERING_CUES).
 *
 * `depends_on` is the ONLY field the implement-phase group scheduler reads
 * to gate cross-group sequencing (plan-validation.ts's own module doc above
 * notes the same is true for parallel_group placement) — prose ordering
 * language in a description is never enforced at runtime. A planner that
 * writes an accurate "confirm Subtask 13 has finished before starting this
 * one" instruction but forgets to add 13 to this subtask's `depends_on`
 * produces a plan whose two representations of the same requirement have
 * silently diverged: an engineer reading the description sees the
 * requirement, but the orchestrator's dependency gate does not, and will
 * schedule this subtask as soon as its (incomplete) declared depends_on are
 * satisfied — regardless of whether 13 ever ran.
 *
 * A reference to a LATER subtask is a different defect: a subtask must be
 * self-contained and never describe future work, because a depends_on edge
 * cannot point forward (it would never be satisfied). Such findings carry
 * `direction: 'later'`; the ordering belongs in the later subtask's own
 * `depends_on`, and the sentence should be dropped from this description.
 *
 * Detection only — this does not mutate the plan. Auto-adding a depends_on
 * edge from a regex match risks introducing an incorrect gate (or a cycle)
 * from a reference that wasn't actually a dependency; a logged warning lets
 * a human or the next planning pass make that call instead.
 */
export function detectUndeclaredSubtaskReferences(subtasks: PlanSubtask[]): UndeclaredDependencyReference[] {
  const validIds = new Set(subtasks.map(s => s.id));
  const byId = new Map(subtasks.map(s => [s.id, s]));
  const found: UndeclaredDependencyReference[] = [];

  // Execution order is parallel_group letter, then id - the same order the
  // implement-phase scheduler uses. A missing group sorts first.
  const isLater = (from: PlanSubtask, to: PlanSubtask): boolean => {
    const gf = from.parallel_group ?? '';
    const gt = to.parallel_group ?? '';
    return gt !== gf ? gt > gf : to.id > from.id;
  };

  for (const s of subtasks) {
    // The synthetic QA-rework subtask (id 9999, see selectSubtasks) is
    // regenerated verbatim from qa_feedback.md on every bounce — it isn't
    // planner-authored prose, has no depends_on an agent could meaningfully
    // add to, and qa_feedback.md routinely quotes other subtask ids in its
    // failure notes without those being real ordering requirements.
    if (!s.description || s.id === 9999) continue;
    const declared = new Set(s.depends_on ?? []);
    const sentences = s.description.split(/(?<=[.!?])\s+/);

    for (const sentence of sentences) {
      const lower = sentence.toLowerCase();
      if (!ORDERING_CUES.some(cue => lower.includes(cue))) continue;

      // Capture a short window of text following each "subtask(s)" mention
      // rather than a strict comma/and-separated numeric list — natural
      // phrasing like "Subtasks 13 (V0) and 14 (V1)" breaks a strict list
      // pattern at the parenthetical aside, silently dropping the second id.
      // A 60-character window comfortably covers such asides while staying
      // well short of the next unrelated number in a normal sentence.
      const windows = sentence.matchAll(/\bsubtasks?\b([^.!?]{0,60})/gi);
      for (const m of windows) {
        // Exclude digits glued to a preceding letter/digit/hyphen — plan
        // prose is full of requirement/criterion ids in that shape (R3,
        // AC-14, C1) that would otherwise be misread as subtask ids.
        const ids = [...m[1].matchAll(/(?<![A-Za-z0-9-])\d+\b/g)].map(n => parseInt(n[0], 10));
        for (const referencedId of ids) {
          if (referencedId === s.id) continue;
          if (!validIds.has(referencedId)) continue;
          if (declared.has(referencedId)) continue;
          if (found.some(f => f.subtaskId === s.id && f.referencedId === referencedId)) continue;
          const ref = byId.get(referencedId)!;
          found.push({
            subtaskId: s.id,
            referencedId,
            sentence: sentence.trim(),
            direction: isLater(s, ref) ? 'later' : 'earlier',
          });
        }
      }
    }
  }

  return found;
}

/**
 * Read plan.json from `specPath`, run detectUndeclaredSubtaskReferences, and
 * log a `[PLAN-LINT]` warning per finding to output.log. Never mutates the
 * plan (see detectUndeclaredSubtaskReferences's doc for why). Returns the
 * findings (empty when plan.json is missing, malformed, or clean).
 */
export function logUndeclaredSubtaskReferences(specPath: string): UndeclaredDependencyReference[] {
  const planPath = path.join(specPath, 'plan.json');
  if (!existsSync(planPath)) return [];

  let plan: { subtasks?: PlanSubtask[] };
  try {
    plan = JSON.parse(readFileSync(planPath, 'utf-8'));
  } catch {
    return [];
  }

  const subtasks = Array.isArray(plan.subtasks) ? plan.subtasks : [];
  const findings = detectUndeclaredSubtaskReferences(subtasks);
  for (const f of findings) {
    if (f.direction === 'later') {
      logToOutput(specPath,
        `
[PLAN-LINT] Subtask ${f.subtaskId} refers to LATER Subtask ${f.referencedId} in its ` +
        `description ("${f.sentence}"). A subtask must be self-contained and must not describe future ` +
        `subtasks — do NOT add ${f.referencedId} to its depends_on (a forward edge is never satisfied). ` +
        `Remove the reference; if Subtask ${f.referencedId} must run after Subtask ${f.subtaskId}, declare ` +
        `that in Subtask ${f.referencedId}'s own depends_on.
`);
      continue;
    }
    logToOutput(specPath,
      `\n[PLAN-LINT] Subtask ${f.subtaskId} references Subtask ${f.referencedId}'s completion in its ` +
      `description ("${f.sentence}") but does not list ${f.referencedId} in its own depends_on — the ` +
      `implement-phase scheduler only reads depends_on for cross-group ordering, so this requirement is ` +
      `NOT enforced at runtime. Add ${f.referencedId} to subtask ${f.subtaskId}'s depends_on if this is a ` +
      `real ordering requirement.\n`);
  }
  return findings;
}

// ── Scoped re-plan preserve-list guardrail ────────────────────────────────

/**
 * Persisted snapshot file so a scoped planner replan can recover from a crash
 * mid-replan. Written by snapshotPreservedPlanSubtasks, read by
 * loadPreservedPlanSubtasks, cleared by clearPreservedPlanSubtasks.
 */
const PRESERVE_SNAPSHOT_FILE = 'plan_preserve_snapshot.json';

/** Serialise the preserve-list map to JSON for crash-recovery persistence. */
function persistPreservedPlanSubtasks(
  specPath: string,
  preserved: Map<number, { subtask: PlanSubtask; index: number }>,
): void {
  const entries: { subtask: PlanSubtask; index: number }[] = [];
  for (const [id, entry] of preserved) {
    // Normalise — the Map key IS the id, but embed it inside the subtask
    // object too so restoration doesn't depend on key ordering.
    entries.push({ subtask: { ...entry.subtask, id }, index: entry.index });
  }
  try {
    writeFileSync(path.join(specPath, PRESERVE_SNAPSHOT_FILE), JSON.stringify(entries, null, 2));
  } catch { /* best-effort — crash recovery is a nice-to-have, not a correctness requirement */ }
}

/**
 * Load the preserve-list from the persisted snapshot, or return null when
 * the file is missing/malformed. Used by runPlanPhase on crash recovery.
 */
export function loadPreservedPlanSubtasks(
  specPath: string,
): Map<number, { subtask: PlanSubtask; index: number }> | null {
  const p = path.join(specPath, PRESERVE_SNAPSHOT_FILE);
  if (!existsSync(p)) return null;
  try {
    const entries: { subtask: PlanSubtask; index: number }[] = JSON.parse(readFileSync(p, 'utf-8'));
    if (!Array.isArray(entries) || entries.length === 0) return null;
    const map = new Map<number, { subtask: PlanSubtask; index: number }>();
    for (const e of entries) {
      if (e && typeof e.subtask?.id === 'number' && typeof e.index === 'number') {
        map.set(e.subtask.id, { subtask: e.subtask, index: e.index });
      }
    }
    return map.size > 0 ? map : null;
  } catch {
    return null;
  }
}

/**
 * Delete the persisted snapshot. Called unconditionally after every plan
 * phase run so a stale file from a prior crash doesn't survive.
 */
export function clearPreservedPlanSubtasks(specPath: string): void {
  const p = path.join(specPath, PRESERVE_SNAPSHOT_FILE);
  try { if (existsSync(p)) unlinkSync(p); } catch { /* best-effort */ }
}

/**
 * Snapshot the subtasks a scoped planner directive must NOT touch, keyed by id.
 *
 * When the pending human feedback targets the planner and carries `subtaskIds`,
 * the reviewer's selection is a **preserve-list**: every subtask NOT in the
 * selection must survive the re-plan byte-for-byte. This captures that set
 * (with each subtask's pre-session array index so a dropped/renumbered subtask
 * can be re-inserted in place) before the planner session runs.
 *
 * Also persists the snapshot to `plan_preserve_snapshot.json` so it survives
 * a crash mid-replan — on recovery, `loadPreservedPlanSubtasks` reads this
 * file as the authoritative baseline.
 *
 * Returns an empty map when plan.json is missing or malformed, or when the
 * selection covers every subtask.
 */
export function snapshotPreservedPlanSubtasks(
  specPath: string,
  selectedIds: number[],
): Map<number, { subtask: PlanSubtask; index: number }> {
  const snapshot = snapshotPreservedPlanSubtasksInternal(specPath, selectedIds);
  if (snapshot.size > 0) persistPreservedPlanSubtasks(specPath, snapshot);
  return snapshot;
}

/** Pure computation — the in-memory snapshot without I/O side-effects. */
function snapshotPreservedPlanSubtasksInternal(
  specPath: string,
  selectedIds: number[],
): Map<number, { subtask: PlanSubtask; index: number }> {
  const planPath = path.join(specPath, 'plan.json');
  if (!existsSync(planPath)) return new Map();
  try {
    const plan = JSON.parse(readFileSync(planPath, 'utf-8'));
    const selected = new Set(selectedIds);
    const preserved = new Map<number, { subtask: PlanSubtask; index: number }>();
    const subtasks: PlanSubtask[] = Array.isArray(plan.subtasks) ? plan.subtasks : [];
    for (let i = 0; i < subtasks.length; i++) {
      const s = subtasks[i];
      if (s && typeof s.id === 'number' && !selected.has(s.id)) {
        preserved.set(s.id, { subtask: s, index: i });
      }
    }
    return preserved;
  } catch {
    return new Map();
  }
}

/** Compare two subtasks ignoring only `id` — used to detect renumbered orphans. */
function subtaskContentEquals(a: PlanSubtask, b: PlanSubtask): boolean {
  const arrEq = (x: string[] | undefined, y: string[] | undefined) =>
    (x ?? []).join('\u0000') === (y ?? []).join('\u0000');
  return a.title === b.title
    && a.description === b.description
    && arrEq(a.files, b.files)
    && arrEq(a.acceptance_criteria, b.acceptance_criteria)
    && (a.completed ?? false) === (b.completed ?? false)
    && (a.qa_flagged ?? false) === (b.qa_flagged ?? false)
    && (a.depends_on ?? []).join(',') === (b.depends_on ?? []).join(',');
}

/**
 * Restore the preserved subtasks into plan.json after a scoped re-plan.
 *
 * The planner is instructed to leave unlisted subtasks byte-for-byte identical
 * (see the replan scope note in human-feedback.ts), but the preserve-list is
 * enforced here, unconditionally:
 * - Any subtask whose id is in the snapshot is overwritten with the original
 *   object, whatever the planner wrote for that id.
 * - Subtasks the planner ADDED (ids outside the preserve-list) are kept.
 * - If the planner dropped or renumbered a preserved subtask, the original is
 *   re-inserted at its pre-session index; a renumbered copy whose content still
 *   matches the original is dropped as an orphan. Every corrective action is
 *   flagged in output.log so drift is diagnosable.
 */
export function restorePreservedPlanSubtasks(
  specPath: string,
  preserved: Map<number, { subtask: PlanSubtask; index: number }>,
): void {
  if (preserved.size === 0) return;
  const planPath = path.join(specPath, 'plan.json');
  if (!existsSync(planPath)) return;

  let plan: { subtasks?: PlanSubtask[] };
  try {
    plan = JSON.parse(readFileSync(planPath, 'utf-8'));
  } catch (err) {
    logToOutput(specPath,
      `\n[PLAN] plan.json is malformed after re-plan — cannot restore preserved subtasks: ${err instanceof Error ? err.message : String(err)}\n`);
    return;
  }

  const postReplan: PlanSubtask[] = Array.isArray(plan.subtasks) ? plan.subtasks : [];
  const preservedIds = new Set(preserved.keys());

  // 1. Overwrite every preserved id the planner left (or rewrote) in place.
  //    Flag the drift so an undo is diagnosable in output.log — the preserve-list
  //    is enforced unconditionally, but a silent correction hides that the
  //    planner "helpfully" reformatted a subtask it was told to leave alone.
  const restored = postReplan.map(s => {
    const entry = preserved.get(s.id);
    if (!entry) return s;
    if (!subtaskContentEquals(s, entry.subtask)) {
      logToOutput(specPath,
        `\n[PLAN] Preserved subtask #${s.id} was modified by the planner — restored to its pre-replan state (preserve-list)\n`);
    }
    return entry.subtask;
  });
  const seen = new Set<number>();
  for (const s of restored) if (preservedIds.has(s.id)) seen.add(s.id);

  // 2. Re-insert preserved ids the planner dropped or renumbered, dropping any
  //    content-duplicate orphan (the renumbered copy) in the process.
  const missing = [...preservedIds].filter(id => !seen.has(id));
  for (const id of missing) {
    const entry = preserved.get(id)!;
    const orphanIdx = restored.findIndex(s =>
      !preservedIds.has(s.id) && subtaskContentEquals(s, entry.subtask),
    );
    if (orphanIdx >= 0) {
      restored.splice(orphanIdx, 1);
      logToOutput(specPath,
        `\n[PLAN] Preserved subtask #${id} was renumbered by the planner — removed the orphan duplicate and restored the original at its pre-replan position\n`);
    } else {
      logToOutput(specPath,
        `\n[PLAN] Preserved subtask #${id} was dropped by the planner — restored the original at its pre-replan position\n`);
    }
    const insertAt = Math.min(entry.index, restored.length);
    restored.splice(insertAt, 0, entry.subtask);
  }

  try {
    plan.subtasks = restored;
    const tmpPath = planPath + '.tmp';
    writeFileSync(tmpPath, JSON.stringify(plan, null, 2));
    renameSync(tmpPath, planPath);
  } catch (err) {
    logToOutput(specPath,
      `\n[PLAN] Failed to persist preserved subtasks to plan.json: ${err instanceof Error ? err.message : String(err)}\n`);
  }
}

// ── Plan-declared file-change detection ────────────────────────────────────

/** A path under `.teamai/` is pipeline-artifact territory (ticket-creation
 *  subtasks, out of scope for the coder — see qa-review.md's carve-out) and
 *  never ends up in a committed diff either way; it doesn't count as a real
 *  file change for this check. */
function isRealSourcePath(f: string): boolean {
  return !f.replace(/\\/g, '/').startsWith('.teamai/');
}

/**
 * Whether plan.json declares any subtask expected to touch real source/test
 * files (as opposed to a purely `.teamai/`-scoped ticket-creation subtask, or
 * a subtask with an empty `files`/`files_to_create` array — a deliberate,
 * verification-only subtask per implement.md's guidance).
 *
 * Used to distinguish a genuinely code-free task (safe to mark `done`
 * directly when its branch has nothing beyond the base branch — see
 * hasCommitsBeyondBase in artifact-commit.ts) from one whose plan expected
 * real changes that never materialized on the branch: the signature of an
 * implementation that was lost, skipped, or never finished. That case must
 * NOT be silently marked done — see runCreatePRPhase/runMergePhase, which
 * throw a loud, actionable error instead when this returns true alongside
 * an empty branch.
 *
 * Returns `true` (the conservative, "treat as suspicious" answer) when
 * plan.json is missing or malformed — a task this far into the pipeline
 * should have one, and an absent/unreadable plan tells us nothing about
 * intent, so it's safer to route to the loud error path than to assume
 * silence means nothing was expected.
 */
export function planDeclaresRealFileChanges(specPath: string): boolean {
  const planPath = path.join(specPath, 'plan.json');
  if (!existsSync(planPath)) return true;

  let plan: { subtasks?: PlanSubtask[] };
  try {
    plan = JSON.parse(readFileSync(planPath, 'utf-8'));
  } catch {
    return true;
  }

  const subtasks = Array.isArray(plan.subtasks) ? plan.subtasks : [];
  return subtasks.some(s =>
    (Array.isArray(s.files) && s.files.some(isRealSourcePath)) ||
    (Array.isArray(s.files_to_create) && s.files_to_create.some(isRealSourcePath)),
  );
}
