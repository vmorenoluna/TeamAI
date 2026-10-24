import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdtempSync, rmSync, readdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { EngineBoundaryError } from '../../src/lib/process-role';

vi.mock('node-pty', () => ({ spawn: vi.fn() }));

import { getOrchestrator, getActiveTaskIds } from '../../src/lib/orchestrator';
import { ProcessManager } from '../../src/lib/process-manager';
import { runInBackground } from '../../src/lib/background-actions';
import { setAutoModeState } from '../../src/lib/auto-mode';
import { ContainerManager } from '../../src/lib/container-manager';
import { TaskStore } from '../../src/lib/task-store';
import { appEvents } from '../../src/lib/app-events';

describe('process-role guard', () => {
  let root: string;
  let saved: string | undefined;

  beforeEach(() => {
    saved = process.env.TEAMAI_PROCESS_ROLE;
    root = mkdtempSync(join(tmpdir(), 'role-guard-'));
  });

  afterEach(() => {
    if (saved === undefined) delete process.env.TEAMAI_PROCESS_ROLE;
    else process.env.TEAMAI_PROCESS_ROLE = saved;
    rmSync(root, { recursive: true, force: true });
  });

  describe("role 'api'", () => {
    beforeEach(() => {
      process.env.TEAMAI_PROCESS_ROLE = 'api';
    });

    it('getOrchestrator throws', () => {
      expect(() => getOrchestrator(root)).toThrow(EngineBoundaryError);
    });

    it('ProcessManager.createSession rejects before spawning', async () => {
      const pm = new ProcessManager();
      await expect(pm.createSession({ taskId: 't', role: 'coder', cwd: root })).rejects.toThrow(EngineBoundaryError);
      expect(pm.getAllSessions()).toHaveLength(0);
    });

    it('ProcessManager.createTerminalSession throws', () => {
      const pm = new ProcessManager();
      expect(() => pm.createTerminalSession({ projectPath: root, role: 'coder.md' })).toThrow(EngineBoundaryError);
      expect(pm.getTerminalSessions()).toHaveLength(0);
    });

    it('runInBackground throws without running the work', () => {
      const work = vi.fn(async () => undefined);
      expect(() => runInBackground({ action: 'stop', taskId: 't', projectRoot: root, notify: 'always' }, work)).toThrow(EngineBoundaryError);
      expect(work).not.toHaveBeenCalled();
    });

    it('setAutoModeState throws and writes nothing', () => {
      expect(() => setAutoModeState(root, true, 1)).toThrow(EngineBoundaryError);
      expect(existsSync(join(root, '.teamai', 'auto-mode.json'))).toBe(false);
    });

    it('ContainerManager.ensureContainer rejects', async () => {
      await expect(new ContainerManager().ensureContainer(root)).rejects.toThrow(EngineBoundaryError);
    });

    it('every TaskStore writer throws and writes no task files', () => {
      const store = new TaskStore(root);
      const before = readdirSync(join(root, '.teamai'));
      expect(() => store.create('id1', 'Title', 'desc')).toThrow(EngineBoundaryError);
      expect(() => store.update('id1', { title: 'x' })).toThrow(EngineBoundaryError);
      expect(() => store.updatePhase('id1', 'spec')).toThrow(EngineBoundaryError);
      expect(() => store.markCompletedTask('id1')).toThrow(EngineBoundaryError);
      expect(() => store.delete('id1')).toThrow(EngineBoundaryError);
      expect(() => store.clearArtifacts('id1', 'spec')).toThrow(EngineBoundaryError);
      expect(readdirSync(join(root, '.teamai'))).toEqual(before);
      expect(existsSync(join(root, '.teamai', 'completed-task-ids.json'))).toBe(false);
    });

    it('TaskStore read methods stay unguarded', async () => {
      const store = new TaskStore(root);
      expect(store.getAll()).toEqual([]);
      expect(store.getById('nope')).toBeNull();
      expect(await store.getAllAsync()).toEqual([]);
      expect(store.isTaskCompleted('nope')).toBe(false);
    });
  });

  describe.each<[string | undefined]>([[undefined], ['engine']])('role %s', (role) => {
    beforeEach(() => {
      if (role === undefined) delete process.env.TEAMAI_PROCESS_ROLE;
      else process.env.TEAMAI_PROCESS_ROLE = role;
    });

    it('TaskStore writes work and emit task-updated on appEvents', () => {
      const listener = vi.fn();
      appEvents.on('task-updated', listener);
      try {
        const task = new TaskStore(root).create('id1', 'Title', 'desc');
        expect(existsSync(join(root, '.teamai', task.slug!, 'task.json'))).toBe(true);
        expect(listener).toHaveBeenCalledWith({ taskId: 'id1', projectRoot: root });
      } finally {
        appEvents.off('task-updated', listener);
      }
    });

    it('runInBackground runs the work', async () => {
      const work = vi.fn(async () => undefined);
      runInBackground({ action: 'stop', taskId: 't', projectRoot: root, notify: 'failure-only' }, work);
      await vi.waitFor(() => expect(work).toHaveBeenCalled());
    });

    it('getOrchestrator and getActiveTaskIds work', () => {
      expect(getOrchestrator(root)).toBeDefined();
      expect(getActiveTaskIds()).toEqual([]);
    });
  });
});
