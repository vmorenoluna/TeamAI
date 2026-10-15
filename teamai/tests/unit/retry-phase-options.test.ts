import { describe, it, expect } from 'vitest';
import { getRetryPhaseOptions, getPhaseClearDescription } from '@/lib/orchestrator/artifacts';

describe('getRetryPhaseOptions', () => {
  it('offers only the agent phases for an ordinary failure', () => {
    expect(getRetryPhaseOptions().map(o => o.phase)).toEqual(['spec', 'plan', 'implement']);
    expect(getRetryPhaseOptions('qa-review').map(o => o.phase)).toEqual(['spec', 'plan', 'implement']);
  });

  it('puts create-pr first for a task that failed creating its PR', () => {
    expect(getRetryPhaseOptions('create-pr').map(o => o.phase)).toEqual(['create-pr', 'spec', 'plan', 'implement']);
  });

  it('puts merge first for a task that failed merging', () => {
    expect(getRetryPhaseOptions('merge').map(o => o.phase)).toEqual(['merge', 'spec', 'plan', 'implement']);
  });

  it('describes create-pr and merge as agent-free resumes', () => {
    expect(getPhaseClearDescription('create-pr')).toMatch(/No agent runs/);
    expect(getPhaseClearDescription('merge')).toMatch(/No agent runs/);
  });
});
