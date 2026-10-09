import { describe, it, expect } from 'vitest';
import { buildHeadMovedNote, buildWakeupReentryHeader } from '../../src/lib/orchestrator/wakeup';

const A = 'aaaaaaa1111111111111111111111111111111aa';
const B = 'bbbbbbb2222222222222222222222222222222bb';

describe('buildHeadMovedNote', () => {
  it('warns when HEAD moved since the wakeup was scheduled', () => {
    const note = buildHeadMovedNote(A, B);
    expect(note).toContain('aaaaaaa');
    expect(note).toContain('bbbbbbb');
    expect(note).toContain('relaunch');
  });

  it('is empty when HEAD is unchanged or either SHA is unknown', () => {
    expect(buildHeadMovedNote(A, A)).toBe('');
    expect(buildHeadMovedNote(undefined, B)).toBe('');
    expect(buildHeadMovedNote(A, undefined)).toBe('');
  });
});

describe('buildWakeupReentryHeader', () => {
  const base = { unitLabel: 'this subtask', wakeupFilename: 'subtask_wakeup-st7.json' };

  it('includes the HEAD-moved warning when the SHAs differ', () => {
    expect(buildWakeupReentryHeader({ ...base, headAtSchedule: A, currentHead: B })).toContain('HEAD moved');
  });

  it('omits it when the SHAs match', () => {
    expect(buildWakeupReentryHeader({ ...base, headAtSchedule: A, currentHead: A })).not.toContain('HEAD moved');
  });
});
