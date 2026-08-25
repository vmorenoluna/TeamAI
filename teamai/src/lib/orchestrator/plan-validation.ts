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
  const restored = postReplan.map(s => preserved.get(s.id)?.subtask ?? s);
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
