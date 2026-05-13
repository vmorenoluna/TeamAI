/**
 * Test Project Lifecycle Utility
 *
 * Creates temporary project directories for tests and ensures they are
 * cleaned up — both the filesystem directory and the ProjectStore entry
 * in ~/.teamai/projects.json.
 *
 * Usage in beforeEach/afterEach:
 *   let cleanup: () => void;
 *   beforeEach(() => {
 *     const { root, clean } = createTestProject();
 *     testDir = root;
 *     cleanup = clean;
 *   });
 *   afterEach(() => cleanup());
 *
 * Usage with register (for tests that need ProjectStore.add):
 *   const { root, store, clean } = registerTestProject('My Test');
 *   // root is the project dir, store has it registered
 *   // clean() removes both the dir and the store entry
 */

import { mkdirSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { ProjectStore } from '@/lib/project-store';

const TEST_PREFIX = '.teamai-test-';

/**
 * Creates a temporary test project directory (NOT registered in ProjectStore).
 * Returns the project root path and a clean() function.
 */
export function createTestProject(): { root: string; clean: () => void } {
  const root = join(process.cwd(), TEST_PREFIX + randomUUID().slice(0, 8));
  mkdirSync(root, { recursive: true });

  const clean = () => {
    if (existsSync(root)) rmSync(root, { recursive: true, force: true });
  };

  return { root, clean };
}

/**
 * Creates a temporary test project directory and a fresh ProjectStore instance.
 * Does NOT register the project in ProjectStore — individual tests create
 * their own store entries via store.add() so they can test the add path.
 *
 * Returns the project root, a store instance, and a clean() function that
 * removes both the directory AND any store entry (defensively).
 */
export function registerTestProject(): {
  root: string;
  store: ProjectStore;
  clean: () => void;
} {
  const root = join(process.cwd(), TEST_PREFIX + randomUUID().slice(0, 8));
  mkdirSync(root, { recursive: true });

  const store = new ProjectStore();

  const clean = () => {
    // Remove from ProjectStore first (unregisters from projects.json)
    // This is defensive — even if the test never called add(), remove is idempotent
    try { store.remove(root); } catch { /* not registered */ }
    // Remove physical directory (after store so the entry is cleaned up
    // even if the filesystem removal fails)
    if (existsSync(root)) rmSync(root, { recursive: true, force: true });
  };

  return { root, store, clean };
}
