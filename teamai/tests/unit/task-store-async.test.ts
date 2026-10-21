// @vitest-environment node

/**
 * Tests the async read API of TaskStore (getAllAsync, getByIdAsync,
 * getDirByIdAsync, getEventsAsync) and the fs-async helpers: parity with the
 * sync methods, Missing-vs-failure semantics, and shared index coherence.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';

const { readFileFailures } = vi.hoisted(() => ({
  readFileFailures: new Map<string, string>(),
}));

// Real readFile unless the path ends with a registered suffix → reject with that code.
vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs/promises')>();
  return {
    ...actual,
    readFile: ((path: unknown, ...rest: unknown[]) => {
      const p = String(path).replace(/\\/g, '/');
      for (const [suffix, code] of readFileFailures) {
        if (p.endsWith(suffix)) {
          return Promise.reject(Object.assign(new Error(`${code}: mock`), { code }));
        }
      }
      return (actual.readFile as (...a: unknown[]) => Promise<unknown>)(path, ...rest);
    }) as typeof actual.readFile,
  };
});

import { TaskStore } from '@/lib/task-store';
import { isMissing, pathExists, readTextIfExists } from '@/lib/fs-async';
import { setupTaskStoreTest, makeTask, type TaskStoreTestEnv } from '../utils/task-store-harness';

let env: TaskStoreTestEnv;
let store: TaskStore;
let root: string;

function writeTaskDir(name: string, id: string, createdAt: string): string {
  const dir = join(root, '.teamai', name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'task.json'), JSON.stringify({
    id, title: name, description: '', phase: 'backlog', createdAt, updatedAt: createdAt,
  }));
  return dir;
}

beforeEach(() => {
  readFileFailures.clear();
  env = setupTaskStoreTest();
  store = env.store;
  root = env.root;
});

afterEach(() => env.clean());

describe('fs-async helpers', () => {
  it('isMissing is true only for ENOENT/ENOTDIR', () => {
    expect(isMissing({ code: 'ENOENT' })).toBe(true);
    expect(isMissing({ code: 'ENOTDIR' })).toBe(true);
    expect(isMissing({ code: 'EIO' })).toBe(false);
    expect(isMissing(new Error('x'))).toBe(false);
    expect(isMissing(null)).toBe(false);
  });

  it('readTextIfExists returns null for a missing file and rejects otherwise', async () => {
    const dir = writeTaskDir('a', 'a', '2024-01-01T00:00:00.000Z');
    expect(await readTextIfExists(join(dir, 'nope.txt'))).toBeNull();
    expect(await readTextIfExists(join(dir, 'task.json'))).toContain('"id"');
    readFileFailures.set('task.json', 'EIO');
    await expect(readTextIfExists(join(dir, 'task.json'))).rejects.toMatchObject({ code: 'EIO' });
  });

  it('pathExists is false for missing paths and true for existing ones', async () => {
    const dir = writeTaskDir('a', 'a', '2024-01-01T00:00:00.000Z');
    expect(await pathExists(dir)).toBe(true);
    expect(await pathExists(join(dir, 'nope'))).toBe(false);
    expect(await pathExists(join(dir, 'task.json', 'child'))).toBe(false); // ENOTDIR
  });
});

describe('TaskStore async parity (AC1)', () => {
  it('async reads equal their sync counterparts', async () => {
    writeTaskDir('one', 't1', '2024-01-01T00:00:00.000Z');
    const d2 = writeTaskDir('two', 't2', '2024-01-02T00:00:00.000Z');
    writeTaskDir('three', 't3', '2024-01-02T00:00:00.000Z'); // createdAt tie → id order
    writeFileSync(join(d2, 'events.jsonl'), '{"phase":"spec","timestamp":"x"}\n{"phase":"plan","timestamp":"y"}\n');
    mkdirSync(join(root, '.teamai', 'no-task-json'), { recursive: true });

    expect(await store.getAllAsync()).toEqual(store.getAll());
    expect((await store.getAllAsync()).map(t => t.id)).toEqual(['t2', 't3', 't1']);
    for (const id of ['t1', 't2', 't3']) {
      expect(await store.getByIdAsync(id)).toEqual(store.getById(id));
      expect(await store.getDirByIdAsync(id)).toBe(store.getDirById(id));
      expect(await store.getEventsAsync(id)).toEqual(store.getEvents(id));
    }
    expect(await store.getEventsAsync('t1')).toEqual([]);
    expect((await store.getEventsAsync('t2')).length).toBe(2);
  });

  it('returns [] when .teamai is missing', async () => {
    const other = new TaskStore(join(root, 'sub'));
    env.clean();
    // specs dir of `other` was created by the constructor under the (now removed) root
    expect(await other.getAllAsync()).toEqual([]);
    env = setupTaskStoreTest();
    store = env.store;
    root = env.root;
  });

  it('unknown id: getByIdAsync → null, getDirByIdAsync rejects with the sync message', async () => {
    expect(await store.getByIdAsync('nope')).toBeNull();
    await expect(store.getDirByIdAsync('nope')).rejects.toThrow('Task directory not found for id nope');
    await expect(store.getEventsAsync('nope')).rejects.toThrow('Task directory not found for id nope');
  });

  it('rejects on a malformed events.jsonl line', async () => {
    const dir = writeTaskDir('a', 'a', '2024-01-01T00:00:00.000Z');
    writeFileSync(join(dir, 'events.jsonl'), '{not json}\n');
    await expect(store.getEventsAsync('a')).rejects.toThrow();
  });

  it('getAllAsync rejects on an unparseable task.json (parity with getAll)', async () => {
    const dir = writeTaskDir('a', 'a', '2024-01-01T00:00:00.000Z');
    writeFileSync(join(dir, 'task.json'), '{broken');
    expect(() => store.getAll()).toThrow();
    await expect(store.getAllAsync()).rejects.toThrow();
  });
});

describe('TaskStore async read failures (AC2)', () => {
  it('getAllAsync rejects when task.json read fails with EIO', async () => {
    writeTaskDir('a', 'a', '2024-01-01T00:00:00.000Z');
    writeTaskDir('b', 'b', '2024-01-02T00:00:00.000Z');
    readFileFailures.set('a/task.json', 'EIO');
    await expect(store.getAllAsync()).rejects.toMatchObject({ code: 'EIO' });
  });

  it('getEventsAsync rejects when events.jsonl read fails with EIO', async () => {
    const dir = writeTaskDir('a', 'a', '2024-01-01T00:00:00.000Z');
    writeFileSync(join(dir, 'events.jsonl'), '{"phase":"spec","timestamp":"x"}\n');
    readFileFailures.set('events.jsonl', 'EIO');
    await expect(store.getEventsAsync('a')).rejects.toMatchObject({ code: 'EIO' });
  });

  it('getByIdAsync rejects on an EIO during index rebuild', async () => {
    writeTaskDir('a', 'a', '2024-01-01T00:00:00.000Z');
    readFileFailures.set('a/task.json', 'EIO');
    await expect(store.getByIdAsync('a')).rejects.toMatchObject({ code: 'EIO' });
  });

  it('ENOENT on one task.json still resolves the other tasks', async () => {
    writeTaskDir('a', 'a', '2024-01-01T00:00:00.000Z');
    writeTaskDir('b', 'b', '2024-01-02T00:00:00.000Z');
    readFileFailures.set('a/task.json', 'ENOENT');
    expect((await store.getAllAsync()).map(t => t.id)).toEqual(['b']);
    expect(await store.getByIdAsync('b')).not.toBeNull();
  });
});

describe('TaskStore shared index coherence (AC3)', () => {
  it('finds a task created after the async index was built, via async and sync', async () => {
    makeTask(store, env.nextId, 'First');
    expect(await store.getByIdAsync('task-1')).not.toBeNull();

    const created = store.create('late-id', 'Late', 'desc');
    const asyncDir = await store.getDirByIdAsync('late-id');
    expect(asyncDir).toBe(store.getDirById('late-id'));
    expect(asyncDir.endsWith(created.slug!)).toBe(true);
  });

  it('delete(id) then getByIdAsync → null', async () => {
    makeTask(store, env.nextId, 'First');
    expect(await store.getByIdAsync('task-1')).not.toBeNull();
    store.delete('task-1');
    expect(await store.getByIdAsync('task-1')).toBeNull();
    await expect(store.getDirByIdAsync('task-1')).rejects.toThrow('Task directory not found');
  });
});
