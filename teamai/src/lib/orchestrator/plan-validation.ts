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
import { existsSync, readFileSync, writeFileSync, renameSync } from 'fs';
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
