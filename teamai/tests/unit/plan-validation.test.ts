/**
 * Unit tests for plan-time plan.json validation (shared-file serialization).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { serializeSharedFileSubtasks, detectUndeclaredSubtaskReferences, planDeclaresRealFileChanges } from '../../src/lib/orchestrator/plan-validation';
import type { PlanSubtask } from '../../src/lib/orchestrator/types';

function st(id: number, files: string[], parallelGroup?: string, dependsOn?: number[]): PlanSubtask {
  return {
    id,
    title: `S${id}`,
    description: `subtask ${id}`,
    files,
    acceptance_criteria: ['works'],
    parallel_group: parallelGroup,
    depends_on: dependsOn ? [...dependsOn] : undefined,
  };
}

describe('serializeSharedFileSubtasks', () => {
  it('returns no fixes and mutates nothing when files are disjoint', () => {
    const subtasks = [st(1, ['a.ts'], 'A'), st(2, ['b.ts'], 'A')];
    const fixes = serializeSharedFileSubtasks(subtasks);
    expect(fixes).toEqual([]);
    expect(subtasks[0].parallel_group).toBe('A');
    expect(subtasks[1].parallel_group).toBe('A');
    expect(subtasks[1].depends_on).toBeUndefined();
  });

  it('reassigns the later subtask to a sequential group when two share a file', () => {
    const subtasks = [st(1, ['a.ts'], 'A'), st(2, ['a.ts'], 'A')];
    const fixes = serializeSharedFileSubtasks(subtasks);

    expect(fixes).toHaveLength(1);
    expect(fixes[0]).toMatchObject({
      subtaskId: 2,
      files: ['a.ts'],
      dependsOn: [1],
      fromGroup: 'A',
      toGroup: 'A.2',
    });

    expect(subtasks[0].parallel_group).toBe('A');
    expect(subtasks[1].parallel_group).toBe('A.2');
    expect(subtasks[1].depends_on).toEqual([1]);
  });

  it('leaves subtasks in different groups sharing a file untouched (already sequential)', () => {
    const subtasks = [st(1, ['a.ts'], 'A'), st(2, ['a.ts'], 'B')];
    const fixes = serializeSharedFileSubtasks(subtasks);
    expect(fixes).toEqual([]);
    expect(subtasks[1].parallel_group).toBe('B');
    expect(subtasks[1].depends_on).toBeUndefined();
  });

  it('leaves solo subtasks (no parallel_group) untouched', () => {
    const subtasks = [st(1, ['a.ts']), st(2, ['a.ts'])];
    const fixes = serializeSharedFileSubtasks(subtasks);
    expect(fixes).toEqual([]);
    expect(subtasks[1].parallel_group).toBeUndefined();
  });

  it('handles a transitive overlap deterministically (first-fit coloring)', () => {
    // A=[f1], B=[f1], C=[f2], D=[f1,f2]
    const subtasks = [
      st(1, ['f1'], 'G'),
      st(2, ['f1'], 'G'),
      st(3, ['f2'], 'G'),
      st(4, ['f1', 'f2'], 'G'),
    ];
    const fixes = serializeSharedFileSubtasks(subtasks);

    // Result: G={1,3} (disjoint), G.2={2}, G.3={4}
    expect(subtasks[0].parallel_group).toBe('G');
    expect(subtasks[1].parallel_group).toBe('G.2');
    expect(subtasks[2].parallel_group).toBe('G');
    expect(subtasks[3].parallel_group).toBe('G.3');

    expect(subtasks[1].depends_on).toEqual([1]);
    expect(subtasks[3].depends_on).toEqual([1, 2, 3]);

    const movedIds = fixes.map(f => f.subtaskId).sort();
    expect(movedIds).toEqual([2, 4]);
  });

  it('coerces numeric parallel_group and generates a string sequential name', () => {
    // parallel_group is declared as string but LLM output can be numeric.
    const subtasks = [
      { ...st(1, ['a.ts']), parallel_group: 1 as unknown as string },
      { ...st(2, ['a.ts']), parallel_group: 1 as unknown as string },
    ];
    const fixes = serializeSharedFileSubtasks(subtasks);

    expect(subtasks[0].parallel_group).toBe(1 as unknown as string);
    expect(subtasks[1].parallel_group).toBe('1.2');
    expect(fixes[0].toGroup).toBe('1.2');
  });

  it('does not collide with a pre-existing generated group name', () => {
    const subtasks = [
      st(1, ['a.ts'], 'A'),
      st(2, ['b.ts'], 'A'),
      st(3, ['a.ts'], 'A'),
      st(4, ['c.ts'], 'A.2'), // a DIFFERENT original group that already used "A.2"
    ];
    const fixes = serializeSharedFileSubtasks(subtasks);

    // subtask 3 shares a.ts with 1, must move out of "A" — but "A.2" is taken.
    expect(subtasks[2].parallel_group).toBe('A.3');
    expect(fixes.find(f => f.subtaskId === 3)?.toGroup).toBe('A.3');
    // The pre-existing "A.2" group is untouched.
    expect(subtasks[3].parallel_group).toBe('A.2');
  });

  it('merges new depends_on into any existing edges', () => {
    const subtasks = [
      st(1, ['a.ts'], 'A'),
      st(2, ['a.ts'], 'A', [9]),
    ];
    serializeSharedFileSubtasks(subtasks);
    expect(subtasks[1].depends_on).toEqual([9, 1]);
  });

  it('records every earlier conflicting subtask, not just the first', () => {
    const subtasks = [
      st(1, ['a.ts'], 'A'),
      st(2, ['a.ts'], 'A'),
      st(3, ['a.ts'], 'A'),
    ];
    serializeSharedFileSubtasks(subtasks);

    expect(subtasks[1].parallel_group).toBe('A.2');
    expect(subtasks[2].parallel_group).toBe('A.3');
    expect(subtasks[1].depends_on).toEqual([1]);
    expect(subtasks[2].depends_on).toEqual([1, 2]);
  });

  it('treats a subtask with an empty files array as non-conflicting', () => {
    const subtasks = [st(1, ['a.ts'], 'A'), st(2, [], 'A'), st(3, ['a.ts'], 'A')];
    const fixes = serializeSharedFileSubtasks(subtasks);
    // subtask 2 touches nothing, stays in A; subtask 3 still conflicts with 1.
    expect(subtasks[1].parallel_group).toBe('A');
    expect(subtasks[2].parallel_group).toBe('A.2');
    expect(fixes.map(f => f.subtaskId)).toEqual([3]);
  });
});

describe('detectUndeclaredSubtaskReferences', () => {
  it('flags a subtask that references another subtask\'s completion without declaring it', () => {
    const subtasks = [
      st(13, ['a.ts'], 'F'),
      st(14, ['b.ts'], 'F'),
      { ...st(15, ['c.ts'], 'G'),
        description: 'Confirm Subtasks 13 (V0) and 14 (V1) have fully finished their sweeps and their servers are shut down before starting this one.' },
    ];
    const findings = detectUndeclaredSubtaskReferences(subtasks);
    expect(findings.map(f => [f.subtaskId, f.referencedId])).toEqual(
      expect.arrayContaining([[15, 13], [15, 14]]),
    );
  });

  it('classifies a reference to an earlier subtask as direction "earlier"', () => {
    const subtasks = [
      st(1, ['a.ts'], 'A'),
      { ...st(2, ['b.ts'], 'B'), description: 'Confirm Subtask 1 has finished before starting this one.' },
    ];
    expect(detectUndeclaredSubtaskReferences(subtasks).map(f => f.direction)).toEqual(['earlier']);
  });

  it('classifies a reference to a later subtask as direction "later" (forward reference)', () => {
    const subtasks = [
      { ...st(2, ['a.ts'], 'B'),
        description: 'This must land BEFORE the verification sweep (subtask 5); nothing may change after subtask 9.' },
      st(5, [], 'D'),
      st(9, ['b.ts'], 'H'),
    ];
    const findings = detectUndeclaredSubtaskReferences(subtasks);
    expect(findings.map(f => [f.referencedId, f.direction])).toEqual(
      expect.arrayContaining([[5, 'later'], [9, 'later']]),
    );
  });

  it('uses id order when both subtasks share a parallel_group', () => {
    const subtasks = [
      { ...st(1, ['a.ts'], 'A'), description: 'Run this before Subtask 2 starts.' },
      st(2, ['b.ts'], 'A'),
    ];
    expect(detectUndeclaredSubtaskReferences(subtasks).map(f => f.direction)).toEqual(['later']);
  });

  it('does not flag a reference already declared in depends_on', () => {
    const subtasks = [
      st(1, ['a.ts'], 'A'),
      { ...st(2, ['b.ts'], 'B', [1]), description: 'Confirm Subtask 1 has finished before starting this one.' },
    ];
    expect(detectUndeclaredSubtaskReferences(subtasks)).toEqual([]);
  });

  it('does not flag a plain mention with no ordering cue word', () => {
    const subtasks = [
      st(1, ['a.ts'], 'A'),
      { ...st(2, ['b.ts'], 'B'), description: 'See Subtask 1 for the file layout used here.' },
    ];
    expect(detectUndeclaredSubtaskReferences(subtasks)).toEqual([]);
  });

  it('does not misread requirement/criterion ids (R3, AC-14, C1) as subtask references', () => {
    const subtasks = [
      st(1, ['a.ts'], 'A'),
      { ...st(2, ['b.ts'], 'B'),
        description: 'This subtask must confirm R3 and AC-14 pass before finishing; see commit C1 for context.' },
    ];
    expect(detectUndeclaredSubtaskReferences(subtasks)).toEqual([]);
  });

  it('ignores the synthetic QA-rework subtask (id 9999)', () => {
    const subtasks = [
      st(1, ['a.ts'], 'A'),
      { ...st(9999, ['b.ts'], 'QA-REWORK'),
        description: 'Wakeup attempt limit exceeded: Subtask 1 failed to produce artifact after 3 wakeup attempts, confirm before retrying.' },
    ];
    expect(detectUndeclaredSubtaskReferences(subtasks)).toEqual([]);
  });

  it('ignores a reference to an id that is not a real subtask', () => {
    const subtasks = [
      { ...st(1, ['a.ts'], 'A'), description: 'Confirm Subtask 999 has finished before starting this one.' },
    ];
    expect(detectUndeclaredSubtaskReferences(subtasks)).toEqual([]);
  });
});

describe('planDeclaresRealFileChanges', () => {
  let specPath: string;

  afterEach(() => {
    try { rmSync(specPath, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  function taskDir(planJson: unknown): string {
    specPath = join(tmpdir(), `teamai-plan-changes-${randomUUID().slice(0, 8)}`);
    mkdirSync(specPath, { recursive: true });
    if (planJson !== undefined) {
      writeFileSync(join(specPath, 'plan.json'), JSON.stringify(planJson));
    }
    return specPath;
  }

  it('returns false when every subtask declares no files (genuine verification-only plan)', () => {
    const dir = taskDir({ subtasks: [st(1, []), st(2, [])] });
    expect(planDeclaresRealFileChanges(dir)).toBe(false);
  });

  it('returns false when a subtask only touches .teamai/ paths (ticket-creation carve-out)', () => {
    const dir = taskDir({ subtasks: [st(1, ['.teamai/some-new-ticket/task.json'])] });
    expect(planDeclaresRealFileChanges(dir)).toBe(false);
  });

  it('returns true when a subtask declares a real source file', () => {
    const dir = taskDir({ subtasks: [st(1, []), st(2, ['src/app.ts'])] });
    expect(planDeclaresRealFileChanges(dir)).toBe(true);
  });

  it('returns true when a subtask declares files_to_create outside .teamai/', () => {
    const dir = taskDir({ subtasks: [{ ...st(1, []), files_to_create: ['src/new-file.ts'] }] });
    expect(planDeclaresRealFileChanges(dir)).toBe(true);
  });

  it('returns true (conservative) when plan.json is missing', () => {
    const dir = taskDir(undefined);
    expect(planDeclaresRealFileChanges(dir)).toBe(true);
  });

  it('returns true (conservative) when plan.json is malformed', () => {
    const dir = taskDir(undefined);
    writeFileSync(join(dir, 'plan.json'), 'not valid json {{{');
    expect(planDeclaresRealFileChanges(dir)).toBe(true);
  });
});
